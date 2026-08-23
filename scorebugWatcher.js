// scorebugWatcher.js — posts a scorebug card to a fixed channel whenever a
// game gets a final score in the Vault.
//
// Mirrors news.js's poll/seed/dedupe pattern (poll on an interval, claim in
// an in-memory Set before posting, seed the existing backlog on first boot
// instead of dumping it into the channel).
//
// Dedup state lives in the ScorebugPost Base44 entity, not a stamped field
// on Game and not a local file. Two earlier approaches were tried and both
// had real failure modes:
//   - A field stamped onto Game itself: Game rows are bulk re-imported by
//     the Madden sync pipeline each cycle, so a custom field written onto
//     one risks being silently wiped on the next import.
//   - A local JSON file (/tmp/xcfl-scorebug-posted.json): Railway's
//     filesystem is ephemeral, so a redeploy wiped it. Combined with a
//     bulk Game re-import (which bumps updated_date on every row it
//     touches), the seed-pass backlog guard below saw those rows as
//     "recently updated" and posted them as if newly final -- reposting a
//     season's worth of already-sent cards. This is what happened Aug 21
//     2026 after a full S84 stats wipe + reimport landed on top of a
//     redeploy.
// ScorebugPost is a separate entity nothing else writes to, so it isn't
// touched by the Madden import pipeline and isn't lost on redeploy.
//
// Environment:
//   SCOREBUG_CHANNEL_ID     channel to post cards to (default below)
//   SCOREBUG_POLL_SECONDS   optional — default 60
//   SCOREBUG_SEED_HOURS     optional — default 24 (first-boot backlog grace window)
//   SCOREBUG_DELAY_MINUTES  optional — default 5 (wait after final before
//                           posting, so WeeklyStats has time to sync — see
//                           the "pending" state below)

import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { list, getStandings, getCurrentCycle, createEntity, pollCached } from "./vault.js";
import { renderScorebugCard } from "./scorebugCard.js";
import { abbrFromName } from "./emoji.js";
import { isGameFinal, getGameContributors } from "./scorebugHelper.js";

const VAULT_URL = process.env.VAULT_PUBLIC_URL || "https://xcfl-companion.com";

const CHANNEL_ID = process.env.SCOREBUG_CHANNEL_ID || "478919775163252736";
const POLL_MS = Number(process.env.SCOREBUG_POLL_SECONDS || 60) * 1000;
const SEED_HOURS = Number(process.env.SCOREBUG_SEED_HOURS || 24);
const DELAY_MS = Number(process.env.SCOREBUG_DELAY_MINUTES || 5) * 60 * 1000;
const POST_TIMEOUT_MS = Number(process.env.SCOREBUG_POST_TIMEOUT_MS || 30_000);

// Games handled this process, so a slow render/post can't be picked up
// twice by the next tick (same fast in-process guard news.js uses). This
// is only a same-tick guard now — ScorebugPost is the real dedup record.
const handled = new Set();

// Rejects instead of hanging forever if a Vault/Discord call inside
// postCard() stalls -- a bare `await` on a stuck fetch would otherwise sit
// unresolved indefinitely, with no error to catch and retry from.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

// Stable key that survives Base44 re-imports regenerating row ids --
// season+week+matchup is what actually identifies "this game" to a human.
function gameKey(g) {
  return `${g.season_number ?? "?"}-${g.week ?? "?"}-${g.awayTeam ?? "?"}-${g.homeTeam ?? "?"}`;
}

// Pull every ScorebugPost row into a per-key {pending, posted} view. Two rows
// can legitimately exist for the same game_key -- see claim()'s comment below
// for why this entity is never updated, only ever created -- so this groups
// them: `posted` is any row that already carries a discord_message_id,
// `pending` is the earliest row that doesn't (the sync-delay clock). Backed
// by Base44, one broad read per tick.
async function loadState() {
  try {
    const rows = await pollCached('scorebug:posts', 15_000, () => list("ScorebugPost", {}, { limit: 5000 }));
    const byKey = new Map();
    for (const r of rows) {
      if (!r.game_key) continue;
      const entry = byKey.get(r.game_key) || { pending: null, posted: null };
      if (r.discord_message_id) {
        entry.posted = r;
      } else if (!entry.pending || new Date(r.created_date || 0) < new Date(entry.pending.created_date || 0)) {
        entry.pending = r;
      }
      byKey.set(r.game_key, entry);
    }
    return byKey;
  } catch (err) {
    console.error(`[SCOREBUG] could not read ScorebugPost: ${err.message}`);
    // Fail closed on the side of NOT reposting: if we can't confirm what's
    // already posted, skip this tick entirely rather than risk a flood.
    return null;
  }
}

// Creates a ScorebugPost row -- for a fresh final, before starting the
// sync-delay wait (no discord_message_id yet); once actually posted, a
// SECOND row for the same key carrying discord_message_id, rather than
// updating the first one. ScorebugPost cannot be updated for this Base44
// app (confirmed live: HTTP 403 "Permission denied for update operation" —
// the same create-only behavior FantasyPick has), so "mark this row as
// posted" isn't expressible as a mutation; posting is instead recorded by
// creating a new, self-contained row. loadState() reads across every row
// for a key rather than assuming one row per key, so two rows here is by
// design, not a bug.
//
// If two ticks somehow race on the same key, the loser just gets a create
// that succeeds harmlessly (no uniqueness constraint at the DB level) --
// the in-process `handled` Set is what actually prevents that within one
// process, and a second process racing this is not a scenario this
// league's single-instance Railway deploy hits in practice.
async function claim(key, g, extra = {}) {
  return createEntity("ScorebugPost", {
    game_key: key,
    season_number: g.season_number,
    week: g.week,
    cycle: g.cycle,
    away_team: g.awayTeam,
    home_team: g.homeTeam,
    discord_channel_id: CHANNEL_ID,
    ...extra,
  });
}

function isFinal(g) {
  return isGameFinal(g.user1_score, g.user2_score);
}

function importedTime(g) {
  return new Date(g.updated_date || g.created_date || 0).getTime();
}

function recordFor(standingsRows, teamAbbr) {
  const row = standingsRows.find((r) => (r.team_abbrName || "").toUpperCase() === teamAbbr);
  if (!row) return undefined;
  const { wins = 0, losses = 0, ties = 0 } = row;
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

async function postCard(client, g, standingsRows) {
  const homeAbbr = abbrFromName(g.homeTeam);
  const awayAbbr = abbrFromName(g.awayTeam);
  if (!homeAbbr || !awayAbbr) {
    console.warn(`[SCOREBUG] could not resolve teams for "${g.awayTeam}" @ "${g.homeTeam}", skipping.`);
    return;
  }

  const homeWon = g.user1_score >= g.user2_score;
  const teamA = homeWon
    ? { abbr: homeAbbr, score: g.user1_score, record: recordFor(standingsRows, homeAbbr) }
    : { abbr: awayAbbr, score: g.user2_score, record: recordFor(standingsRows, awayAbbr) };
  const teamB = homeWon
    ? { abbr: awayAbbr, score: g.user2_score, record: recordFor(standingsRows, awayAbbr) }
    : { abbr: homeAbbr, score: g.user1_score, record: recordFor(standingsRows, homeAbbr) };

  const png = await renderScorebugCard({
    week: g.week, teamA, teamB,
    contributors: await getGameContributors(g.scheduleId, g.cycle),
  });
  const filename = `scorebug-${awayAbbr}-${homeAbbr}-wk${g.week ?? "x"}.png`;
  const file = new AttachmentBuilder(png, { name: filename });

  const gameUrl = `${VAULT_URL}/games/${g.id}`;
  const embed = new EmbedBuilder()
    .setTitle(`${g.awayTeam} @ ${g.homeTeam} — View Recap`)
    .setURL(gameUrl)
    .setColor(0xd4a843)
    .setImage(`attachment://${filename}`);

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    throw new Error("channel not found or not text-based");
  }
  const message = await channel.send({ embeds: [embed], files: [file] });
  console.log(`[SCOREBUG] posted: ${awayAbbr} ${g.user2_score} @ ${homeAbbr} ${g.user1_score} (wk ${g.week}) -> ${gameUrl}`);
  return message;
}

async function tick(client, { seed = false } = {}) {
  let games;
  try {
    // Cached -- this watcher's own 60s poll re-reading the whole Game
    // collection every tick with no caching was part of what tripped
    // Base44's read-rate limit. scheduleWatcher.js's own list("Game") is
    // event-driven (fires on a Discord message, not a poll) and untouched.
    games = await pollCached('scorebug:games', 15_000, () => list("Game"));
  } catch (err) {
    console.error(`[SCOREBUG] fetch failed: ${err.message}`);
    return;
  }

  // Only the CURRENT cycle is "from here on out" -- a historical CSV
  // backfill (old seasons, old cycle) must never reach postCard, no matter
  // how recent its updated_date looks or whether this is a seed pass.
  const currentCycle = await getCurrentCycle();
  const finals = games.filter((g) => g.cycle === currentCycle && isFinal(g));
  if (!finals.length) return;

  const state = await loadState();
  if (state === null) return; // couldn't confirm dedup state — skip this tick, don't risk a repost flood
  const cutoff = Date.now() - SEED_HOURS * 3600 * 1000;

  // Standings are the same for every game in a given season within one
  // tick -- fetch once per season seen, not once per game.
  const standingsBySeason = new Map();
  const rowsFor = async (season) => {
    if (!standingsBySeason.has(season)) {
      standingsBySeason.set(season, (await getStandings(season)).rows);
    }
    return standingsBySeason.get(season);
  };

  for (const g of finals) {
    const key = gameKey(g);
    if (handled.has(key)) continue;

    const entry = state.get(key) || { pending: null, posted: null };

    if (entry.posted) continue; // some row for this key already carries a discord_message_id — done

    // First boot on a Vault that already has final games: mark the backlog
    // as already-handled (no delay) rather than dumping a season's worth of
    // cards at once or making them all wait out the sync delay. Uses the
    // same seeded:<timestamp> sentinel suspensionWatcher.js's seedBacklog()
    // already established for "claimed without actually posting."
    if (seed && importedTime(g) < cutoff) {
      if (entry.pending) continue; // already recorded from a prior boot
      handled.add(key); // avoid re-claiming every tick until the create lands
      try {
        await claim(key, g, { discord_message_id: `seeded:${Date.now()}` });
      } catch (err) {
        console.error(`[SCOREBUG] backlog claim failed for ${key}: ${err.message}`);
      }
      continue;
    }

    // No row yet: this is a newly-final game. Start the sync-delay wait
    // instead of posting immediately -- WeeklyStats (the contributor/leader
    // data) lags behind the score itself, so posting right away can render
    // an incomplete stat strip. A bare claim() row (no discord_message_id
    // yet) is "pending," and Base44's own created_date timestamp is the
    // "pending since" clock -- both predate tonight, so there's no new
    // field here for Base44 to drop.
    if (!entry.pending) {
      handled.add(key);
      try {
        await claim(key, g);
        console.log(`[SCOREBUG] ${key} went final — waiting ${DELAY_MS / 60000}m for stats to sync`);
      } catch (err) {
        console.error(`[SCOREBUG] pending claim failed for ${key}: ${err.message}`);
      }
      continue;
    }

    const pendingSince = entry.pending.created_date ? new Date(entry.pending.created_date).getTime() : 0;
    if (Date.now() - pendingSince < DELAY_MS) continue; // still waiting for stats to sync

    handled.add(key); // fast in-process guard against a double-fire mid-render
    try {
      // A stuck fetch inside rowsFor()/postCard() (Vault or Discord) can hang
      // without ever resolving or rejecting -- confirmed live: a game sat
      // "in progress" with no posted/failed log line for 10+ minutes, then
      // posted instantly the moment the process restarted (which is what
      // cleared `handled`, not anything about the hang itself resolving).
      // A bounded timeout turns a silent indefinite hang into a real error
      // that the catch below can see and retry from, without needing a
      // manual restart.
      const message = await withTimeout(
        (async () => postCard(client, g, await rowsFor(g.season_number)))(),
        POST_TIMEOUT_MS,
        `[SCOREBUG] post for ${key}`
      );
      // Record the post as a NEW row rather than updating the pending one --
      // ScorebugPost cannot be updated for this Base44 app (confirmed live:
      // 403 Permission denied), the same create-only behavior FantasyPick
      // has. loadState() already reads across every row for a key, so a
      // second row here is expected, not a leak.
      await claim(key, g, {
        posted_at: new Date().toISOString(),
        // postCard() returns undefined (not a throw) when it can't resolve
        // both team abbreviations -- a permanent, not transient, failure.
        // Stamp a sentinel so that's treated as "handled" too, rather than
        // retrying forever on a game that can never resolve.
        discord_message_id: message?.id || `unresolved:${Date.now()}`,
      });
    } catch (err) {
      console.error(`[SCOREBUG] post failed for ${key}: ${err.message}`);
      // Unlike a hang, a caught failure (including the timeout above) can
      // safely retry within this same process: no "posted" row was created,
      // so clearing `handled` lets the very next 60s poll try again instead
      // of requiring a manual restart.
      handled.delete(key);
    }
  }
}

export function startScorebugWatcher(client) {
  if (!CHANNEL_ID) {
    console.log("[SCOREBUG] watcher disabled — no SCOREBUG_CHANNEL_ID set.");
    return;
  }
  console.log(`[SCOREBUG] watcher starting — channel ${CHANNEL_ID}, every ${POLL_MS / 1000}s`);

  tick(client, { seed: true })
    .catch((err) => console.error(`[SCOREBUG] seed pass failed: ${err.message}`))
    .finally(() => {
      setInterval(() => {
        tick(client).catch((err) => console.error(`[SCOREBUG] poll failed: ${err.message}`));
      }, POLL_MS);
    });
}
