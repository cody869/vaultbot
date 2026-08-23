// fantasyDraft.js — async snake draft engine.

import {
  ENTITIES,
  getLeague,
  getPlayers,
  getRosters,
  getWeeklyStats,
  getGames,
  getTeams,
  getPicks,
  createEntity,
  updateEntity,
  invalidate,
} from './fantasyStore.js';

import { scorePlayerRow, scoreTeamDefense } from './fantasyScoring.js';
import { getMemberByDiscordId } from './vault.js';

import {
  GAME_FIELDS,
  KEY_FIELDS,
  readNumber,
  readString,
  LEAGUE_DEFAULTS,
  resolveRosterLimits,
  rosterSizeOf,
  fantasyPosition,
  playerKey,
  defenseKey,
  normalizeName,
  resolveScoring,
} from './fantasyConfig.js';

// ---------------------------------------------------------------------------
// Draft pool
// ---------------------------------------------------------------------------

const OVR_FIELDS = ['player_ovr', 'player_bestOvr', 'playerBestOvr', 'overall', 'ovr'];

function readOvr(p) {
  for (const f of OVR_FIELDS) {
    const n = Number(p[f]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

let poolCache = null;
let poolCachedAt = 0;

/**
 * Season-to-date fantasy points for every player and defense, using the same
 * scoring rules the league is played under.
 *
 * The draft opens in week 5, so real production already exists — ranking on it
 * is far more useful than Madden OVR, which says nothing about usage. Falls
 * back to OVR for anyone with no stats yet (rookies, backups, injured).
 */
/**
 * Look up key into the season-points map.
 *
 * Asset keys carry a position (`p:name|WR`) but the stats side cannot — the
 * WeeklyStats rows have no position field — so player points are keyed by name
 * alone. Defenses key identically on both sides and pass through unchanged.
 */
export function pointsKeyFor(asset) {
  if (String(asset.position).toUpperCase() === 'DEF') return asset.key;
  return `p:${normalizeName(asset.name)}`;
}

export async function seasonPointsByKey(league) {
  const season = league?.season_number ?? LEAGUE_DEFAULTS.season_number;
  const [statRows, games] = await Promise.all([getWeeklyStats(season), getGames(season)]);
  const scoring = resolveScoring(league);

  const paByTeamWeek = new Map();
  for (const g of games) {
    if (readNumber(g, GAME_FIELDS.season) !== season) continue;
    const wk = readNumber(g, GAME_FIELDS.week);
    const home = normalizeName(readString(g, GAME_FIELDS.homeTeam));
    const away = normalizeName(readString(g, GAME_FIELDS.awayTeam));
    if (home) paByTeamWeek.set(`${home}|${wk}`, readNumber(g, GAME_FIELDS.awayScore));
    if (away) paByTeamWeek.set(`${away}|${wk}`, readNumber(g, GAME_FIELDS.homeScore));
  }

  const byName = new Map();      // normalized player name -> points
  const defByTeamWeek = new Map(); // "team|week" -> rows

  for (const row of statRows) {
    if (readNumber(row, KEY_FIELDS.season) !== season) continue;
    const name = readString(row, KEY_FIELDS.playerName);
    const team = normalizeName(readString(row, KEY_FIELDS.teamName));
    const wk = readNumber(row, KEY_FIELDS.week);

    if (name) {
      const k = normalizeName(name);
      byName.set(k, (byName.get(k) || 0) + scorePlayerRow(row, scoring).points);
    }
    if (team) {
      const k = `${team}|${wk}`;
      if (!defByTeamWeek.has(k)) defByTeamWeek.set(k, []);
      defByTeamWeek.get(k).push(row);
    }
  }

  const out = new Map();
  // Keyed by normalized NAME only, with no position suffix: WeeklyStats has
  // no position field, so the stat side cannot construct a name|POS key. The
  // pool looks these up via pointsKeyFor() below, which strips the position.
  for (const [k, pts] of byName) out.set(`p:${k}`, Math.round(pts * 100) / 100);

  // Defenses score per week, so sum each team's weekly totals.
  const defTotals = new Map();
  for (const [k, rows] of defByTeamWeek) {
    const [team, wk] = k.split('|');
    const pa = paByTeamWeek.get(`${team}|${wk}`);
    if (pa === undefined) continue; // that team did not play that week
    const pts = scoreTeamDefense(rows, pa, scoring).points;
    defTotals.set(team, (defTotals.get(team) || 0) + pts);
  }
  for (const [team, pts] of defTotals) {
    out.set(`d:${team}`, Math.round(pts * 100) / 100);
  }

  return out;
}

/**
 * Draftable assets: currently rostered QB/HB/WR/TE plus one D/ST per team.
 *
 * VERIFIED against live data (Aug 2026): M27 Player rows have an EMPTY
 * team_name — the team lives on the Roster entity. The two are joined on
 * madden_roster_id, which is a real Madden id and stable across the cycle
 * (Base44 record ids are re-minted on every import, so they can't be used).
 * Roster supplies the team; Player supplies position, OVR and dev trait.
 */
export async function buildDraftPool({ cycle = null, ttlMs = 10 * 60 * 1000, league = null } = {}) {
  const leagueForPoints = league || { season_number: LEAGUE_DEFAULTS.season_number };
  if (poolCache && Date.now() - poolCachedAt < ttlMs) return poolCache;

  const [players, rosters] = await Promise.all([getPlayers(cycle), getRosters(cycle)]);

  // madden_roster_id -> team, with a normalized-name fallback.
  // VERIFIED: a meaningful share of Roster rows carry madden_roster_id: null
  // (Jalen Hurts, Jake Ferguson, Javonte Williams, Tony Pollard among them).
  // Joining on the id alone would silently drop those players from the pool.
  const teamByRosterId = new Map();
  const teamByName = new Map();
  const teamNames = new Set();
  for (const r of rosters) {
    if (cycle && r.cycle && r.cycle !== cycle) continue;
    const team = (r.team_name || '').trim();
    if (!team || team.toLowerCase() === 'free agent') continue;
    teamNames.add(team);
    if (r.madden_roster_id != null) teamByRosterId.set(String(r.madden_roster_id), team);
    if (r.player_fullName) teamByName.set(normalizeName(r.player_fullName), team);
  }

  const seen = new Map();
  for (const p of players) {
    if (cycle && p.cycle && p.cycle !== cycle) continue;

    const pos = fantasyPosition(p.player_position);
    if (!pos) continue;

    const name = p.player_fullName || '';
    if (!name) continue;

    // "Currently rostered" only — a player with no Roster row is a free agent.
    const team = (p.madden_roster_id != null ? teamByRosterId.get(String(p.madden_roster_id)) : null)
      || teamByName.get(normalizeName(name))
      || (p.team_name || '').trim();
    if (!team || team.toLowerCase() === 'free agent') continue;

    const key = playerKey(name, pos);
    const ovr = readOvr(p);
    const existing = seen.get(key);
    if (!existing || ovr > existing.ovr) {
      seen.set(key, {
        key,
        name,
        position: pos,
        madden_position: p.player_position,
        nfl_team: team,
        ovr,
        dev: p.player_devTrait || '',
        player_id: p.id,
      });
    }
  }

  const defenses = [...teamNames].sort().map((team) => ({
    key: defenseKey(team),
    name: `${team} D/ST`,
    position: 'DEF',
    madden_position: 'DEF',
    nfl_team: team,
    ovr: 0,
    dev: '',
    player_id: null,
  }));

  // Rank by production this season, falling back to OVR for players with no
  // stats yet. `rank` is what the autocomplete and autopick sort on.
  let points = new Map();
  try {
    points = await seasonPointsByKey(leagueForPoints);
  } catch (err) {
    console.error('[fantasy] season points unavailable, ranking on OVR:', err.message);
  }

  const pool = [...seen.values(), ...defenses].map((a) => {
    const pts = points.get(pointsKeyFor(a));
    return {
      ...a,
      season_points: pts ?? null,
      // OVR-only players sort below anyone with real production. Scaling OVR
      // into a small range keeps their relative order without letting an
      // unproven 90 OVR outrank someone actually producing.
      rank: pts != null ? pts : (a.ovr || 60) / 100,
    };
  }).sort((a, b) => b.rank - a.rank);

  poolCache = pool;
  poolCachedAt = Date.now();
  const scored = pool.filter((a) => a.season_points != null).length;
  console.log(`[fantasy] draft pool: ${seen.size} players + ${defenses.length} defenses across ${teamNames.size} teams (${scored} with S${leagueForPoints.season_number} stats)`);
  return pool;
}

export function invalidatePool() {
  poolCache = null;
}

/**
 * Prime the draft pool at startup and on an interval.
 *
 * buildDraftPool now pages through Player/Roster/WeeklyStats/Game rather than
 * one request each, so a cold rebuild easily exceeds the 3s Discord allows
 * for autocomplete. A process restart wipes poolCache, so without this the
 * very next /fantasy pick or /fantasy queue autocomplete after a deploy fails
 * with "Loading options failed" until something else happens to warm it.
 *
 * Not gated on draft_status: /fantasy queue is meant to be usable before the
 * draft starts (status 'pending'), so restricting this to 'in_progress' left
 * queue's autocomplete cold the whole time a draft is being set up.
 */
export async function warmDraftPool() {
  const league = await getLeague();
  if (!league) return null;
  return buildDraftPool({ cycle: league.cycle || null, league });
}

// ---------------------------------------------------------------------------
// Snake order
// ---------------------------------------------------------------------------

/**
 * 1-based pick number -> { round, slotIndex }.
 * Snake reverses every even round; linear keeps the same order every round.
 */
export function snakePosition(pickNumber, teamCount, draftType = 'snake') {
  const zero = pickNumber - 1;
  const round = Math.floor(zero / teamCount) + 1;
  const indexInRound = zero % teamCount;
  const slotIndex = draftType === 'linear'
    ? indexInRound
    : (round % 2 === 1 ? indexInRound : teamCount - 1 - indexInRound);
  return { round, slotIndex };
}

export function teamOnTheClock(league, teams) {
  const order = Array.isArray(league.draft_order) ? league.draft_order : [];
  if (!order.length) return null;
  const pickNumber = league.current_pick_number || 1;
  const totalPicks = order.length * rosterSizeOf(league);
  if (pickNumber > totalPicks) return null;

  const { round, slotIndex } = snakePosition(pickNumber, order.length, league.draft_type);
  const teamId = order[slotIndex];
  const team = teams.find((t) => t.id === teamId);
  return team ? { team, round, pickNumber, slotIndex } : null;
}

export function shuffle(array) {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clock (with quiet hours)
// ---------------------------------------------------------------------------

/**
 * Deadline = now + clock hours, but the clock pauses overnight. If the
 * deadline lands inside quiet hours, it's pushed to the end of the window.
 */
/** Clock length in minutes, tolerating the legacy hours-only field. */
export function clockMinutes(league) {
  if (league?.pick_clock_minutes != null) return Number(league.pick_clock_minutes);
  if (league?.pick_clock_hours != null) return Number(league.pick_clock_hours) * 60;
  return LEAGUE_DEFAULTS.pick_clock_minutes;
}

export function computeDeadline(league, from = new Date()) {
  const minutes = clockMinutes(league);
  const tzOffset = league.timezone_offset_hours ?? LEAGUE_DEFAULTS.timezone_offset_hours;
  const quietStart = league.quiet_start_hour ?? LEAGUE_DEFAULTS.quiet_start_hour;
  const quietEnd = league.quiet_end_hour ?? LEAGUE_DEFAULTS.quiet_end_hour;

  let deadline = new Date(from.getTime() + minutes * 60 * 1000);
  if (quietStart === quietEnd) return deadline;

  const localHour = (d) => {
    const h = d.getUTCHours() + tzOffset;
    return ((h % 24) + 24) % 24;
  };

  const inQuiet = (h) => (quietStart < quietEnd
    ? h >= quietStart && h < quietEnd
    : h >= quietStart || h < quietEnd);

  // Walk forward hour by hour until we're clear of the window (max 24 hops).
  let guard = 0;
  while (inQuiet(localHour(deadline)) && guard < 24) {
    deadline = new Date(deadline.getTime() + 3600 * 1000);
    guard += 1;
  }
  return deadline;
}

// ---------------------------------------------------------------------------
// Roster legality
// ---------------------------------------------------------------------------

export function rosterCounts(roster) {
  const counts = { QB: 0, HB: 0, WR: 0, TE: 0, DEF: 0 };
  for (const slot of roster || []) {
    const pos = String(slot.position || '').toUpperCase();
    if (counts[pos] !== undefined) counts[pos] += 1;
  }
  return counts;
}

/**
 * Which positions this team may legally take with its next pick.
 * Blocks position caps, and once remaining picks exactly equal remaining
 * minimum requirements, restricts to the positions still owed.
 */
export function eligiblePositions(roster, league = null) {
  const { min, max } = resolveRosterLimits(league);
  const rosterSize = rosterSizeOf(league);
  const counts = rosterCounts(roster);
  const picksLeft = rosterSize - (roster?.length || 0);

  const owed = {};
  let owedTotal = 0;
  for (const [pos, m] of Object.entries(min)) {
    const short = Math.max(0, m - (counts[pos] || 0));
    owed[pos] = short;
    owedTotal += short;
  }

  const underCap = Object.keys(min).filter((pos) => (counts[pos] || 0) < (max[pos] ?? 99));
  if (picksLeft <= owedTotal) {
    return underCap.filter((pos) => owed[pos] > 0);
  }
  return underCap;
}

export function canDraft(roster, position, league = null) {
  const allowed = eligiblePositions(roster, league);
  const pos = String(position || '').toUpperCase();
  if (!allowed.includes(pos)) {
    const { max } = resolveRosterLimits(league);
    const counts = rosterCounts(roster);
    if ((counts[pos] || 0) >= (max[pos] ?? 99)) {
      return { ok: false, reason: `You already have the max ${pos} (${max[pos]}).` };
    }
    return {
      ok: false,
      reason: `You need to fill required slots with your remaining picks. Still allowed: ${allowed.join(', ') || 'none'}.`,
    };
  }
  return { ok: true };
}

/**
 * The real NFL team this manager controls in the underlying Madden
 * franchise, normalized for comparison against asset.nfl_team — or null if
 * their Discord isn't linked to a LeagueMember with a team.
 *
 * A manager drafting their own controlled team's player onto their fantasy
 * roster is a conflict of interest (they control that player's real-game
 * usage), so this is checked before every pick, manual or auto.
 */
async function controlledTeamOf(team) {
  const member = await getMemberByDiscordId(team.discord_user_id);
  return member?.team_name ? normalizeName(member.team_name) : null;
}

// ---------------------------------------------------------------------------
// Making a pick
// ---------------------------------------------------------------------------

export async function availableAssets(league, poolOverride = null) {
  const pool = poolOverride || await buildDraftPool({ cycle: league.cycle || null, league });
  const picks = await getPicks(league.id);
  const taken = new Set(picks.map((p) => p.player_key));
  return pool.filter((a) => !taken.has(a.key));
}

/**
 * Record a pick and advance the clock. Guards against double-picks by
 * re-reading current_pick_number and refusing if it moved.
 */
export async function makePick(league, team, asset, { auto = false, expectedPickNumber = null } = {}) {
  const pickNumber = league.current_pick_number || 1;
  if (expectedPickNumber != null && expectedPickNumber !== pickNumber) {
    return { ok: false, reason: 'The clock moved — that pick was already made.' };
  }

  const roster = Array.isArray(team.roster) ? [...team.roster] : [];
  const legality = canDraft(roster, asset.position, league);
  if (!legality.ok) return { ok: false, reason: legality.reason };

  const ownTeam = await controlledTeamOf(team);
  if (ownTeam && normalizeName(asset.nfl_team) === ownTeam) {
    return { ok: false, reason: `${asset.nfl_team} is the team you control — you can't draft your own players.` };
  }

  const order = league.draft_order || [];
  const { round } = snakePosition(pickNumber, order.length, league.draft_type);

  await createEntity(ENTITIES.pick, {
    league_id: league.id,
    pick_number: pickNumber,
    round,
    fantasy_team_id: team.id,
    player_key: asset.key,
    player_name: asset.name,
    player_position: asset.position,
    nfl_team: asset.nfl_team,
    auto,
    picked_at: new Date().toISOString(),
  });

  roster.push({
    key: asset.key,
    name: asset.name,
    position: asset.position,
    nfl_team: asset.nfl_team,
    round,
    pick: pickNumber,
  });

  const queue = (team.queue || []).filter((k) => k !== asset.key);
  await updateEntity(ENTITIES.team, team.id, { roster, queue });

  const totalPicks = order.length * rosterSizeOf(league);
  const nextPick = pickNumber + 1;
  const draftComplete = nextPick > totalPicks;

  await updateEntity(ENTITIES.league, league.id, {
    current_pick_number: nextPick,
    current_pick_deadline: draftComplete ? null : computeDeadline(league).toISOString(),
    draft_status: draftComplete ? 'complete' : 'in_progress',
    status: draftComplete ? 'active' : league.status,
  });

  invalidate(ENTITIES.pick);
  invalidate(ENTITIES.team);
  invalidate(ENTITIES.league);

  return { ok: true, pickNumber, round, draftComplete, asset };
}

// ---------------------------------------------------------------------------
// Autopick
// ---------------------------------------------------------------------------

/**
 * Best available for a team: their queue first, then need-weighted OVR.
 * Positional value multipliers keep it from taking a 4th TE at 88 OVR over a
 * WR2 at 85 when the WR slots are still thin.
 */
const NEED_WEIGHT = { QB: 1.0, HB: 1.06, WR: 1.08, TE: 0.94, DEF: 0.55 };

export async function pickForTeam(league, team, available) {
  const roster = team.roster || [];
  const allowed = new Set(eligiblePositions(roster, league));
  const { min } = resolveRosterLimits(league);
  const ownTeam = await controlledTeamOf(team);
  const draftable = (asset) => allowed.has(asset.position)
    && (!ownTeam || normalizeName(asset.nfl_team) !== ownTeam);

  const queue = team.queue || [];
  for (const key of queue) {
    const asset = available.find((a) => a.key === key);
    if (asset && draftable(asset)) return asset;
  }

  const counts = rosterCounts(roster);
  let best = null;
  let bestScore = -Infinity;

  for (const asset of available) {
    if (!draftable(asset)) continue;
    const need = min[asset.position] || 0;
    const stillNeeded = Math.max(0, need - (counts[asset.position] || 0));
    const urgency = 1 + stillNeeded * 0.05;
    // Prefer real production; OVR only breaks ties among the unproven.
    const base = asset.season_points != null ? asset.season_points : (asset.ovr || 60) / 100;
    const score = base * (NEED_WEIGHT[asset.position] || 1) * urgency;
    if (score > bestScore) { bestScore = score; best = asset; }
  }
  return best;
}

/**
 * Fire autopicks for every expired clock — or, for a team with autodraft
 * enabled, immediately once it's their turn regardless of the deadline.
 * Returns what it did.
 */
export async function processExpiredClocks(league) {
  if (league.draft_status !== 'in_progress') return { picks: [] };
  // A paused draft never autopicks. The deadline is left untouched while
  // paused and shifted forward on resume, so whoever is on the clock keeps
  // exactly the time they had left.
  if (league.draft_paused) return { picks: [], paused: true };

  const teams = await getTeams(league.id);
  const onClock = teamOnTheClock(league, teams);
  if (!onClock) return { picks: [] };

  const deadline = league.current_pick_deadline ? new Date(league.current_pick_deadline) : null;
  const deadlineExpired = deadline && Date.now() >= deadline.getTime();
  if (!deadlineExpired && !onClock.team.autodraft) return { picks: [] };

  const available = await availableAssets(league);
  const asset = await pickForTeam(league, onClock.team, available);
  if (!asset) return { picks: [] };

  const result = await makePick(league, onClock.team, asset, {
    auto: true,
    expectedPickNumber: onClock.pickNumber,
  });
  if (!result.ok) return { picks: [], error: result.reason };

  return { picks: [{ team: onClock.team, asset, round: result.round, pickNumber: result.pickNumber, auto: true }], draftComplete: result.draftComplete };
}
