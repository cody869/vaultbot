// liveScoreWatcher.js — live in-game scores for the game broadcast, read off
// each live game's Twitch stream (Madden scorebug) once a minute.
//
// ONLY runs while the league broadcast is on air: the game broadcast host
// panel (Vault /broadcast/game/host) sets BroadcastScene(show='game')
// .live_scores and refreshes .live_scores_heartbeat every ~2 minutes while it
// is open. If the switch is off or the heartbeat is older than
// HEARTBEAT_MAX_MS, a tick is one cached Base44 read and nothing else: no
// Twitch requests, no Anthropic calls. Closing the host panel stops reading
// within a few minutes.
//
// While on, each tick:
//   1. this week's games (earliest week with an unplayed game, as Week Central)
//   2. their GameStream rows that went live in the last hour (streamWatcher)
//   3. per unfinished game, newest stream first: grab a frame (twitchFrame.js),
//      read the scorebug (scorebugReader.js), judge it (liveScoreLogic.js)
//   4. write the LiveScore row for that game (create once, then update)
// The broadcast overlay shows the score for a LIVE game whose LiveScore row
// was checked in the last few minutes.
//
// Environment:
//   ANTHROPIC_API_KEY         required for reading; without it this watcher stays off
//   LIVE_SCORE_MODEL          optional, default claude-opus-5-5 (see scorebugReader.js)
//   LIVE_SCORE_POLL_SECONDS   optional, default 60
//   LIVE_SCORE_DISABLED       set to "true" to turn the watcher off entirely

import { list, createEntity, updateEntity, pollCached } from "./vault.js";
import { isRateLimited } from "./base44Pacer.js";
import { grabTwitchFrame, twitchLogin } from "./twitchFrame.js";
import { readScorebug } from "./scorebugReader.js";
import { judgeReading } from "./liveScoreLogic.js";

const POLL_MS = Number(process.env.LIVE_SCORE_POLL_SECONDS || 60) * 1000;
const HEARTBEAT_MAX_MS = 6 * 60 * 1000;
const LIVE_WINDOW_MS = 60 * 60 * 1000; // a game takes about an hour; same rule as Week Central / streamWatcher
const CONCURRENCY = 3;

// Per-game memory: last accepted reading and any reading held for confirmation.
const memory = new Map(); // game_id -> { prev, pending, rowId }
let running = false;
let wasOn = false;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isPlayed = (g) => Number(g.status) === 2 || Number(g.status) === 3 || num(g.user1_score) + num(g.user2_score) > 0;

async function broadcastOn() {
  const rows = await pollCached("livescore:scene", 50_000, () => list("BroadcastScene", { show: "game" }, { limit: 5 }));
  const scene = (rows || []).sort((a, b) => String(b.updated_date).localeCompare(String(a.updated_date)))[0];
  if (!scene?.live_scores || !scene.live_scores_heartbeat) return false;
  return Date.now() - Date.parse(scene.live_scores_heartbeat) < HEARTBEAT_MAX_MS;
}

async function currentSeason() {
  const rows = await pollCached("livescore:season", 10 * 60_000, () => list("AppConfig", { key: "current_season_number" }));
  const n = Number(rows?.[0]?.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Run fn over items, at most `limit` at a time. */
async function pool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

async function save(game, season, week, patch) {
  const m = memory.get(game.id) || {};
  const data = {
    game_id: game.id, season_number: season, week,
    away_team: game.awayTeam, home_team: game.homeTeam,
    checked_at: new Date().toISOString(),
    ...patch,
  };
  if (m.rowId) {
    await updateEntity("LiveScore", m.rowId, data);
  } else {
    const row = await createEntity("LiveScore", data);
    if (row?.id) memory.set(game.id, { ...m, rowId: row.id });
  }
}

async function readGame(game, logins, season, week) {
  const m = memory.get(game.id) || {};
  for (const login of logins) {
    let frame;
    try {
      frame = await grabTwitchFrame(login);
    } catch (err) {
      console.error(`[LIVESCORE] frame ${login}: ${err.message}`);
      continue;
    }
    // Ad break on this stream: keep the last good score, try again next tick.
    if (frame.ad) return;
    if (frame.offline) continue;

    let reading;
    try {
      reading = await readScorebug(frame.jpeg);
    } catch (err) {
      console.error(`[LIVESCORE] read ${login}: ${err.message}`);
      return;
    }
    const verdict = judgeReading(m.prev || null, m.pending || null, reading || { scorebug_visible: false });
    memory.set(game.id, { ...memory.get(game.id), pending: verdict.pending });

    if (verdict.accept) {
      const prev = { away_score: reading.away_score, home_score: reading.home_score, quarter: reading.quarter };
      memory.set(game.id, { ...memory.get(game.id), prev, pending: null });
      await save(game, season, week, {
        away_score: reading.away_score, home_score: reading.home_score,
        quarter: reading.quarter || "", clock: reading.clock || "", down_distance: reading.down_distance || "",
        possession: reading.possession === "away" || reading.possession === "home" ? reading.possession : "unknown",
        stream_login: login, read_at: new Date().toISOString(), state: "live",
      });
      console.log(`[LIVESCORE] ${game.awayTeam} ${reading.away_score} - ${reading.home_score} ${game.homeTeam} (${reading.quarter} ${reading.clock}) via ${login}`);
    } else {
      // Keep the last good score; just record that we looked.
      await save(game, season, week, { state: verdict.state, stream_login: login });
      if (verdict.pending) console.log(`[LIVESCORE] ${game.id}: ${verdict.reason}`);
    }
    return;
  }
  await save(game, season, week, { state: "offline" });
}

async function tick() {
  if (running || isRateLimited()) return;
  running = true;
  try {
    const on = await broadcastOn();
    if (!on) {
      if (wasOn) console.log("[LIVESCORE] broadcast off air: stopped reading streams");
      wasOn = false;
      return;
    }
    if (!wasOn) console.log("[LIVESCORE] broadcast on air: reading live scores");
    wasOn = true;

    const season = await currentSeason();
    if (!season) return;
    const games = await pollCached(`livescore:games:${season}`, 55_000, () => list("Game", { season_number: season }, { limit: 1000 }));
    const open = (games || []).filter((g) => !isPlayed(g) && g.week != null);
    if (!open.length) return;
    const week = Math.min(...open.map((g) => Number(g.week)));

    const [streams, existing] = await Promise.all([
      pollCached(`livescore:streams:${season}:${week}`, 55_000, () => list("GameStream", { season_number: season, week }, { limit: 300 })),
      pollCached(`livescore:rows:${season}:${week}`, 5 * 60_000, () => list("LiveScore", { season_number: season, week }, { limit: 300 })),
    ]);
    // Remember existing rows (after a restart) so we update instead of duplicating.
    for (const row of existing || []) {
      if (!memory.has(row.game_id)) {
        memory.set(row.game_id, {
          rowId: row.id,
          prev: row.state === "live" || row.away_score != null
            ? { away_score: row.away_score, home_score: row.home_score, quarter: row.quarter }
            : null,
        });
      }
    }

    const now = Date.now();
    const targets = open.filter((g) => Number(g.week) === week).map((g) => {
      const logins = (streams || [])
        .filter((s) => s.game_id === g.id && s.live_started_at && now - Date.parse(s.live_started_at) < LIVE_WINDOW_MS)
        .sort((a, b) => String(b.live_started_at).localeCompare(String(a.live_started_at)))
        .map((s) => s.twitch_login || twitchLogin(s.url))
        .filter(Boolean);
      return { game: g, logins: [...new Set(logins)] };
    }).filter((t) => t.logins.length);

    await pool(targets, CONCURRENCY, ({ game, logins }) =>
      readGame(game, logins, season, week).catch((err) => console.error(`[LIVESCORE] ${game.id}: ${err.message}`)));
  } catch (err) {
    console.error("[LIVESCORE] tick failed:", err.message);
  } finally {
    running = false;
  }
}

export function startLiveScoreWatcher() {
  if (process.env.LIVE_SCORE_DISABLED === "true") {
    console.log("[LIVESCORE] disabled (LIVE_SCORE_DISABLED=true)");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[LIVESCORE] off: set ANTHROPIC_API_KEY to read live scores during broadcasts");
    return;
  }
  console.log(`[LIVESCORE] watching for the broadcast going on air (every ${POLL_MS / 1000}s)`);
  setInterval(tick, POLL_MS);
}
