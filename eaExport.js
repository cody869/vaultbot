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

/*
 * How to address the destination.
 *
 *   "path"   — append snallabot's URL paths (/{platform}/{league}/leagueteams,
 *              /week/reg/5/passing, ...). Correct for a snallabot-compatible
 *              relay like a webhook.site bin.
 *
 *   "direct" — POST every payload to MADDEN_EXPORT_URL unchanged.
 *              Correct for Base44 functions: maddenWebhook identifies data by
 *              calling detectPayloadType(body), and never looks at the URL.
 *              Base44 also routes functions at an exact URL, so appending a
 *              path makes it hunt for a function literally named
 *              "maddenWebhook/xbsx/850949/leagueteams" and 404.
 *
 * Every stat record carries weekIndex/seasonIndex/stageIndex in the body, so
 * nothing is lost by dropping the path.
 */
const EXPORT_MODE = (process.env.MADDEN_EXPORT_MODE || "path").toLowerCase();
const DIRECT = EXPORT_MODE === "direct";

/*
 * Extra destination(s) that get a raw copy of every payload this bot sends,
 * always, regardless of EXPORT_MODE above. Each one is treated as
 * direct-mode: no snallabot path suffix appended, matching how
 * maddenWebhook-style endpoints identify payloads by body shape instead of
 * URL. Failures here are logged and swallowed — they never block or fail
 * the primary export to MADDEN_EXPORT_URL.
 */
const EXTRA_EXPORT_URLS = [
  "https://xcfl.vercel.app/api/export",
];

/*
 * Teams/standings are only sent when the destination can parse them. A
 * snallabot-compatible relay routes on the URL path, so it can; maddenWebhook
 * sniffs the body and has no branch for those two shapes. Override with
 * MADDEN_EXPORT_LEAGUE_INFO=true if a handler gets added later.
 */
const LEAGUE_INFO_SUPPORTED =
  process.env.MADDEN_EXPORT_LEAGUE_INFO === "true" || !DIRECT;

// EA rate-limits and this bot shares a Railway container with the gateway
// connection — keep concurrency low so a big export can't starve Discord.
const WEEK_BATCH = 2;

/*
 * Roster pacing. Rosters are the heavy part: 33 POSTs of 250KB+ each.
 * Relays and serverless endpoints drop these when they arrive in bursts, and
 * the drop is silent — the POST returns 200 from the relay while the forward
 * behind it never lands. Lower the batch and add a delay if that happens.
 *
 *   EA_TEAM_BATCH=1     fully sequential, slowest and safest
 *   EA_ROSTER_DELAY_MS  pause between batches, e.g. 1000
 */
const TEAM_BATCH = Math.max(1, Number(process.env.EA_TEAM_BATCH || 2));
const ROSTER_DELAY_MS = Math.max(0, Number(process.env.EA_ROSTER_DELAY_MS || 750));
const POST_TIMEOUT_MS = Math.max(5000, Number(process.env.EA_POST_TIMEOUT_MS || 180000));

/*
 * Pause between distinct payload categories sent back-to-back for the same
 * week or export step — e.g. passing then rushing then receiving, or
 * leagueteams then standings, or free agents then the first roster batch.
 * These are sequential by design already (see exportWeek's comment on why),
 * so adding a pause here doesn't slow anything that could otherwise run
 * concurrently — it just gives the receiving webhook breathing room between
 * requests instead of hitting it back-to-back.
 */
const CATEGORY_DELAY_MS = Math.max(0, Number(process.env.EA_CATEGORY_DELAY_MS || 500));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Best-effort POST to one of the extra destinations. Never throws — a
// broken/slow extra destination must never fail or stall the real export.
async function postToUrl(url, data, retries = 3) {
  const body = JSON.stringify(data);
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (res.ok) return;

      const retryable = res.status === 429 || res.status >= 500;
      const detail = `${res.status} ${(await res.text()).slice(0, 200)}`;
      if (!retryable || attempt === retries - 1) {
        console.warn(`[EA] extra export -> ${url} failed: ${detail}`);
        return;
      }
      console.warn(`[EA] extra export -> ${url} -> ${detail}, retrying`);
    } catch (e) {
      if (attempt === retries - 1) {
        console.warn(`[EA] extra export -> ${url} failed: ${e.message}`);
        return;
      }
      console.warn(`[EA] extra export -> ${url} -> ${e.message}, retrying`);
    }
    await sleep(500 * 2 ** attempt);
  }
}

function postExtras(data) {
  if (!EXTRA_EXPORT_URLS.length) return Promise.resolve();
  return Promise.all(EXTRA_EXPORT_URLS.map((url) => postToUrl(url, data)));
}

async function post(pathname, data, retries = 3) {
  const body = JSON.stringify(data);
  // In direct mode the path is dropped from the request but kept for logs and
  // error messages, so failures still say WHICH payload broke.
  const url = DIRECT ? EXPORT_URL : `${EXPORT_URL}${pathname}`;

  // Kick off the extra destination(s) in parallel with the primary send —
  // it never throws, so it can't affect the primary export either way.
  const extras = postExtras(data);

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
        // Roster payloads are large; without a timeout a stalled connection
        // hangs the whole export until Discord's interaction window expires.
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });

      if (res.ok) {
        await extras;
        return;
      }

      // 4xx (except 429) won't fix themselves — fail immediately rather than
      // hammering the endpoint three times with the same bad request.
      const retryable = res.status === 429 || res.status >= 500;
      const detail = `${res.status} ${(await res.text()).slice(0, 200)}`;
      if (!retryable || attempt === retries - 1) {
        await extras;
        throw new Error(`Export POST ${pathname} failed: ${detail}`);
      }
      console.warn(`[EA] ${pathname} -> ${detail}, retrying`);
    } catch (e) {
      if (e.message?.startsWith("Export POST")) throw e;
      if (attempt === retries - 1) {
        await extras;
        throw new Error(`Export POST ${pathname} failed: ${e.message}`);
      }
      console.warn(`[EA] ${pathname} -> ${e.message}, retrying`);
    }

    await sleep(500 * 2 ** attempt);
  }
}

const stagePrefix = (stage) => (stage === Stage.SEASON ? "reg" : "pre");

/**
 * Work out which weeks to pull.
 *  current     — just the week the league is sitting on
 *  recent      — previous + current week (the default the /admin export
 *                wizard opens with)
 *  surrounding — previous, current, next (what snallabot uses on advance)
 *  all         — every preseason + regular/playoff week
 *  week        — one specific regular-season/playoff week, given as a
 *                1-based number (what the app and Discord show). Preseason
 *                isn't reachable this way since the app drops preseason
 *                games on import anyway (see maddenWebhook) — "current" /
 *                "recent" / "surrounding" still work fine during preseason
 *                since they read the league's actual live stage.
 */
function resolveWeeks(mode, leagueInfo, weekNumber) {
  const { seasonWeek, seasonWeekType } = leagueInfo.careerHubInfo.seasonInfo;
  const stage = seasonWeekType === 0 ? Stage.PRESEASON : Stage.SEASON;

  if (mode === "week") {
    const weekIndex = Math.round(weekNumber) - 1;
    if (!Number.isFinite(weekIndex) || weekIndex < 0 || weekIndex > 22 || weekIndex === 21) {
      throw new Error(`Invalid week number: ${weekNumber}. Regular season is weeks 1-23, excluding 22 (Pro Bowl).`);
    }
    return [{ weekIndex, stage: Stage.SEASON }];
  }

  if (mode === "all") {
    return [
      ...PRESEASON_WEEKS.map((weekIndex) => ({ weekIndex, stage: Stage.PRESEASON })),
      ...SEASON_WEEKS.map((weekIndex) => ({ weekIndex, stage: Stage.SEASON })),
    ];
  }

  if (mode === "current") return [{ weekIndex: seasonWeek, stage }];

  // "recent" and "surrounding" below. seasonWeekType 8 means the
  // offseason/final week; index 21 is the Pro Bowl.
  const current = seasonWeekType === 8 ? 22 : seasonWeek;
  const maxWeek = stage === Stage.PRESEASON ? 3 : 22;
  const prev = current - 1;
  const next = current + 1;
  const inRange = (w) =>
    w >= 0 &&
    w <= maxWeek &&
    // Guard the case where the league is sitting ON week 21 — upstream lets
    // that through, but there is nothing to export for the Pro Bowl.
    !(stage === Stage.SEASON && w === 21);

  const weekIndexes =
    mode === "surrounding"
      ? [prev === 21 ? 20 : prev, current, next === 21 ? 22 : next]
      : [prev === 21 ? 20 : prev, current]; // "recent" (and any unknown mode)

  return weekIndexes.filter(inRange).map((weekIndex) => ({ weekIndex, stage }));
}

async function exportWeek(client, leagueId, platform, { weekIndex, stage }, datasets) {
  // Madden's weekIndex is 0-based; the export path is 1-based.
  const base = `/${platform}/${leagueId}/week/${stagePrefix(stage)}/${weekIndex + 1}`;
  // SEQUENTIAL, not Promise.all: passing/rushing/receiving/defense for the
  // same game all touch the same WeeklyStats rows (a RB shows up in both
  // rushing and receiving; a DE who forces a fumble shows up in defense and
  // maybe fumbles). maddenWebhook snapshots "what already exists" once per
  // invocation before deciding create-vs-update -- if two category calls for
  // this week land within milliseconds of each other (which Promise.all
  // guarantees), neither sees the other's still-in-flight write, and both
  // independently create a row for the same player+game. That's what caused
  // the Week 1 AND Week 2 duplicate-row bugs. Posting one dataset at a time
  // means each call's snapshot already includes everything the previous call
  // committed, so there's nothing left to race.
  //
  // Each dataset is isolated in its own try/catch. Confirmed live: a game's
  // final score and passing stats posted successfully, but nothing else did
  // -- because the old code let one dataset's failure (an EA hiccup, a bad
  // payload) abort every dataset still queued after it for that week,
  // silently. Failures are collected and thrown as a single error only
  // AFTER every dataset has been attempted, so a week ends up as complete
  // as it can be instead of stopping at the first failure, while the
  // caller still learns something needs a retry.
  const failures = [];
  for (let i = 0; i < datasets.length; i++) {
    const key = datasets[i];
    // Pace category posts for the receiving webhook, same reasoning as
    // ROSTER_DELAY_MS below — no pause before the first one, since there's
    // nothing to space it from.
    if (i > 0 && CATEGORY_DELAY_MS) await sleep(CATEGORY_DELAY_MS);
    try {
      const data = await WEEK_DATASETS[key](client)(leagueId, stage, weekIndex);
      await post(`${base}/${key}`, data);
    } catch (err) {
      console.error(`[EA] week ${weekIndex + 1} ${key} failed: ${err.message}`);
      failures.push(key);
    }
  }
  if (failures.length) {
    throw new Error(`week ${weekIndex + 1}: ${failures.join(", ")} failed (see logs)`);
  }
}

async function exportRosters(client, leagueId, platform, teamList, onProgress) {
  const freeAgents = await client.getFreeAgents(leagueId);
  await post(`/${platform}/${leagueId}/freeagents/roster`, freeAgents);
  if (CATEGORY_DELAY_MS) await sleep(CATEGORY_DELAY_MS);

  for (let i = 0; i < teamList.length; i += TEAM_BATCH) {
    // Pace the batches. The failure this prevents is silent: a relay or
    // serverless endpoint accepts the POST (200) but drops the work behind it
    // when several 250KB bodies land at once.
    if (i > 0 && ROSTER_DELAY_MS) await sleep(ROSTER_DELAY_MS);

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
 * @param {"current"|"recent"|"surrounding"|"all"|"week"} opts.mode   which weeks to pull
 * @param {number}   [opts.week]       1-based week number, required when mode is "week"
 * @param {boolean}  opts.rosters      also pull all 32 rosters + free agents
 * @param {boolean}  opts.leagueInfo   also pull teams + standings
 * @param {string[]} opts.datasets     which per-week datasets (default: all 8)
 * @param {Function} opts.onProgress   async (text) => void, for editReply
 */
async function runExport({
  mode = "current",
  week,
  rosters = false,
  leagueInfo: wantLeagueInfo = true,
  datasets = ALL_DATASETS,
  onProgress,
} = {}) {
  requireUrl();
  const progress = onProgress || (async () => {});

  if (mode === "week" && (week == null || !Number.isFinite(Number(week)))) {
    throw new Error('scope "week" requires a week number.');
  }

  const unknown = datasets.filter((d) => !WEEK_DATASETS[d]);
  if (unknown.length) throw new Error(`Unknown dataset(s): ${unknown.join(", ")}`);
  if (!datasets.length) throw new Error("No datasets selected — nothing to export.");

  await progress("Connecting to EA…");
  const { client, leagueId } = await getConnectedClient();
  const platform = client.getSystemConsole();

  const info = await client.getLeagueInfo(leagueId);
  const weeks = resolveWeeks(mode, info, week);
  const summary = {
    weeks: weeks.length,
    datasets: datasets.length,
    rosters: 0,
    leagueInfo: false,
  };

  if (wantLeagueInfo && !LEAGUE_INFO_SUPPORTED) {
    // maddenWebhook's detectPayloadType only recognizes weekly stats, rosters,
    // and game schedules. Teams/standings payloads fall through to 'unknown'
    // and come back 400, which would abort the whole export. Skip them rather
    // than fail. Set MADDEN_EXPORT_LEAGUE_INFO=true once a handler exists.
    console.log("[EA] skipping teams/standings — destination has no handler for them");
    summary.leagueInfo = "skipped (unsupported)";
  } else if (wantLeagueInfo) {
    await progress("Exporting teams and standings…");
    const [teams, standings] = await Promise.all([
      client.getTeams(leagueId),
      client.getStandings(leagueId),
    ]);
    await post(`/${platform}/${leagueId}/leagueteams`, teams);
    if (CATEGORY_DELAY_MS) await sleep(CATEGORY_DELAY_MS);
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
 * Rosters only — no weeks, no stats, no league info.
 *
 * runExport() can't express this: it rejects an empty `datasets` array, so
 * asking it for rosters alone would still pull a week of stats. Rosters change
 * on their own schedule (trades, signings, cuts) rather than when a game is
 * played, so they get their own cadence.
 */
async function runRosterExport({ onProgress } = {}) {
  requireUrl();
  const progress = onProgress || (async () => {});

  await progress("Connecting to EA…");
  const { client, leagueId } = await getConnectedClient();
  const platform = client.getSystemConsole();

  const info = await client.getLeagueInfo(leagueId);
  const teamList = info.teamIdInfoList || [];

  await progress("Exporting rosters…");
  await exportRosters(client, leagueId, platform, teamList, progress);

  return { rosters: teamList.length };
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
  runRosterExport,
  resolveWeeks,
  getLeagueFingerprint,
  ALL_DATASETS,
};
