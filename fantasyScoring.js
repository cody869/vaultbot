// fantasyScoring.js — pure scoring. No network, no Discord. Testable in isolation.

import {
  SCORING,
  LINEUP_SLOTS,
  STAT_FIELDS,
  KEY_FIELDS,
  GAME_FIELDS,
  pointsAllowedScore,
  readNumber,
  readString,
  normalizeName,
  isDefenseKey,
  round2,
} from './fantasyConfig.js';

// ---------------------------------------------------------------------------
// Individual player scoring
// ---------------------------------------------------------------------------

/**
 * Fantasy points for one offensive player's stat row.
 * Returns { points, breakdown } — breakdown is used by /fantasy scores so a
 * disputed total can be audited without re-reading the export.
 */
export function scorePlayerRow(row) {
  const passYds = readNumber(row, STAT_FIELDS.passYds);
  const passTDs = readNumber(row, STAT_FIELDS.passTDs);
  const passInts = readNumber(row, STAT_FIELDS.passInts);
  const rushYds = readNumber(row, STAT_FIELDS.rushYds);
  const rushTDs = readNumber(row, STAT_FIELDS.rushTDs);
  const rushFum = readNumber(row, STAT_FIELDS.rushFum);
  const recCatches = readNumber(row, STAT_FIELDS.recCatches);
  const recYds = readNumber(row, STAT_FIELDS.recYds);
  const recTDs = readNumber(row, STAT_FIELDS.recTDs);
  const recFum = readNumber(row, STAT_FIELDS.recFum);

  const breakdown = {
    passYds: passYds / SCORING.passYdsPerPoint,
    passTD: passTDs * SCORING.passTD,
    passInt: passInts * SCORING.passInt,
    rushYds: rushYds / SCORING.rushYdsPerPoint,
    rushTD: rushTDs * SCORING.rushTD,
    rec: recCatches * SCORING.reception,
    recYds: recYds / SCORING.recYdsPerPoint,
    recTD: recTDs * SCORING.recTD,
    fumbles: (rushFum + recFum) * SCORING.fumbleLost,
  };

  const points = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { points: round2(points), breakdown, raw: { passYds, passTDs, passInts, rushYds, rushTDs, recCatches, recYds, recTDs } };
}

/**
 * Team defense score for one week.
 * Defensive counting stats are summed from that team's individual defensive
 * player rows (more reliable than the team-level export, which doesn't always
 * carry sacks/INTs). Points allowed comes from the Game row.
 */
export function scoreTeamDefense(defRows, pointsAllowed) {
  let sacks = 0, ints = 0, fumRec = 0, tds = 0, safeties = 0;

  for (const row of defRows) {
    sacks += readNumber(row, STAT_FIELDS.defSacks);
    ints += readNumber(row, STAT_FIELDS.defInts);
    fumRec += readNumber(row, STAT_FIELDS.defFumRec);
    tds += readNumber(row, STAT_FIELDS.defTDs);
    safeties += readNumber(row, STAT_FIELDS.defSafeties);
  }

  const breakdown = {
    sacks: sacks * SCORING.defSack,
    ints: ints * SCORING.defInt,
    fumbleRec: fumRec * SCORING.defFumbleRec,
    safeties: safeties * SCORING.defSafety,
    defTD: tds * SCORING.defTD,
    pointsAllowed: pointsAllowedScore(pointsAllowed),
  };

  const points = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return {
    points: round2(points),
    breakdown,
    raw: { sacks, ints, fumRec, tds, safeties, pointsAllowed },
  };
}

// ---------------------------------------------------------------------------
// Best-ball optimal lineup
// ---------------------------------------------------------------------------

/**
 * Given every rostered asset with its weekly points, pick the highest-scoring
 * legal lineup. Slots are strict (no FLEX), so this is just "take the top N of
 * each position" — no search needed.
 *
 * entries: [{ key, name, position, points, played }]
 * returns { starters, bench, total }
 */
export function optimalLineup(entries) {
  const byPosition = new Map();
  for (const e of entries) {
    const pos = String(e.position || '').toUpperCase();
    if (!byPosition.has(pos)) byPosition.set(pos, []);
    byPosition.get(pos).push(e);
  }
  for (const list of byPosition.values()) {
    list.sort((a, b) => (b.points || 0) - (a.points || 0));
  }

  const starters = [];
  const usedKeys = new Set();

  for (const { slot, position, count } of LINEUP_SLOTS) {
    const pool = byPosition.get(position) || [];
    let filled = 0;
    for (const entry of pool) {
      if (filled >= count) break;
      if (usedKeys.has(entry.key)) continue;
      starters.push({ ...entry, slot });
      usedKeys.add(entry.key);
      filled += 1;
    }
    // Short-rostered slots stay empty and simply score 0.
    while (filled < count) {
      starters.push({ key: null, name: '—', position, points: 0, slot, empty: true });
      filled += 1;
    }
  }

  const bench = entries
    .filter((e) => !usedKeys.has(e.key))
    .sort((a, b) => (b.points || 0) - (a.points || 0));

  const total = round2(starters.reduce((sum, s) => sum + (s.points || 0), 0));
  return { starters, bench, total };
}

// ---------------------------------------------------------------------------
// Week assembly
// ---------------------------------------------------------------------------

/**
 * Index this week's stat rows.
 *
 * WeeklyStats has no position field, so offensive rows are keyed by normalized
 * player name (plus a name|team key for disambiguating duplicate names), and
 * team defense simply collects EVERY row for that team — offensive players
 * carry no def_* values, so summing across all of them is safe and avoids
 * needing a position join at scoring time.
 */
export function indexWeeklyStats(statRows, { season, week }) {
  const byName = new Map();
  const byNameTeam = new Map();
  const defenseByTeam = new Map();

  for (const row of statRows) {
    const rowSeason = readNumber(row, KEY_FIELDS.season);
    const rowWeek = readNumber(row, KEY_FIELDS.week);
    if (season != null && rowSeason !== season) continue;
    if (week != null && rowWeek !== week) continue;

    const name = readString(row, KEY_FIELDS.playerName);
    const team = readString(row, KEY_FIELDS.teamName);
    if (!name) continue;

    const nKey = normalizeName(name);
    // A player can appear on more than one row (passing / rushing splits in
    // some exports) — merge rather than overwrite.
    byName.set(nKey, byName.has(nKey) ? mergeStatRows(byName.get(nKey), row) : row);

    if (team) {
      const ntKey = `${nKey}|${normalizeName(team)}`;
      byNameTeam.set(ntKey, byNameTeam.has(ntKey) ? mergeStatRows(byNameTeam.get(ntKey), row) : row);

      const tKey = normalizeName(team);
      if (!defenseByTeam.has(tKey)) defenseByTeam.set(tKey, []);
      defenseByTeam.get(tKey).push(row);
    }
  }

  return { byName, byNameTeam, defenseByTeam };
}

/** Combine two rows for the same player (some exports split pass/rush lines). */
function mergeStatRows(a, b) {
  const merged = { ...a };
  for (const candidates of Object.values(STAT_FIELDS)) {
    for (const key of candidates) {
      if (b[key] !== undefined && b[key] !== null) {
        merged[key] = (Number(a[key]) || 0) + (Number(b[key]) || 0);
        break;
      }
    }
  }
  return merged;
}

/** Points allowed per team for a week, derived from Game rows. */
export function pointsAllowedByTeam(gameRows, { season, week }) {
  const map = new Map();
  for (const g of gameRows) {
    const gSeason = readNumber(g, GAME_FIELDS.season);
    const gWeek = readNumber(g, GAME_FIELDS.week);
    if (season != null && gSeason !== season) continue;
    if (week != null && gWeek !== week) continue;

    const home = readString(g, GAME_FIELDS.homeTeam);
    const away = readString(g, GAME_FIELDS.awayTeam);
    const homeScore = readNumber(g, GAME_FIELDS.homeScore);
    const awayScore = readNumber(g, GAME_FIELDS.awayScore);

    if (home) map.set(normalizeName(home), awayScore);
    if (away) map.set(normalizeName(away), homeScore);
  }
  return map;
}

/**
 * True when every scheduled game for the week has a result.
 * Game.status is the game TYPE (1 = regular, 2 = playoff), not a completion
 * flag, so a played game is detected purely by a non-zero score. A genuine
 * 0-0 final is not reachable in Madden.
 */
export function weekIsComplete(gameRows, { season, week }) {
  const games = gameRows.filter((g) => {
    const gSeason = readNumber(g, GAME_FIELDS.season);
    const gWeek = readNumber(g, GAME_FIELDS.week);
    return gSeason === season && gWeek === week;
  });
  if (!games.length) return { complete: false, played: 0, total: 0 };

  let played = 0;
  for (const g of games) {
    const homeScore = readNumber(g, GAME_FIELDS.homeScore);
    const awayScore = readNumber(g, GAME_FIELDS.awayScore);
    if (homeScore > 0 || awayScore > 0) played += 1;
  }
  return { complete: played === games.length, played, total: games.length };
}

/**
 * Score one fantasy team for one week.
 * roster: [{ key, name, position, nfl_team }]
 */
export function scoreRosterWeek(roster, { byName, byNameTeam, defenseByTeam, paByTeam }) {
  const entries = roster.map((slot) => {
    if (isDefenseKey(slot.key)) {
      const teamKey = normalizeName(slot.nfl_team || slot.name);
      const defRows = defenseByTeam.get(teamKey) || [];
      const pa = paByTeam.get(teamKey);
      const played = defRows.length > 0 || pa !== undefined;
      const { points, breakdown, raw } = scoreTeamDefense(defRows, pa);
      return {
        key: slot.key,
        name: slot.name,
        position: 'DEF',
        nfl_team: slot.nfl_team || slot.name,
        points: played ? points : 0,
        played,
        breakdown,
        raw,
      };
    }

    // Prefer the name+team match so two players sharing a name can't collide;
    // fall back to name alone, since a drafted player may have been traded to
    // a different XCFL team mid-season.
    const nKey = normalizeName(slot.name);
    const row = (slot.nfl_team ? byNameTeam.get(`${nKey}|${normalizeName(slot.nfl_team)}`) : null)
      || byName.get(nKey);

    if (!row) {
      return { key: slot.key, name: slot.name, position: slot.position, nfl_team: slot.nfl_team, points: 0, played: false, breakdown: {}, raw: {} };
    }
    const { points, breakdown, raw } = scorePlayerRow(row);
    return { key: slot.key, name: slot.name, position: slot.position, nfl_team: slot.nfl_team, points, played: true, breakdown, raw };
  });

  const { starters, bench, total } = optimalLineup(entries);
  return { entries, starters, bench, total };
}
