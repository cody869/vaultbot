/*
 * Persistence for the EA connection.
 *
 * WHY A FILE AND NOT BASE44:
 * This blob is a live credential for your EA account. Anything in a Vault
 * entity is readable by whatever can read that entity, and the bot logs in
 * as a normal (non-admin) BOT_EMAIL user, so an admin-only RLS rule would
 * lock the bot out of its own token. A Railway volume keeps the secret off
 * the app database entirely and gives us single-writer semantics for free.
 *
 * Set EA_STORE_PATH to a path on a mounted Railway volume (e.g. /data/ea.json).
 */

import fs from "node:fs/promises";
import path from "node:path";

import { refreshToken, refreshBlazeSession, retrieveBlazeSession, createEAClient } from "./eaClient.js";

const STORE_PATH = process.env.EA_STORE_PATH || "/data/ea.json";
const LOCK_PATH = `${STORE_PATH}.lock`;
const LOCK_STALE_MS = 2 * 60 * 1000;

/*
 * In-process serialization. Every refresh rotates BOTH EA tokens, so two
 * overlapping refreshes race and one of them invalidates the other's chain
 * — which costs a browser relink, not just a retry. This chain plus the
 * lockfile below is the whole safety story.
 */
let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(STORE_PATH, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Write via temp file + rename so a crash mid-write can't truncate the token. */
async function writeStore(data) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, STORE_PATH);
}

/*
 * Cross-process guard, for the window where a Railway deploy overlaps two
 * containers on the same volume. Same lesson as the news watcher: the
 * durable artifact is the lock, not an in-memory flag.
 */
async function acquireLock() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
      const handle = await fs.open(LOCK_PATH, "wx");
      await handle.writeFile(`${process.pid}:${Date.now()}`);
      await handle.close();
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Break a lock left behind by a container that died mid-refresh.
      try {
        const stat = await fs.stat(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(LOCK_PATH);
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Could not acquire EA token lock — another process is refreshing");
}

async function releaseLock() {
  try {
    await fs.unlink(LOCK_PATH);
  } catch {
    /* already gone */
  }
}

/** Called once by scripts/linkEA.js after a successful browser login. */
async function saveConnection({ token, leagueId, leagueName }) {
  await writeStore({
    token,
    leagueId: Number(leagueId),
    leagueName: leagueName || null,
    linkedAt: new Date().toISOString(),
  });
}

async function getConnection() {
  const stored = await readStore();
  if (!stored) {
    throw new Error(
      `No EA connection found at ${STORE_PATH}. Run \`node scripts/linkEA.js\` first.`
    );
  }
  return stored;
}

/**
 * The main entry point: returns a ready-to-use EA client with a valid token
 * and session, persisting any rotation that happened along the way.
 */
async function getConnectedClient() {
  return serialize(async () => {
    const stored = await getConnection();
    await acquireLock();
    try {
      // Re-read inside the lock — another process may have rotated already.
      const fresh = (await readStore()) || stored;
      const token = await refreshToken(fresh.token);

      let session = fresh.session
        ? await refreshBlazeSession(token, fresh.session)
        : await retrieveBlazeSession(token);

      const rotated =
        token.accessToken !== fresh.token.accessToken ||
        token.refreshToken !== fresh.token.refreshToken;

      if (rotated || session.sessionKey !== fresh.session?.sessionKey) {
        await writeStore({ ...fresh, token, session });
      }

      const client = await createEAClient(token, session);
      return { client, leagueId: fresh.leagueId, leagueName: fresh.leagueName };
    } finally {
      await releaseLock();
    }
  });
}

export {
  STORE_PATH,
  saveConnection,
  getConnection,
  getConnectedClient,
};
