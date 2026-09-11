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
// The actual "send the Discord message" step is additionally guarded by
// fileLock.js's cross-process mutex (same fix already applied to
// suspensionWatcher.js/news.js/weeklyDigestWatcher.js in commit 269c8cc,
// missed here at the time) -- this is NOT the same "local file" approach
// rejected above: that one used /tmp as a persisted dedup RECORD, wiped by
// every ephemeral-filesystem redeploy. fileLock.js's lock file lives on
// Railway's persistent volume and is only ever held momentarily (created,
// checked, deleted within one post), not relied on to survive anything --
// losing it on a restart is fine, since ScorebugPost is still the actual
// source of truth for "was this posted."
//
// Environment:
//   SCOREBUG_CHANNEL_ID          channel to post cards to (default below)
//   SCOREBUG_POLL_SECONDS        optional — default 60
//   SCOREBUG_SEED_HOURS          optional — default 24 (first-boot backlog grace window)
//   SCOREBUG_DELAY_MINUTES       optional — default 5 (wait after final before
//                                 posting, so WeeklyStats has time to sync — see
//                                 the "pending" state below)
//   SCOREBUG_STATS_MAX_WAIT_MINUTES  optional — default 30 (cap on how long to
//                                 keep waiting on incomplete passing/rushing/
//                                 receiving/defense stats before posting anyway)

import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { list, getStandings, getCurrentCycle, createEntity, pollCached } from "./vault.js";
import { isRateLimited } from "./base44Pacer.js";
import { withFileLock } from "./fileLock.js";
import { renderScorebugCard } from "./scorebugCard.js";
import { abbrFromName } from "./emoji.js";
import { isGameFinal, getGameContributors, getGameStatsCompleteness } from "./scorebugHelper.js";

const VAULT_URL = process.env.VAULT_PUBLIC_URL || "https://xcfl-companion.com";

const CHANNEL_ID = process.env.SCOREBUG_CHANNEL_ID || "478919775163252736";
const POLL_MS = Number(process.env.SCOREBUG_POLL_SECONDS || 60) * 1000;
const SEED_HOURS = Number(process.env.SCOREBUG_SEED_HOURS || 24);
const DELAY_MS = Number(process.env.SCOREBUG_DELAY_MINUTES || 5) * 60 * 1000;
const STATS_MAX_WAIT_MS = Number(process.env.SCOREBUG_STATS_MAX_WAIT_MINUTES || 30) * 60 * 1000;

// NOTE: `handled` is created fresh INSIDE tick() (below), not here at
// module scope. It used to live here, back when a game was claimed and
// posted in one shot within a single tick — "added once this process" and
// "posted forever" were the same thing, so a module-level Set was safe.
// That stopped being true once a game could sit in `pending` for minutes
// across many ticks: a module-level Set meant the very first tick to see a
// new final added it here and NOTHING ever removed it except a failed post
// attempt — so a game that was simply still waiting out its sync delay got
// silently skipped by every tick from then on, forever, with no error to
// log. Confirmed live: two separate games each sat stuck for 30-60+
// minutes with zero log output, and only posted once a restart wiped this
// Set clean. A per-tick Set fixes that — it only needs to guard against
// processing the same key twice within ONE tick's loop (finals shouldn't
// contain duplicates, but this is cheap insurance), not across ticks.
//
// There used to be a withTimeout() here that raced postCard() against a
// 30s local timer and declared failure if the timer won. Confirmed live
// (Sept 11 logs) that this itself caused duplicate posts, not prevented
// them: Promise.race doesn't cancel the losing side, so when postCard()'s
// Vault/Discord calls were just slow (queued behind an EA export sharing
// the same app-wide Base44 pacer, not actually stuck), the "timed out"
// branch logged a failure and skipped claim() while the real send kept
// running in the background -- and later succeeded, posting for real, with
// no claim() ever recorded for it. The next tick, seeing no posted row,
// tried again. One game (JAX @ IND) posted three separate times in a
// single container run this way, no second container involved. The
// per-key withFileLock() around this step (added for the cross-process
// race, see below) is what actually needs to own "give up and let another
// attempt through" now: a genuinely stuck call just holds the lock, and
// fileLock.js's own 2-minute staleness detection is the real backstop --
// exactly the model eaTokenStore.js's original lock already used this for.

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
    const rows = await pollCached('scorebug:posts', 55_000, () => list("ScorebugPost", {}, { limit: 5000 }));
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

// Re-reads ScorebugPost for exactly this key, uncached -- used right before
// the "post the card" decision, inside withFileLock below, so the answer
// reflects whatever the winning container (if any) just wrote, not the up-
// to-55s-stale snapshot loadState() loaded at the top of this tick.
async function freshEntry(key) {
  const rows = await list("ScorebugPost", { game_key: key }, { limit: 50 });
  const entry = { pending: null, posted: null };
  for (const r of rows) {
    if (r.discord_message_id) entry.posted = r;
    else if (!entry.pending || new Date(r.created_date || 0) < new Date(entry.pending.created_date || 0)) {
      entry.pending = r;
    }
  }
  return entry;
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
// A duplicate "pending" row from two containers racing the initial claim is
// harmless (loadState() just picks the earliest one as the sync-delay
// clock, and both containers converge on the same clock). The "post the
// card" claim is the one that actually sends a Discord message, and IS
// guarded against a real cross-process race -- see the withFileLock use at
// its call site in tick() below. Confirmed live: this watcher was the one
// left out when suspensionWatcher.js/news.js/weeklyDigestWatcher.js got
// that same fix (commit 269c8cc), on the assumption this league only ever
// runs one container -- scorebugs then started posting multiple times,
// consistent with that assumption no longer holding.
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
  // An app-wide Base44 pause is in effect (see base44Pacer.js) -- sit this
  // tick out rather than piling onto it. The next tick checks again.
  if (isRateLimited()) return;

  // Fresh every tick — see the comment above where this used to live at
  // module scope for why that was the actual bug behind games getting
  // stuck forever.
  const handled = new Set();

  let games;
  try {
    // Cached -- this watcher's own 60s poll re-reading the whole Game
    // collection every tick with no caching was part of what tripped
    // Base44's read-rate limit. scheduleWatcher.js's own list("Game") is
    // event-driven (fires on a Discord message, not a poll) and untouched.
    games = await pollCached('scorebug:games', 55_000, () => list("Game"));
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
    const waitedMs = Date.now() - pendingSince;
    if (waitedMs < DELAY_MS) continue; // still waiting for stats to sync

    // The base delay is a floor, not a guarantee -- confirmed live: cards
    // posted before passing/rushing/receiving/defense had all landed,
    // showing an incomplete stat strip. Re-check every tick past DELAY_MS
    // and keep waiting rather than post early, up to STATS_MAX_WAIT_MS so a
    // game whose stats genuinely never fully sync doesn't wait forever.
    if (waitedMs < STATS_MAX_WAIT_MS) {
      let completeness;
      try {
        completeness = await getGameStatsCompleteness(g.scheduleId, g.cycle);
      } catch (err) {
        console.error(`[SCOREBUG] stats completeness check failed for ${key}: ${err.message}`);
        continue; // treat an unconfirmed check the same as "not ready yet"
      }
      if (!completeness.complete) {
        console.log(`[SCOREBUG] ${key} stats incomplete (missing ${completeness.missing.join(", ")}) — waiting`);
        continue;
      }
    } else {
      console.warn(`[SCOREBUG] ${key} still missing some stats after ${STATS_MAX_WAIT_MS / 60000}m — posting anyway`);
    }

    handled.add(key); // fast in-process guard against a double-fire mid-render
    try {
      // Cross-process guard around the ONE step that actually sends a
      // Discord message -- same primitive (atomic file creation) already
      // used by eaTokenStore.js/suspensionWatcher.js/news.js/
      // weeklyDigestWatcher.js for this exact class of bug. Per-key so an
      // unrelated game finishing in the same tick doesn't wait on this one.
      await withFileLock(`scorebug-claim:${key}`, async () => {
        // Another container may have posted this already -- either it won
        // the race for this same tick, or loadState()'s cached snapshot
        // (up to 55s old) simply predates its post. Re-check with a fresh,
        // uncached read before sending anything.
        const fresh = await freshEntry(key);
        if (fresh.posted) {
          console.log(`[SCOREBUG] ${key} already posted by another container, skipping`);
          return;
        }

        // No local timeout here on purpose -- see the file-header comment
        // near the top for why racing postCard() against a timer caused
        // duplicate posts rather than preventing them. A call that's
        // genuinely stuck just holds this lock; fileLock.js's own 2-minute
        // staleness detection is what lets a later attempt through.
        const message = await postCard(client, g, await rowsFor(g.season_number));
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
      });
    } catch (err) {
      console.error(`[SCOREBUG] post failed for ${key}: ${err.message}`);
      // No "posted" row was created, and `handled` is fresh every tick, so
      // the very next 60s poll retries automatically -- no manual restart
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
