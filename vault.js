// vault.js — reads XCFL Vault data from Base44's public REST API.
// All read entities have open read RLS, so no auth token is required.
const APP_ID = process.env.BASE44_APP_ID;
const SERVER = process.env.BASE44_SERVER_URL || "https://base44.app";

if (!APP_ID) {
  console.error("Missing BASE44_APP_ID in environment. See README.");
  process.exit(1);
}

const CYCLE = process.env.XCFL_CYCLE || "M26";

// --- helpers -------------------------------------------------------------

// Read an entity via the REST endpoint. `filter` is a plain object; it's sent
// as Base44's query params. Returns an array (possibly empty). Throws only on
// an actual network/HTTP failure — an empty entity returns [].
async function list(entity, filter = {}, opts = {}) {
  const url = new URL(`${SERVER}/api/apps/${APP_ID}/entities/${entity}`);
  // Base44 expects each filter field as its own query param.
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  if (opts.sort) url.searchParams.set("sort", opts.sort);
  if (opts.limit) url.searchParams.set("limit", String(opts.limit));

  let res;
  try {
    res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        // Base44 identifies the app via this header; without it anonymous
        // reads of public entities are rejected with 403.
        "X-App-Id": APP_ID,
        ...(process.env.BASE44_API_KEY
          ? { Authorization: `Bearer ${process.env.BASE44_API_KEY}` }
          : {}),
      },
    });
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

// Scores for a given week (defaults to the latest week with games) in the
// latest season. Home team is user1, away is user2 by the export convention.
export async function getScores(week, seasonNumber) {
  const games = await list("Game", { cycle: CYCLE });
  if (!games.length) return { season: null, week: null, games: [] };

  const season =
    seasonNumber ?? Math.max(...games.map((g) => g.season_number ?? 0));

  const inSeason = games.filter((g) => g.season_number === season);
  if (!inSeason.length) return { season, week: null, games: [] };

  const wk =
    week ?? Math.max(...inSeason.map((g) => g.week ?? 0));

  const wkGames = inSeason
    .filter((g) => g.week === wk)
    .map((g) => ({
      home: g.homeTeam ?? "",
      away: g.awayTeam ?? "",
      homeScore: g.user1_score ?? 0,
      awayScore: g.user2_score ?? 0,
      status: g.status, // 2=regular, 3=playoff (per export)
    }))
    // Final scores first by margin, just for stable ordering.
    .sort((a, b) => b.homeScore + b.awayScore - (a.homeScore + a.awayScore));

  return { season, week: wk, games: wkGames };
}

// Weeks available in the latest season (for the /scores week autocomplete).
export async function getScoreWeeks(seasonNumber) {
  const games = await list("Game", { cycle: CYCLE });
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
  const games = await list("Game", { cycle: CYCLE });
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

  let rows = await list(cfg.entity, { cycle: CYCLE });
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
    const recs = await list("SeasonRecord", { cycle: CYCLE });
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
const PLAYER_TTL_MS = 60_000; // 1 minute

async function getAllPlayers() {
  const now = Date.now();
  if (now - _playerCache.at < PLAYER_TTL_MS && _playerCache.rows.length) {
    return _playerCache.rows;
  }
  const rows = await list("Player", { cycle: CYCLE });
  _playerCache = { at: now, rows };
  return rows;
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

  return scored.map(({ p }) => {
    const team = p.team_abbrName ? ` · ${p.team_abbrName}` : "";
    const label =
      `${p.player_fullName} (${p.player_position ?? "?"} · ${p.player_ovr ?? "?"} OVR${team})`.slice(
        0,
        100 // Discord caps choice names at 100 chars
      );
    return { name: label, value: p.id || p.player_fullName };
  });
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
    const rows = await list("Roster", {
      cycle: CYCLE,
      player_fullName: playerFullName,
    });
    return rows[0] ?? null;
  } catch {
    return null;
  }
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
