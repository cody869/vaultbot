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
      headers: { "Content-Type": "application/json" },
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

// Stat leaders for a category. Returns top N sorted by the chosen field.
const STAT_CONFIG = {
  passing: { entity: "PassingStat", field: "passTotalYds", label: "Pass Yds" },
  rushing: { entity: "RushingStat", field: "rushTotalYds", label: "Rush Yds" },
  receiving: { entity: "ReceivingStat", field: "recTotalYds", label: "Rec Yds" },
  defense: { entity: "DefenseStat", field: "defTotalSacks", label: "Sacks" },
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

// Look up a single player by (partial) name. Returns the best match, plus a
// list of other near-matches so the caller can disambiguate if needed.
export async function getPlayer(name) {
  const all = await list("Player", { cycle: CYCLE });
  if (!all.length) return { match: null, others: [] };

  const q = name.trim().toLowerCase();

  // Rank: exact > startsWith > includes. Prefer higher OVR within a tier.
  const scored = all
    .map((p) => {
      const n = (p.player_fullName ?? "").toLowerCase();
      let tier = -1;
      if (n === q) tier = 3;
      else if (n.startsWith(q)) tier = 2;
      else if (n.includes(q)) tier = 1;
      return { p, tier };
    })
    .filter((x) => x.tier > 0)
    .sort(
      (a, b) => b.tier - a.tier || (b.p.player_ovr ?? 0) - (a.p.player_ovr ?? 0)
    );

  return {
    match: scored.length ? scored[0].p : null,
    others: scored.slice(1, 6).map((x) => x.p),
  };
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
