// fantasyConfig.js — XCFL Vault fantasy league: constants, scoring rules, and
// the field-name resolution layer for Madden stat rows.
//
// EVERY assumption about what a WeeklyStats / Game / Player field is called
// lives in this file. If the export names something differently, fix it HERE
// and nothing else needs to change. Run `/fantasy doctor` to see what resolved.

export const LEAGUE_DEFAULTS = {
  name: 'XCFL Best Ball',
  season_number: 84,
  team_slots: 12,
  roster_size: 12,
  scoring_start_week: 3,
  regular_season_end_week: 13,
  playoff_start_week: 14,
  final_week_start: 16,
  final_week_end: 17,
  playoff_teams: 6,
  pick_clock_hours: 8,
  quiet_start_hour: 23, // 11pm — clock pauses
  quiet_end_hour: 8,    // 8am  — clock resumes
  timezone_offset_hours: -7, // America/Los_Angeles (PDT). Used only for quiet hours.
};

// Starting lineup. Strict position matching, no FLEX.
export const LINEUP_SLOTS = [
  { slot: 'QB', position: 'QB', count: 1 },
  { slot: 'HB', position: 'HB', count: 2 },
  { slot: 'WR', position: 'WR', count: 3 },
  { slot: 'TE', position: 'TE', count: 1 },
  { slot: 'DEF', position: 'DEF', count: 1 },
];

export const STARTER_COUNT = LINEUP_SLOTS.reduce((n, s) => n + s.count, 0); // 8
export const BENCH_COUNT = LEAGUE_DEFAULTS.roster_size - STARTER_COUNT;    // 4

// Roster construction rules enforced during the draft.
export const ROSTER_MIN = { QB: 1, HB: 2, WR: 3, TE: 1, DEF: 1 };
export const ROSTER_MAX = { QB: 3, HB: 6, WR: 7, TE: 3, DEF: 2 };

// Madden position -> fantasy position. Anything not listed is undraftable.
export const POSITION_MAP = {
  QB: 'QB',
  HB: 'HB', RB: 'HB', FB: 'HB',
  WR: 'WR',
  TE: 'TE',
};

export function fantasyPosition(maddenPos) {
  if (!maddenPos) return null;
  return POSITION_MAP[String(maddenPos).trim().toUpperCase()] || null;
}

// Positions whose individual stat lines roll up into a team defense score.
export const DEFENSIVE_POSITIONS = new Set([
  'DE', 'DT', 'LE', 'RE', 'LEDGE', 'REDGE', 'EDGE', 'NT',
  'LOLB', 'MLB', 'ROLB', 'OLB', 'ILB', 'LB', 'MIKE', 'SAM', 'WILL',
  'CB', 'FS', 'SS', 'S', 'DB',
]);

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const SCORING = {
  // Passing
  passYdsPerPoint: 25,
  passTD: 4,
  passInt: -2,
  passTwoPt: 2,
  // Rushing
  rushYdsPerPoint: 10,
  rushTD: 6,
  rushTwoPt: 2,
  // Receiving (full PPR)
  reception: 1,
  recYdsPerPoint: 10,
  recTD: 6,
  recTwoPt: 2,
  // Turnovers charged to the offensive player
  fumbleLost: -2,
  // Team defense (ESPN standard)
  defSack: 1,
  defInt: 2,
  defFumbleRec: 2,
  defSafety: 2,
  defTD: 6,
};

// ESPN standard points-allowed tiers.
export const DEF_POINTS_ALLOWED_TIERS = [
  { max: 0, points: 5 },
  { max: 6, points: 4 },
  { max: 13, points: 3 },
  { max: 17, points: 1 },
  { max: 27, points: 0 },
  { max: 34, points: -1 },
  { max: 45, points: -3 },
  { max: Infinity, points: -5 },
];

export function pointsAllowedScore(pa) {
  const n = Number(pa);
  if (!Number.isFinite(n)) return 0;
  for (const tier of DEF_POINTS_ALLOWED_TIERS) {
    if (n <= tier.max) return tier.points;
  }
  return -5;
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------
// Madden/Snallabot exports are inconsistent across versions and the app has
// been through an import refactor, so we never hard-code a single field name.
// Each logical stat lists candidate keys in priority order; the first key
// present on the row wins. resolveField() reports which one matched so the
// doctor command can show it.

export const STAT_FIELDS = {
  passYds:   ['passYds', 'passingYards', 'pass_yds', 'passTotalYds', 'passYards'],
  passTDs:   ['passTDs', 'passTD', 'passingTouchdowns', 'pass_tds', 'passTotalTDs'],
  passInts:  ['passInts', 'passInt', 'passingInterceptions', 'pass_ints', 'passTotalInts'],
  passSacks: ['passSacks', 'sacked', 'passTotalSacks'],
  rushYds:   ['rushYds', 'rushingYards', 'rush_yds', 'rushTotalYds', 'rushYards'],
  rushTDs:   ['rushTDs', 'rushTD', 'rushingTouchdowns', 'rush_tds', 'rushTotalTDs'],
  rushFum:   ['rushFum', 'rushFumbles', 'fumblesLost', 'rushTotalFum'],
  recCatches:['recCatches', 'receptions', 'recCatch', 'rec_catches', 'recTotalCatches'],
  recYds:    ['recYds', 'receivingYards', 'rec_yds', 'recTotalYds', 'recYards'],
  recTDs:    ['recTDs', 'recTD', 'receivingTouchdowns', 'rec_tds', 'recTotalTDs'],
  recFum:    ['recFum', 'recFumbles'],
  twoPt:     ['twoPtConv', 'twoPointConv', 'twoPt'],
  // Defense (individual player rows, summed to a team total)
  defSacks:  ['defSacks', 'sacks', 'def_sacks', 'defTotalSacks'],
  defInts:   ['defInts', 'defInt', 'interceptions', 'def_ints', 'defTotalInts'],
  defFumRec: ['defFumRec', 'fumblesRecovered', 'defFumbleRec', 'defTotalFumRec'],
  defTDs:    ['defTDs', 'defTD', 'defensiveTouchdowns', 'defTotalTDs'],
  defSafeties:['defSafeties', 'safeties', 'defSafety'],
  defTackles:['defTotalTackles', 'defTackles', 'tackles'],
};

// Keys that identify which player / team / week a stat row belongs to.
export const KEY_FIELDS = {
  playerName: ['player_fullName', 'playerName', 'fullName', 'name', 'player_name'],
  playerPosition: ['player_position', 'position', 'playerPosition', 'pos'],
  playerId: ['player_id', 'playerId', 'rosterId', 'id'],
  teamName: ['team_name', 'teamName', 'team_displayName', 'teamDisplayName', 'team'],
  teamAbbr: ['team_abbrName', 'teamAbbr', 'abbrName', 'team_abbr'],
  week: ['week', 'weekIndex', 'week_number', 'weekNumber'],
  season: ['season_number', 'seasonIndex', 'season', 'seasonNumber'],
};

export const GAME_FIELDS = {
  week: ['week', 'week_number', 'weekIndex', 'weekNumber'],
  season: ['season_number', 'seasonIndex', 'season', 'seasonNumber'],
  homeTeam: ['home_team', 'homeTeam', 'home_team_name', 'homeTeamName', 'home'],
  awayTeam: ['away_team', 'awayTeam', 'away_team_name', 'awayTeamName', 'away'],
  homeScore: ['home_score', 'homeScore', 'home_points', 'homeTeamScore'],
  awayScore: ['away_score', 'awayScore', 'away_points', 'awayTeamScore'],
  status: ['status', 'game_status', 'gameStatus', 'is_complete', 'completed'],
};

/** Return the first candidate key that is present (and non-null) on the row. */
export function resolveKey(row, candidates) {
  if (!row) return null;
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return key;
  }
  // Second pass: allow explicit zero / false values.
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null) return key;
  }
  return null;
}

export function readField(row, candidates, fallback = 0) {
  const key = resolveKey(row, candidates);
  if (!key) return fallback;
  return row[key];
}

export function readNumber(row, candidates) {
  const raw = readField(row, candidates, 0);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function readString(row, candidates) {
  const raw = readField(row, candidates, '');
  return raw == null ? '' : String(raw);
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/** Normalized name used to join stat rows to drafted players. */
export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable identity key for a drafted asset.
 * Players: "p:<normalized name>|<fantasy position>" (matches the app's
 * getDeduplicatedPlayers identity of name+position — player record ids are
 * re-minted every cycle and are NOT stable).
 * Defenses: "d:<normalized team name>".
 */
export function playerKey(name, fantasyPos) {
  return `p:${normalizeName(name)}|${String(fantasyPos || '').toUpperCase()}`;
}

export function defenseKey(teamName) {
  return `d:${normalizeName(teamName)}`;
}

export function isDefenseKey(key) {
  return String(key || '').startsWith('d:');
}

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
