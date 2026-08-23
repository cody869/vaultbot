// scheduleWatcher.js — watches the #schedule channel, parses each post with
// scheduleParser.js, matches it to a Game row, and saves the result to the
// ScheduledGame entity. Reacts ✅ on a confident parse or ❓ when a human
// should double check.
//
// Matches against Game, not a separate "Schedule" entity — Game holds the
// whole season's matchups up front (future weeks exist with status 1 and
// 0-0 scores before they're played; status 2/3 = completed regular/
// playoff), so it's the single source for both played and upcoming games
// here. (An earlier version of this file assumed pre-game matchups lived
// in a separate Schedule entity — that entity turned out to have no data
// loaded at all, and was the wrong place to look regardless.)
//
// IMPORTANT: scheduled_status (and which emoji gets reacted) reflects
// confidence in the TEXT parse ONLY — day/time/forfeit-winner and which
// team(s) could be identified from message emoji. Whether a matching Game
// row was actually found (game_id) is tracked separately in
// schedule_match_note and never downgrades scheduled_status.
//
// Written to a separate ScheduledGame entity rather than stamping fields
// onto Game directly, for the same reason ScorebugPost is separate from
// Game: Game rows are bulk re-imported by the Madden sync pipeline, so a
// custom field written onto one risks being silently wiped on the next
// import.
//
// Environment:
//   SCHEDULE_CHANNEL_ID   channel to watch (default: XCFL's #schedule)
//   FW_STAFF_CHANNEL_ID   channel to prompt staff to confirm a detected
//                         forced win (default below)
//
// Requires the Message Content privileged intent to be enabled for this bot
// in the Discord Developer Portal (Bot -> Privileged Gateway Intents ->
// MESSAGE CONTENT INTENT), plus GuildMessages/MessageContent/
// GuildMessageReactions added to the Client's intents in index.js.

import { Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { list, getCurrentCycle, createEntity, updateEntity } from "./vault.js";
import { abbrFromName } from "./emoji.js";
import { TEAMS } from "./teamLogos.js";
import { parseScheduleMessage } from "./scheduleParser.js";
import { resolveLiveGameByNicknames } from "./adminCommands.js";

const CHANNEL_ID = process.env.SCHEDULE_CHANNEL_ID || "468580053865725994";
const FW_STAFF_CHANNEL_ID = process.env.FW_STAFF_CHANNEL_ID || "951848098588663848";

const SUCCESS_EMOJI = "✅";
const REVIEW_EMOJI = "❓";

const TEAM_ABBRS = new Set(Object.keys(TEAMS)); // e.g. "LAR", "NYG", ...
const EMOJI_TAG_RE = /<a?:([a-zA-Z0-9_]+):(\d+)>/g;

// Pulls custom-emoji shortcodes out of the message and keeps only the ones
// that match a known team abbreviation (server emoji are named "lar", "gb",
// etc. — same convention emoji.js's TEAM_FALLBACK keys already assume).
// Returns {abbr, index} pairs (not just abbrs) so a forfeit post can be
// split around the "FW" marker: "Week 4 <NO> vs <ATL> FW <ATL>" names the
// WINNER as whichever team's emoji appears after "FW", which is not
// necessarily the first team emoji in the message.
function extractTeamEmoji(content) {
  const found = [];
  EMOJI_TAG_RE.lastIndex = 0;
  let m;
  while ((m = EMOJI_TAG_RE.exec(content))) {
    const abbr = m[1].toUpperCase();
    if (TEAM_ABBRS.has(abbr)) found.push({ abbr, index: m.index });
  }
  return found;
}

function isPlayedGame(g) {
  return g.status === 2 || g.status === 3; // 2=regular, 3=playoff (per export)
}

function buildGameKey(season, week, teamAName, teamBName) {
  const teams = [teamAName, teamBName].filter(Boolean).sort();
  return `${season ?? "?"}-${week ?? "?"}-${teams[0] ?? "?"}-${teams[1] ?? "?"}`;
}

// Finds the Game row this post is about. abbrB is optional: a forfeit post
// may only show the winning team's emoji, in which case we match on abbrA +
// week alone and can pick up the opponent from whichever Game row we land
// on.
async function matchGame({ abbrA, abbrB, weekNumber }) {
  const cycle = await getCurrentCycle();
  const games = await list("Game");
  const inCycle = games.filter((g) => g.cycle === cycle);
  if (!inCycle.length) {
    return { cycle, season: null, gameRow: null, weekNumber, note: "No Game data loaded for this cycle yet." };
  }

  const season = Math.max(...inCycle.map((g) => g.season_number ?? 0), 0);

  const candidates = inCycle.filter((g) => {
    if (g.season_number !== season) return false;
    const h = abbrFromName(g.homeTeam);
    const a = abbrFromName(g.awayTeam);
    if (abbrB) return (h === abbrA && a === abbrB) || (h === abbrB && a === abbrA);
    return h === abbrA || a === abbrA;
  });

  if (weekNumber != null) {
    const row = candidates.find((g) => g.week === weekNumber) || null;
    return {
      cycle,
      season,
      gameRow: row,
      weekNumber,
      note: row ? null : `Could not find a Week ${weekNumber} matchup for these team(s).`,
    };
  }

  const unplayed = candidates
    .filter((g) => !isPlayedGame(g))
    .sort((a, b) => (a.week ?? 999) - (b.week ?? 999));

  const row = unplayed[0] || null;
  return {
    cycle,
    season,
    gameRow: row,
    weekNumber: row ? row.week : null,
    note: row ? null : "Could not find an unplayed matchup for these team(s) this season — try including \"Week #\".",
  };
}

/**
 * When a forfeit is detected, cross-reference it against live EA data and
 * prompt staff in FW_STAFF_CHANNEL_ID to confirm it with one click — using
 * the same force-win logic /admin force-home-win / force-away-win runs,
 * via adminCommands.js's shared applyForceWin() (invoked through the
 * fw:home/fw:away button handler, not called directly from here).
 *
 * teamBName may be unknown (a forfeit post can show only the winner's
 * emoji, and the Vault Game match can also fail to fill it in) — in that
 * case this still posts a notice, just without actionable buttons, since
 * resolveLiveGameByNicknames needs both team names to find one game.
 */
async function notifyStaffOfForfeit(client, { teamAName, teamBName, weekNumber, messageUrl }) {
  if (!FW_STAFF_CHANNEL_ID) return;
  const channel = await client.channels.fetch(FW_STAFF_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error(`[SCHEDULE] FW staff channel ${FW_STAFF_CHANNEL_ID} not found`);
    return;
  }

  const weekLabel = weekNumber != null ? `week ${weekNumber}` : "this week";
  const matchupLabel = teamBName ? `${teamAName} over ${teamBName}` : `${teamAName} (forfeit)`;
  const sourceLine = messageUrl ? `\nSource: ${messageUrl}` : "";

  if (!teamBName) {
    await channel.send({
      content: `⚠️ Detected a forced win in #schedule — **${teamAName}** forfeit win, ${weekLabel}, but couldn't identify the opponent from the post. Check manually with \`/admin force-home-win\` or \`/admin force-away-win\`.${sourceLine}`,
    });
    return;
  }

  const resolved = await resolveLiveGameByNicknames(teamAName, teamBName);
  if (!resolved.ok) {
    await channel.send({
      content: `⚠️ Detected a forced win in #schedule (**${matchupLabel}**, ${weekLabel}) but couldn't confidently match it to a live EA game (\`${resolved.reason}\`) — check manually with \`/admin force-home-win\` or \`/admin force-away-win\`.${sourceLine}`,
    });
    return;
  }

  const { game } = resolved;
  const [awayNick, homeNick] = (game.seasonGameInfo.matchup || "").split(" @ ").map((s) => s.trim());
  const winnerIsHome = homeNick && teamAName.toLowerCase().includes(homeNick.toLowerCase());

  const content = [
    `🏈 **Forced win detected** — ${matchupLabel} (${game.seasonGameInfo.displayedWeek || weekLabel})`,
    `Winner: **${teamAName}**${homeNick ? (winnerIsHome ? " (home)" : " (away)") : ""}`,
    "Confirm below, or run `/admin force-home-win` / `/admin force-away-win` manually.",
  ].join("\n") + sourceLine;

  await channel.send({
    content,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`fw:home:${game.seasonGameKey}`)
          .setLabel(`Confirm Home Win${homeNick ? ` (${homeNick})` : ""}`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`fw:away:${game.seasonGameKey}`)
          .setLabel(`Confirm Away Win${awayNick ? ` (${awayNick})` : ""}`)
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`fw:dismiss:${game.seasonGameKey}`)
          .setLabel("Dismiss")
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
  });
}

async function findExistingRow(messageId) {
  const rows = await list("ScheduledGame", {}, { limit: 5000 });
  return rows.find((r) => r.discord_message_id === messageId) || null;
}

async function applyReaction(message, emoji) {
  try {
    for (const other of [SUCCESS_EMOJI, REVIEW_EMOJI]) {
      if (other === emoji) continue;
      const existing = message.reactions.cache.get(other);
      if (existing) await existing.users.remove(message.client.user.id).catch(() => {});
    }
    await message.react(emoji);
  } catch (err) {
    console.error(`[SCHEDULE] could not react to ${message.id}: ${err.message}`);
  }
}

async function handleScheduleMessage(message) {
  if (message.channelId !== CHANNEL_ID) return;
  if (message.author?.bot) return;
  const content = message.content || "";
  if (!content.trim()) return; // e.g. attachment-only post, nothing to parse

  // createdAt is the original post time even on a re-parsed edit (editing a
  // message doesn't change when it was originally sent) — that's the right
  // anchor for "today" here, not whenever the edit/re-parse happens to run.
  const parsed = parseScheduleMessage(content, message.createdAt);
  const emoji = extractTeamEmoji(content);
  const abbrs = emoji.map((e) => e.abbr);

  // scheduled_status reflects TEXT-parse confidence only, decided here.
  // Team-count requirements differ by shape: a real matchup needs both
  // teams named; a forfeit post typically shows only the winner's logo.
  let status = parsed.status;
  let timeText = parsed.timeText;
  let abbrA = null, abbrB = null;

  if (status === "forfeit") {
    // "FW <emoji>" names the WINNER specifically — it is not always the
    // first team emoji in the message (e.g. "Week 4 <NO> vs <ATL> FW
    // <ATL>" — ATL is the winner despite NO appearing first). Whichever
    // team emoji appears at/after the FW marker is the winner; the emoji
    // before it (the "X vs Y" pairing) give the full matchup.
    const before = parsed.fwIndex != null ? emoji.filter((e) => e.index < parsed.fwIndex).map((e) => e.abbr) : [];
    const after = parsed.fwIndex != null ? emoji.filter((e) => e.index >= parsed.fwIndex).map((e) => e.abbr) : abbrs;
    const matchup = [...new Set(before.length ? before : abbrs)];

    const winner = after[0] || null;
    if (winner) {
      abbrA = winner;
      abbrB = matchup.find((a) => a !== winner) || null;
    } else if (matchup.length >= 1) {
      // No emoji at all after the FW marker (just the bare word) — fall
      // back to the old assumption that the first named team is the winner.
      abbrA = matchup[0];
      abbrB = matchup[1] || null;
    } else {
      status = "needs_review";
      timeText = [timeText, "Could not identify the forfeit-winning team from message emoji."]
        .filter(Boolean).join(" — ");
    }
  } else if (status === "scheduled") {
    if (abbrs.length === 2) {
      abbrA = abbrs[0];
      abbrB = abbrs[1];
    } else {
      status = "needs_review";
      timeText = [timeText, "Could not identify exactly two teams from message emoji."]
        .filter(Boolean).join(" — ");
    }
  } else {
    // Already needs_review from ambiguous text — grab whatever teams we
    // can for context, but don't gate on a specific count.
    if (abbrs.length >= 1) abbrA = abbrs[0];
    if (abbrs.length >= 2) abbrB = abbrs[1];
  }

  let teamAName = abbrA ? TEAMS[abbrA]?.name ?? null : null;
  let teamBName = abbrB ? TEAMS[abbrB]?.name ?? null : null;

  // Game cross-reference — purely informational, never touches `status`.
  let cycle = null, season = null, gameRow = null, weekNumber = parsed.weekNumber;
  let scheduleMatchNote = null;

  if (abbrA) {
    try {
      const result = await matchGame({ abbrA, abbrB, weekNumber });
      cycle = result.cycle;
      season = result.season;
      gameRow = result.gameRow;
      weekNumber = result.weekNumber;
      scheduleMatchNote = result.note;

      // Forfeit post only had the winner's emoji — a matched Game row
      // tells us the opponent for free.
      if (gameRow && !teamBName) {
        const homeAbbr = abbrFromName(gameRow.homeTeam);
        const awayAbbr = abbrFromName(gameRow.awayTeam);
        const otherAbbr = homeAbbr === abbrA ? awayAbbr : homeAbbr;
        teamBName = TEAMS[otherAbbr]?.name ?? (homeAbbr === abbrA ? gameRow.awayTeam : gameRow.homeTeam);
      }
    } catch (err) {
      console.error(`[SCHEDULE] Game lookup failed: ${err.message}`);
      scheduleMatchNote = "Vault lookup failed — try again or check manually.";
    }
  }

  const forfeitWinner = status === "forfeit" ? teamAName : null;

  const gameKey = gameRow
    ? buildGameKey(season, weekNumber, teamAName, teamBName)
    : `unmatched-${message.id}`;

  // Looked up early (not just at save time) so the forfeit-staff-prompt
  // below can check whether this message already triggered one — a
  // MessageUpdate re-trigger on the same post must not re-notify staff.
  const existing = await findExistingRow(message.id);

  let staffNotified = existing?.fw_staff_notified === true;
  if (status === "forfeit" && teamAName && !staffNotified) {
    try {
      await notifyStaffOfForfeit(message.client, {
        teamAName,
        teamBName,
        weekNumber,
        messageUrl: message.url,
      });
      staffNotified = true;
    } catch (err) {
      console.error(`[SCHEDULE] FW staff notify failed for message ${message.id}: ${err.message}`);
      // Leave staffNotified false — an edit re-trigger will retry.
    }
  }

  const payload = {
    game_key: gameKey,
    cycle,
    season_number: season,
    week: weekNumber ?? null,
    team_a: teamAName,
    team_b: teamBName,
    game_id: gameRow?.id ?? null,
    schedule_match_note: scheduleMatchNote,
    scheduled_status: status,
    scheduled_time_text: timeText,
    scheduled_day: parsed.day,
    scheduled_hour_24: parsed.hour24,
    scheduled_minute: parsed.minute,
    scheduled_timezone: parsed.timezone,
    forfeit_winner_team: forfeitWinner,
    fw_staff_notified: staffNotified,
    raw_message: content,
    discord_channel_id: message.channelId,
    discord_message_id: message.id,
    discord_user_id: message.author?.id ?? null,
    discord_username: message.member?.displayName || message.author?.username || null,
    reaction_applied: status === "needs_review" ? "review" : "success",
    parsed_at: new Date().toISOString(),
  };

  try {
    if (existing) {
      await updateEntity("ScheduledGame", existing.id, payload);
    } else {
      await createEntity("ScheduledGame", payload);
    }
  } catch (err) {
    console.error(`[SCHEDULE] save failed for message ${message.id}: ${err.message}`);
    // Still react so the poster gets feedback even if the Vault write failed.
  }

  await applyReaction(message, status === "needs_review" ? REVIEW_EMOJI : SUCCESS_EMOJI);
}

export function startScheduleWatcher(client) {
  console.log(`[SCHEDULE] watcher starting — channel ${CHANNEL_ID}`);

  client.on(Events.MessageCreate, (message) => {
    handleScheduleMessage(message).catch((err) =>
      console.error(`[SCHEDULE] handler error: ${err.message}`)
    );
  });

  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    handleScheduleMessage(newMessage).catch((err) =>
      console.error(`[SCHEDULE] edit handler error: ${err.message}`)
    );
  });
}
