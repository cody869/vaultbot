// fileLock.js — cross-process/cross-container mutex via atomic file creation.
//
// Extracted from eaTokenStore.js's own lock (same proven pattern: fs.open
// with the "wx" flag is atomic at the filesystem level, unlike a Base44
// record-based "write a claim token, then re-read to check it stuck"
// pattern, which is only an optimistic check -- it can't tell the
// difference between "I won" and "I raced two other containers and each of
// us independently saw our own write before the others' arrived," which is
// exactly what let the same suspension get posted 4 times at once
// (confirmed live). eaTokenStore.js's own comment already names the root
// cause generally: "the window where a Railway deploy overlaps two
// containers on the same volume" -- a real, frequent situation here, since
// Railway auto-deploys on every push to main and this repo pushes often.
//
// Requires `dir` (or EA_STORE_PATH's directory, by default) to be a path
// actually shared across whatever might overlap -- Railway's mounted
// volume already serves this role for eaTokenStore.js's own lock. On a
// single-container host (local dev, or the eventual self-hosted VPS) this
// is simply uncontended and adds no real overhead.

import fs from "node:fs/promises";
import path from "node:path";

const LOCK_DIR = process.env.LOCK_DIR || path.dirname(process.env.EA_STORE_PATH || "/data/ea.json");
const STALE_MS = 2 * 60 * 1000; // matches eaTokenStore.js's own LOCK_STALE_MS

async function acquire(lockPath) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${process.pid}:${Date.now()}`);
      await handle.close();
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Break a lock left behind by a container that died mid-claim.
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Could not acquire lock: ${lockPath}`);
}

async function release(lockPath) {
  try {
    await fs.unlink(lockPath);
  } catch {
    /* already gone */
  }
}

/**
 * Run `fn` while holding an exclusive, cross-process lock named `key`.
 * Only one caller (in this process or any other sharing LOCK_DIR) can be
 * inside `fn` for a given `key` at a time -- everyone else waits (up to
 * ~15s total across 30 retries) or breaks a stale lock left by a dead
 * process.
 */
export async function withFileLock(key, fn) {
  const lockPath = path.join(LOCK_DIR, `${key}.lock`);
  await acquire(lockPath);
  try {
    return await fn();
  } finally {
    await release(lockPath);
  }
}
