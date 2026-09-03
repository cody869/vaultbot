// suspensionWatcher.js
//
// Polls Base44 for APPROVED Suspension records and posts each one exactly once
// to the suspensions channel, tagging the affected team owner.
//
// Mirrors newsWatcher.js:
//   - the RECORD is the durable, cross-restart lock: claim() stamps
//     discord_message_id with a unique token and re-reads to confirm
//     ownership BEFORE sending. On its own that write-then-reread is only an
//     optimistic check (confirmed live: it let the same suspension post
//     several times at once when containers overlapped during a redeploy),
//     so the whole thing also runs inside fileLock.js's withFileLock() so
//     only one container can be attempting a claim at a time.
//   - `handled` (a plain in-process Set) is layered on top as a fast guard
//     against re-offering a suspension THIS process has already claimed.
//     This one was missing here (unlike news.js/weeklyDigestWatcher.js,
//     which both already had it) -- confirmed live as the actual cause of
//     a suspension posting 3-4 times, once per tick, with no other
//     container involved: the due-list read below is cached for up to
//     715s, which can outlive several ticks when SUSPENSION_POLL_SECONDS is
//     shorter than that, and without `handled` every one of those ticks
//     re-evaluated the same stale snapshot, saw the suspension still
//     looking due, and claim() -- with nothing else in-process racing it --
//     blindly overwrote discord_message_id with a fresh token and "won"
//     every single time.
//   - the final message-id write-back retries; if it can't persist it leaves
//     the claim token in place (never clears to empty) so the record stays
//     locked rather than reposting forever.
//   - plain markdown + SuppressEmbeds (no link previews / image unfurls).
//
// Base44 auth: the bot logs in as a normal BOT_EMAIL user, NOT admin. The
// Suspension entity's RLS update rule includes {data.status: "approved"},
// which is exactly (and only) the window this watcher writes in.
//
// Env:
//   SUSPENSIONS_CHANNEL_ID   required — channel to post into
//   SUSPENSION_POLL_SECONDS  optional — default 60
//   SUSPENSION_SEED_HOURS    optional — default 24; on startup, approved
//                            records older than this are marked handled so a
//                            first deploy doesn't flood the channel

import { MessageFlags, AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { list, getLeagueMembers, memberDisplayName, updateEntity, pollCached } from './vault.js';
import { isRateLimited } from './base44Pacer.js';
import { withFileLock } from './fileLock.js';
import { renderSuspensionCard } from './suspensionCard.js';
import { abbrFromName } from './emoji.js';

const CHANNEL_ID = process.env.SUSPENSIONS_CHANNEL_ID;
// A suspension is posted after a human committee/admin decision already
// happened elsewhere -- there's no "live" event being tracked here, just
// propagation delay to Discord, so several minutes is imperceptible.
const POLL_MS = (Number(process.env.SUSPENSION_POLL_SECONDS) || 720) * 1000;
const SEED_HOURS = Number(process.env.SUSPENSION_SEED_HOURS) || 24;

const PID = process.pid;

// Suspensions we've already picked up this process, so a stale cached scan
// (see fetchDue()'s pollCached call below) can't hand the same due
// suspension to a later tick a second time -- same guard news.js and
// weeklyDigestWatcher.js already use for the identical reason.
const handled = new Set();

const isWarning = (s) => (s.suspension_games ?? 0) === 0;

const VIOLATION_LABELS = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };
const violationLabel = (n) => VIOLATION_LABELS[n] || `${n}th`;

/**
 * Resolve a mention for the suspended team's owner.
 *
 * IMPORTANT (privacy rule): LeagueMember.username is often an email, so it must
 * never be echoed into Discord. Prefer a real ping via discord_user_id; fall
 * back to a safe display name, then to the team name. Never the raw username.
 */
function resolveOwnerMention(suspension, members) {
  const uname = (suspension.username || '').trim().toLowerCase();
  const team = (suspension.team_name || '').trim().toLowerCase();

  const member = members.find((m) => {
    const mu = (m.username || '').trim().toLowerCase();
    const mt = (m.team_name || '').trim().toLowerCase();
    return (uname && mu === uname) || (team && mt === team);
  });

  if (member?.discord_user_id) return `<@${member.discord_user_id}>`;
  // memberDisplayName() already walks the safe fallback chain and never
  // returns an email, which is the privacy rule for anything shown in Discord.
  if (member) return memberDisplayName(member);
  return suspension.team_name ? `${suspension.team_name} owner` : 'Team owner';
}

const isCustom = (s) => s.suspension_type === 'custom';

/**
 * Plain-markdown post body. Mirrors buildDiscordEmbed() in the app's
 * PendingSuspensions.jsx.
 *
 * suspension_type: 'custom' entries (hand-entered on the Suspensions page for
 * any rule break other than the 70/30 pass-ratio rule) carry none of
 * violation_game_id/violation_week/violation_pass_ratio/violation_number --
 * those are '70_30'-only per the schema. Unconditionally formatting them in
 * (the original bug here) produced "Week undefined -- **undefined%** pass
 * rate (undefined violation this season)". Branch on suspension_type instead
 * and use rule_broken/violation_description, which are custom-only.
 */
function buildMessage(s, ownerMention) {
  const custom = isCustom(s);
  const title = custom
    ? `# 🚨 ${s.rule_broken || 'Suspension'} — ${s.team_name || 'Unknown Team'}`
    : `# 🚨 70/30 Rule Violation — ${s.team_name || 'Unknown Team'}`;

  const lines = [
    title,
    `Owner: ${ownerMention}`,
    custom
      ? `Season ${s.season_number}`
      : `Season ${s.season_number} · Week ${s.violation_week} — **${s.violation_pass_ratio}%** pass rate (${violationLabel(s.violation_number)} violation this season)`,
    '',
  ];

  if (custom && s.violation_description) {
    lines.push(`> ${s.violation_description}`);
    lines.push('');
  }

  if (isWarning(s)) {
    lines.push(
      custom
        ? '**Penalty:** ⚠️ Warning — no suspension.'
        // The "next violation" followup is specifically about the 70/30
        // progressive-violation tally, which custom suspensions never affect.
        : '**Penalty:** ⚠️ Warning — no suspension. Next violation this season triggers a suspension.'
    );
  } else {
    const positions = (s.suspended_positions || []).join(' + ');
    lines.push(`**Penalty:** ${s.suspension_games}-game suspension${positions ? ` · ${positions}` : ''}`);
    if ((s.suspended_player_names || []).length > 0) {
      lines.push(`> Suspended: ${s.suspended_player_names.join(', ')}`);
    }
    if (s.applies_to_week) {
      lines.push(`> Applies to: Week ${s.applies_to_week}`);
    }
  }

  if (s.admin_notes) lines.push(`> Note: ${s.admin_notes}`);

  return lines.join('\n');
}

/** A record is due if it's approved and nothing has claimed or posted it yet. */
function isDue(s) {
  return s.status === 'approved' && !s.discord_message_id;
}

/**
 * Stake a claim on this record before sending anything.
 * Returns true only if OUR token is the one that stuck.
 *
 * The write-then-reread below is only an OPTIMISTIC check on its own --
 * confirmed live, it let the same suspension post 4 times at once. Each of
 * several overlapping containers (a Railway redeploy doesn't guarantee the
 * old container is gone before the new one starts, and this repo pushes to
 * main often) can independently write its own token and then read back ITS
 * OWN write before any of the others' writes arrive, so every one of them
 * sees "yes, my token is there" and proceeds. A Base44 record update has no
 * compare-and-swap to fix this with. withFileLock does: it's a real,
 * cross-process mutex (atomic file creation, same primitive
 * eaTokenStore.js already relies on for this exact class of Railway
 * deploy-overlap problem), so only one container is ever inside this
 * function's body at a time -- the write-then-reread inside it now
 * actually means what it always claimed to.
 */
async function claim(suspension) {
  return withFileLock('suspension-claim', async () => {
    const token = `posting:${PID}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    try {
      await updateEntity('Suspension', suspension.id, { discord_message_id: token });
    } catch (err) {
      console.error(`[SUSPENSION] claim write failed for ${suspension.id}:`, err.message);
      return false;
    }

    // Re-read to confirm ownership — last-write-wins means our write may have
    // been clobbered by another instance between the write and this read.
    try {
      const fresh = await list('Suspension', {}, { sort: '-created_date', limit: 5000 });
      const row = fresh.find((r) => r.id === suspension.id);
      if (!row || row.discord_message_id !== token) {
        console.log(`[SUSPENSION] lost claim race on ${suspension.id}, skipping`);
        return false;
      }
    } catch (err) {
      console.error(`[SUSPENSION] claim verify failed for ${suspension.id}:`, err.message);
      return false;
    }

    return true;
  });
}

/** Persist the real message id, retrying a few times. Never clears back to empty. */
async function writeBackMessageId(suspension, message) {
  const payload = {
    discord_message_id: message.id,
    discord_message_url: message.url,
    discord_posted_at: new Date().toISOString(),
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await updateEntity('Suspension', suspension.id, payload);
      return true;
    } catch (err) {
      console.error(`[SUSPENSION] write-back attempt ${attempt} failed for ${suspension.id}:`, err.message);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }

  // Leave the claim token in place. The record stays locked, so we post once
  // and only once even though we lost the id.
  console.error(`[SUSPENSION] write-back gave up for ${suspension.id}; claim token retained (posted as ${message.id})`);
  return false;
}

/**
 * Render the stylized card, matching scorebugCard.js's visual language.
 * Returns null (never throws) so a render failure can fall back to the
 * plain-text message instead of losing the post entirely.
 */
async function buildCard(s) {
  const abbr = abbrFromName(s.team_name);
  if (!abbr) {
    console.warn(`[SUSPENSION] could not resolve team abbr for "${s.team_name}", falling back to text`);
    return null;
  }
  try {
    const png = await renderSuspensionCard({
      abbr,
      teamName: s.team_name,
      season: s.season_number,
      week: s.violation_week,
      passRatio: s.violation_pass_ratio,
      violationNumber: s.violation_number,
      ruleBroken: s.rule_broken,
      games: s.suspension_games ?? 0,
      positions: s.suspended_positions,
      players: s.suspended_player_names,
      appliesToWeek: s.applies_to_week,
    });
    const filename = `suspension-${abbr}-${s.id}.png`;
    return {
      files: [new AttachmentBuilder(png, { name: filename })],
      embeds: [
        new EmbedBuilder()
          .setColor(isWarning(s) ? 0xffb612 : 0xc60c30)
          .setImage(`attachment://${filename}`),
      ],
    };
  } catch (err) {
    console.error(`[SUSPENSION] card render failed for ${s.id}, falling back to text:`, err.message);
    return null;
  }
}

async function postOne(client, suspension, members) {
  if (!(await claim(suspension))) return false;

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) {
    console.error(`[SUSPENSION] channel ${CHANNEL_ID} not found`);
    return false;
  }

  const ownerMention = resolveOwnerMention(suspension, members);
  const card = await buildCard(suspension);

  // Mention pings and the admin-notes/violation-description asides need to be
  // real message content, not baked into the image, so they still
  // render/ping normally. The full plain-text layout is only used as a
  // fallback when the card can't render. violation_description is
  // custom-suspension-only -- the card's own bottom line shows rule_broken,
  // but the fuller free-text description belongs here, not squeezed onto it.
  const content = card
    ? [
        `Owner: ${ownerMention}`,
        isCustom(suspension) && suspension.violation_description ? `> ${suspension.violation_description}` : null,
        suspension.admin_notes ? `> Note: ${suspension.admin_notes}` : null,
      ].filter(Boolean).join('\n')
    : buildMessage(suspension, ownerMention);

  const message = await channel.send({
    content,
    embeds: card?.embeds ?? [],
    files: card?.files ?? [],
    flags: card ? undefined : MessageFlags.SuppressEmbeds,
    allowedMentions: { users: ownerMention.startsWith('<@') ? [ownerMention.slice(2, -1)] : [] },
  });

  await writeBackMessageId(suspension, message);
  console.log(`[SUSPENSION] posted ${suspension.id} (${suspension.team_name}) as ${message.id}`);
  return true;
}

/**
 * Startup seed: mark old approved records as handled without posting them, so a
 * first deploy (or a long outage) doesn't dump the whole backlog into the channel.
 */
async function seedBacklog() {
  const cutoff = Date.now() - SEED_HOURS * 3600 * 1000;
  let seeded = 0;

  const all = await list('Suspension', {}, { sort: '-created_date', limit: 5000 });
  for (const s of all.filter(isDue)) {
    const created = new Date(s.created_date).getTime();
    if (Number.isFinite(created) && created >= cutoff) continue;
    try {
      await updateEntity('Suspension', s.id, {
        discord_message_id: `seeded:${Date.now()}`,
        discord_posted_at: new Date().toISOString(),
      });
      seeded++;
    } catch (err) {
      console.error(`[SUSPENSION] seed failed for ${s.id}:`, err.message);
    }
  }

  if (seeded > 0) console.log(`[SUSPENSION] seeded ${seeded} backlog record(s) as handled (older than ${SEED_HOURS}h)`);
}

async function tick(client) {
  // An app-wide Base44 pause is in effect (see base44Pacer.js) -- sit this
  // tick out rather than piling onto it. The next tick checks again.
  if (isRateLimited()) return;

  try {
    // Cached (not claim()'s own re-read above, which must stay live to
    // verify a write actually stuck) -- this is just "scan for anything
    // newly due," which doesn't need sub-minute freshness on this poll.
    // This cache can outlive several ticks whenever SUSPENSION_POLL_SECONDS
    // is shorter than its own TTL -- which is exactly why `handled` below
    // is required, not optional: without it, every tick that reuses this
    // same stale snapshot would see an already-claimed-and-posted
    // suspension as still "due" and repost it, since claim() has nothing
    // else in-process stopping it from re-claiming (confirmed live: the
    // same suspension posted 3-4 times, once per tick, until this cache
    // finally refreshed).
    const [all, members] = await Promise.all([
      pollCached('suspension:all', 715_000, () => list('Suspension', {}, { sort: '-created_date', limit: 5000 })),
      getLeagueMembers(),
    ]);

    const due = all.filter((s) => isDue(s) && !handled.has(s.id));
    for (const s of due) {
      handled.add(s.id); // fast in-process guard; the record claim is the real lock
      try {
        await postOne(client, s, members);
      } catch (err) {
        console.error(`[SUSPENSION] post failed for ${s.id}:`, err.message);
        handled.delete(s.id); // let a later tick retry
      }
    }
  } catch (err) {
    console.error('[SUSPENSION] poll failed:', err.message);
  }
}

export function startSuspensionWatcher(client) {
  if (!CHANNEL_ID) {
    console.log('[SUSPENSION] SUSPENSIONS_CHANNEL_ID not set — watcher disabled');
    return;
  }

  console.log(`[SUSPENSION] watcher starting (poll ${POLL_MS / 1000}s, channel ${CHANNEL_ID})`);

  seedBacklog()
    .catch((err) => console.error('[SUSPENSION] seed pass failed:', err.message))
    .finally(() => {
      tick(client);
      setInterval(() => tick(client), POLL_MS);
    });
}
