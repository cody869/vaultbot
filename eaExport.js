/*
 * Pulls a Madden export from EA and POSTs it to your webhook.
 *
 * The URL scheme below is byte-for-byte snallabot's, because maddenWebhook
 * already knows how to parse exactly these payloads at exactly these paths.
 * Nothing downstream changes — we are only replacing who does the pushing.
 *
 * Derived from snallabot-service (MIT License, Copyright (c) snallabot):
 * src/export/exporter.ts (MaddenUrlDestination) and the export orchestration
 * in src/dashboard/ea_client.ts (handleExportTask).
 */

import { getConnectedClient } from "./eaTokenStore.js";
import { Stage, PRESEASON_WEEKS, SEASON_WEEKS } from "./eaConstants.js";

const EXPORT_URL = (process.env.MADDEN_EXPORT_URL || "").replace(/\/$/, "");

// EA rate-limits and this bot shares a Railway container with the gateway
// connection — keep concurrency low so a big export can't starve Discord.
const WEEK_BATCH = 2;
const TEAM_BATCH = 4;

function requireUrl() {
  if (!EXPORT_URL) {
    throw new Error("MADDEN_EXPORT_URL is not set — nowhere to send the export.");
  }
}

async function post(pathname, data) {
  const res = await fetch(`${EXPORT_URL}${pathname}`, {
    method: "POST",
    body: JSON.stringify(data),
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Export POST ${pathname} failed: ${res.status} ${await res.text()}`);
  }
}

const stagePrefix = (stage) => (stage === Stage.SEASON ? "reg" : "pre");

/**
 * Work out which weeks to pull.
 *  current     — just the week the league is sitting on
 *  surrounding — previous, current, next (what snallabot uses on advance)
 *  all         — every preseason + regular/playoff week
 */
function resolveWeeks(mode, leagueInfo) {
  const { seasonWeek, seasonWeekType } = leagueInfo.careerHubInfo.seasonInfo;
  const stage = seasonWeekType === 0 ? Stage.PRESEASON : Stage.SEASON;

  if (mode === "all") {
    return [
      ...PRESEASON_WEEKS.map((weekIndex) => ({ weekIndex, stage: Stage.PRESEASON })),
      ...SEASON_WEEKS.map((weekIndex) => ({ weekIndex, stage: Stage.SEASON })),
    ];
  }

  if (mode === "current") return [{ weekIndex: seasonWeek, stage }];

  // seasonWeekType 8 means the offseason/final week; index 21 is the Pro Bowl
  const current = seasonWeekType === 8 ? 22 : seasonWeek;
  const maxWeek = stage === Stage.PRESEASON ? 3 : 22;
  const prev = current - 1;
  const next = current + 1;
  return [prev === 21 ? 20 : prev, current, next === 21 ? 22 : next]
    .filter((w) => w >= 0 && w <= maxWeek)
    // Guard the case where the league is sitting ON week 21 — upstream lets
    // that through, but there is nothing to export for the Pro Bowl.
    .filter((w) => !(stage === Stage.SEASON && w === 21))
    .map((weekIndex) => ({ weekIndex, stage }));
}

async function exportWeek(client, leagueId, platform, { weekIndex, stage }) {
  const [passing, schedules, teamstats, defense, punting, receiving, kicking, rushing] =
    await Promise.all([
      client.getPassingStats(leagueId, stage, weekIndex),
      client.getSchedules(leagueId, stage, weekIndex),
      client.getTeamStats(leagueId, stage, weekIndex),
      client.getDefensiveStats(leagueId, stage, weekIndex),
      client.getPuntingStats(leagueId, stage, weekIndex),
      client.getReceivingStats(leagueId, stage, weekIndex),
      client.getKickingStats(leagueId, stage, weekIndex),
      client.getRushingStats(leagueId, stage, weekIndex),
    ]);

  // Madden's weekIndex is 0-based; the export path is 1-based.
  const base = `/${platform}/${leagueId}/week/${stagePrefix(stage)}/${weekIndex + 1}`;
  await Promise.all([
    post(`${base}/passing`, passing),
    post(`${base}/schedules`, schedules),
    post(`${base}/teamstats`, teamstats),
    post(`${base}/defense`, defense),
    post(`${base}/punting`, punting),
    post(`${base}/receiving`, receiving),
    post(`${base}/kicking`, kicking),
    post(`${base}/rushing`, rushing),
  ]);
}

async function exportRosters(client, leagueId, platform, teamList, onProgress) {
  const freeAgents = await client.getFreeAgents(leagueId);
  await post(`/${platform}/${leagueId}/freeagents/roster`, freeAgents);

  for (let i = 0; i < teamList.length; i += TEAM_BATCH) {
    const batch = teamList.slice(i, i + TEAM_BATCH);
    await Promise.all(
      batch.map(async (team, offset) => {
        const roster = await client.getTeamRoster(leagueId, team.teamId, i + offset);
        await post(`/${platform}/${leagueId}/team/${team.teamId}/roster`, roster);
      })
    );
    if (onProgress) await onProgress(`Rosters ${Math.min(i + TEAM_BATCH, teamList.length)}/${teamList.length}`);
  }
}

/**
 * Run an export.
 *
 * @param {object}   opts
 * @param {"current"|"surrounding"|"all"} opts.mode   which weeks to pull
 * @param {boolean}  opts.rosters      also pull all 32 rosters + free agents
 * @param {boolean}  opts.leagueInfo   also pull teams + standings
 * @param {Function} opts.onProgress   async (text) => void, for editReply
 */
async function runExport({
  mode = "current",
  rosters = false,
  leagueInfo: wantLeagueInfo = true,
  onProgress,
} = {}) {
  requireUrl();
  const progress = onProgress || (async () => {});

  await progress("Connecting to EA…");
  const { client, leagueId } = await getConnectedClient();
  const platform = client.getSystemConsole();

  const info = await client.getLeagueInfo(leagueId);
  const weeks = resolveWeeks(mode, info);
  const summary = { weeks: weeks.length, rosters: 0, leagueInfo: false };

  if (wantLeagueInfo) {
    await progress("Exporting teams and standings…");
    const [teams, standings] = await Promise.all([
      client.getTeams(leagueId),
      client.getStandings(leagueId),
    ]);
    await post(`/${platform}/${leagueId}/leagueteams`, teams);
    await post(`/${platform}/${leagueId}/standings`, standings);
    summary.leagueInfo = true;
  }

  for (let i = 0; i < weeks.length; i += WEEK_BATCH) {
    const batch = weeks.slice(i, i + WEEK_BATCH);
    await progress(`Exporting weeks ${i + 1}-${Math.min(i + WEEK_BATCH, weeks.length)} of ${weeks.length}…`);
    // Sequential per batch, parallel within it — mirrors snallabot's memory
    // guard for the "all weeks" case, which is otherwise a huge payload.
    await Promise.all(batch.map((w) => exportWeek(client, leagueId, platform, w)));
  }

  if (rosters) {
    await progress("Exporting rosters…");
    const teamList = info.teamIdInfoList || [];
    await exportRosters(client, leagueId, platform, teamList, progress);
    summary.rosters = teamList.length;
  }

  return summary;
}

/**
 * Cheap poll of league state. Returns a fingerprint that changes when the
 * league advances or a game finishes — use it to trigger an auto-export
 * instead of exporting on a blind timer.
 */
async function getLeagueFingerprint() {
  const { client, leagueId } = await getConnectedClient();
  const info = await client.getLeagueInfo(leagueId);
  const week = info.careerHubInfo.seasonInfo.seasonWeek;
  const weekType = info.careerHubInfo.seasonInfo.seasonWeekType;
  const gamesPlayed = (info.gameScheduleHubInfo?.leagueSchedule || []).filter(
    (g) => g.seasonGameInfo?.isGamePlayed
  ).length;
  return { week, weekType, gamesPlayed, key: `${weekType}:${week}:${gamesPlayed}` };
}

export {
  runExport,
  resolveWeeks,
  getLeagueFingerprint,
};
