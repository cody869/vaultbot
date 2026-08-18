// fantasyLeague.js — schedule, weekly scoring runner, standings, playoffs.

import {
  ENTITIES,
  getLeague,
  getTeams,
  getMatchups,
  getWeekScores,
  getGames,
  getWeeklyStats,
  createEntity,
  bulkCreateEntity,
  updateEntity,
  invalidate,
} from './fantasyStore.js';

import {
  indexWeeklyStats,
  pointsAllowedByTeam,
  weekIsComplete,
  scoreRosterWeek,
} from './fantasyScoring.js';

import { LEAGUE_DEFAULTS, round2 } from './fantasyConfig.js';

// ---------------------------------------------------------------------------
// Regular-season schedule
// ---------------------------------------------------------------------------

/**
 * Circle-method round robin. For N teams it always produces N-1 rounds, so 12
 * teams generate 11 weeks of play regardless of when the season starts.
 *
 * Starting later than that allows means the tail has to be dropped — see
 * generateSchedule, which truncates at regular_season_end_week. Every round is
 * internally complete (all 12 teams play, 6 games), so truncating simply means
 * each team plays fewer distinct opponents; it never leaves anyone idle or
 * creates a repeat pairing.
 */
export function buildRoundRobin(teamIds, startWeek) {
  const teams = [...teamIds];
  const n = teams.length;
  if (n % 2 !== 0) throw new Error('Round robin needs an even number of teams.');

  const rounds = [];
  const fixed = teams[0];
  let rotating = teams.slice(1);

  for (let r = 0; r < n - 1; r += 1) {
    const week = startWeek + r;
    const pairs = [];
    // Alternate home/away so nobody is always the "home" side in the display.
    if (r % 2 === 0) pairs.push({ week, home: fixed, away: rotating[0] });
    else pairs.push({ week, home: rotating[0], away: fixed });

    for (let i = 1; i < n / 2; i += 1) {
      const a = rotating[i];
      const b = rotating[rotating.length - i];
      if (i % 2 === 0) pairs.push({ week, home: a, away: b });
      else pairs.push({ week, home: b, away: a });
    }
    rounds.push(...pairs);
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, -1)];
  }
  return rounds;
}

export async function generateSchedule(league, teams) {
  const existing = await getMatchups(league.id);
  if (existing.length) return { created: 0, skipped: true };

  const ids = teams.map((t) => t.id);
  const startWeek = league.scoring_start_week ?? LEAGUE_DEFAULTS.scoring_start_week;
  const endWeek = league.regular_season_end_week ?? LEAGUE_DEFAULTS.regular_season_end_week;

  const allPairs = buildRoundRobin(ids, startWeek);
  // Drop any round that would run past the regular season into the playoffs.
  // With 12 teams the generator always emits 11 rounds; a start week later
  // than (endWeek - 10) means some pairings simply do not get played.
  const pairs = allPairs.filter((p) => p.week <= endWeek);
  const droppedRounds = new Set(allPairs.filter((p) => p.week > endWeek).map((p) => p.week)).size;
  if (droppedRounds > 0) {
    console.log(
      `[fantasy] schedule: weeks ${startWeek}-${endWeek} fits ${endWeek - startWeek + 1} of ` +
      `${ids.length - 1} round-robin rounds; ${droppedRounds} dropped. ` +
      `Each team plays ${endWeek - startWeek + 1} of ${ids.length - 1} opponents.`
    );
  }

  const payloads = pairs.map((p) => ({
    league_id: league.id,
    week: p.week,
    round: 'regular',
    home_team_id: p.home,
    away_team_id: p.away,
    home_points: 0,
    away_points: 0,
    status: 'scheduled',
  }));

  await bulkCreateEntity(ENTITIES.matchup, payloads);
  await updateEntity(ENTITIES.league, league.id, { schedule_generated: true });
  invalidate(ENTITIES.matchup);
  return { created: payloads.length, skipped: false };
}

// ---------------------------------------------------------------------------
// Weekly scoring
// ---------------------------------------------------------------------------

/**
 * Score a single week: computes every team's best-ball lineup, writes
 * FantasyWeekScore rows, and finalizes that week's matchups.
 * Idempotent — re-running overwrites the same rows rather than duplicating.
 */
export async function scoreWeek(league, week, { force = false } = {}) {
  const season = league.season_number ?? LEAGUE_DEFAULTS.season_number;
  const games = await getGames();
  const completion = weekIsComplete(games, { season, week });

  if (!completion.complete && !force) {
    return { ok: false, reason: 'incomplete', ...completion };
  }

  const teams = await getTeams(league.id);
  if (!teams.length) return { ok: false, reason: 'no_teams' };

  const statRows = await getWeeklyStats();
  const { byName, byNameTeam, defenseByTeam } = indexWeeklyStats(statRows, { season, week });
  const paByTeam = pointsAllowedByTeam(games, { season, week });

  const existingScores = await getWeekScores(league.id, week);
  const scoreByTeam = new Map(existingScores.map((s) => [s.fantasy_team_id, s]));

  const results = [];
  for (const team of teams) {
    const roster = Array.isArray(team.roster) ? team.roster : [];
    const { starters, bench, total } = scoreRosterWeek(roster, { byName, byNameTeam, defenseByTeam, paByTeam });

    const payload = {
      league_id: league.id,
      fantasy_team_id: team.id,
      week,
      total_points: total,
      starters: starters.map((s) => ({
        key: s.key, name: s.name, position: s.position, slot: s.slot,
        points: round2(s.points), played: !!s.played,
      })),
      bench: bench.map((b) => ({
        key: b.key, name: b.name, position: b.position,
        points: round2(b.points), played: !!b.played,
      })),
      games_complete: completion.complete,
      computed_at: new Date().toISOString(),
    };

    const existing = scoreByTeam.get(team.id);
    if (existing) await updateEntity(ENTITIES.weekScore, existing.id, payload);
    else await createEntity(ENTITIES.weekScore, payload);

    results.push({ team, total });
  }

  invalidate(ENTITIES.weekScore);
  const finalized = await finalizeMatchups(league, week, new Map(results.map((r) => [r.team.id, r.total])));
  await recalcStandings(league);

  return { ok: true, week, results, finalized, ...completion };
}

/** Write weekly totals onto the matchups and decide winners. */
async function finalizeMatchups(league, week, totalsByTeam) {
  const matchups = await getMatchups(league.id, week);
  const finalized = [];

  for (const m of matchups) {
    // The two-week final accumulates across weeks 16 and 17.
    const isFinalLeg2 = m.round === 'FINAL' && week === (league.final_week_end ?? LEAGUE_DEFAULTS.final_week_end);
    const priorHome = isFinalLeg2 ? Number(m.home_points) || 0 : 0;
    const priorAway = isFinalLeg2 ? Number(m.away_points) || 0 : 0;

    const home = round2(priorHome + (totalsByTeam.get(m.home_team_id) || 0));
    const away = round2(priorAway + (totalsByTeam.get(m.away_team_id) || 0));

    // Leg 1 of the final stays "in_progress" so it isn't treated as decided.
    const stillRunning = m.round === 'FINAL' && week === (league.final_week_start ?? LEAGUE_DEFAULTS.final_week_start);
    const winner = home === away ? null : (home > away ? m.home_team_id : m.away_team_id);

    await updateEntity(ENTITIES.matchup, m.id, {
      home_points: home,
      away_points: away,
      status: stillRunning ? 'in_progress' : 'final',
      winner_team_id: stillRunning ? null : winner,
    });
    finalized.push({ ...m, home_points: home, away_points: away, winner_team_id: winner });
  }

  invalidate(ENTITIES.matchup);
  return finalized;
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

export async function recalcStandings(league) {
  const teams = await getTeams(league.id);
  const matchups = await getMatchups(league.id);
  const regEnd = league.regular_season_end_week ?? LEAGUE_DEFAULTS.regular_season_end_week;

  const tally = new Map(teams.map((t) => [t.id, { wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 }]));

  for (const m of matchups) {
    if (m.round !== 'regular' || m.status !== 'final') continue;
    const home = tally.get(m.home_team_id);
    const away = tally.get(m.away_team_id);
    if (!home || !away) continue;

    const hp = Number(m.home_points) || 0;
    const ap = Number(m.away_points) || 0;
    home.pf += hp; home.pa += ap;
    away.pf += ap; away.pa += hp;

    if (hp > ap) { home.wins += 1; away.losses += 1; }
    else if (ap > hp) { away.wins += 1; home.losses += 1; }
    else { home.ties += 1; away.ties += 1; }
  }

  for (const team of teams) {
    const t = tally.get(team.id);
    if (!t) continue;
    await updateEntity(ENTITIES.team, team.id, {
      wins: t.wins, losses: t.losses, ties: t.ties,
      points_for: round2(t.pf), points_against: round2(t.pa),
    });
  }

  invalidate(ENTITIES.team);
  return { regEnd, tally };
}

/** Sorted standings. Tiebreaker: win pct, then points for. */
export function rankTeams(teams) {
  return [...teams].sort((a, b) => {
    const aGames = (a.wins || 0) + (a.losses || 0) + (a.ties || 0);
    const bGames = (b.wins || 0) + (b.losses || 0) + (b.ties || 0);
    const aPct = aGames ? ((a.wins || 0) + (a.ties || 0) * 0.5) / aGames : 0;
    const bPct = bGames ? ((b.wins || 0) + (b.ties || 0) * 0.5) / bGames : 0;
    if (bPct !== aPct) return bPct - aPct;
    return (b.points_for || 0) - (a.points_for || 0);
  });
}

// ---------------------------------------------------------------------------
// Playoffs — 6 teams, weeks 14-17
//   wk 14  R1:   3v6, 4v5           (seeds 1-2 bye)
//   wk 15  SEMI: 1 vs lowest alive, 2 vs other
//   wk 16-17 FINAL: two-week aggregate
// ---------------------------------------------------------------------------

export async function seedPlayoffs(league) {
  const teams = await getTeams(league.id);
  const ranked = rankTeams(teams).slice(0, league.playoff_teams ?? LEAGUE_DEFAULTS.playoff_teams);

  for (let i = 0; i < ranked.length; i += 1) {
    await updateEntity(ENTITIES.team, ranked[i].id, { seed: i + 1 });
  }

  const week = league.playoff_start_week ?? LEAGUE_DEFAULTS.playoff_start_week;
  const existing = (await getMatchups(league.id, week)).filter((m) => m.round === 'R1');
  if (existing.length) return { created: 0, ranked };

  const payloads = [
    { home_team_id: ranked[2].id, away_team_id: ranked[5].id },
    { home_team_id: ranked[3].id, away_team_id: ranked[4].id },
  ].map((p) => ({
    league_id: league.id, week, round: 'R1',
    home_points: 0, away_points: 0, status: 'scheduled', ...p,
  }));

  await bulkCreateEntity(ENTITIES.matchup, payloads);
  invalidate(ENTITIES.matchup);
  invalidate(ENTITIES.team);
  return { created: payloads.length, ranked };
}

export async function buildSemis(league) {
  const teams = await getTeams(league.id);
  const seedOf = new Map(teams.map((t) => [t.id, t.seed || 99]));
  const week = (league.playoff_start_week ?? LEAGUE_DEFAULTS.playoff_start_week) + 1;

  const existing = (await getMatchups(league.id, week)).filter((m) => m.round === 'SEMI');
  if (existing.length) return { created: 0 };

  const r1 = (await getMatchups(league.id, week - 1)).filter((m) => m.round === 'R1' && m.status === 'final');
  if (r1.length < 2) return { created: 0, reason: 'r1_not_final' };

  const survivors = r1.map((m) => m.winner_team_id).filter(Boolean);
  survivors.sort((a, b) => (seedOf.get(a) || 99) - (seedOf.get(b) || 99));

  const one = teams.find((t) => t.seed === 1);
  const two = teams.find((t) => t.seed === 2);
  if (!one || !two || survivors.length < 2) return { created: 0, reason: 'missing_seeds' };

  const lowest = survivors[survivors.length - 1];
  const other = survivors.find((s) => s !== lowest);

  const payloads = [
    { home_team_id: one.id, away_team_id: lowest },
    { home_team_id: two.id, away_team_id: other },
  ].map((p) => ({
    league_id: league.id, week, round: 'SEMI',
    home_points: 0, away_points: 0, status: 'scheduled', ...p,
  }));

  await bulkCreateEntity(ENTITIES.matchup, payloads);
  invalidate(ENTITIES.matchup);
  return { created: payloads.length };
}

export async function buildFinal(league) {
  const semiWeek = (league.playoff_start_week ?? LEAGUE_DEFAULTS.playoff_start_week) + 1;
  const startWeek = league.final_week_start ?? LEAGUE_DEFAULTS.final_week_start;

  const existing = (await getMatchups(league.id, startWeek)).filter((m) => m.round === 'FINAL');
  if (existing.length) return { created: 0 };

  const semis = (await getMatchups(league.id, semiWeek)).filter((m) => m.round === 'SEMI' && m.status === 'final');
  if (semis.length < 2) return { created: 0, reason: 'semis_not_final' };

  const teams = await getTeams(league.id);
  const seedOf = new Map(teams.map((t) => [t.id, t.seed || 99]));
  const winners = semis.map((m) => m.winner_team_id).filter(Boolean);
  if (winners.length < 2) return { created: 0, reason: 'no_winners' };
  winners.sort((a, b) => (seedOf.get(a) || 99) - (seedOf.get(b) || 99));

  // One FINAL row spanning weeks 16-17; points accumulate across both legs.
  await createEntity(ENTITIES.matchup, {
    league_id: league.id,
    week: startWeek,
    round: 'FINAL',
    home_team_id: winners[0],
    away_team_id: winners[1],
    home_points: 0,
    away_points: 0,
    status: 'scheduled',
    two_week: true,
  });

  invalidate(ENTITIES.matchup);
  return { created: 1 };
}

/**
 * The two-week final is stored as ONE matchup row on week 16. Week 17's
 * scoring pass needs to find it, so we clone the row reference forward by
 * looking it up on the start week whenever we score the end week.
 */
export async function matchupsForScoringWeek(league, week) {
  const endWeek = league.final_week_end ?? LEAGUE_DEFAULTS.final_week_end;
  const startWeek = league.final_week_start ?? LEAGUE_DEFAULTS.final_week_start;
  if (week === endWeek) {
    const final = (await getMatchups(league.id, startWeek)).filter((m) => m.round === 'FINAL');
    if (final.length) return final;
  }
  return getMatchups(league.id, week);
}

// ---------------------------------------------------------------------------
// Advancement — call after each week is scored
// ---------------------------------------------------------------------------

export async function advanceLeague(league) {
  const regEnd = league.regular_season_end_week ?? LEAGUE_DEFAULTS.regular_season_end_week;

  const matchups = await getMatchups(league.id);
  const regWeekGames = matchups.filter((m) => m.round === 'regular' && m.week === regEnd);
  const regDone = regWeekGames.length > 0 && regWeekGames.every((m) => m.status === 'final');
  const r1Done = matchups.filter((m) => m.round === 'R1').length > 0
    && matchups.filter((m) => m.round === 'R1').every((m) => m.status === 'final');
  const semiDone = matchups.filter((m) => m.round === 'SEMI').length > 0
    && matchups.filter((m) => m.round === 'SEMI').every((m) => m.status === 'final');

  const actions = [];
  if (regDone && !matchups.some((m) => m.round === 'R1')) {
    actions.push({ step: 'seedPlayoffs', result: await seedPlayoffs(league) });
  }
  if (r1Done && !matchups.some((m) => m.round === 'SEMI')) {
    actions.push({ step: 'buildSemis', result: await buildSemis(league) });
  }
  if (semiDone && !matchups.some((m) => m.round === 'FINAL')) {
    actions.push({ step: 'buildFinal', result: await buildFinal(league) });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Watcher — polls for completed weeks and scores them
// ---------------------------------------------------------------------------

export async function runScoringPass({ onWeekScored } = {}) {
  const league = await getLeague();
  if (!league || league.status !== 'active') return { skipped: true };

  const start = league.scoring_start_week ?? LEAGUE_DEFAULTS.scoring_start_week;
  const end = league.final_week_end ?? LEAGUE_DEFAULTS.final_week_end;
  const scored = [];

  for (let week = start; week <= end; week += 1) {
    const existing = await getWeekScores(league.id, week);
    const alreadyFinal = existing.length > 0 && existing.every((s) => s.games_complete);
    if (alreadyFinal) continue;

    const result = await scoreWeek(league, week);
    if (result.ok) {
      scored.push(result);
      await advanceLeague(league);
      if (onWeekScored) await onWeekScored(league, week, result);
    } else {
      // First incomplete week blocks everything after it.
      break;
    }
  }

  return { skipped: false, scored };
}

export function startFantasyWatcher(client, { intervalMs = 10 * 60 * 1000, onWeekScored } = {}) {
  const tick = async () => {
    try {
      const result = await runScoringPass({ onWeekScored });
      if (result?.scored?.length) {
        console.log(`[fantasy] scored ${result.scored.length} week(s)`);
      }
    } catch (err) {
      console.error('[fantasy] scoring pass failed:', err.message);
    }
  };
  setTimeout(tick, 30 * 1000);
  setInterval(tick, intervalMs);
  console.log(`[fantasy] scoring watcher started (every ${Math.round(intervalMs / 60000)}m)`);
}
