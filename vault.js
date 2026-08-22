// vault.js — reads XCFL Vault data from Base44.
// If BOT_EMAIL/BOT_PASSWORD are set, the bot logs in as that user and sends a
// bearer token (needed once the app requires login). Otherwise it falls back to
// anonymous reads (works only while the app is public).
import { abbrFromName } from "./emoji.js";

const APP_ID = process.env.BASE44_APP_ID;
const SERVER = process.env.BASE44_SERVER_URL || "https://base44.app";

if (!APP_ID) {
  console.error("Missing BASE44_APP_ID in environment. See README.");
  process.exit(1);
}

// Current cycle comes from AppConfig (key/value rows), cached for a minute.
let _cycleCache = { at: 0, cycle: process.env.XCFL_CYCLE || "M26" };
const CYCLE_TTL_MS = 60_000;

export async function getCurrentCycle() {
  const now = Date.now();
  if (_cycleCache.at && now - _cycleCache.at < CYCLE_TTL_MS) {
    return _cycleCache.cycle;
  }

  try {
    const config = await list("AppConfig");
    // AppConfig stores key/value rows — find the current_cycle row.
    const row = config.find((c) => c.key === "current_cycle");
    if (row && row.value) {
      _cycleCache = { at: now, cycle: row.value };
      console.log(`[CYCLE] current_cycle = ${row.value}`);
      return row.value;
    }
    console.warn("[CYCLE] No current_cycle row found in AppConfig.");
  } catch (err) {
    console.error("[CYCLE] Could not read AppConfig:", err.message);
  }

  const fallback = process.env.XCFL_CYCLE || "M26";
  console.log(`[CYCLE] Falling back to ${fallback}`);
  return fallback;
}

// --- auth ----------------------------------------------------------------

let _token = null;

// Log in as the bot's dedicated user and cache the access token. Safe to call
// repeatedly; returns the token or null if no credentials are configured.
export async function botLogin() {
  const email = process.env.BOT_EMAIL;
  const password = process.env.BOT_PASSWORD;
  // A pre-issued token can be supplied directly instead of email/password.
  if (process.env.BASE44_TOKEN) {
    _token = process.env.BASE44_TOKEN;
    return _token;
  }
  if (!email || !password) return null;

  try {
    const res = await fetch(`${SERVER}/api/apps/${APP_ID}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Id": APP_ID },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Bot login failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      _token = null;
      return null;
    }
    const data = await res.json().catch(() => null);
    _token = data?.access_token || null;
    if (_token) console.log("🔑 Bot authenticated to the Vault.");
    else console.error("Bot login returned no access_token.");
    return _token;
  } catch (err) {
    console.error("Bot login error:", err.message);
    _token = null;
    return null;
  }
}

// Build auth headers for a request, including the bearer token if we have one.
function authHeaders() {
  const h = { "Content-Type": "application/json", "X-App-Id": APP_ID };
  if (_token) h.Authorization = `Bearer ${_token}`;
  return h;
}

// --- helpers -------------------------------------------------------------

// Read an entity via the REST endpoint. `filter` is a plain object; it's sent
// as Base44's query params. Returns an array (possibly empty). Throws only on
// an actual network/HTTP failure — an empty entity returns []. If a request is
// rejected for auth (401/403) and we have credentials, it re-logs in once and
// retries.
export async function list(entity, filter = {}, opts = {}) {
  const doFetch = async () => {
    const url = new URL(`${SERVER}/api/apps/${APP_ID}/entities/${entity}`);
    for (const [k, v] of Object.entries(filter)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    if (opts.sort) url.searchParams.set("sort", opts.sort);
    if (opts.limit) url.searchParams.set("limit", String(opts.limit));
    return fetch(url, { headers: authHeaders() });
  };

  let res;
  try {
    res = await doFetch();
    // Token expired or app now requires auth — re-login once and retry.
    if ((res.status === 401 || res.status === 403) && (process.env.BOT_EMAIL || process.env.BASE44_TOKEN)) {
      await botLogin();
      res = await doFetch();
    }
  } catch (err) {
    console.error(`Network error reading ${entity}:`, err.message);
    throw new Error(`Could not reach the Vault for ${entity}.`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`HTTP ${res.status} reading ${entity}: ${body.slice(0, 200)}`);
    throw new Error(`Could not reach the Vault for ${entity} (HTTP ${res.status}).`);
  }

  const data = await res.json().catch(() => null);
  // Endpoint may return an array directly or {entities:[...]} — handle both.
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.entities)) return data.entities;
  return [];
}

// Server-side filters aren't always honored, so every read that matters is
// verified in memory. Tries the narrow (filtered) request first and falls back
// to a broad fetch when that comes back with nothing usable.
async function listMatching(entity, filter, matchFn, opts = {}) {
  try {
    const narrow = await list(entity, filter, { limit: opts.limit ?? 500 });
    const hits = narrow.filter(matchFn);
    if (hits.length) return hits;
  } catch (err) {
    console.error(`[${entity}] narrow read failed:`, err.message);
  }
  try {
    const broad = await list(entity, {}, { limit: opts.broadLimit ?? 5000 });
    return broad.filter(matchFn);
  } catch (err) {
    console.error(`[${entity}] broad read failed:`, err.message);
    return [];
  }
}

// Loose name comparison — handles case and the "F.LastName" short form that
// some imports use.
function nameMatches(candidate, fullName) {
  if (!candidate || !fullName) return false;
  const a = String(candidate).trim().toLowerCase();
  const b = String(fullName).trim().toLowerCase();
  if (a === b) return true;
  const parts = b.split(/\s+/);
  if (parts.length >= 2) {
    const short = `${parts[0][0]}.${parts[parts.length - 1]}`;
    if (a === short) return true;
  }
  return false;
}

// --- data accessors used by commands -------------------------------------

// Standings, derived from TeamStat (cumulative win/loss per team per week).
// TeamStat is keyed by Madden team_id and has one row per week, so we take the
// latest week's row per team in the target season, then join TeamMap for names.
export async function getStandings(seasonNumber) {
  const stats = await list("TeamStat");
  if (!stats.length) return { season: null, rows: [] };

  // Target season = explicit arg, else the highest season_index present.
  const season =
    seasonNumber ?? Math.max(...stats.map((s) => s.season_index ?? 0));

  // Keep only the latest-week row for each team in that season.
  const latestByTeam = new Map();
  for (const s of stats) {
    if (s.season_index !== season) continue;
    const prev = latestByTeam.get(s.team_id);
    if (!prev || (s.week_index ?? 0) > (prev.week_index ?? 0)) {
      latestByTeam.set(s.team_id, s);
    }
  }

  // Build team_id -> name lookup from TeamMap (non-fatal if it fails).
  let nameById = {};
  try {
    const teams = await list("TeamMap");
    for (const t of teams) {
      nameById[t.team_id] = {
        team_name: t.team_name ?? "",
        team_abbrName: t.team_abbrName ?? "",
      };
    }
  } catch {
    /* names just won't show */
  }

  const rows = [...latestByTeam.values()]
    .map((s) => {
      const info = nameById[s.team_id] ?? {};
      return {
        team_name: info.team_name ?? "",
        team_abbrName: info.team_abbrName ?? "",
        wins: s.total_wins ?? 0,
        losses: s.total_losses ?? 0,
        ties: s.total_ties ?? 0,
        seed: s.seed ?? null,
        points_for: s.off_pts_per_game ?? 0,
      };
    })
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        a.losses - b.losses ||
        (a.seed ?? 99) - (b.seed ?? 99)
    );

  return { season, rows };
}

// A Game row counts as played once it has a completed status (2=regular,
// 3=playoff per the export convention) — status 1 means the matchup exists
// (Game holds the whole season's schedule up front) but hasn't been played.
function isPlayedGame(g) {
  return g.status === 2 || g.status === 3;
}

// Unplayed Game rows for a season+week, enriched with whatever the schedule
// watcher (scheduleWatcher.js, reading the #schedule channel) has parsed for
// them. Takes the unplayed rows directly (already split out of the same
// Game fetch getScores did) rather than re-querying — Game is the single
// source for both played and upcoming matchups here, there's no separate
// "Schedule" data source to cross-reference.
async function getUpcomingForWeek(unplayedGames, season, wk) {
  if (!unplayedGames.length) return [];
  try {
    // ScheduledGame rows are keyed by season/week/team_a/team_b (see
    // scheduleWatcher.js) — one row per matchup, latest parse wins if a
    // message was edited and re-parsed more than once.
    //
    // Match keys are built from team ABBREVIATION, not raw name string:
    // Game stores full names ("Houston Texans") while ScheduledGame stores
    // nickname-only names ("Texans", from the team-emoji lookup) — comparing
    // those two strings directly never matches even when it's the same
    // team, so both sides go through abbrFromName() to normalize first.
    const scheduledRows = await list("ScheduledGame", {}, { limit: 5000 });
    const byMatchup = new Map();
    for (const r of scheduledRows) {
      if (r.season_number !== season || r.week !== wk) continue;
      const pair = [abbrFromName(r.team_a), abbrFromName(r.team_b)].filter(Boolean).sort().join("|");
      if (!pair) continue;
      const prev = byMatchup.get(pair);
      if (!prev || (r.parsed_at || "") > (prev.parsed_at || "")) byMatchup.set(pair, r);
    }

    return unplayedGames.map((g) => {
      const pair = [abbrFromName(g.homeTeam), abbrFromName(g.awayTeam)].filter(Boolean).sort().join("|");
      const sched = byMatchup.get(pair) || null;
      return {
        home: g.homeTeam ?? "",
        away: g.awayTeam ?? "",
        status: sched?.scheduled_status ?? "unscheduled",
        timeText:
          sched?.scheduled_status === "forfeit"
            ? `FW${sched.forfeit_winner_team ? ` (${sched.forfeit_winner_team})` : ""}`
            : sched?.scheduled_time_text ?? null,
      };
    });
  } catch (err) {
    console.error("[SCORES] upcoming lookup failed:", err.message);
    return []; // non-fatal — completed games still show without this section
  }
}

// Scores for a given week (defaults to the latest week that has at least
// one COMPLETED game) in the latest season. Home team is user1, away is
// user2 by the export convention. Also returns `upcoming`: unplayed
// matchups in that same week, with whatever day/time the #schedule channel
// watcher has parsed for them.
//
// NOTE on the week default: Game holds the whole season's matchups up
// front (future weeks exist with status 1 and 0-0 scores before they're
// played), so defaulting to the single highest `week` number in the season
// — as this used to do — could land on a not-yet-played future week
// instead of the most recent actual results. Defaulting to the earliest
// not-yet-fully-played week fixes that (verified against real data: weeks
// 1-3 were entirely status 2/3, week 4 entirely status 1 — clean weekly
// boundaries, not a mix within one week — so "the current week" is the
// front line of play, not the last fully-resolved week or the season's
// max week number).
export async function getScores(week, seasonNumber) {
  const games = await list("Game");
  if (!games.length) return { season: null, week: null, games: [], upcoming: [] };

  const season =
    seasonNumber ?? Math.max(...games.map((g) => g.season_number ?? 0));

  const inSeason = games.filter((g) => g.season_number === season);
  if (!inSeason.length) return { season, week: null, games: [], upcoming: [] };

  const unplayedWeeks = inSeason.filter((g) => !isPlayedGame(g)).map((g) => g.week ?? 0);
  const wk =
    week ?? (unplayedWeeks.length ? Math.min(...unplayedWeeks) : Math.max(...inSeason.map((g) => g.week ?? 0)));

  const wkAll = inSeason.filter((g) => g.week === wk);
  const wkPlayed = wkAll.filter(isPlayedGame);
  const wkUnplayed = wkAll.filter((g) => !isPlayedGame(g));

  const wkGames = wkPlayed
    .map((g) => ({
      home: g.homeTeam ?? "",
      away: g.awayTeam ?? "",
      homeScore: g.user1_score ?? 0,
      awayScore: g.user2_score ?? 0,
      status: g.status, // 2=regular, 3=playoff (per export)
      scheduleId: g.scheduleId ?? null,
      cycle: g.cycle ?? null,
    }))
    // Final scores first by margin, just for stable ordering.
    .sort((a, b) => b.homeScore + b.awayScore - (a.homeScore + a.awayScore));

  const upcoming = await getUpcomingForWeek(wkUnplayed, season, wk);

  return { season, week: wk, games: wkGames, upcoming };
}

// Weeks available in the latest season (for the /scores week autocomplete).
// Game holds the full season's matchups up front, so this already includes
// upcoming not-yet-played weeks — no separate lookup needed.
export async function getScoreWeeks(seasonNumber) {
  const games = await list("Game");
  if (!games.length) return { season: null, weeks: [] };
  const season =
    seasonNumber ?? Math.max(...games.map((g) => g.season_number ?? 0));
  const weeks = [
    ...new Set(
      games
        .filter((g) => g.season_number === season)
        .map((g) => g.week)
        .filter((w) => w != null)
    ),
  ].sort((a, b) => a - b);
  return { season, weeks };
}

// A signature that changes whenever game data changes — the most recent
// `updated_date` across all games. Used by the scheduler to detect new scores.
export async function getScoresSignature() {
  const games = await list("Game");
  if (!games.length) return null;
  let latest = "";
  for (const g of games) {
    const u = g.updated_date || g.created_date || "";
    if (u > latest) latest = u;
  }
  return latest || null;
}

// Stat leaders for a category. Returns top N sorted by the chosen field.
const STAT_CONFIG = {
  passing_yds: { entity: "PassingStat", field: "passTotalYds", label: "Passing Yds" },
  passing_tds: { entity: "PassingStat", field: "passTotalTDs", label: "Passing TDs" },
  passing_ints: { entity: "PassingStat", field: "passTotalInts", label: "Passing INTs" },
  rushing_yds: { entity: "RushingStat", field: "rushTotalYds", label: "Rushing Yds" },
  rushing_tds: { entity: "RushingStat", field: "rushTotalTDs", label: "Rushing TDs" },
  fumbles: { entity: "RushingStat", field: "rushTotalFum", label: "Fumbles" },
  receptions: { entity: "ReceivingStat", field: "recTotalCatches", label: "Receptions" },
  receiving_yds: { entity: "ReceivingStat", field: "recTotalYds", label: "Receiving Yds" },
  receiving_tds: { entity: "ReceivingStat", field: "recTotalTDs", label: "Receiving TDs" },
  sacks: { entity: "DefenseStat", field: "defTotalSacks", label: "Sacks" },
  def_ints: { entity: "DefenseStat", field: "defTotalInts", label: "Defensive INTs" },
  forced_fumbles: { entity: "DefenseStat", field: "defTotalForcedFum", label: "Forced Fumbles" },
};

export async function getStatLeaders(category, limit = 10, seasonNumber) {
  const cfg = STAT_CONFIG[category];
  if (!cfg) throw new Error(`Unknown stat category: ${category}`);

  const cycle = await getCurrentCycle();
  const all = await list(cfg.entity, { cycle }, { limit: 5000 });
  const rows = all.filter((r) => !r.cycle || r.cycle === cycle);
  if (!rows.length) return { ...cfg, season: null, leaders: [] };

  const season =
    seasonNumber ?? Math.max(...rows.map((r) => r.season_number ?? 0));

  const leaders = rows
    .filter((r) => r.season_number === season)
    .sort((a, b) => (b[cfg.field] ?? 0) - (a[cfg.field] ?? 0))
    .slice(0, limit);

  return { ...cfg, season, leaders };
}

// Power rankings for the most recent week present. Enriches each row with the
// member's current team (from the latest SeasonRecord) so the embed can show a
// helmet, since PowerRanking itself only stores a username.
export async function getPowerRankings() {
  const all = await list("PowerRanking");
  if (!all.length) return { week: null, rows: [] };

  // Build username -> team_name from the latest season's records.
  let teamByUser = {};
  try {
    const cycle = await getCurrentCycle();
    const allRecs = await list("SeasonRecord", { cycle }, { limit: 5000 });
    const recs = allRecs.filter((r) => !r.cycle || r.cycle === cycle);
    if (recs.length) {
      const latest = Math.max(...recs.map((r) => r.season_number ?? 0));
      for (const r of recs) {
        if (r.season_number === latest && r.username && r.team_name) {
          teamByUser[r.username] = r.team_name;
        }
      }
    }
  } catch {
    // Non-fatal — rankings just won't have helmets.
  }

  const weeks = [...new Set(all.map((r) => r.week))];
  const week = weeks[weeks.length - 1];

  const rows = all
    .filter((r) => r.week === week)
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
    .map((r) => ({ ...r, team_name: teamByUser[r.username] ?? null }));

  return { week, rows };
}

// Trade block entries (players + picks on offer). Optional `team` filters to a
// single franchise — matches on full name, nickname, or abbreviation, case-
// insensitively (e.g. "Browns", "cleveland browns", or "CLE" all work).
export async function getTradeBlock(team) {
  const entries = await list("TradeBlock");
  let filtered = entries;

  if (team && team.trim()) {
    const q = team.toLowerCase().trim();
    filtered = entries.filter((e) => {
      const name = (e.team_name ?? "").toLowerCase();
      const abbr = (e.team_abbrName ?? "").toLowerCase();
      const nick = name.split(/\s+/).pop();
      return (
        name === q ||
        abbr === q ||
        nick === q ||
        name.includes(q) ||
        q.includes(nick)
      );
    });
  }

  return {
    team: team?.trim() || null,
    entries: filtered.sort((a, b) => (b.player_ovr ?? 0) - (a.player_ovr ?? 0)),
  };
}

// Distinct team names that currently have trade-block entries (for error help).
export async function getTradeBlockTeams() {
  const entries = await list("TradeBlock");
  return [...new Set(entries.map((e) => e.team_name).filter(Boolean))].sort();
}

// Cache the full player list briefly so autocomplete (which fires on every
// keystroke) doesn't hit the API repeatedly.
let _playerCache = { at: 0, rows: [] };
let _playerRefresh = null; // in-flight load, shared by concurrent callers
const PLAYER_TTL_MS = 300_000; // 5 minutes — refreshes happen in background

async function loadPlayers() {
  const cycle = await getCurrentCycle();
  const allRows = await list("Player", {}, { limit: 10000 });
  // Filter to the current cycle in memory — the server-side filter can't be
  // relied on, and stale-cycle players are the exact bug we're avoiding.
  const rows = allRows.filter((p) => p.cycle === cycle);
  console.log(`[PLAYER] ${allRows.length} total -> ${rows.length} in cycle ${cycle}`);
  _playerCache = { at: Date.now(), rows };
  return rows;
}

// Kick off a refresh without blocking the caller. Multiple callers share the
// same in-flight promise so we never stack duplicate 10k-row fetches.
function refreshPlayersInBackground() {
  if (_playerRefresh) return _playerRefresh;
  _playerRefresh = loadPlayers()
    .catch((err) => {
      console.error("[PLAYER] background refresh failed:", err.message);
      return _playerCache.rows;
    })
    .finally(() => {
      _playerRefresh = null;
    });
  return _playerRefresh;
}

// Warm the cache at startup so the very first autocomplete is instant.
export async function warmPlayerCache() {
  try {
    await loadPlayers();
    console.log("🔥 Player cache warmed.");
  } catch (err) {
    console.error("[PLAYER] warm failed:", err.message);
  }
}

// Cached player list. Never blocks on a refresh if we already have rows —
// Discord gives autocomplete only 3 seconds, and a cold fetch blows past it.
async function getAllPlayers() {
  const fresh = Date.now() - _playerCache.at < PLAYER_TTL_MS;
  if (_playerCache.rows.length) {
    // Stale but usable: hand back what we have and refresh behind the scenes.
    if (!fresh) refreshPlayersInBackground();
    return _playerCache.rows;
  }
  // Nothing cached at all — we have to wait for the first load.
  return refreshPlayersInBackground();
}

// Suggestions for autocomplete. Returns up to `limit` players ranked by how
// well they match the partial query, each as { name, value } where value is a
// stable, unambiguous identifier (the Base44 record id when available).
export async function suggestPlayers(partial, limit = 25) {
  const all = await getAllPlayers();
  const q = (partial ?? "").trim().toLowerCase();

  const scored = all
    .map((p) => {
      const n = (p.player_fullName ?? "").toLowerCase();
      const words = n.split(/\s+/);
      let tier = 0;
      if (!q) tier = 1; // empty query -> show top players
      else if (n === q) tier = 4;
      else if (n.startsWith(q)) tier = 3;
      else if (words.some((w) => w.startsWith(q))) tier = 2;
      else if (n.includes(q)) tier = 1;
      return { p, tier };
    })
    .filter((x) => x.tier > 0)
    .sort(
      (a, b) => b.tier - a.tier || (b.p.player_ovr ?? 0) - (a.p.player_ovr ?? 0)
    )
    .slice(0, limit);

  return scored
    .map(({ p }) => {
      const team = p.team_abbrName ? ` · ${p.team_abbrName}` : "";
      const label =
        `${p.player_fullName} (${p.player_position ?? "?"} · ${p.player_ovr ?? "?"} OVR${team})`.slice(
          0,
          100 // Discord caps choice names at 100 chars
        );
      // Discord rejects the ENTIRE response if any single choice is malformed:
      // name and value must both be non-empty strings under 100 characters.
      const value = String(p.id || p.player_fullName || "").slice(0, 100);
      const name = String(label || "").trim();
      if (!name || !value) return null;
      return { name, value };
    })
    .filter(Boolean);
}

// Fetch a single player by Base44 record id (what autocomplete sends).
export async function getPlayerById(id) {
  const all = await getAllPlayers();
  return all.find((p) => p.id === id) ?? null;
}

// Look up players by (partial) name. Returns a ranked list of matches plus a
// flag for whether the result is unambiguous (a single clear player) so the
// caller can either show the card directly or present a chooser.
export async function getPlayer(name) {
  const all = await getAllPlayers();
  if (!all.length) return { matches: [], unambiguous: false };

  const q = name.trim().toLowerCase();

  // Rank each player: exact full-name match > starts-with > word match >
  // substring. Within a tier, prefer higher OVR.
  const scored = all
    .map((p) => {
      const n = (p.player_fullName ?? "").toLowerCase();
      const words = n.split(/\s+/);
      let tier = 0;
      if (n === q) tier = 4;
      else if (n.startsWith(q)) tier = 3;
      else if (words.includes(q)) tier = 2; // exact word (e.g. last name)
      else if (n.includes(q)) tier = 1;
      return { p, tier };
    })
    .filter((x) => x.tier > 0)
    .sort(
      (a, b) => b.tier - a.tier || (b.p.player_ovr ?? 0) - (a.p.player_ovr ?? 0)
    );

  const matches = scored.map((x) => x.p);

  // Unambiguous only when there's exactly one match, or the top match is an
  // exact full-name hit that nothing else ties.
  const exact = scored.filter((x) => x.tier === 4);
  const unambiguous =
    matches.length === 1 || exact.length === 1;

  return { matches, unambiguous };
}

// Look up a Roster row for a player (gives team name + abbreviation for the
// helmet/header) — falls back gracefully if the player isn't rostered.
export async function getRosterFor(playerFullName) {
  try {
    const cycle = await getCurrentCycle();
    const rows = await listMatching(
      "Roster",
      { cycle, player_fullName: playerFullName },
      (r) =>
        (!r.cycle || r.cycle === cycle) &&
        nameMatches(r.player_fullName, playerFullName)
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

// --- player stat views (used by the /player dropdown) --------------------

// Short-lived cache so flipping between dropdown views doesn't refetch.
const _statCache = new Map(); // key -> { at, data }
const STAT_TTL_MS = 120_000;

function cachedStats(key) {
  const hit = _statCache.get(key);
  if (hit && Date.now() - hit.at < STAT_TTL_MS) return hit.data;
  return null;
}
function putStats(key, data) {
  _statCache.set(key, { at: Date.now(), data });
  return data;
}

// Per-week stat lines for a player in the current cycle, newest week first.
// Returns { season, weeks: [...] } for the latest season that has data.
export async function getPlayerWeeklyStats(playerFullName) {
  const cycle = await getCurrentCycle();
  const key = `weekly:${cycle}:${playerFullName}`;
  const hit = cachedStats(key);
  if (hit) return hit;

  const rows = await listMatching(
    "WeeklyStats",
    { cycle, player_full_name: playerFullName },
    (r) =>
      (!r.cycle || r.cycle === cycle) &&
      nameMatches(r.player_full_name, playerFullName),
    { limit: 500, broadLimit: 10000 }
  );

  if (!rows.length) return putStats(key, { season: null, weeks: [] });

  const season = Math.max(...rows.map((r) => r.season_index ?? 0));
  const weeks = rows
    .filter((r) => (r.season_index ?? 0) === season)
    .sort((a, b) => (b.week_index ?? 0) - (a.week_index ?? 0));

  return putStats(key, { season, weeks });
}

// Season totals for a player, merged across the four stat entities.
// Returns [{ season, gamesPlayed, passing, rushing, receiving, defense }, ...]
// sorted newest season first.
export async function getPlayerSeasonStats(playerFullName) {
  const cycle = await getCurrentCycle();
  const key = `season:${cycle}:${playerFullName}`;
  const hit = cachedStats(key);
  if (hit) return hit;

  const entities = [
    ["passing", "PassingStat"],
    ["rushing", "RushingStat"],
    ["receiving", "ReceivingStat"],
    ["defense", "DefenseStat"],
  ];

  const bySeason = new Map();

  for (const [bucket, entity] of entities) {
    let rows = [];
    try {
      rows = await listMatching(
        entity,
        { cycle, player_fullName: playerFullName },
        (r) =>
          (!r.cycle || r.cycle === cycle) &&
          nameMatches(r.player_fullName, playerFullName),
        { limit: 200, broadLimit: 8000 }
      );
    } catch (err) {
      console.error(`[STATS] ${entity} read failed:`, err.message);
    }
    for (const r of rows) {
      const s = r.season_number ?? 0;
      if (!bySeason.has(s)) bySeason.set(s, { season: s, gamesPlayed: 0 });
      const slot = bySeason.get(s);
      slot[bucket] = r;
      slot.gamesPlayed = Math.max(slot.gamesPlayed, r.gamesPlayed ?? 0);
    }
  }

  const out = [...bySeason.values()].sort((a, b) => b.season - a.season);
  return putStats(key, out);
}

// Recent trade submissions, newest first.
export async function getTrades(status, limit = 10) {
  const filter = status ? { status } : {};
  const trades = await list("TradeSubmission", filter, {
    sort: "-created_date",
    limit,
  });
  return trades;
}

// --- league members, teams, rivalries (for /team /myteam /rivalry) -------

// Optional: if src/lib/tradeValueEngine.js from the app repo is copied into
// the bot folder, /compare shows real trade values. Absent, it degrades.
let _calcPlayerValue = null;
try {
  const mod = await import("./tradeValueEngine.js");
  _calcPlayerValue = mod.calcPlayerValue ?? null;
  if (_calcPlayerValue) console.log("💰 Trade value engine loaded.");
} catch {
  console.log("ℹ️  tradeValueEngine.js not found — /compare will omit trade value.");
}

export function playerTradeValue(player) {
  if (!_calcPlayerValue || !player) return null;
  try {
    return _calcPlayerValue(player);
  } catch {
    return null;
  }
}

// League members, cached — small table, read often.
let _memberCache = { at: 0, rows: [] };
const MEMBER_TTL_MS = 300_000;

export async function getLeagueMembers() {
  if (Date.now() - _memberCache.at < MEMBER_TTL_MS && _memberCache.rows.length) {
    return _memberCache.rows;
  }
  const rows = await list("LeagueMember", {}, { limit: 500 });
  _memberCache = { at: Date.now(), rows };
  return rows;
}

// Map a Discord user to their LeagueMember via LeagueMember.discord_user_id.
export async function getMemberByDiscordId(discordUserId) {
  if (!discordUserId) return null;
  const members = await getLeagueMembers();
  return members.find((m) => String(m.discord_user_id ?? "") === String(discordUserId)) ?? null;
}

// Some LeagueMember.username values are email addresses (from account
// linking). Emails are private — they must never be shown in Discord or
// used as searchable text.
function looksLikeEmail(s) {
  return /\S+@\S+\.\S+/.test(String(s ?? ""));
}

// The safe, human-readable name for a member. Falls back through the
// non-email options and finally to their team, never exposing an email.
export function memberDisplayName(m) {
  if (!m) return "Unknown member";
  const candidates = [
    m.discord_username,
    m.avatar_name,
    m.username,
    ...(Array.isArray(m.aliases) ? m.aliases : []),
  ];
  for (const c of candidates) {
    if (c && !looksLikeEmail(c)) return String(c);
  }
  return m.team_name ? `${m.team_name} owner` : "Unnamed member";
}

// Look up a member by record id, falling back to a username match so older
// interactions (which sent usernames) keep working.
export async function getMemberByIdOrUsername(input) {
  if (!input) return null;
  const members = await getLeagueMembers();
  const key = String(input).toLowerCase();
  return (
    members.find((m) => String(m.id ?? "").toLowerCase() === key) ??
    members.find((m) => String(m.username ?? "").toLowerCase() === key) ??
    null
  );
}

// Autocomplete over league members. Matches and displays only non-email
// names; the option value is the record id, so no email is ever sent to
// Discord in either the label or the payload.
export async function suggestMembers(partial, limit = 25) {
  const members = await getLeagueMembers();
  const q = (partial ?? "").trim().toLowerCase();

  const scored = members
    .map((m) => {
      const display = memberDisplayName(m);
      const n = display.toLowerCase();
      // Search the display name and any non-email aliases only.
      const searchable = [n, ...(Array.isArray(m.aliases) ? m.aliases : [])
        .filter((a) => a && !looksLikeEmail(a))
        .map((a) => String(a).toLowerCase())];
      let tier = 0;
      if (!q) tier = 1;
      else if (searchable.some((t) => t === q)) tier = 3;
      else if (searchable.some((t) => t.startsWith(q))) tier = 2;
      else if (searchable.some((t) => t.includes(q))) tier = 1;
      return { m, display, tier };
    })
    .filter((x) => x.tier > 0 && x.display)
    .sort((a, b) => b.tier - a.tier || a.display.localeCompare(b.display))
    .slice(0, limit);

  return scored.map(({ m, display }) => {
    const team = m.team_name ? ` · ${m.team_name}` : "";
    return {
      name: String(`${display}${team}`).slice(0, 100),
      value: String(m.id ?? m.username ?? display).slice(0, 100),
    };
  });
}

// Loose team matching: full name, nickname, or abbreviation.
function teamMatches(candidate, query) {
  if (!candidate || !query) return false;
  const c = String(candidate).toLowerCase().trim();
  const q = String(query).toLowerCase().trim();
  if (c === q) return true;
  const nick = c.split(/\s+/).pop();
  return nick === q || c.includes(q) || q.includes(nick);
}

// Everything the /team card needs, assembled in one pass.
export async function getTeamOverview(teamQuery) {
  const cycle = await getCurrentCycle();

  // Resolve the query to a canonical team name via TeamMap.
  let teams = [];
  try {
    teams = await list("TeamMap", {}, { limit: 200 });
  } catch {
    /* fall through to roster-derived names */
  }
  let mapped = teams.find(
    (t) => teamMatches(t.team_name, teamQuery) || teamMatches(t.team_abbrName, teamQuery)
  );

  const allRoster = await list("Roster", {}, { limit: 10000 });
  const inCycle = allRoster.filter((r) => !r.cycle || r.cycle === cycle);

  const teamName = mapped?.team_name ?? null;
  const roster = inCycle.filter((r) =>
    teamMatches(r.team_name, teamName ?? teamQuery)
  );

  if (!roster.length && !mapped) {
    // Give the caller the list of valid names for a helpful error.
    const names = [...new Set(inCycle.map((r) => r.team_name).filter(Boolean))].sort();
    return { found: false, query: teamQuery, teams: names };
  }

  const resolvedName = teamName ?? roster[0]?.team_name ?? teamQuery;
  const abbr = mapped?.team_abbrName ?? roster[0]?.team_abbrName ?? "";

  // Join roster -> Player for ratings.
  const players = await getAllPlayers();
  const byName = new Map();
  for (const p of players) {
    if (p.player_fullName) byName.set(p.player_fullName.toLowerCase(), p);
  }
  const enriched = roster
    .map((r) => {
      const p = byName.get(String(r.player_fullName ?? "").toLowerCase());
      return {
        player_fullName: r.player_fullName,
        player_position: p?.player_position ?? r.player_position,
        player_ovr: p?.player_ovr ?? null,
        player: p ?? null,
      };
    })
    .sort((a, b) => (b.player_ovr ?? 0) - (a.player_ovr ?? 0));

  // Owner: prefer the roster's owner_username, else LeagueMember by team.
  // owner_username can be an email, so always resolve a safe display name
  // and never return the raw value.
  let ownerMember = null;
  let owner = null;
  try {
    const members = await getLeagueMembers();
    const rawOwner = roster.find((r) => r.owner_username)?.owner_username ?? null;
    if (rawOwner) {
      ownerMember =
        members.find(
          (m) => String(m.username ?? "").toLowerCase() === String(rawOwner).toLowerCase()
        ) ?? null;
    }
    if (!ownerMember) {
      ownerMember = members.find((m) => teamMatches(m.team_name, resolvedName)) ?? null;
    }
    if (ownerMember) {
      owner = memberDisplayName(ownerMember);
    } else if (rawOwner && !looksLikeEmail(rawOwner)) {
      // No member record, but the raw value is safe to show.
      owner = rawOwner;
    }
  } catch {
    /* owner is optional */
  }

  // Record from standings (already derived from TeamStat + TeamMap).
  let record = null;
  try {
    const { season, rows } = await getStandings();
    const row = rows.find((r) => teamMatches(r.team_name, resolvedName));
    if (row) record = { ...row, season };
  } catch {
    /* record is optional */
  }

  // Trade block entries for this team.
  let block = [];
  try {
    const entries = await list("TradeBlock", {}, { limit: 5000 });
    block = entries.filter((e) => teamMatches(e.team_name, resolvedName));
  } catch {
    /* optional */
  }

  // Cap picture from CycleData, keyed by team abbreviation.
  let cap = null;
  try {
    const cd = await list("CycleData", {}, { limit: 200 });
    cap =
      cd.find(
        (c) => (!c.cycle || c.cycle === cycle) && teamMatches(c.team_abbr, abbr)
      ) ?? null;
  } catch {
    /* optional */
  }

  return {
    found: true,
    teamName: resolvedName,
    abbr,
    owner,
    record,
    roster: enriched,
    block,
    cap,
    cycle,
  };
}

// Every name a member is known by, lowercased. Rivalry and Game rows store
// gamertags ("quacks", "chaosrevolver") while LeagueMember.username is often
// an email, so identity matching has to consider all of these.
export function memberIdentities(m) {
  if (!m) return [];
  const raw = [
    m.username,
    m.discord_username,
    m.avatar_name,
    ...(Array.isArray(m.aliases) ? m.aliases : []),
  ];
  return [
    ...new Set(
      raw
        .filter(Boolean)
        .map((x) => String(x).trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

// Resolve a member object from an id, a username, or any known alias.
async function resolveMember(input) {
  if (!input) return null;
  if (typeof input === "object") return input;
  const key = String(input).trim().toLowerCase();
  const members = await getLeagueMembers();
  return (
    members.find((m) => String(m.id ?? "").toLowerCase() === key) ??
    members.find((m) => memberIdentities(m).includes(key)) ??
    null
  );
}

// Head-to-head between two league members. Accepts member objects, record
// ids, usernames, or aliases. Uses the pre-computed Rivalry record when
// present, otherwise tallies the Game entity directly.
export async function getRivalry(input1, input2) {
  const m1 = await resolveMember(input1);
  const m2 = await resolveMember(input2);

  // Fall back to the raw strings if a member record is missing.
  const ids1 = m1 ? memberIdentities(m1) : [String(input1 ?? "").trim().toLowerCase()];
  const ids2 = m2 ? memberIdentities(m2) : [String(input2 ?? "").trim().toLowerCase()];
  if (!ids1.length || !ids2.length) return null;

  const display1 = m1 ? memberDisplayName(m1) : String(input1);
  const display2 = m2 ? memberDisplayName(m2) : String(input2);

  const isA = (v) => ids1.includes(String(v ?? "").trim().toLowerCase());
  const isB = (v) => ids2.includes(String(v ?? "").trim().toLowerCase());

  console.log(
    `[RIVALRY] matching ${display1} [${ids1.join("|")}] vs ${display2} [${ids2.join("|")}]`
  );

  // 1) Pre-computed record.
  try {
    const rows = await list("Rivalry", {}, { limit: 5000 });
    const hit = rows.find(
      (r) =>
        (isA(r.user1_username) && isB(r.user2_username)) ||
        (isB(r.user1_username) && isA(r.user2_username))
    );
    if (hit && ((hit.user1_wins ?? 0) || (hit.user2_wins ?? 0) || (hit.ties ?? 0))) {
      // Rivalry rows store the pair alphabetically — orient to our arguments.
      const flipped = isB(hit.user1_username);
      console.log(`[RIVALRY] matched Rivalry row ${hit.id}`);
      return {
        source: "rivalry",
        user1: display1,
        user2: display2,
        display1,
        display2,
        user1_wins: flipped ? hit.user2_wins ?? 0 : hit.user1_wins ?? 0,
        user2_wins: flipped ? hit.user1_wins ?? 0 : hit.user2_wins ?? 0,
        ties: hit.ties ?? 0,
        games: [],
      };
    }
  } catch (err) {
    console.error("[RIVALRY] Rivalry read failed:", err.message);
  }

  // 2) Live tally from Game rows.
  const games = await list("Game", {}, { limit: 20000 });
  const meetings = games.filter(
    (g) =>
      (isA(g.user1_username) && isB(g.user2_username)) ||
      (isB(g.user1_username) && isA(g.user2_username))
  );
  console.log(`[RIVALRY] live tally found ${meetings.length} meetings`);

  let w1 = 0;
  let w2 = 0;
  let ties = 0;
  for (const g of meetings) {
    const aIsUser1 = isA(g.user1_username);
    const aScore = aIsUser1 ? g.user1_score ?? 0 : g.user2_score ?? 0;
    const bScore = aIsUser1 ? g.user2_score ?? 0 : g.user1_score ?? 0;
    if (aScore > bScore) w1++;
    else if (bScore > aScore) w2++;
    else ties++;
  }

  const recent = [...meetings]
    .sort(
      (x, y) =>
        (y.season_number ?? 0) - (x.season_number ?? 0) || (y.week ?? 0) - (x.week ?? 0)
    )
    .slice(0, 5)
    .map((g) => {
      const aIsUser1 = isA(g.user1_username);
      return {
        season: g.season_number,
        week: g.week,
        aScore: aIsUser1 ? g.user1_score ?? 0 : g.user2_score ?? 0,
        bScore: aIsUser1 ? g.user2_score ?? 0 : g.user1_score ?? 0,
      };
    });

  return {
    source: "games",
    user1: display1,
    user2: display2,
    display1,
    display2,
    user1_wins: w1,
    user2_wins: w2,
    ties,
    games: recent,
  };
}

// Distinct team names in the current cycle (for the trade builder + /team).
export async function getCycleTeams() {
  const cycle = await getCurrentCycle();
  const roster = await list("Roster", {}, { limit: 10000 });
  const names = roster
    .filter((r) => !r.cycle || r.cycle === cycle)
    .map((r) => r.team_name)
    .filter(Boolean);
  return [...new Set(names)].sort();
}

// A team's players in the current cycle, joined to Player for position/OVR
// and sorted by OVR. Shared by /submit_trade so it can't drift from /team.
// Returns [{ name, position, ovr }].
export async function getTeamRosterPlayers(teamName) {
  const cycle = await getCurrentCycle();
  const roster = await list("Roster", {}, { limit: 10000 });

  const mine = roster.filter(
    (r) => (!r.cycle || r.cycle === cycle) && teamMatches(r.team_name, teamName)
  );
  if (!mine.length) return [];

  // getAllPlayers is already cycle-filtered and cached.
  const players = await getAllPlayers();
  const byName = new Map();
  for (const p of players) {
    if (p.player_fullName) byName.set(p.player_fullName.toLowerCase(), p);
  }

  return mine
    .map((r) => {
      const p = byName.get(String(r.player_fullName ?? "").toLowerCase());
      return {
        name: r.player_fullName,
        position: p?.player_position || r.player_position || "?",
        ovr: p?.player_ovr ?? 0,
      };
    })
    .filter((x) => x.name)
    .sort((a, b) => b.ovr - a.ovr);
}

// --- writes (trade voting) ----------------------------------------------

// Update one entity record. Base44's REST shape for writes isn't documented
// here, so try the likely verbs in order and remember which one worked.
let _writeVerb = null;

export async function updateEntity(entity, id, data) {
  const url = `${SERVER}/api/apps/${APP_ID}/entities/${entity}/${id}`;
  const verbs = _writeVerb ? [_writeVerb] : ["PUT", "PATCH", "POST"];

  let lastErr = null;
  for (const method of verbs) {
    try {
      let res = await fetch(url, {
        method,
        headers: authHeaders(),
        body: JSON.stringify(data),
      });
      if ((res.status === 401 || res.status === 403) &&
          (process.env.BOT_EMAIL || process.env.BASE44_TOKEN)) {
        await botLogin();
        res = await fetch(url, {
          method,
          headers: authHeaders(),
          body: JSON.stringify(data),
        });
      }
      if (res.ok) {
        if (!_writeVerb) {
          _writeVerb = method;
          console.log(`[WRITE] ${entity} updates use ${method}.`);
        }
        return await res.json().catch(() => ({}));
      }
      const body = await res.text().catch(() => "");
      lastErr = new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
      // 405/404 means wrong verb — try the next one.
      if (![404, 405].includes(res.status)) break;
    } catch (err) {
      lastErr = err;
    }
  }
  console.error(`[WRITE] ${entity}/${id} update failed:`, lastErr?.message);
  throw new Error(`Could not save to the Vault: ${lastErr?.message ?? "unknown error"}`);
}

// Create a new entity record. Same collection endpoint as list(), POST verb.
export async function createEntity(entity, data) {
  const url = `${SERVER}/api/apps/${APP_ID}/entities/${entity}`;
  const doFetch = () =>
    fetch(url, { method: "POST", headers: authHeaders(), body: JSON.stringify(data) });

  let res;
  try {
    res = await doFetch();
    if ((res.status === 401 || res.status === 403) &&
        (process.env.BOT_EMAIL || process.env.BASE44_TOKEN)) {
      await botLogin();
      res = await doFetch();
    }
  } catch (err) {
    console.error(`[WRITE] ${entity} create failed:`, err.message);
    throw new Error(`Could not save to the Vault: ${err.message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[WRITE] ${entity} create failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    throw new Error(`Could not save to the Vault: HTTP ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

// Trades awaiting committee review.
export async function getPendingTrades() {
  const rows = await list("TradeSubmission", {}, { sort: "-created_date", limit: 200 });
  return rows.filter((t) => (t.status ?? "pending") === "pending");
}

export async function getTradeById(id) {
  const rows = await list("TradeSubmission", {}, { limit: 500 });
  return rows.find((t) => t.id === id) ?? null;
}

// Committee members who can vote, keyed for Discord lookups.
export async function getCommitteeMembers() {
  const members = await getLeagueMembers();
  return members.filter((m) => m.is_committee);
}

// Look up players by name for enriching a trade message (current cycle).
export async function getPlayersByNames(names = []) {
  if (!names.length) return new Map();
  const players = await getAllPlayers();
  const wanted = new Set(names.map((n) => String(n).trim().toLowerCase()));
  const out = new Map();
  for (const p of players) {
    const key = String(p.player_fullName ?? "").toLowerCase();
    if (wanted.has(key)) out.set(key, p);
  }
  return out;
}

// All trade submissions, newest first (used by the approval announcer).
export async function getAllTrades(limit = 300) {
  return list("TradeSubmission", {}, { sort: "-created_date", limit });
}

// Find a member by any identity they're known by (username, discord name,
// avatar name, alias). Returns null when nothing matches — callers should
// then omit the name rather than fall back to the raw value, which may be a
// real name or an email.
export async function findMemberByIdentity(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  if (!key) return null;
  const members = await getLeagueMembers();
  return members.find((m) => memberIdentities(m).includes(key)) ?? null;
}

// The member who owns a team, matched loosely on full name, nickname, or
// abbreviation ("49ers", "San Francisco 49ers", and "SF" all resolve).
export async function findMemberByTeam(teamName) {
  if (!teamName) return null;
  const members = await getLeagueMembers();
  return members.find((m) => m.team_name && teamMatches(m.team_name, teamName)) ?? null;
}
