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

import { getConnectedClient } from "./eaTokenStore.js";
import { runExport, getLeagueFingerprint } from "./eaExport.js";

const POLL_MINUTES = Number(process.env.EA_POLL_MINUTES || 15);
const AUTO_EXPORT = process.env.EA_AUTO_EXPORT === "true";

let lastKey = null;
let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
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
    `[EA] watcher starting (every ${POLL_MINUTES}m, auto-export ${AUTO_EXPORT ? "on" : "off"})`
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
