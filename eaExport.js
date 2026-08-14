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

/*
 * The eight per-week datasets. The key is BOTH the URL suffix and the option
 * value, so adding one here is all that's needed to expose it.
 */
const WEEK_DATASETS = {
  schedules: (c) => c.getSchedules,
  passing: (c) => c.getPassingStats,
  rushing: (c) => c.getRushingStats,
  receiving: (c) => c.getReceivingStats,
  defense: (c) => c.getDefensiveStats,
  kicking: (c) => c.getKickingStats,
  punting: (c) => c.getPuntingStats,
  teamstats: (c) => c.getTeamStats,
};

const ALL_DATASETS = Object.keys(WEEK_DATASETS);

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

async function exportWeek(client, leagueId, platform, { weekIndex, stage }, datasets) {
  // Madden's weekIndex is 0-based; the export path is 1-based.
  const base = `/${platform}/${leagueId}/week/${stagePrefix(stage)}/${weekIndex + 1}`;
  await Promise.all(
    datasets.map(async (key) => {
      const data = await WEEK_DATASETS[key](client)(leagueId, stage, weekIndex);
      await post(`${base}/${key}`, data);
    })
  );
}

// Free agents come back as one payload roughly 8x the size of a team roster,
// which exceeds Base44's function gateway timeout no matter how the import
// batches its writes. Split the player array and post each chunk as its own
// roster payload — 50 keeps every request the same shape and size as a team
// roster, which already imports cleanly.
const FA_CHUNK = 50;

function chunkRosterPayload(payload, size) {
  if (Array.isArray(payload)) {
    const out = [];
    for (let i = 0; i < payload.length; i += size) out.push(payload.slice(i, i + size));
    return out.length ? out : [payload];
  }
  if (!payload || typeof payload !== "object") return [payload];

  // The wrapper key differs between EA endpoints, so find the player array by
  // shape (largest array of objects) rather than hardcoding a name.
  let key = null;
  for (const [k, v] of Object.entries(payload)) {
    if (!Array.isArray(v) || v.length === 0) continue;
    if (typeof v[0] !== "object" || v[0] === null) continue;
    if (!key || v.length > payload[key].length) key = k;
  }
  if (!key || payload[key].length <= size) return [payload];

  const arr = payload[key];
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push({ ...payload, [key]: arr.slice(i, i + size) });
  }
  return out;
}

async function exportRosters(client, leagueId, platform, teamList, onProgress) {
  const freeAgents = await client.getFreeAgents(leagueId);
  const faChunks = chunkRosterPayload(freeAgents, FA_CHUNK);
  // Sequential on purpose: parallel chunks would put several full-league
  // reads on the import function at once and reintroduce the timeout.
  for (let i = 0; i < faChunks.length; i++) {
    await post(`/${platform}/${leagueId}/freeagents/roster`, faChunks[i]);
    if (onProgress && faChunks.length > 1) {
      await onProgress(`Free agents ${i + 1}/${faChunks.length}`);
    }
  }

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
 * @param {string[]} opts.datasets     which per-week datasets (default: all 8)
 * @param {Function} opts.onProgress   async (text) => void, for editReply
 */
async function runExport({
  mode = "current",
  rosters = false,
  leagueInfo: wantLeagueInfo = true,
  datasets = ALL_DATASETS,
  onProgress,
} = {}) {
  requireUrl();
  const progress = onProgress || (async () => {});

  const unknown = datasets.filter((d) => !WEEK_DATASETS[d]);
  if (unknown.length) throw new Error(`Unknown dataset(s): ${unknown.join(", ")}`);
  if (!datasets.length) throw new Error("No datasets selected — nothing to export.");

  await progress("Connecting to EA…");
  const { client, leagueId } = await getConnectedClient();
  const platform = client.getSystemConsole();

  const info = await client.getLeagueInfo(leagueId);
  const weeks = resolveWeeks(mode, info);
  const summary = {
    weeks: weeks.length,
    datasets: datasets.length,
    rosters: 0,
    leagueInfo: false,
  };

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

  // A narrow pull is 1-2 requests per week instead of 8, so more weeks can go
  // in parallel without hitting EA any harder than a full export already does.
  const weekBatch = datasets.length > 2 ? WEEK_BATCH : 6;

  for (let i = 0; i < weeks.length; i += weekBatch) {
    const batch = weeks.slice(i, i + weekBatch);
    await progress(
      `Exporting weeks ${i + 1}-${Math.min(i + weekBatch, weeks.length)} of ${weeks.length}…`
    );
    // Sequential per batch, parallel within it — mirrors snallabot's memory
    // guard for the "all weeks" case, which is otherwise a huge payload.
    await Promise.all(
      batch.map((w) => exportWeek(client, leagueId, platform, w, datasets))
    );
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
  ALL_DATASETS,
};
