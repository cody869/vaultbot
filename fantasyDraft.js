// fantasyDraft.js — async snake draft engine.

import {
  ENTITIES,
  getPlayers,
  getTeams,
  getPicks,
  createEntity,
  updateEntity,
  invalidate,
} from './fantasyStore.js';

import {
  LEAGUE_DEFAULTS,
  ROSTER_MIN,
  ROSTER_MAX,
  fantasyPosition,
  playerKey,
  defenseKey,
  normalizeName,
} from './fantasyConfig.js';

// ---------------------------------------------------------------------------
// Draft pool
// ---------------------------------------------------------------------------

const OVR_FIELDS = ['player_bestOvr', 'player_playerBestOvr', 'playerBestOvr', 'player_overall', 'overall', 'ovr'];

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
 * Draftable assets: currently rostered QB/HB/WR/TE plus 32 team defenses.
 * Player rows are deduped on normalized name + position, which is the app's
 * real identity key (record ids are re-minted every cycle).
 */
export async function buildDraftPool({ cycle = null, ttlMs = 10 * 60 * 1000 } = {}) {
  if (poolCache && Date.now() - poolCachedAt < ttlMs) return poolCache;

  const players = await getPlayers();
  const seen = new Map();
  const teamNames = new Set();

  for (const p of players) {
    if (cycle && p.cycle && p.cycle !== cycle) continue;

    const team = p.team_name || p.teamName || '';
    if (!team) continue; // "currently rostered" only — free agents excluded
    teamNames.add(team);

    const pos = fantasyPosition(p.player_position);
    if (!pos) continue;

    const name = p.player_fullName || p.playerName || '';
    if (!name) continue;

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

  const pool = [...seen.values(), ...defenses].sort((a, b) => b.ovr - a.ovr);
  poolCache = pool;
  poolCachedAt = Date.now();
  console.log(`[fantasy] draft pool built: ${pool.length} assets (${defenses.length} defenses)`);
  return pool;
}

export function invalidatePool() {
  poolCache = null;
}

// ---------------------------------------------------------------------------
// Snake order
// ---------------------------------------------------------------------------

/** 1-based pick number -> { round, slotIndex } for a snake draft. */
export function snakePosition(pickNumber, teamCount) {
  const zero = pickNumber - 1;
  const round = Math.floor(zero / teamCount) + 1;
  const indexInRound = zero % teamCount;
  const slotIndex = round % 2 === 1 ? indexInRound : teamCount - 1 - indexInRound;
  return { round, slotIndex };
}

export function teamOnTheClock(league, teams) {
  const order = Array.isArray(league.draft_order) ? league.draft_order : [];
  if (!order.length) return null;
  const pickNumber = league.current_pick_number || 1;
  const totalPicks = order.length * (league.roster_size ?? LEAGUE_DEFAULTS.roster_size);
  if (pickNumber > totalPicks) return null;

  const { round, slotIndex } = snakePosition(pickNumber, order.length);
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
export function computeDeadline(league, from = new Date()) {
  const hours = league.pick_clock_hours ?? LEAGUE_DEFAULTS.pick_clock_hours;
  const tzOffset = league.timezone_offset_hours ?? LEAGUE_DEFAULTS.timezone_offset_hours;
  const quietStart = league.quiet_start_hour ?? LEAGUE_DEFAULTS.quiet_start_hour;
  const quietEnd = league.quiet_end_hour ?? LEAGUE_DEFAULTS.quiet_end_hour;

  let deadline = new Date(from.getTime() + hours * 3600 * 1000);
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
export function eligiblePositions(roster, rosterSize = LEAGUE_DEFAULTS.roster_size) {
  const counts = rosterCounts(roster);
  const picksLeft = rosterSize - (roster?.length || 0);

  const owed = {};
  let owedTotal = 0;
  for (const [pos, min] of Object.entries(ROSTER_MIN)) {
    const short = Math.max(0, min - counts[pos]);
    owed[pos] = short;
    owedTotal += short;
  }

  const underCap = Object.keys(ROSTER_MIN).filter((pos) => counts[pos] < ROSTER_MAX[pos]);
  if (picksLeft <= owedTotal) {
    return underCap.filter((pos) => owed[pos] > 0);
  }
  return underCap;
}

export function canDraft(roster, position, rosterSize = LEAGUE_DEFAULTS.roster_size) {
  const allowed = eligiblePositions(roster, rosterSize);
  const pos = String(position || '').toUpperCase();
  if (!allowed.includes(pos)) {
    const counts = rosterCounts(roster);
    if (counts[pos] >= (ROSTER_MAX[pos] ?? 99)) {
      return { ok: false, reason: `You already have the max ${pos} (${ROSTER_MAX[pos]}).` };
    }
    return {
      ok: false,
      reason: `You need to fill required slots with your remaining picks. Still allowed: ${allowed.join(', ') || 'none'}.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Making a pick
// ---------------------------------------------------------------------------

export async function availableAssets(league, poolOverride = null) {
  const pool = poolOverride || await buildDraftPool({ cycle: league.cycle || null });
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
  const legality = canDraft(roster, asset.position, league.roster_size ?? LEAGUE_DEFAULTS.roster_size);
  if (!legality.ok) return { ok: false, reason: legality.reason };

  const order = league.draft_order || [];
  const { round } = snakePosition(pickNumber, order.length);

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

  const totalPicks = order.length * (league.roster_size ?? LEAGUE_DEFAULTS.roster_size);
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
  const rosterSize = league.roster_size ?? LEAGUE_DEFAULTS.roster_size;
  const roster = team.roster || [];
  const allowed = new Set(eligiblePositions(roster, rosterSize));

  const queue = team.queue || [];
  for (const key of queue) {
    const asset = available.find((a) => a.key === key);
    if (asset && allowed.has(asset.position)) return asset;
  }

  const counts = rosterCounts(roster);
  let best = null;
  let bestScore = -Infinity;

  for (const asset of available) {
    if (!allowed.has(asset.position)) continue;
    const min = ROSTER_MIN[asset.position] || 0;
    const stillNeeded = Math.max(0, min - counts[asset.position]);
    const urgency = 1 + stillNeeded * 0.05;
    const score = (asset.ovr || 60) * (NEED_WEIGHT[asset.position] || 1) * urgency;
    if (score > bestScore) { bestScore = score; best = asset; }
  }
  return best;
}

/** Fire autopicks for every expired clock. Returns what it did. */
export async function processExpiredClocks(league) {
  if (league.draft_status !== 'in_progress') return { picks: [] };
  const deadline = league.current_pick_deadline ? new Date(league.current_pick_deadline) : null;
  if (!deadline || Date.now() < deadline.getTime()) return { picks: [] };

  const teams = await getTeams(league.id);
  const onClock = teamOnTheClock(league, teams);
  if (!onClock) return { picks: [] };

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
