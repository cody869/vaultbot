// vault.js — thin wrapper around the Base44 SDK for reading XCFL Vault data.
// All the entities the bot reads have open read permissions, so an app id is enough.
import { createClient } from "@base44/sdk";

const APP_ID = process.env.BASE44_APP_ID;

if (!APP_ID) {
  console.error("Missing BASE44_APP_ID in environment. See README.");
  process.exit(1);
}

export const base44 = createClient({ appId: APP_ID });

// If you ever lock entities behind auth, set BASE44_AUTH_TOKEN and uncomment:
// if (process.env.BASE44_AUTH_TOKEN) base44.auth.setToken(process.env.BASE44_AUTH_TOKEN);

const CYCLE = process.env.XCFL_CYCLE || "M26";

// --- helpers -------------------------------------------------------------

// Generic safe list. Base44 entities expose .filter()/.list().
async function list(entity, filter = {}, opts = {}) {
  try {
    if (Object.keys(filter).length) {
      return await base44.entities[entity].filter(filter, opts.sort, opts.limit);
    }
    return await base44.entities[entity].list(opts.sort, opts.limit);
  } catch (err) {
    console.error(`Base44 read failed for ${entity}:`, err.message);
    throw new Error(`Could not reach the Vault for ${entity}.`);
  }
}

// --- data accessors used by commands -------------------------------------

// Standings: most recent season's records, sorted by wins.
export async function getStandings(seasonNumber) {
  let records = await list("SeasonRecord", { cycle: CYCLE });
  if (!records.length) return { season: null, rows: [] };

  // Pick target season (explicit arg, else the highest season number present).
  const season =
    seasonNumber ??
    Math.max(...records.map((r) => r.season_number ?? 0));

  const rows = records
    .filter((r) => r.season_number === season)
    .sort(
      (a, b) =>
        (b.wins ?? 0) - (a.wins ?? 0) ||
        (b.points_for ?? 0) - (a.points_for ?? 0)
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
