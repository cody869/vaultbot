// fantasyCommands.js — /fantasy slash command handlers.
//
// index.js already calls deferReply() before the switch, so NOTHING here may
// defer again (that's what crashed /bug-status). Use interaction.editReply().
// Autocomplete interactions are NOT deferred and must answer within 3s.

import { MessageFlags } from 'discord.js';

import {
  ENTITIES,
  getLeague,
  getTeams,
  getPicks,
  getMatchups,
  getWeekScores,
  getLeagueMembers,
  getWeeklyStats,
  getGames,
  createEntity,
  updateEntity,
  invalidate,
} from './fantasyStore.js';

import {
  buildDraftPool,
  availableAssets,
  teamOnTheClock,
  makePick,
  shuffle,
  computeDeadline,
  rosterCounts,
  eligiblePositions,
  invalidatePool,
  processExpiredClocks,
} from './fantasyDraft.js';

import {
  generateSchedule,
  scoreWeek,
  recalcStandings,
  rankTeams,
  advanceLeague,
} from './fantasyLeague.js';

import {
  LEAGUE_DEFAULTS,
  LINEUP_SLOTS,
  ROSTER_MIN,
  STAT_FIELDS,
  KEY_FIELDS,
  GAME_FIELDS,
  resolveKey,
  round2,
} from './fantasyConfig.js';

const PLAIN = { flags: MessageFlags.SuppressEmbeds };

function adminIds() {
  return (process.env.FANTASY_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isCommissioner(interaction) {
  const ids = adminIds();
  if (!ids.length) return false;
  return ids.includes(interaction.user.id);
}

function posEmojiFree(pos) {
  return String(pos || '').toUpperCase();
}

function fmtPts(n) {
  return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
}

function teamLabel(team) {
  return team?.team_name || team?.display_name || 'Unclaimed';
}

function relTime(iso) {
  if (!iso) return 'no deadline';
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

export async function handleFantasyAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (!['player', 'add'].includes(focused.name)) return interaction.respond([]);

  try {
    const league = await getLeague();
    if (!league) return interaction.respond([]);

    const query = String(focused.value || '').toLowerCase().trim();
    const available = await availableAssets(league);

    let matches = available;
    if (query) {
      matches = available.filter((a) =>
        a.name.toLowerCase().includes(query) || a.position.toLowerCase() === query);
    }

    // Restrict pick suggestions to positions this team may legally take.
    if (focused.name === 'player') {
      const teams = await getTeams(league.id);
      const mine = teams.find((t) => t.discord_user_id === interaction.user.id);
      if (mine) {
        const allowed = new Set(eligiblePositions(mine.roster || [], league.roster_size ?? LEAGUE_DEFAULTS.roster_size));
        matches = matches.filter((a) => allowed.has(a.position));
      }
    }

    const options = matches.slice(0, 25).map((a) => ({
      name: `${a.name} — ${a.position}${a.ovr ? ` ${a.ovr}` : ''} (${a.nfl_team})`.slice(0, 100),
      value: a.key.slice(0, 100),
    }));
    return interaction.respond(options);
  } catch (err) {
    console.error('[fantasy] autocomplete failed:', err.message);
    return interaction.respond([]);
  }
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function handleFantasyCommand(interaction) {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'setup': return cmdSetup(interaction);
    case 'join': return cmdJoin(interaction);
    case 'leave': return cmdLeave(interaction);
    case 'start': return cmdStart(interaction);
    case 'order': return cmdOrder(interaction);
    case 'pick': return cmdPick(interaction);
    case 'queue': return cmdQueue(interaction);
    case 'board': return cmdBoard(interaction);
    case 'team': return cmdTeam(interaction);
    case 'standings': return cmdStandings(interaction);
    case 'matchup': return cmdMatchup(interaction);
    case 'scores': return cmdScores(interaction);
    case 'score-week': return cmdScoreWeek(interaction);
    case 'doctor': return cmdDoctor(interaction);
    default:
      return interaction.editReply({ content: `Unknown subcommand: ${sub}`, ...PLAIN });
  }
}

// ---------------------------------------------------------------------------
// setup / join / leave
// ---------------------------------------------------------------------------

async function cmdSetup(interaction) {
  if (!isCommissioner(interaction)) {
    return interaction.editReply({ content: 'Commissioner only.', ...PLAIN });
  }
  const existing = await getLeague();
  if (existing && existing.status !== 'complete') {
    return interaction.editReply({ content: `A league already exists: **${existing.name}** (${existing.status}).`, ...PLAIN });
  }

  const league = await createEntity(ENTITIES.league, {
    ...LEAGUE_DEFAULTS,
    cycle: process.env.FANTASY_CYCLE || null,
    status: 'setup',
    draft_status: 'pending',
    draft_order: [],
    current_pick_number: 1,
    current_pick_deadline: null,
    schedule_generated: false,
    channel_id: interaction.channelId,
  });

  invalidate(ENTITIES.league);
  return interaction.editReply({
    content: [
      `# ${league.name} created`,
      `Season ${league.season_number} · ${league.team_slots} teams · ${league.roster_size}-man rosters`,
      `Scoring begins **week ${league.scoring_start_week}**, regular season through week ${league.regular_season_end_week}.`,
      '',
      'Members can now claim a spot with `/fantasy join`.',
    ].join('\n'),
    ...PLAIN,
  });
}

async function cmdJoin(interaction) {
  const league = await getLeague();
  if (!league) return interaction.editReply({ content: 'No league yet — a commissioner needs to run `/fantasy setup`.', ...PLAIN });
  if (league.draft_status !== 'pending') {
    return interaction.editReply({ content: 'The draft has already started — signups are closed.', ...PLAIN });
  }

  const teams = await getTeams(league.id);
  if (teams.some((t) => t.discord_user_id === interaction.user.id)) {
    return interaction.editReply({ content: "You're already in.", ...PLAIN });
  }
  if (teams.length >= (league.team_slots ?? 12)) {
    return interaction.editReply({ content: `League is full (${teams.length}/${league.team_slots}).`, ...PLAIN });
  }

  const requested = interaction.options.getString('team_name');
  const members = await getLeagueMembers().catch(() => []);
  const member = members.find((m) => m.discord_user_id === interaction.user.id);

  // Never surface a username — it may be an email (league privacy rule).
  const displayName = member?.discord_username
    || member?.avatar_name
    || interaction.user.displayName
    || interaction.user.username;

  await createEntity(ENTITIES.team, {
    league_id: league.id,
    team_name: requested || `${displayName}'s Team`,
    discord_user_id: interaction.user.id,
    discord_username: interaction.user.username,
    display_name: displayName,
    league_member_id: member?.id || null,
    draft_slot: null,
    roster: [],
    queue: [],
    wins: 0, losses: 0, ties: 0,
    points_for: 0, points_against: 0,
    seed: null,
  });

  invalidate(ENTITIES.team);
  const count = teams.length + 1;
  return interaction.editReply({
    content: `**${requested || `${displayName}'s Team`}** is in — spot ${count} of ${league.team_slots}.${count === league.team_slots ? '\n\nLeague is full. Commissioner can run `/fantasy start`.' : ''}`,
    ...PLAIN,
  });
}

async function cmdLeave(interaction) {
  const league = await getLeague();
  if (!league) return interaction.editReply({ content: 'No league found.', ...PLAIN });
  if (league.draft_status !== 'pending') {
    return interaction.editReply({ content: "Draft has started — you can't leave now.", ...PLAIN });
  }
  const teams = await getTeams(league.id);
  const mine = teams.find((t) => t.discord_user_id === interaction.user.id);
  if (!mine) return interaction.editReply({ content: "You're not in the league.", ...PLAIN });

  await updateEntity(ENTITIES.team, mine.id, { league_id: null, discord_user_id: null });
  invalidate(ENTITIES.team);
  return interaction.editReply({ content: 'Spot released.', ...PLAIN });
}

// ---------------------------------------------------------------------------
// start / order
// ---------------------------------------------------------------------------

async function cmdStart(interaction) {
  if (!isCommissioner(interaction)) {
    return interaction.editReply({ content: 'Commissioner only.', ...PLAIN });
  }
  const league = await getLeague();
  if (!league) return interaction.editReply({ content: 'No league found.', ...PLAIN });
  if (league.draft_status !== 'pending') {
    return interaction.editReply({ content: 'Draft already started.', ...PLAIN });
  }

  const teams = await getTeams(league.id);
  if (teams.length !== (league.team_slots ?? 12)) {
    return interaction.editReply({ content: `Need exactly ${league.team_slots} teams — currently ${teams.length}.`, ...PLAIN });
  }

  const order = shuffle(teams.map((t) => t.id));
  for (let i = 0; i < order.length; i += 1) {
    await updateEntity(ENTITIES.team, order[i], { draft_slot: i + 1 });
  }

  const deadline = computeDeadline(league);
  await updateEntity(ENTITIES.league, league.id, {
    draft_order: order,
    draft_status: 'in_progress',
    status: 'drafting',
    current_pick_number: 1,
    current_pick_deadline: deadline.toISOString(),
    channel_id: interaction.channelId,
  });

  invalidate(ENTITIES.league);
  invalidate(ENTITIES.team);
  await buildDraftPool({ cycle: league.cycle || null });

  const byId = new Map(teams.map((t) => [t.id, t]));
  const lines = order.map((id, i) => `${i + 1}. ${teamLabel(byId.get(id))} — <@${byId.get(id).discord_user_id}>`);

  return interaction.editReply({
    content: [
      '# Draft order set',
      `Snake, ${league.roster_size} rounds, ${league.pick_clock_hours}h per pick (clock pauses ${league.quiet_start_hour}:00–${league.quiet_end_hour}:00).`,
      '',
      ...lines,
      '',
      `**On the clock:** <@${byId.get(order[0]).discord_user_id}> — pick 1.01, deadline ${relTime(deadline.toISOString())}`,
      'Make a pick with `/fantasy pick`.',
    ].join('\n'),
    ...PLAIN,
  });
}

async function cmdOrder(interaction) {
  const league = await getLeague();
  if (!league) return interaction.editReply({ content: 'No league found.', ...PLAIN });
  const teams = await getTeams(league.id);

  if (!league.draft_order?.length) {
    const lines = teams.map((t, i) => `${i + 1}. ${teamLabel(t)}`);
    return interaction.editReply({
      content: `# Signed up (${teams.length}/${league.team_slots})\n${lines.join('\n') || '_nobody yet_'}`,
      ...PLAIN,
    });
  }

  const byId = new Map(teams.map((t) => [t.id, t]));
  const onClock = teamOnTheClock(league, teams);
  const lines = league.draft_order.map((id, i) => {
    const marker = onClock && onClock.slotIndex === i ? ' ← on the clock' : '';
    return `${i + 1}. ${teamLabel(byId.get(id))}${marker}`;
  });

  return interaction.editReply({
    content: [
      '# Draft order',
      ...lines,
      '',
      onClock
        ? `Pick ${onClock.round}.${String(((onClock.pickNumber - 1) % league.draft_order.length) + 1).padStart(2, '0')} — <@${onClock.team.discord_user_id}>, deadline ${relTime(league.current_pick_deadline)}`
        : 'Draft complete.',
    ].join('\n'),
    ...PLAIN,
  });
}

// ---------------------------------------------------------------------------
// pick / queue
// ---------------------------------------------------------------------------

async function cmdPick(interaction) {
  const league = await getLeague();
  if (!league) return interaction.editReply({ content: 'No league found.', ...PLAIN });
  if (league.draft_status !== 'in_progress') {
    return interaction.editReply({ content: 'The draft is not running.', ...PLAIN });
  }

  const teams = await getTeams(league.id);
  const onClock = teamOnTheClock(league, teams);
  if (!onClock) return interaction.editReply({ content: 'Draft is complete.', ...PLAIN });

  if (onClock.team.discord_user_id !== interaction.user.id) {
    return interaction.editReply({
      content: `Not your pick — <@${onClock.team.discord_user_id}> is on the clock. Use \`/fantasy queue\` to line one up.`,
      ...PLAIN,
    });
  }

  const key = interaction.options.getString('player');
  const available = await availableAssets(league);
  const asset = available.find((a) => a.key === key)
    || available.find((a) => a.name.toLowerCase() === String(key).toLowerCase());

  if (!asset) {
    return interaction.editReply({ content: 'That player is gone or not in the pool — pick from the autocomplete list.', ...PLAIN });
  }

  const result = await makePick(league, onClock.team, asset, { expectedPickNumber: onClock.pickNumber });
  if (!result.ok) return interaction.editReply({ content: result.reason, ...PLAIN });

  const nextLeague = await getLeague();
  const nextTeams = await getTeams(league.id);
  const next = teamOnTheClock(nextLeague, nextTeams);

  return interaction.editReply({
    content: [
      `**${onClock.team.team_name}** select **${asset.name}** — ${posEmojiFree(asset.position)}, ${asset.nfl_team}`,
      `_Pick ${result.round}.${String(((result.pickNumber - 1) % league.draft_order.length) + 1).padStart(2, '0')}_`,
      '',
      result.draftComplete
        ? '# Draft complete\nRosters are locked. Scoring starts week ' + (league.scoring_start_week ?? 3) + '.'
        : `On the clock: <@${next.team.discord_user_id}> (${teamLabel(next.team)}) — ${relTime(nextLeague.current_pick_deadline)}`,
    ].join('\n'),
    ...PLAIN,
  });
}

async function cmdQueue(interaction) {
  const league = await getLeague();
  if (!league) return interaction.editReply({ content: 'No league found.', ...PLAIN });

  const teams = await getTeams(league.id);
  const mine = teams.find((t) => t.discord_user_id === interaction.user.id);
  if (!mine) return interaction.editReply({ content: "You're not in the league.", ...PLAIN });

  const add = interaction.options.getString('add');
  const clear = interaction.options.getBoolean('clear');

  let queue = Array.isArray(mine.queue) ? [...mine.queue] : [];
  if (clear) queue = [];
  if (add && !queue.includes(add)) queue.push(add);

  if (add || clear) {
    await updateEntity(ENTITIES.team, mine.id, { queue });
    invalidate(ENTITIES.team);
  }

  const pool = await buildDraftPool({ cycle: league.cycle || null });
  const byKey = new Map(pool.map((a) => [a.key, a]));
  const lines = queue.map((k, i) => {
    const a = byKey.get(k);
    return `${i + 1}. ${a ? `${a.name} — ${a.position}, ${a.nfl_team}` : k}`;
  });

  return interaction.editReply({
    content: `# Your queue\n${lines.join('\n') || '_empty_'}\n\nIf your clock expires, the bot picks the top available name here.`,
    ...PLAIN,
  });
}

// ---------------------------------------------------------------------------
// board / team / standings
// ---------------------------------------------------------------------------

async function cmdBoard(interaction) {
  const league = await getLeague();
  if (!league) return interaction.editReply({ content: 'No league found.', ...PLAIN });

  const picks = await getPicks(league.id);
  if (!picks.length) return interaction.editReply({ content: 'No picks yet.', ...PLAIN });

  const teams = await getTeams(league.id);
  const byId = new Map(teams.map((t) => [t.id, t]));
  const roundFilter = interaction.options.getInteger('round');

  const shown = roundFilter ? picks.filter((p) => p.round === roundFilter) : picks.slice(-24);
  const lines = shown.map((p) => {
    const slot = ((p.pick_number - 1) % (league.draft_order?.length || 12)) + 1;
    const auto = p.auto ? ' _(auto)_' : '';
    return `\`${p.round}.${String(slot).padStart(2, '0')}\` **${p.player_name}** ${p.player_position} · ${p.nfl_team} → ${teamLabel(byId.get(p.fantasy_team_id))}${auto}`;
  });

  return interaction.editReply({
    content: `# Draft board${roundFilter ? ` — round ${roundFilter}` : ' — recent picks'}\n${lines.join('\n')}`,
    ...PLAIN,
  });
}

async function cmdTeam(interaction) {
  const league = await getLeague();
  if (!league) return interaction.editReply({ content: 'No league found.', ...PLAIN });

  const target = interaction.options.getUser('user') || interaction.user;
  const teams = await getTeams(league.id);
  const team = teams.find((t) => t.discord_user_id === target.id);
  if (!team) return interaction.editReply({ content: 'No team for that user.', ...PLAIN });

  const roster = team.roster || [];
  const counts = rosterCounts(roster);
  const order = { QB: 0, HB: 1, WR: 2, TE: 3, DEF: 4 };
  const sorted = [...roster].sort((a, b) => (order[a.position] ?? 9) - (order[b.position] ?? 9) || a.pick - b.pick);

  const lines = sorted.map((p) => `\`${p.position.padEnd(3)}\` ${p.name} · ${p.nfl_team} _(${p.round}.${String(((p.pick - 1) % (league.draft_order?.length || 12)) + 1).padStart(2, '0')})_`);
  const needs = Object.entries(ROSTER_MIN)
    .filter(([pos, min]) => counts[pos] < min)
    .map(([pos, min]) => `${pos} ${counts[pos]}/${min}`);

  return interaction.editReply({
    content: [
      `# ${teamLabel(team)}`,
      `${team.wins || 0}-${team.losses || 0}${team.ties ? `-${team.ties}` : ''} · ${fmtPts(team.points_for)} PF · ${fmtPts(team.points_against)} PA`,
      '',
      `### Roster (${roster.length}/${league.roster_size})`,
      lines.join('\n') || '_empty_',
      needs.length ? `\n**Still needed:** ${needs.join(', ')}` : '',
    ].join('\n'),
    ...PLAIN,
  });
}

async function cmdStandings(interaction) {
  const league = await getLeague();
  if (!league) return interaction.editReply({ content: 'No league found.', ...PLAIN });

  const teams = rankTeams(await getTeams(league.id));
  const playoffCut = league.playoff_teams ?? 6;

  const lines = teams.map((t, i) => {
    const cut = i === playoffCut ? '\n— — — playoff cut — — —\n' : '';
    return `${cut}${i + 1}. **${teamLabel(t)}** ${t.wins || 0}-${t.losses || 0}${t.ties ? `-${t.ties}` : ''} · ${fmtPts(t.points_for)} PF`;
  });

  return interaction.editReply({
    content: `# Standings\n${lines.join('\n')}`,
    ...PLAIN,
  });
}

async function cmdMatchup(interaction) {
  const league = await getLeague();
  if (!league) return interaction.editReply({ content: 'No league found.', ...PLAIN });

  const week = interaction.options.getInteger('week') || league.scoring_start_week;
  const matchups = await getMatchups(league.id, week);
  if (!matchups.length) return interaction.editReply({ content: `No matchups for week ${week}.`, ...PLAIN });

  const teams = await getTeams(league.id);
  const byId = new Map(teams.map((t) => [t.id, t]));

  const lines = matchups.map((m) => {
    const home = teamLabel(byId.get(m.home_team_id));
    const away = teamLabel(byId.get(m.away_team_id));
    if (m.status === 'scheduled') return `${away} at ${home}`;
    const hw = m.winner_team_id === m.home_team_id;
    return `${away} **${fmtPts(m.away_points)}** ${hw ? '' : '✓'} at ${home} **${fmtPts(m.home_points)}** ${hw ? '✓' : ''}`.trim();
  });

  return interaction.editReply({
    content: `# Week ${week}${matchups[0].round !== 'regular' ? ` — ${matchups[0].round}` : ''}\n${lines.join('\n')}`,
    ...PLAIN,
  });
}

async function cmdScores(interaction) {
  const league = await getLeague();
  if (!league) return interaction.editReply({ content: 'No league found.', ...PLAIN });

  const week = interaction.options.getInteger('week') || league.scoring_start_week;
  const target = interaction.options.getUser('user') || interaction.user;

  const teams = await getTeams(league.id);
  const team = teams.find((t) => t.discord_user_id === target.id);
  if (!team) return interaction.editReply({ content: 'No team for that user.', ...PLAIN });

  const scores = await getWeekScores(league.id, week);
  const mine = scores.find((s) => s.fantasy_team_id === team.id);
  if (!mine) return interaction.editReply({ content: `Week ${week} hasn't been scored yet.`, ...PLAIN });

  const starters = (mine.starters || []).map((s) =>
    `\`${String(s.slot).padEnd(3)}\` ${s.name.padEnd(22).slice(0, 22)} **${fmtPts(s.points)}**${s.played ? '' : ' _(did not play)_'}`);
  const bench = (mine.bench || []).map((b) => `\`BN \` ${b.name.padEnd(22).slice(0, 22)} ${fmtPts(b.points)}`);

  return interaction.editReply({
    content: [
      `# ${teamLabel(team)} — week ${week}`,
      `### ${fmtPts(mine.total_points)} points`,
      starters.join('\n'),
      '',
      '**Bench**',
      bench.join('\n') || '_none_',
      mine.games_complete ? '' : '\n_Week not final — subject to change._',
    ].join('\n'),
    ...PLAIN,
  });
}

async function cmdScoreWeek(interaction) {
  if (!isCommissioner(interaction)) {
    return interaction.editReply({ content: 'Commissioner only.', ...PLAIN });
  }
  const league = await getLeague();
  if (!league) return interaction.editReply({ content: 'No league found.', ...PLAIN });

  const week = interaction.options.getInteger('week');
  const force = interaction.options.getBoolean('force') || false;

  const result = await scoreWeek(league, week, { force });
  if (!result.ok) {
    return interaction.editReply({
      content: `Week ${week} not scored — ${result.reason === 'incomplete' ? `only ${result.played}/${result.total} games are final. Re-run with \`force: true\` to score anyway.` : result.reason}`,
      ...PLAIN,
    });
  }

  await advanceLeague(league);
  const lines = result.results
    .sort((a, b) => b.total - a.total)
    .map((r, i) => `${i + 1}. ${teamLabel(r.team)} — **${fmtPts(r.total)}**`);

  return interaction.editReply({
    content: `# Week ${week} scored\n${lines.join('\n')}`,
    ...PLAIN,
  });
}

// ---------------------------------------------------------------------------
// doctor — verify field-name resolution against live rows
// ---------------------------------------------------------------------------

async function cmdDoctor(interaction) {
  if (!isCommissioner(interaction)) {
    return interaction.editReply({ content: 'Commissioner only.', ...PLAIN });
  }

  const [stats, games] = await Promise.all([getWeeklyStats(), getGames()]);
  const statRow = stats[0];
  const gameRow = games[0];

  const report = (label, row, groups) => {
    if (!row) return [`### ${label}`, '_no rows found_'];
    const lines = [`### ${label} (${Object.keys(row).length} fields on sample row)`];
    for (const [name, candidates] of Object.entries(groups)) {
      const hit = resolveKey(row, candidates);
      lines.push(`${hit ? '✓' : '✗'} ${name} → ${hit || 'NOT FOUND'}`);
    }
    return lines;
  };

  const offensive = stats.find((r) => resolveKey(r, STAT_FIELDS.passYds) || resolveKey(r, STAT_FIELDS.recYds));
  const defensive = stats.find((r) => resolveKey(r, STAT_FIELDS.defSacks) || resolveKey(r, STAT_FIELDS.defInts));

  const out = [
    '# Fantasy field doctor',
    `WeeklyStats rows: ${stats.length} · Game rows: ${games.length}`,
    '',
    ...report('Identity fields', statRow, KEY_FIELDS),
    '',
    ...report('Offensive stats', offensive || statRow, {
      passYds: STAT_FIELDS.passYds, passTDs: STAT_FIELDS.passTDs, passInts: STAT_FIELDS.passInts,
      rushYds: STAT_FIELDS.rushYds, rushTDs: STAT_FIELDS.rushTDs,
      recCatches: STAT_FIELDS.recCatches, recYds: STAT_FIELDS.recYds, recTDs: STAT_FIELDS.recTDs,
    }),
    '',
    ...report('Defensive stats', defensive || statRow, {
      defSacks: STAT_FIELDS.defSacks, defInts: STAT_FIELDS.defInts,
      defFumRec: STAT_FIELDS.defFumRec, defTDs: STAT_FIELDS.defTDs, defSafeties: STAT_FIELDS.defSafeties,
    }),
    '',
    ...report('Game fields', gameRow, GAME_FIELDS),
    '',
    '_Anything marked ✗ scores as zero. Fix the candidate list in fantasyConfig.js._',
  ];

  return interaction.editReply({ content: out.join('\n').slice(0, 1900), ...PLAIN });
}

// ---------------------------------------------------------------------------
// Draft clock watcher — pings the room and autopicks on expiry
// ---------------------------------------------------------------------------

let lastPingedPick = null;

export function startDraftWatcher(client, { intervalMs = 60 * 1000 } = {}) {
  const tick = async () => {
    try {
      const league = await getLeague();
      if (!league || league.draft_status !== 'in_progress') return;

      const channelId = league.channel_id || process.env.FANTASY_CHANNEL_ID;
      if (!channelId) return;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) return;

      // Autopick anything past its deadline, then keep going — a long absence
      // can burn several picks in one pass.
      let guard = 0;
      while (guard < 24) {
        const current = await getLeague();
        const expired = await processExpiredClocks(current);
        if (!expired.picks.length) break;

        for (const p of expired.picks) {
          await channel.send({
            content: `**${teamLabel(p.team)}** auto-select **${p.asset.name}** — ${p.asset.position}, ${p.asset.nfl_team} _(clock expired)_`,
            ...PLAIN,
          });
        }
        if (expired.draftComplete) break;
        guard += 1;
      }

      const fresh = await getLeague();
      if (fresh.draft_status === 'complete') {
        const teams = await getTeams(fresh.id);
        await generateSchedule(fresh, teams);
        await updateEntity(ENTITIES.league, fresh.id, { status: 'active' });
        invalidate(ENTITIES.league);
        await channel.send({
          content: `# Draft complete\nSchedule generated: weeks ${fresh.scoring_start_week}–${fresh.regular_season_end_week}, then a ${fresh.playoff_teams}-team bracket in weeks ${fresh.playoff_start_week}–${fresh.final_week_end}.`,
          ...PLAIN,
        });
        return;
      }

      // Ping whoever is on the clock, once per pick.
      const teams = await getTeams(fresh.id);
      const onClock = teamOnTheClock(fresh, teams);
      if (onClock && lastPingedPick !== onClock.pickNumber) {
        lastPingedPick = onClock.pickNumber;
        const slot = ((onClock.pickNumber - 1) % fresh.draft_order.length) + 1;
        await channel.send({
          content: `<@${onClock.team.discord_user_id}> you're on the clock — pick ${onClock.round}.${String(slot).padStart(2, '0')}, deadline ${relTime(fresh.current_pick_deadline)}.`,
          ...PLAIN,
        });
      }
    } catch (err) {
      console.error('[fantasy] draft watcher failed:', err.message);
    }
  };

  setTimeout(tick, 20 * 1000);
  setInterval(tick, intervalMs);
  console.log('[fantasy] draft watcher started');
}

/** Posted by the scoring watcher after each week finalizes. */
export async function announceWeek(client, league, week, result) {
  const channelId = league.channel_id || process.env.FANTASY_CHANNEL_ID;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const teams = await getTeams(league.id);
  const byId = new Map(teams.map((t) => [t.id, t]));
  const matchups = await getMatchups(league.id, week);

  const lines = matchups.map((m) => {
    const home = teamLabel(byId.get(m.home_team_id));
    const away = teamLabel(byId.get(m.away_team_id));
    const hw = m.winner_team_id === m.home_team_id;
    return `${away} ${fmtPts(m.away_points)} ${hw ? '' : '✓'} — ${hw ? '✓' : ''} ${home} ${fmtPts(m.home_points)}`.replace(/\s+/g, ' ');
  });

  const high = [...result.results].sort((a, b) => b.total - a.total)[0];

  await channel.send({
    content: [
      `# Week ${week} results`,
      lines.join('\n'),
      '',
      high ? `**High score:** ${teamLabel(high.team)} — ${fmtPts(high.total)}` : '',
      'Check your optimal lineup with `/fantasy scores`.',
    ].join('\n'),
    flags: MessageFlags.SuppressEmbeds,
  });
}
