// scheduleWatcher.js — watches the #schedule channel, parses each post with
// scheduleParser.js, matches it to a Schedule row (the pre-game matchup —
// NOT the Game entity, which only holds already-played results), and saves
// the result to the ScheduledGame entity. Reacts ✅ on a confident parse or
// ❓ when a human should double check.
//
// Written to a separate ScheduledGame entity rather than stamping fields
// onto Schedule/Game directly, for the same reason ScorebugPost is separate
// from Game: Schedule/Game rows are bulk re-imported by the Madden sync
// pipeline, so a custom field written onto one risks being silently wiped
// on the next import.
//
// Environment:
//   SCHEDULE_CHANNEL_ID   channel to watch (default: XCFL's #schedule)
//
// Requires the Message Content privileged intent to be enabled for this bot
// in the Discord Developer Portal (Bot -> Privileged Gateway Intents ->
// MESSAGE CONTENT INTENT), plus GuildMessages/MessageContent/
// GuildMessageReactions added to the Client's intents in index.js — see
// the integration notes delivered alongside this file.

import { Events } from "discord.js";
import { list, getCurrentCycle, createEntity, updateEntity } from "./vault.js";
import { abbrFromName } from "./emoji.js";
import { TEAMS } from "./teamLogos.js";
import { parseScheduleMessage } from "./scheduleParser.js";

const CHANNEL_ID = process.env.SCHEDULE_CHANNEL_ID || "468580053865725994";

const SUCCESS_EMOJI = "✅";
const REVIEW_EMOJI = "❓";

const TEAM_ABBRS = new Set(Object.keys(TEAMS)); // e.g. "LAR", "NYG", ...
const EMOJI_TAG_RE = /<a?:([a-zA-Z0-9_]+):(\d+)>/g;

// Pulls custom-emoji shortcodes out of the message and keeps only the ones
// that match a known team abbreviation (server emoji are named "lar", "gb",
// etc. — same convention emoji.js's TEAM_FALLBACK keys already assume).
function extractTeamAbbrs(content, fromIndex = 0) {
  const found = [];
  EMOJI_TAG_RE.lastIndex = 0;
  let m;
  while ((m = EMOJI_TAG_RE.exec(content))) {
    if (m.index < fromIndex) continue;
    const abbr = m[1].toUpperCase();
    if (TEAM_ABBRS.has(abbr)) found.push(abbr);
  }
  return found;
}

function scheduleWeekNumber(s) {
  if (s.week != null) return s.week;
  if (s.week_index != null) return s.week_index + 1;
  return null;
}

function buildGameKey(scheduleRow, season, week) {
  const teams = [scheduleRow?.home_team, scheduleRow?.away_team].filter(Boolean).sort();
  return `${season ?? "?"}-${week ?? "?"}-${teams[0] ?? "?"}-${teams[1] ?? "?"}`;
}

// Find the Schedule row this post is about. Schedule holds the pre-game
// matchup (home_team/away_team/week_index/status) — Game only exists once a
// result has been imported, so upcoming games live in Schedule, not Game.
async function matchSchedule({ abbrA, abbrB, weekNumber }) {
  const cycle = await getCurrentCycle();
  const rows = await list("Schedule", { cycle }, { limit: 5000 });
  const inCycle = rows.filter((s) => !s.cycle || s.cycle === cycle);
  if (!inCycle.length) return { cycle, season: null, scheduleRow: null, weekNumber, note: "No schedule data loaded for this cycle yet." };

  const season = Math.max(...inCycle.map((s) => s.season_index ?? 0), 0);

  const candidates = inCycle.filter((s) => {
    if (s.season_index !== season) return false;
    const h = abbrFromName(s.home_team);
    const a = abbrFromName(s.away_team);
    return (h === abbrA && a === abbrB) || (h === abbrB && a === abbrA);
  });

  if (weekNumber != null) {
    const row = candidates.find((s) => scheduleWeekNumber(s) === weekNumber) || null;
    return {
      cycle,
      season,
      scheduleRow: row,
      weekNumber,
      note: row ? null : `Could not find a Week ${weekNumber} matchup between these teams.`,
    };
  }

  // No explicit week — take the earliest not-yet-completed matchup between
  // these two teams this season (status 2 = completed per the Schedule
  // schema; also guard on scores being unset in case status wasn't synced).
  const unplayed = candidates
    .filter((s) => s.status !== 2 && s.home_score == null && s.away_score == null)
    .sort((a, b) => (scheduleWeekNumber(a) ?? 999) - (scheduleWeekNumber(b) ?? 999));

  const row = unplayed[0] || null;
  return {
    cycle,
    season,
    scheduleRow: row,
    weekNumber: row ? scheduleWeekNumber(row) : null,
    note: row ? null : "Could not find an unplayed matchup between these teams this season — try including \"Week #\".",
  };
}

async function findExistingRow(messageId) {
  // ScheduledGame is small (one row per matchup per week); a broad read and
  // in-memory match mirrors the pattern vault.js's list() helpers use
  // elsewhere in this codebase, since server-side filters aren't reliable.
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

  const parsed = parseScheduleMessage(content);
  const abbrs = extractTeamAbbrs(content);

  let status = parsed.status;
  const notes = [];

  if (abbrs.length !== 2) {
    status = "needs_review";
    notes.push("Could not identify exactly two teams from the message's team emoji.");
  }

  let cycle = null, season = null, scheduleRow = null, weekNumber = parsed.weekNumber;

  if (abbrs.length === 2) {
    try {
      const result = await matchSchedule({ abbrA: abbrs[0], abbrB: abbrs[1], weekNumber });
      cycle = result.cycle;
      season = result.season;
      scheduleRow = result.scheduleRow;
      weekNumber = result.weekNumber;
      if (result.note) {
        status = "needs_review";
        notes.push(result.note);
      }
    } catch (err) {
      console.error(`[SCHEDULE] Schedule lookup failed: ${err.message}`);
      status = "needs_review";
      notes.push("Vault lookup failed — try again or check manually.");
    }
  }

  // If FW was mentioned, look for a team emoji right after it as the
  // forfeit winner (e.g. "FW 🏈raiders" -> Raiders won by forfeit).
  let forfeitWinner = null;
  if (parsed.status === "forfeit" && typeof parsed.fwIndex === "number") {
    const hits = extractTeamAbbrs(content, parsed.fwIndex);
    if (hits.length) forfeitWinner = TEAMS[hits[0]]?.name ?? null;
  }

  const gameKey = scheduleRow
    ? buildGameKey(scheduleRow, season, weekNumber)
    : `unmatched-${message.id}`;

  const timeText = [parsed.timeText, notes.join(" ")].filter(Boolean).join(" — ") || null;

  const payload = {
    game_key: gameKey,
    cycle,
    season_number: season,
    week: weekNumber ?? null,
    team_a: abbrs[0] ? TEAMS[abbrs[0]]?.name ?? null : null,
    team_b: abbrs[1] ? TEAMS[abbrs[1]]?.name ?? null : null,
    game_id: scheduleRow?.id ?? null,
    scheduled_status: status,
    scheduled_time_text: timeText,
    scheduled_day: parsed.day,
    scheduled_hour_24: parsed.hour24,
    scheduled_minute: parsed.minute,
    scheduled_timezone: parsed.timezone,
    forfeit_winner_team: forfeitWinner,
    raw_message: content,
    discord_channel_id: message.channelId,
    discord_message_id: message.id,
    discord_user_id: message.author?.id ?? null,
    discord_username: message.member?.displayName || message.author?.username || null,
    reaction_applied: status === "needs_review" ? "review" : "success",
    parsed_at: new Date().toISOString(),
  };

  try {
    const existing = await findExistingRow(message.id);
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
