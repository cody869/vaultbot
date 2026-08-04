// vault.js — reads XCFL Vault data from Base44.
// ... (keep all existing imports and auth code) ...

const APP_ID = process.env.BASE44_APP_ID;
const SERVER = process.env.BASE44_SERVER_URL || "https://base44.app";

if (!APP_ID) {
  console.error("Missing BASE44_APP_ID in environment. See README.");
  process.exit(1);
}

// Cache the current cycle from AppConfig (refresh every minute)
let _cycleCache = { at: 0, cycle: process.env.XCFL_CYCLE || "M26" };
const CYCLE_TTL_MS = 60_000;

async function getCurrentCycle() {
  const now = Date.now();
  if (now - _cycleCache.at < CYCLE_TTL_MS) {
    return _cycleCache.cycle;
  }

  try {
    const config = await list("AppConfig");
    if (config && config.length > 0 && config[0].current_cycle) {
      _cycleCache = { at: now, cycle: config[0].current_cycle };
      return config[0].current_cycle;
    }
  } catch (err) {
    console.error("Could not fetch current cycle from AppConfig:", err.message);
  }

  // Fall back to env var or M26
  return process.env.XCFL_CYCLE || "M26";
}

// --- auth ----------------------------------------------------------------

let _token = null;

// ... (keep all existing auth code unchanged) ...

// --- helpers -------------------------------------------------------------

// ... (keep the list() function unchanged) ...

// --- data accessors used by commands -------------------------------------

// Standings, derived from TeamStat (cumulative win/loss per team per week).
// TeamStat is keyed by Madden team_id and has one row per week, so we take the
// latest week's row per team in the target season, then join TeamMap for names.
export async function getStandings(seasonNumber) {
  const stats = await list("TeamStat");
  if (!stats.length) return { season: null, rows: [] };

  // ... (rest unchanged) ...
}

// ... (keep getScores, getScoreWeeks, getScoresSignature unchanged) ...

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
  let rows = await list(cfg.entity, { cycle });
  if (!rows.length) return { ...cfg, season: null, leaders: [] };

  // ... (rest unchanged) ...
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
    const recs = await list("SeasonRecord", { cycle });
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

  // ... (rest unchanged) ...
}

// ... (keep getTradeBlock, getTradeBlockTeams unchanged) ...

// Cache the full player list briefly so autocomplete (which fires on every
// keystroke) doesn't hit the API repeatedly.
let _playerCache = { at: 0, rows: [] };
const PLAYER_TTL_MS = 60_000; // 1 minute

async function getAllPlayers() {
  const now = Date.now();
  if (now - _playerCache.at < PLAYER_TTL_MS && _playerCache.rows.length) {
    return _playerCache.rows;
  }
  const cycle = await getCurrentCycle();
  const rows = await list("Player", { cycle });
  _playerCache = { at: now, rows };
  return rows;
}

// ... (keep suggestPlayers, getPlayerById, getPlayer unchanged) ...

// Look up a Roster row for a player (gives team name + abbreviation for the
// helmet/header) — falls back gracefully if the player isn't rostered.
export async function getRosterFor(playerFullName) {
  try {
    const cycle = await getCurrentCycle();
    const rows = await list("Roster", {
      cycle,
      player_fullName: playerFullName,
    });
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

// ... (keep getTrades unchanged) ...
