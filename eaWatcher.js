/*
 * Background watcher. Two jobs:
 *
 *  1. KEEP THE TOKENS ALIVE. This is not optional. The refresh chain dies
 *     after roughly ten days of no use, and reviving it means re-running
 *     scripts/linkEA.js from a browser. A cheap periodic call is the whole
 *     reason snallabot ships ea_refresher.ts.
 *
 *  2. Notice when the league actually changed (a game got played, the week
 *     advanced) and export just that week — instead of exporting blindly on
 *     a timer and hammering EA for nothing.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getConnectedClient } from "./eaTokenStore.js";
import { runExport, runRosterExport, getLeagueFingerprint } from "./eaExport.js";

const POLL_MINUTES = Number(process.env.EA_POLL_MINUTES || 15);
const AUTO_EXPORT = process.env.EA_AUTO_EXPORT === "true";

// Rosters change on trades/signings/cuts, not on games, so they get their own
// cadence rather than riding the game-completion fingerprint. 0 disables.
const ROSTER_HOURS = Number(process.env.EA_ROSTER_HOURS ?? 48);

// The timestamp lives on the Railway volume next to the EA tokens. Holding it
// in memory would mean every deploy restarts the 48h clock, so a bot that
// redeploys often would either never export rosters or export on every boot.
const ROSTER_STATE_PATH = process.env.EA_ROSTER_STATE_PATH || "/data/ea-roster.json";

let lastKey = null;
let timer = null;
let running = false;

async function readRosterState() {
  try {
    return JSON.parse(await fs.readFile(ROSTER_STATE_PATH, "utf8"));
  } catch {
    return { lastRosterExportAt: 0 };
  }
}

async function writeRosterState(state) {
  try {
    await fs.mkdir(path.dirname(ROSTER_STATE_PATH), { recursive: true });
    const tmp = `${ROSTER_STATE_PATH}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, ROSTER_STATE_PATH);
  } catch (e) {
    // Losing the timestamp only costs an extra export later; never fatal.
    console.error("[EA] could not persist roster export state:", e.message);
  }
}

/**
 * Export rosters if the interval has elapsed. Runs regardless of
 * EA_AUTO_EXPORT — keeping rosters current is useful even when game exports
 * are manual (the fantasy draft pool reads the Roster entity for team
 * assignments).
 */
async function maybeExportRosters() {
  if (!ROSTER_HOURS || ROSTER_HOURS <= 0) return;

  const state = await readRosterState();
  const last = Number(state.lastRosterExportAt) || 0;
  const dueAt = last + ROSTER_HOURS * 3600 * 1000;
  if (Date.now() < dueAt) return;

  // Stamp BEFORE the export. If it fails we wait a full interval rather than
  // retrying every poll and hammering EA through an outage.
  await writeRosterState({ lastRosterExportAt: Date.now() });

  const label = last ? `${Math.round((Date.now() - last) / 3600000)}h since last` : "first run";
  console.log(`[EA] roster export due (${label})`);
  const summary = await runRosterExport();
  console.log(`[EA] roster export complete — ${summary.rosters} teams`);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    // Rosters first — this is also a token touch, so it doubles as keep-alive.
    await maybeExportRosters();

    if (!AUTO_EXPORT) {
      // Keep-alive only: touching the client refreshes the token and session.
      await getConnectedClient();
      return;
    }

    const fingerprint = await getLeagueFingerprint();

    // First tick after a restart just records where things stand — otherwise
    // every deploy would fire a spurious export.
    if (lastKey === null) {
      lastKey = fingerprint.key;
      console.log(`[EA] watcher seeded at ${fingerprint.key}`);
      return;
    }

    if (fingerprint.key !== lastKey) {
      console.log(`[EA] change detected ${lastKey} -> ${fingerprint.key}, exporting`);
      lastKey = fingerprint.key;
      await runExport({ mode: "surrounding", rosters: false });
      console.log("[EA] auto export complete");
    }
  } catch (e) {
    // Never throw out of the interval — a transient EA outage should not
    // take the bot down or stop future polls.
    console.error("[EA] watcher error:", e.message);
  } finally {
    running = false;
  }
}

function startEAWatcher() {
  if (timer) return;
  console.log(
    `[EA] watcher starting (every ${POLL_MINUTES}m, auto-export ${AUTO_EXPORT ? "on" : "off"}` +
      `, roster export ${ROSTER_HOURS > 0 ? `every ${ROSTER_HOURS}h` : "off"})`
  );
  // Small delay so this doesn't compete with the player cache warm at boot.
  setTimeout(tick, 30_000);
  timer = setInterval(tick, POLL_MINUTES * 60 * 1000);
}

function stopEAWatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}

export {
  startEAWatcher,
  stopEAWatcher,
};
