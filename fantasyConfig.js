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
  pick_clock_minutes: 480, // 8h. Canonical clock field — minutes so short
                           // clocks (a live 90-second draft) are expressible.
  pick_clock_hours: 8,     // legacy; read only if minutes is unset
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

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------
// The constants above are DEFAULTS. A live league stores its own format and
// scoring on the FantasyLeague row so the commissioner can change them from
// Discord without a deploy. Always read config through these resolvers rather
// than importing the constants directly.

export const POSITION_ORDER = ['QB', 'HB', 'WR', 'TE', 'DEF'];

/** Lineup slots for a league, falling back to the defaults. */
export function resolveLineup(league) {
  if (!league) return LINEUP_SLOTS;
  const counts = {
    QB: league.lineup_qb,
    HB: league.lineup_hb,
    WR: league.lineup_wr,
    TE: league.lineup_te,
    DEF: league.lineup_def,
  };
  // If the row carries no lineup at all, use the defaults untouched.
  if (Object.values(counts).every((v) => v == null)) return LINEUP_SLOTS;

  const fallback = Object.fromEntries(LINEUP_SLOTS.map((l) => [l.position, l.count]));
  return POSITION_ORDER
    .map((pos) => ({
      slot: pos,
      position: pos,
      count: counts[pos] == null ? fallback[pos] ?? 0 : Number(counts[pos]),
    }))
    .filter((l) => l.count > 0);
}

export function starterCount(league) {
  return resolveLineup(league).reduce((n, s) => n + s.count, 0);
}

export function rosterSizeOf(league) {
  return Number(league?.roster_size ?? LEAGUE_DEFAULTS.roster_size);
}

export function benchCount(league) {
  return Math.max(0, rosterSizeOf(league) - starterCount(league));
}

/**
 * Roster minimums and maximums derived from the lineup.
 * Minimum = the number of starting slots at that position, so a legal roster
 * can always field a full lineup. Maximum scales with the slot count and the
 * bench so a 3-WR league can stack receivers but a 1-QB league can't hoard QBs.
 */
export function resolveRosterLimits(league) {
  const lineup = resolveLineup(league);
  const bench = benchCount(league);
  const min = {}, max = {};
  for (const { position, count } of lineup) {
    min[position] = count;
    // DEF is a special case: nobody needs three team defenses.
    max[position] = position === 'DEF'
      ? Math.min(count + 1, count + bench)
      : count + bench;
  }
  return { min, max };
}

/** Scoring rules for a league, merged over the defaults. */
export function resolveScoring(league) {
  if (!league) return SCORING;
  const overrides = {
    reception: league.score_ppr,
    passYdsPerPoint: league.score_pass_yds_per_point,
    passTD: league.score_pass_td,
    passInt: league.score_pass_int,
    rushYdsPerPoint: league.score_rush_yds_per_point,
    rushTD: league.score_rush_td,
    recYdsPerPoint: league.score_rec_yds_per_point,
    recTD: league.score_rec_td,
    fumbleLost: league.score_fumble_lost,
    defSack: league.score_def_sack,
    defInt: league.score_def_int,
    defFumbleRec: league.score_def_fumble_rec,
    defSafety: league.score_def_safety,
    defTD: league.score_def_td,
  };
  const out = { ...SCORING };
  for (const [k, v] of Object.entries(overrides)) {
    if (v != null && v !== '' && !isNaN(Number(v))) out[k] = Number(v);
  }
  return out;
}

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
  // VERIFIED against base44/entities/WeeklyStats.jsonc (Aug 2026). The export
  // is snake_case; camelCase variants are kept only as defensive fallbacks.
  passYds:    ['pass_yds', 'passYds', 'passingYards'],
  passTDs:    ['pass_tds', 'passTDs', 'passingTouchdowns'],
  passInts:   ['pass_ints', 'passInts', 'passingInterceptions'],
  passSacks:  ['pass_sacks', 'passSacks'],
  rushYds:    ['rush_yds', 'rushYds', 'rushingYards'],
  rushTDs:    ['rush_tds', 'rushTDs', 'rushingTouchdowns'],
  rushFum:    ['rush_fum', 'rushFum', 'fumblesLost'],
  recCatches: ['rec_catches', 'recCatches', 'receptions'],
  recYds:     ['rec_yds', 'recYds', 'receivingYards'],
  recTDs:     ['rec_tds', 'recTDs', 'receivingTouchdowns'],
  recFum:     ['rec_fum', 'recFum'],
  // Defense — individual player rows, summed to a team total.
  defSacks:   ['def_sacks', 'defSacks'],
  defInts:    ['def_ints', 'defInts'],
  defFumRec:  ['def_fum_rec', 'defFumRec'],
  defForcedFum: ['def_forced_fum', 'defForcedFum'],
  defTackles: ['def_total_tackles', 'defTotalTackles'],
  // NOT PRESENT in the current WeeklyStats schema. Left mapped so that if the
  // export ever starts carrying them, scoring picks them up with no code
  // change. Until then these score 0 — see the DEF caveat in INSTALL.md.
  defTDs:     ['def_tds', 'defTDs'],
  defSafeties:['def_safeties', 'defSafeties'],
};

// Identity fields on a WeeklyStats row.
// NOTE: WeeklyStats carries NO position field. Offensive stat rows are matched
// to drafted players by normalized name (with team as a tiebreak), and team
// defense is summed across every row for that team — so position is never
// needed at scoring time.
export const KEY_FIELDS = {
  playerName: ['player_full_name', 'player_fullName', 'playerName'],
  playerId: ['player_id', 'playerId'],
  rosterId: ['roster_id', 'madden_roster_id', 'rosterId'],
  teamName: ['team_name', 'teamName', 'team_displayName'],
  teamAbbr: ['team_abbrName', 'teamAbbr'],
  week: ['week_index', 'week', 'weekIndex'],
  season: ['season_index', 'season_number', 'seasonIndex'],
  cycle: ['cycle'],
};

// VERIFIED against base44/entities/Game.jsonc.
// user1 is the HOME side and user2 the AWAY side (confirmed against the S83
// playoff run: Titans beat the Eagles 43-38 in week 23 as the away team).
// `status` is the game TYPE (1 = regular season, 2 = playoff), NOT a
// completion flag — never use it to decide whether a game has been played.
export const GAME_FIELDS = {
  week: ['week', 'week_number'],
  season: ['season_number', 'seasonIndex'],
  homeTeam: ['homeTeam', 'home_team'],
  awayTeam: ['awayTeam', 'away_team'],
  homeScore: ['user1_score', 'home_score', 'homeScore'],
  awayScore: ['user2_score', 'away_score', 'awayScore'],
  gameType: ['status'],
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
