// base44Pacer.js — a bot-wide minimum spacing between outgoing Base44
// requests, regardless of which module or watcher issues them.
//
// WHY: no Base44 rate-limit ceiling is documented anywhere (README, .env
// comments, code) -- the only signal available is "429s happen" or "429s
// don't happen." Fixing every known redundant/uncached read (see vault.js's
// pollCached callers, fantasyStore.js's cachedList) removes the *systematic*
// waste, but nothing stops several independent watchers' 60s setInterval
// ticks from occasionally landing within the same second by coincidence
// (each one's actual phase is its own seed-fetch latency plus a startup
// stagger, not a fixed offset -- see index.js's watcher startup comment),
// and fantasyStore.js's listEntity() pages large collections in fixed
// 500-row chunks fired back-to-back, which can itself burst several
// requests in milliseconds from one logical cache refresh. This module is a
// deterministic backstop against exactly that kind of clustering, on top of
// (not instead of) the real fixes.
//
// No imports from vault.js or fantasyStore.js on purpose -- both of those
// import THIS module, and keeping this a dependency-free leaf avoids any
// risk of a circular import between the two.

const MIN_GAP_MS = 250; // ~4 req/sec ceiling -- well above real steady-state
                         // traffic, so it adds no perceptible latency to any
                         // single request, but no two requests bot-wide can
                         // ever start closer together than this.

let nextSlotAt = 0;

/** Await this before every outgoing Base44 request. */
export async function pace() {
  const now = Date.now();
  const wait = nextSlotAt - now;
  nextSlotAt = Math.max(nextSlotAt, now) + MIN_GAP_MS;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
}

// --- circuit breaker -------------------------------------------------------
//
// The pacer above only spaces requests apart; it doesn't stop a genuine 429
// burst (e.g. several EA-export rollup reads landing close together) from
// having every independent watcher retry into the same wall at once. When
// ANY caller sees a 429, it records how long Base44 itself asked for via
// recordRetryAfter() below -- every OTHER caller checking isRateLimited()
// then sees the app-wide pause and can sit its turn out instead of piling
// on. Watchers check this at the top of their own tick and skip; user-facing
// command paths are NOT gated on it (a user is actively waiting on those) and
// keep using the bounded single-retry wait recordRetryAfter() also returns.

const RETRY_CAP_MS = 10_000; // per-request bounded retry cap (existing behavior)
const PAUSE_CAP_MS = 120_000; // app-wide circuit-breaker pause cap

let pausedUntil = 0;

function parseRetrySeconds(body) {
  const m = /retry after (\d+(?:\.\d+)?)\s*second/i.exec(body || "");
  return m ? Number(m[1]) : 3;
}

/**
 * Call this from the one place each caller already detects a 429. Records
 * the app-wide pause AND returns the same bounded wait that caller uses for
 * its own single retry -- one parse serves both purposes instead of every
 * module duplicating the same regex.
 */
export function recordRetryAfter(body) {
  const seconds = parseRetrySeconds(body);
  pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(PAUSE_CAP_MS, Math.max(1000, seconds * 1000)));
  return Math.min(RETRY_CAP_MS, Math.max(500, seconds * 1000));
}

/** Background watchers check this and skip their turn while a pause is active. */
export function isRateLimited() {
  return Date.now() < pausedUntil;
}
