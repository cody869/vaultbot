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
import { list, getStandings, getCurrentCycle, createEntity, updateEntity } from "./vault.js";
import { renderScorebugCard } from "./scorebugCard.js";
import { abbrFromName } from "./emoji.js";
import { isGameFinal, getGameContributors } from "./scorebugHelper.js";

const VAULT_URL = process.env.VAULT_PUBLIC_URL || "https://xcfl-companion.com";

const CHANNEL_ID = process.env.SCOREBUG_CHANNEL_ID || "478919775163252736";
const POLL_MS = Number(process.env.SCOREBUG_POLL_SECONDS || 60) * 1000;
const SEED_HOURS = Number(process.env.SCOREBUG_SEED_HOURS || 24);
const DELAY_MS = Number(process.env.SCOREBUG_DELAY_MINUTES || 5) * 60 * 1000;

// Games handled this process, so a slow render/post can't be picked up
// twice by the next tick (same fast in-process guard news.js uses). This
// is only a same-tick guard now — ScorebugPost is the real dedup record.
const handled = new Set();

// Stable key that survives Base44 re-imports regenerating row ids --
// season+week+matchup is what actually identifies "this game" to a human.
function gameKey(g) {
  return `${g.season_number ?? "?"}-${g.week ?? "?"}-${g.awayTeam ?? "?"}-${g.homeTeam ?? "?"}`;
}

// Pull every ScorebugPost row for this key's-eye view of state, keyed by
// game_key -> full row (not just a Set) so the delay logic below can read
// each row's status/first_seen_at. Backed by Base44, one broad read per tick.
async function loadState() {
  try {
    const rows = await list("ScorebugPost", {}, { limit: 5000 });
    const byKey = new Map();
    for (const r of rows) {
      if (r.game_key) byKey.set(r.game_key, r);
    }
    return byKey;
  } catch (err) {
    console.error(`[SCOREBUG] could not read ScorebugPost: ${err.message}`);
    // Fail closed on the side of NOT reposting: if we can't confirm what's
    // already posted, skip this tick entirely rather than risk a flood.
    return null;
  }
}

// Claim a key by creating its ScorebugPost row BEFORE sending to Discord (or,
// for a fresh final, before starting the sync-delay wait). If two ticks
// somehow race on the same key, the loser just gets a create that succeeds
// harmlessly (no uniqueness constraint at the DB level) -- the in-process
// `handled` Set is what actually prevents that within one process, and a
// second process racing this is not a scenario this league's single-instance
// Railway deploy hits in practice.
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
    games = await list("Game");
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

    const existing = state.get(key);

    // First boot on a Vault that already has final games: mark the backlog
    // as already-posted (status: 'posted', no delay) rather than dumping a
    // season's worth of cards at once or making them all wait out the sync
    // delay. NOTE: this cutoff is now a genuine first-boot-only backlog
    // guard -- it no longer has to also compensate for lost dedup state,
    // since ScorebugPost persists across restarts and reimports. A reimport
    // that bumps updated_date on old games can no longer cause a repost:
    // those keys are already sitting in ScorebugPost from when they first
    // posted (or were backlog-claimed).
    if (seed && importedTime(g) < cutoff) {
      if (existing) continue; // already recorded from a prior boot
      handled.add(key); // avoid re-claiming every tick until the create lands
      try {
        await claim(key, g, { status: "posted", posted_at: new Date().toISOString() });
      } catch (err) {
        console.error(`[SCOREBUG] backlog claim failed for ${key}: ${err.message}`);
      }
      continue;
    }

    // No row yet: this is a newly-final game. Start the sync-delay wait
    // instead of posting immediately -- WeeklyStats (the contributor/leader
    // data) lags behind the score itself, so posting right away can render
    // an incomplete stat strip. A row with no `status` at all is a legacy
    // row from before this delay existed; treat anything that isn't
    // literally "pending" as already handled so old posted games can never
    // be mistaken for freshly-final and re-posted.
    if (!existing) {
      handled.add(key);
      try {
        await claim(key, g, { status: "pending", first_seen_at: new Date().toISOString() });
        console.log(`[SCOREBUG] ${key} went final — waiting ${DELAY_MS / 60000}m for stats to sync`);
      } catch (err) {
        console.error(`[SCOREBUG] pending claim failed for ${key}: ${err.message}`);
      }
      continue;
    }

    if (existing.status !== "pending") continue; // already posted (or a legacy/undated row) — nothing to do

    const firstSeenAt = existing.first_seen_at ? new Date(existing.first_seen_at).getTime() : 0;
    if (Date.now() - firstSeenAt < DELAY_MS) continue; // still waiting for stats to sync

    handled.add(key); // fast in-process guard against a double-fire mid-render
    try {
      const rows = await rowsFor(g.season_number);
      const message = await postCard(client, g, rows);
      await updateEntity("ScorebugPost", existing.id, {
        status: "posted",
        posted_at: new Date().toISOString(),
        discord_message_id: message?.id,
      });
    } catch (err) {
      console.error(`[SCOREBUG] post failed for ${key}: ${err.message}`);
      // `handled` keeps this key from being retried again within this same
      // process (matches the pre-existing tradeoff: an occasional miss beats
      // flood-reposting on a render error that recurs every tick). Unlike
      // before, though, the row is still sitting at status 'pending' rather
      // than already marked 'posted' -- a restart (which clears `handled`)
      // will pick it back up and retry automatically, no manual row deletion
      // needed.
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
