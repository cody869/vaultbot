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
