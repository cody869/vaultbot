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

// Every payload — one week/dataset pair, one roster team, teams, standings,
// free agents — is sent strictly one at a time, in a fixed order, with no
// artificial pause between them. Nothing here runs concurrently: previous
// batching (multiple weeks or roster teams in flight together) turned out to
// be exactly what overwhelmed the destination in the first place — confirmed
// live, picking several weeks with a narrow dataset once sent that many
// simultaneous POSTs and the destination couldn't keep up. Fully sequential
// posting is also what makes a truthful, one-item-at-a-time live status
// display possible in the first place.
const POST_TIMEOUT_MS = Math.max(5000, Number(process.env.EA_POST_TIMEOUT_MS || 180000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Thrown when a caller cancels an in-progress export (see cancelSignal below).
// A distinct type so callers can show "cancelled" rather than "failed".
class ExportCancelledError extends Error {
  constructor() {
    super("Export cancelled.");
    this.name = "ExportCancelledError";
  }
}

function checkCancelled(cancelSignal) {
  if (cancelSignal?.aborted) throw new ExportCancelledError();
}

// Merges an arbitrary number of AbortSignals into one. Node's built-in
// AbortSignal.any() would do this directly, but it's Node 20+ only and
// production runs Node 18 (confirmed from a live crash log) — this is the
// Node 18-safe equivalent. Falsy entries (an omitted cancelSignal) are
// dropped rather than erroring.
function combineSignals(signals) {
  const valid = signals.filter(Boolean);
  if (valid.length <= 1) return valid[0];
  const controller = new AbortController();
  for (const s of valid) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

// Best-effort description of whatever EA's export endpoint actually handed
// back — top-level keys, or (if there's an array in there somewhere) the
// array's length plus its first element's field names. Shape-agnostic on
// purpose: this doesn't assume the exact structure any one category returns,
// it just shows enough to tell rushing-shaped fields (rush_yds, rush_att)
// apart from defensive ones (def_total_tackles, def_sacks) at a glance.
function summarizeFetchedShape(data) {
  if (Array.isArray(data)) {
    return `array(${data.length}) fields: ${Object.keys(data[0] || {}).slice(0, 15).join(",")}`;
  }
  if (data && typeof data === "object") {
    const keys = Object.keys(data);
    const arrKey = keys.find((k) => Array.isArray(data[k]));
    if (arrKey) {
      const arr = data[arrKey];
      return `{${arrKey}: array(${arr.length})} fields: ${Object.keys(arr[0] || {}).slice(0, 15).join(",")}`;
    }
    return `object keys: ${keys.slice(0, 20).join(",")}`;
  }
  return typeof data;
}

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

/*
 * The six per-week player-stat datasets all describe the same players in
 * the same games for the same week, just split by category. Confirmed live
 * (via summarizeFetchedShape's diagnostic log) that each comes back under
 * its own non-colliding top-level key -- playerPassingStatInfoList,
 * playerRushingStatInfoList, playerReceivingStatInfoList,
 * playerDefensiveStatInfoList, playerKickingStatInfoList,
 * playerPuntingStatInfoList -- so a shallow merge of any subset is safe and
 * lossless on EA's side.
 *
 * ON by default, and covers all six (not just the original four) because
 * this is now a confirmed fix for real data loss, not a speculative
 * optimization: the destination (maddenWebhook, outside this repo)
 * classifies every one of these six as the same payload type and does NOT
 * merge across separate POSTs for the same week -- it replaces. Posting
 * kicking/punting as follow-up POSTs after a combined passing+rushing+
 * receiving+defense payload was silently overwriting that merged capture
 * with just the last category sent (confirmed live). Combining all six into
 * one POST is what makes them coexist in the destination at all. Set
 * EA_COMBINE_STATS=false to go back to one POST per category if a
 * destination-side issue ever needs isolating again.
 */
const PLAYER_STAT_DATASETS = ["passing", "rushing", "receiving", "defense", "kicking", "punting"];
const COMBINE_STATS = process.env.EA_COMBINE_STATS !== "false";

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

async function post(pathname, data, retries = 3, cancelSignal) {
  checkCancelled(cancelSignal);
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
        // Combined with cancelSignal so a manual cancel interrupts an
        // in-flight request too, not just requests that haven't started yet.
        signal: combineSignals([AbortSignal.timeout(POST_TIMEOUT_MS), cancelSignal]),
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
      // A cancel can be what actually aborted the fetch above (surfacing as
      // some flavor of AbortError) or can have fired while an unrelated
      // error was already in flight — either way, once cancelSignal itself
      // is aborted this is a cancellation, not a retryable failure.
      if (cancelSignal?.aborted) throw new ExportCancelledError();
      if (e instanceof ExportCancelledError) throw e;
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
 *                1-based number (what the app and Discord show).
 *  weeks       — an arbitrary set of specific regular-season/playoff weeks,
 *                given as an array of 1-based numbers (same validation as
 *                "week", applied to each). Preseason isn't reachable via
 *                "week"/"weeks" since the app drops preseason games on
 *                import anyway (see maddenWebhook) — "current" / "recent" /
 *                "surrounding" still work fine during preseason since they
 *                read the league's actual live stage.
 */
function weekNumberToIndex(weekNumber) {
  const weekIndex = Math.round(weekNumber) - 1;
  if (!Number.isFinite(weekIndex) || weekIndex < 0 || weekIndex > 22 || weekIndex === 21) {
    throw new Error(`Invalid week number: ${weekNumber}. Regular season is weeks 1-23, excluding 22 (Pro Bowl).`);
  }
  return weekIndex;
}

function resolveWeeks(mode, leagueInfo, weekNumber) {
  const { seasonWeek, seasonWeekType } = leagueInfo.careerHubInfo.seasonInfo;
  const stage = seasonWeekType === 0 ? Stage.PRESEASON : Stage.SEASON;

  if (mode === "week") {
    return [{ weekIndex: weekNumberToIndex(weekNumber), stage: Stage.SEASON }];
  }

  if (mode === "weeks") {
    const numbers = Array.isArray(weekNumber) ? weekNumber : [weekNumber];
    if (!numbers.length) throw new Error('scope "weeks" requires at least one week number.');
    return numbers.map((n) => ({ weekIndex: weekNumberToIndex(n), stage: Stage.SEASON }));
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

/*
 * An export is a flat, ordered list of independent payloads ("items") — one
 * week/dataset pair, one roster team, teams, standings, free agents. Building
 * the whole plan upfront (rather than discovering work as we go) is what lets
 * the caller show a real "here's everything, here's what's done" status
 * display instead of vague phase names.
 *
 * Order: league info first (cheap, and useful context even if stats fail),
 * then every week/dataset pair in the order weeks and datasets were given,
 * then rosters last (free agents, then each team). Weeks are NOT interleaved
 * by dataset — datasets are still grouped by week (all of week 3's payloads
 * before week 4's) since maddenWebhook snapshots existing rows once per
 * invocation before deciding create-vs-update; two payloads for the SAME
 * week landing close together risked each missing the other's still-in-
 * flight write and both creating a duplicate row for the same player+game
 * (confirmed live). Fully sequential processing already prevents that, but
 * keeping weeks un-interleaved keeps the plan's order intuitive too.
 */
function buildPlan({ weeks, datasets, willExportLeagueInfo, rosters, teamList }) {
  const items = [];
  if (willExportLeagueInfo) {
    items.push({ type: "teams", label: "Teams" });
    items.push({ type: "standings", label: "Standings" });
  }

  // When enabled (see COMBINE_STATS above), the player-stat categories among
  // the requested datasets collapse into one combined item per week instead
  // of one item each -- same total data, one POST instead of up to four.
  // Only worth doing with 2+ of them actually selected; datasets doesn't
  // change per week, so this is computed once outside the loop.
  const combinable = COMBINE_STATS ? datasets.filter((k) => PLAYER_STAT_DATASETS.includes(k)) : [];
  const singles = combinable.length > 1 ? datasets.filter((k) => !combinable.includes(k)) : datasets;

  for (const w of weeks) {
    if (combinable.length > 1) {
      items.push({
        type: "stat",
        weekIndex: w.weekIndex,
        stage: w.stage,
        datasets: combinable, // combined categories -- see processItem's "stat" case
        dataset: combinable[0], // anchors the POST path; see processItem
        week: w.weekIndex + 1,
        label: `Week ${w.weekIndex + 1} — ${combinable.join("+")} (combined)`,
      });
    }
    for (const key of singles) {
      items.push({
        type: "stat",
        weekIndex: w.weekIndex,
        stage: w.stage,
        dataset: key,
        week: w.weekIndex + 1,
        label: `Week ${w.weekIndex + 1} — ${key}`,
      });
    }
  }
  if (rosters) {
    items.push({ type: "freeagents", label: "Free agents" });
    teamList.forEach((team, teamIndex) => {
      items.push({ type: "roster", teamId: team.teamId, teamIndex, label: `Roster: team ${team.teamId}` });
    });
  }
  return items;
}

// Fetches and posts exactly one plan item. Every item is independent — a
// failure here never touches any other item, since runExport's loop below
// isolates each one in its own try/catch and keeps going regardless.
async function processItem(client, leagueId, platform, item, cancelSignal) {
  switch (item.type) {
    case "teams": {
      const teams = await client.getTeams(leagueId);
      await post(`/${platform}/${leagueId}/leagueteams`, teams, 3, cancelSignal);
      return;
    }
    case "standings": {
      const standings = await client.getStandings(leagueId);
      await post(`/${platform}/${leagueId}/standings`, standings, 3, cancelSignal);
      return;
    }
    case "stat": {
      const base = `/${platform}/${leagueId}/week/${stagePrefix(item.stage)}/${item.weekIndex + 1}`;

      if (item.datasets) {
        // Combined player-stat categories -- see COMBINE_STATS above. Each
        // dataset's own fetch is unchanged; only the posting is merged into
        // one body. Fetches run in parallel since they're independent EA
        // reads, not destination POSTs -- the "post one item at a time"
        // rule is about not stacking load on the destination, which this
        // still honors (exactly one POST for the whole combined set).
        const parts = await Promise.all(
          item.datasets.map((key) => WEEK_DATASETS[key](client)(leagueId, item.stage, item.weekIndex))
        );
        // Each part contributes its own non-colliding *StatInfoList key
        // (confirmed live -- see COMBINE_STATS above), so a shallow merge is
        // lossless.
        const merged = Object.assign({}, ...parts);
        const lists = Object.keys(merged).filter((k) => Array.isArray(merged[k]));
        console.log(
          `[EA] ${item.label} fetched -> combined ${item.datasets.length} datasets into 1 POST ` +
          `(${lists.map((k) => `${k}:${merged[k].length}`).join(", ")})`
        );
        await post(`${base}/${item.dataset}`, merged, 3, cancelSignal);
        return;
      }

      const data = await WEEK_DATASETS[item.dataset](client)(leagueId, item.stage, item.weekIndex);
      // Diagnostic only: confirmed live that a "defense" pull got classified
      // as "rushing" by the destination even though this code unambiguously
      // requests CareerMode_GetWeeklyDefensiveStatsExport for "defense" (no
      // aliasing anywhere between the dataset key and the EA export type) --
      // so the mismatch happens either in EA's own response or in the
      // destination's payload-type detection, neither of which is visible
      // from here. Logging what EA actually sent back, right before it's
      // posted, settles which side it's on without guessing.
      console.log(`[EA] ${item.label} fetched -> ${summarizeFetchedShape(data)}`);
      await post(`${base}/${item.dataset}`, data, 3, cancelSignal);
      return;
    }
    case "freeagents": {
      const freeAgents = await client.getFreeAgents(leagueId);
      await post(`/${platform}/${leagueId}/freeagents/roster`, freeAgents, 3, cancelSignal);
      return;
    }
    case "roster": {
      const roster = await client.getTeamRoster(leagueId, item.teamId, item.teamIndex);
      await post(`/${platform}/${leagueId}/team/${item.teamId}/roster`, roster, 3, cancelSignal);
      return;
    }
    default:
      throw new Error(`Unknown export item type: ${item.type}`);
  }
}

// Runs every item in `items` strictly one at a time, in order, with no delay
// between them. Each item's failure is isolated — logged and recorded, but
// never stops the remaining items from being attempted — except a
// cancellation, which stops everything immediately. `emitItem(index, status)`
// fires "sending" right before an item starts and "sent"/"failed" right
// after, so a caller can render a live per-item status.
async function runPlan(client, leagueId, platform, items, emitItem, cancelSignal) {
  const failures = [];
  for (let i = 0; i < items.length; i++) {
    checkCancelled(cancelSignal);
    await emitItem(i, "sending");
    try {
      await processItem(client, leagueId, platform, items[i], cancelSignal);
      await emitItem(i, "sent");
    } catch (err) {
      if (err instanceof ExportCancelledError) throw err;
      console.error(`[EA] ${items[i].label} failed: ${err.message}`);
      await emitItem(i, "failed");
      failures.push(items[i].label);
    }
  }
  return failures;
}

/**
 * Run an export.
 *
 * @param {object}   opts
 * @param {"current"|"recent"|"surrounding"|"all"|"week"|"weeks"} opts.mode   which weeks to pull
 * @param {number|number[]} [opts.week]  1-based week number ("week") or array of
 *                                       1-based week numbers ("weeks") — required for either mode
 * @param {boolean}  opts.rosters      also pull all 32 rosters + free agents
 * @param {boolean}  opts.leagueInfo   also pull teams + standings
 * @param {string[]} opts.datasets     which per-week datasets (default: all 8)
 * @param {Function} [opts.onPlan]     async (items) => void — called once, right after the
 *                                     full ordered list of payloads is known. Each item is
 *                                     {type, label, ...}; see buildPlan().
 * @param {Function} [opts.onItem]     async (index, "sending"|"sent"|"failed") => void — called
 *                                     for every item as it starts and finishes, in plan order.
 * @param {AbortSignal} [opts.cancelSignal]  abort to stop the export early — in-flight
 *                                     destination POSTs are cancelled too, not just future
 *                                     ones. Only wired into the destination side; EA's own
 *                                     reads (getConnectedClient/getLeagueInfo/getExportData)
 *                                     aren't the slow part in practice and finish quickly.
 * @returns {Promise<{weeks:number, datasets:number, rosters:number, leagueInfo:boolean|string,
 *                    items:number, failures:string[]}>}
 */
async function runExport({
  mode = "current",
  week,
  rosters = false,
  leagueInfo: wantLeagueInfo = true,
  datasets = ALL_DATASETS,
  onPlan,
  onItem,
  cancelSignal,
} = {}) {
  requireUrl();
  const emitPlan = onPlan || (async () => {});
  const emitItem = onItem || (async () => {});

  if (mode === "week" && (week == null || !Number.isFinite(Number(week)))) {
    throw new Error('scope "week" requires a week number.');
  }
  if (mode === "weeks" && (!Array.isArray(week) || !week.length)) {
    throw new Error('scope "weeks" requires an array of week numbers.');
  }

  const unknown = datasets.filter((d) => !WEEK_DATASETS[d]);
  if (unknown.length) throw new Error(`Unknown dataset(s): ${unknown.join(", ")}`);
  if (!datasets.length) throw new Error("No datasets selected — nothing to export.");

  checkCancelled(cancelSignal);
  const { client, leagueId } = await getConnectedClient();
  const platform = client.getSystemConsole();

  const info = await client.getLeagueInfo(leagueId);
  const weeks = resolveWeeks(mode, info, week);
  const teamList = info.teamIdInfoList || [];

  const willExportLeagueInfo = wantLeagueInfo && LEAGUE_INFO_SUPPORTED;
  if (wantLeagueInfo && !LEAGUE_INFO_SUPPORTED) {
    // maddenWebhook's detectPayloadType only recognizes weekly stats, rosters,
    // and game schedules. Teams/standings payloads fall through to 'unknown'
    // and come back 400, which would abort the whole export. Skip them rather
    // than fail. Set MADDEN_EXPORT_LEAGUE_INFO=true once a handler exists.
    console.log("[EA] skipping teams/standings — destination has no handler for them");
  }

  const items = buildPlan({ weeks, datasets, willExportLeagueInfo, rosters, teamList });
  await emitPlan(items);

  const failures = await runPlan(client, leagueId, platform, items, emitItem, cancelSignal);

  return {
    weeks: weeks.length,
    datasets: datasets.length,
    rosters: rosters ? teamList.length : 0,
    leagueInfo: willExportLeagueInfo ? true : wantLeagueInfo ? "skipped (unsupported)" : false,
    items: items.length,
    failures,
  };
}

/**
 * Rosters only — no weeks, no stats, no league info.
 *
 * runExport() can't express this: it rejects an empty `datasets` array, so
 * asking it for rosters alone would still pull a week of stats. Rosters change
 * on their own schedule (trades, signings, cuts) rather than when a game is
 * played, so they get their own cadence.
 */
async function runRosterExport({ onPlan, onItem, cancelSignal } = {}) {
  requireUrl();
  const emitPlan = onPlan || (async () => {});
  const emitItem = onItem || (async () => {});

  checkCancelled(cancelSignal);
  const { client, leagueId } = await getConnectedClient();
  const platform = client.getSystemConsole();

  const info = await client.getLeagueInfo(leagueId);
  const teamList = info.teamIdInfoList || [];

  const items = buildPlan({ weeks: [], datasets: [], willExportLeagueInfo: false, rosters: true, teamList });
  await emitPlan(items);

  const failures = await runPlan(client, leagueId, platform, items, emitItem, cancelSignal);

  return { rosters: teamList.length, failures };
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
  ExportCancelledError,
};
