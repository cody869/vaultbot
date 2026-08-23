// suspensionWatcher.js
//
// Polls Base44 for APPROVED Suspension records and posts each one exactly once
// to the suspensions channel, tagging the affected team owner.
//
// Mirrors newsWatcher.js:
//   - the RECORD is the lock, not an in-memory Set. An in-memory guard empties
//     on every Railway restart/deploy-overlap, which is what caused the news
//     reposting bug. claim() stamps discord_message_id with a unique token and
//     re-reads to confirm ownership BEFORE sending.
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
import { list, getLeagueMembers, memberDisplayName, updateEntity } from './vault.js';
import { renderSuspensionCard } from './suspensionCard.js';
import { abbrFromName } from './emoji.js';

const CHANNEL_ID = process.env.SUSPENSIONS_CHANNEL_ID;
const POLL_MS = (Number(process.env.SUSPENSION_POLL_SECONDS) || 60) * 1000;
const SEED_HOURS = Number(process.env.SUSPENSION_SEED_HOURS) || 24;

const PID = process.pid;

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

/** Plain-markdown post body. Mirrors buildDiscordEmbed() in the app's PendingSuspensions.jsx. */
function buildMessage(s, ownerMention) {
  const lines = [
    `# 🚨 70/30 Rule Violation — ${s.team_name || 'Unknown Team'}`,
    `Owner: ${ownerMention}`,
    `Season ${s.season_number} · Week ${s.violation_week} — **${s.violation_pass_ratio}%** pass rate (${violationLabel(s.violation_number)} violation this season)`,
    '',
  ];

  if (isWarning(s)) {
    lines.push('**Penalty:** ⚠️ Warning — no suspension. Next violation this season triggers a suspension.');
  } else {
    lines.push(`**Penalty:** ${s.suspension_games}-game suspension · ${(s.suspended_positions || []).join(' + ')}`);
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
 * Returns true only if OUR token is the one that stuck — if two containers race,
 * exactly one wins the re-read and the loser backs off.
 */
async function claim(suspension) {
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

  // Mention pings and the admin-notes aside need to be real message content,
  // not baked into the image, so they still render/ping normally. The full
  // plain-text layout is only used as a fallback when the card can't render.
  const content = card
    ? [`Owner: ${ownerMention}`, suspension.admin_notes ? `> Note: ${suspension.admin_notes}` : null].filter(Boolean).join('\n')
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
  try {
    const [all, members] = await Promise.all([
      list('Suspension', {}, { sort: '-created_date', limit: 5000 }),
      getLeagueMembers(),
    ]);

    const due = all.filter(isDue);
    for (const s of due) {
      try {
        await postOne(client, s, members);
      } catch (err) {
        console.error(`[SUSPENSION] post failed for ${s.id}:`, err.message);
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
