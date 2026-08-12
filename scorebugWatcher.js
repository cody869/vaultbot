// scorebugWatcher.js — posts a scorebug card to a fixed channel whenever a
// game gets a final score in the Vault.
//
// Mirrors news.js's poll/seed/dedupe pattern (poll on an interval, claim in
// an in-memory Set before posting, seed the existing backlog on first boot
// instead of dumping it into the channel). One deliberate difference:
// dedup state lives in a local file, not a stamped field on the Game row.
// Game rows are bulk re-imported by the Madden sync pipeline each cycle, so
// a custom field written onto one risks being silently wiped on the next
// import -- unlike NewsArticle, which nothing but this bot ever writes to.
// The tradeoff: Railway's filesystem is ephemeral, so a redeploy loses the
// dedup history and the next poll re-seeds (catches up silently, doesn't
// repost) rather than resuming exactly where it left off. Same tradeoff
// scheduler.js already accepts for its own autopost signature file.
//
// Environment:
//   SCOREBUG_CHANNEL_ID    channel to post cards to (default below)
//   SCOREBUG_POLL_SECONDS  optional — default 60
//   SCOREBUG_SEED_HOURS    optional — default 24 (first-boot backlog grace window)
//   SCOREBUG_STATE_FILE    optional — default /tmp/xcfl-scorebug-posted.json

import { readFileSync, writeFileSync } from "node:fs";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { list, getStandings } from "./vault.js";
import { renderScorebugCard } from "./scorebugCard.js";
import { abbrFromName } from "./emoji.js";
import { isGameFinal, getGameContributors } from "./scorebugHelper.js";

const VAULT_URL = process.env.VAULT_PUBLIC_URL || "https://xcfl-companion.com";

const CHANNEL_ID = process.env.SCOREBUG_CHANNEL_ID || "478919775163252736";
const POLL_MS = Number(process.env.SCOREBUG_POLL_SECONDS || 60) * 1000;
const SEED_HOURS = Number(process.env.SCOREBUG_SEED_HOURS || 24);
const STATE_FILE = process.env.SCOREBUG_STATE_FILE || "/tmp/xcfl-scorebug-posted.json";

// Games handled this process, so a slow render/post can't be picked up
// twice by the next tick (same fast in-process guard news.js uses).
const handled = new Set();

// Stable key that survives Base44 re-imports regenerating row ids --
// season+week+matchup is what actually identifies "this game" to a human.
function gameKey(g) {
  return `${g.season_number ?? "?"}-${g.week ?? "?"}-${g.awayTeam ?? "?"}-${g.homeTeam ?? "?"}`;
}

function loadPosted() {
  try {
    return new Set(JSON.parse(readFileSync(STATE_FILE, "utf8")).posted || []);
  } catch {
    return new Set();
  }
}
function savePosted(posted) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ posted: [...posted] }));
  } catch (err) {
    console.error(`[SCOREBUG] could not persist state: ${err.message}`);
  }
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
  await channel.send({ embeds: [embed], files: [file] });
  console.log(`[SCOREBUG] posted: ${awayAbbr} ${g.user2_score} @ ${homeAbbr} ${g.user1_score} (wk ${g.week}) -> ${gameUrl}`);
}

async function tick(client, { seed = false } = {}) {
  let games;
  try {
    games = await list("Game");
  } catch (err) {
    console.error(`[SCOREBUG] fetch failed: ${err.message}`);
    return;
  }

  const finals = games.filter(isFinal);
  if (!finals.length) return;

  const posted = loadPosted();
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

  let dirty = false;
  for (const g of finals) {
    const key = gameKey(g);
    if (handled.has(key) || posted.has(key)) continue;

    // First boot on a Vault that already has final games: mark the backlog
    // as handled rather than dumping a season's worth of cards at once.
    if (seed && importedTime(g) < cutoff) {
      posted.add(key);
      dirty = true;
      continue;
    }

    handled.add(key); // fast in-process guard against a double-fire mid-render
    try {
      const rows = await rowsFor(g.season_number);
      await postCard(client, g, rows);
      posted.add(key);
      dirty = true;
    } catch (err) {
      console.error(`[SCOREBUG] post failed for ${key}: ${err.message}`);
      // leave it out of `posted` so a later tick retries
    } finally {
      handled.delete(key);
    }
  }

  if (dirty) savePosted(posted);
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
