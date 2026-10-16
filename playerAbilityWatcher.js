// playerAbilityWatcher.js
//
// Polls Base44 for PlayerAbilityChangePost rows (one per player per roster
// import whose Madden ability ratings changed -- written by maddenWebhook,
// see base44/functions/maddenWebhook/entry.ts's abilityPostsToCreate) and
// posts each one exactly once to a dedicated Discord channel.
//
// Mirrors suspensionWatcher.js's claim pattern (that file has the fullest
// writeup of why each piece exists -- see its header comment):
//   - the RECORD is the durable, cross-restart lock: claim() stamps
//     discord_message_id with a unique "posting:<pid>:<ts>:<rand>" token and
//     re-reads to confirm ownership BEFORE sending, inside withFileLock.js's
//     cross-process mutex so two overlapping containers (a redeploy) can't
//     both win the optimistic write-then-reread.
//   - `handled` (a plain in-process Set, rebuilt fresh every tick) guards
//     against re-offering a row this process already claimed within the same
//     poll cycle, since the due-list read is cached.
//   - isDue() treats an old "posting:" token as abandoned and reclaimable
//     (CLAIM_STALE_MS) -- the one gap a plain release-on-failure try/catch
//     can't cover: a hard process crash/redeploy between claim() and send().
//     A real send is marked "sent:<id>" immediately, before the slower
//     write-back, so that recovery path can never apply to a message that
//     actually went out.
//   - the final message-id write-back retries; if it can't persist it leaves
//     the "sent:" marker in place (never clears to empty) so the record
//     stays locked rather than reposting forever.
//
// Env:
//   ABILITY_CHANGES_CHANNEL_ID   required -- channel to post into. No-ops
//                                (watcher disabled, logged once) if unset.
//   ABILITY_WATCHER_POLL_SECONDS  optional -- default 120
//   ABILITY_WATCHER_SEED_HOURS    optional -- default 24; on startup, rows
//                                 older than this are marked handled so a
//                                 first deploy doesn't flood the channel.

import { EmbedBuilder } from 'discord.js';
import { list, updateEntity, pollCached } from './vault.js';
import { isRateLimited } from './base44Pacer.js';
import { withFileLock } from './fileLock.js';
import { teamEmojiByName } from './emoji.js';

const CHANNEL_ID = process.env.ABILITY_CHANGES_CHANNEL_ID;
const POLL_MS = (Number(process.env.ABILITY_WATCHER_POLL_SECONDS) || 120) * 1000;
const SEED_HOURS = Number(process.env.ABILITY_WATCHER_SEED_HOURS) || 24;
const PID = process.pid;

// In-process guard against re-offering a row this process already claimed
// within the same cached poll window -- same reasoning as every other
// claim-pattern watcher in this repo (see suspensionWatcher.js).
const handled = new Set();

const CLAIM_STALE_MS = 10 * 60 * 1000;

function claimTimestamp(token) {
  if (typeof token !== 'string' || !token.startsWith('posting:')) return null;
  const ts = Number(token.split(':')[2]);
  return Number.isFinite(ts) ? ts : null;
}

function isDue(p) {
  if (!p.discord_message_id) return true;
  const claimedAt = claimTimestamp(p.discord_message_id);
  return claimedAt != null && Date.now() - claimedAt > CLAIM_STALE_MS;
}

// PlayerAbilityChangePost accumulates one row per player per import with no
// cleanup -- paginate properly rather than trusting a single list() call,
// which the platform caps regardless of the limit argument passed. Sort by
// `id` (immutable, assigned once at insert), not `created_date`: a shared-
// millisecond bulkCreate batch ties on created_date, and a tied sort key
// makes skip/limit pagination lose or duplicate rows across pages (same
// fix as fantasyStore.js's getWeeklyStats / scorebugWatcher.js's
// fetchAllScorebugPosts).
const PAGE_SIZE = 500;
async function fetchAllAbilityPosts() {
  const all = [];
  let skip = 0;
  for (let i = 0; i < 50; i++) {
    const page = await list('PlayerAbilityChangePost', {}, { sort: 'id', limit: PAGE_SIZE, skip });
    if (!page.length) break;
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    skip += page.length;
  }
  return all;
}

async function claim(post) {
  return withFileLock('ability-post-claim', async () => {
    const token = `posting:${PID}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    try {
      await updateEntity('PlayerAbilityChangePost', post.id, { discord_message_id: token });
    } catch (err) {
      console.error(`[ABILITY] claim write failed for ${post.id}:`, err.message);
      return false;
    }

    try {
      // Re-read a recent slice and find by id in JS, same as
      // suspensionWatcher.js's claim() -- filtering this entity's REST
      // endpoint by `id` as a query param isn't a pattern used (or verified
      // to work) anywhere else in this codebase, so don't risk it here.
      const fresh = await list('PlayerAbilityChangePost', {}, { sort: '-created_date', limit: 5000 });
      const row = fresh.find((r) => r.id === post.id);
      if (!row || row.discord_message_id !== token) {
        console.log(`[ABILITY] lost claim race on ${post.id}, skipping`);
        return false;
      }
    } catch (err) {
      console.error(`[ABILITY] claim verify failed for ${post.id}:`, err.message);
      return false;
    }

    return true;
  });
}

function fmtDelta(d) {
  const n = Number(d) || 0;
  return n > 0 ? `+${n}` : String(n);
}

function buildEmbed(post) {
  const changes = Array.isArray(post.changes) ? post.changes : [];
  const MAX_LINES = 40;
  const lines = changes.slice(0, MAX_LINES).map((c) => {
    const delta = c.delta != null ? ` (${fmtDelta(c.delta)})` : '';
    return `**${c.label}**: ${c.old_value} → ${c.new_value}${delta}`;
  });
  if (changes.length > MAX_LINES) lines.push(`...and ${changes.length - MAX_LINES} more`);

  const teamEmoji = post.team_name ? teamEmojiByName(post.team_name) : '';
  const title = `🔧 Ability Changes — ${post.player_fullName}`;
  const subtitle = [post.player_position, post.team_name].filter(Boolean).join(' · ');

  return new EmbedBuilder()
    .setColor(0xd4a843)
    .setTitle(title)
    .setDescription([subtitle && `${teamEmoji} ${subtitle}`.trim(), '', lines.join('\n') || 'No details recorded.'].filter((l) => l !== undefined).join('\n'));
}

async function postOne(client, post) {
  if (!(await claim(post))) return false;

  let channel, message;
  try {
    channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) throw new Error(`channel ${CHANNEL_ID} not found`);
    message = await channel.send({ embeds: [buildEmbed(post)] });
  } catch (err) {
    console.error(`[ABILITY] send failed for ${post.id}, releasing claim:`, err.message);
    await updateEntity('PlayerAbilityChangePost', post.id, { discord_message_id: '' }).catch(() => {});
    return false;
  }

  // Mark the real send immediately, before the slower id write-back, so a
  // crash between here and there leaves a "sent:" marker (never reclaimed
  // by isDue()'s staleness check) instead of a "posting:" token that would
  // eventually be mistaken for an abandoned claim and reposted.
  await updateEntity('PlayerAbilityChangePost', post.id, { discord_message_id: `sent:${message.id}` }).catch((err) => {
    console.error(`[ABILITY] sent-marker write failed for ${post.id}:`, err.message);
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await updateEntity('PlayerAbilityChangePost', post.id, {
        discord_message_id: message.id,
        discord_message_url: message.url,
        discord_posted_at: new Date().toISOString(),
      });
      break;
    } catch (err) {
      console.error(`[ABILITY] write-back attempt ${attempt} failed for ${post.id}:`, err.message);
      if (attempt === 3) {
        console.error(`[ABILITY] write-back gave up for ${post.id}; "sent:" marker retained (posted as ${message.id})`);
      } else {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  console.log(`[ABILITY] posted ${post.id} (${post.player_fullName}) as ${message.id}`);
  return true;
}

async function seedBacklog() {
  const cutoff = Date.now() - SEED_HOURS * 3600 * 1000;
  let seeded = 0;

  const all = await fetchAllAbilityPosts();
  for (const p of all.filter(isDue)) {
    const created = new Date(p.created_date).getTime();
    if (Number.isFinite(created) && created >= cutoff) continue;
    try {
      await updateEntity('PlayerAbilityChangePost', p.id, {
        discord_message_id: `seeded:${Date.now()}`,
        discord_posted_at: new Date().toISOString(),
      });
      seeded++;
    } catch (err) {
      console.error(`[ABILITY] seed failed for ${p.id}:`, err.message);
    }
  }

  if (seeded > 0) console.log(`[ABILITY] seeded ${seeded} backlog record(s) as handled (older than ${SEED_HOURS}h)`);
}

async function tick(client) {
  if (isRateLimited()) return;

  try {
    const all = await pollCached('ability-posts:all', 115_000, fetchAllAbilityPosts);
    const due = all.filter((p) => isDue(p) && !handled.has(p.id));
    for (const p of due) {
      handled.add(p.id);
      try {
        await postOne(client, p);
      } catch (err) {
        console.error(`[ABILITY] post failed for ${p.id}:`, err.message);
        handled.delete(p.id);
      }
    }
  } catch (err) {
    console.error('[ABILITY] poll failed:', err.message);
  }
}

export function startAbilityWatcher(client) {
  if (!CHANNEL_ID) {
    console.log('[ABILITY] ABILITY_CHANGES_CHANNEL_ID not set — watcher disabled');
    return;
  }

  console.log(`[ABILITY] watcher starting (poll ${POLL_MS / 1000}s, channel ${CHANNEL_ID})`);

  seedBacklog()
    .catch((err) => console.error('[ABILITY] seed pass failed:', err.message))
    .finally(() => {
      tick(client);
      setInterval(() => tick(client), POLL_MS);
    });
}
