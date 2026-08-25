// fantasyStore.js — Base44 access layer for the fantasy league.
//
// Reuses vault.js's auth if it exposes it; otherwise logs in itself with
// BOT_EMAIL / BOT_PASSWORD (or a pre-issued BASE44_TOKEN), exactly like the
// rest of vaultbot. Query-param filters on Base44 REST are unreliable from the
// bot, so every read pulls the collection and filters in memory.

import { pace } from './base44Pacer.js';

const BASE = process.env.BASE44_BASE || 'https://app.base44.com';
const APP_ID = process.env.BASE44_APP_ID || '69d09944c8636f39abaa7ef0';

let cachedToken = null;
let tokenExpiresAt = 0;
let writeVerb = null; // detected at runtime: PUT | PATCH | POST

function entityUrl(entity, id) {
  const base = `${BASE}/api/apps/${APP_ID}/entities/${entity}`;
  return id ? `${base}/${id}` : base;
}

/** Try to borrow vault.js's token so we share one session. */
async function borrowVaultToken() {
  try {
    const vault = await import('./vault.js');
    for (const name of ['getToken', 'getAccessToken', 'botLogin', 'login', 'ensureLogin']) {
      if (typeof vault[name] === 'function') {
        const result = await vault[name]();
        if (typeof result === 'string' && result.length > 20) return result;
        if (result && typeof result.access_token === 'string') return result.access_token;
      }
    }
    for (const name of ['authHeaders', 'getAuthHeaders']) {
      if (typeof vault[name] === 'function') {
        const headers = await vault[name]();
        const auth = headers?.Authorization || headers?.authorization;
        if (typeof auth === 'string') return auth.replace(/^Bearer\s+/i, '');
      }
    }
  } catch {
    // vault.js not importable from here — fall through to our own login.
  }
  return null;
}

async function login() {
  if (process.env.BASE44_TOKEN) return process.env.BASE44_TOKEN;

  const borrowed = await borrowVaultToken();
  if (borrowed) return borrowed;

  const email = process.env.BOT_EMAIL;
  const password = process.env.BOT_PASSWORD;
  if (!email || !password) {
    throw new Error('[fantasy] No BASE44_TOKEN and no BOT_EMAIL/BOT_PASSWORD — cannot authenticate.');
  }
  const res = await fetch(`${BASE}/api/apps/${APP_ID}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`[fantasy] Base44 login failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const token = data.access_token || data.token || data.accessToken;
  if (!token) throw new Error('[fantasy] Login succeeded but no access_token in response.');
  return token;
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  cachedToken = await login();
  tokenExpiresAt = Date.now() + 45 * 60 * 1000; // refresh well before expiry
  return cachedToken;
}

async function authHeaders() {
  return {
    Authorization: `Bearer ${await getToken()}`,
    'Content-Type': 'application/json',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Base44's 429 body names exactly how long to back off (e.g. "Retry after 7
// seconds."). Honor that instead of failing outright — capped so a caller on
// a hard-deadline path never hangs indefinitely waiting out one of the much
// longer backoffs seen during sustained overload (confirmed live: up to 56s).
const RETRY_429_CAP_MS = 10_000;
function parseRetryAfterMs(body) {
  const m = /retry after (\d+(?:\.\d+)?)\s*second/i.exec(body || '');
  const seconds = m ? Number(m[1]) : 3;
  return Math.min(RETRY_429_CAP_MS, Math.max(500, seconds * 1000));
}

async function request(method, url, body, { retryAuth = true, retry429 = true } = {}) {
  await pace(); // bot-wide minimum spacing -- see base44Pacer.js
  const res = await fetch(url, {
    method,
    headers: await authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && retryAuth) {
    cachedToken = null;
    return request(method, url, body, { retryAuth: false, retry429 });
  }
  // A single bounded retry, honoring the server's own suggested wait --
  // confirmed live: FantasyLeague/FantasyPick reads reliably 429 right after
  // a redeploy's boot-time burst, and previously just failed outright rather
  // than waiting the few seconds Base44 itself asked for. A 429 means the
  // request was rejected before doing anything, so retrying a write is safe
  // too -- nothing was applied on the first attempt.
  if (res.status === 429 && retry429) {
    const text = await res.text().catch(() => '');
    const waitMs = parseRetryAfterMs(text);
    console.warn(`[fantasy] 429 on ${method} ${url}, retrying in ${waitMs}ms`);
    await sleep(waitMs);
    return request(method, url, body, { retryAuth, retry429: false });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`[fantasy] ${method} ${url} -> ${res.status} ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// ---------------------------------------------------------------------------
// Generic entity operations
// ---------------------------------------------------------------------------

function rowsFrom(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

const PAGE_SIZE = 500;

/**
 * List an entity, paging until exhausted.
 *
 * The pagination parameter is `skip`, not `offset` — confirmed against the
 * Base44 SDK's own entities module. Using the wrong name meant every page
 * re-fetched rows 1-500, so the draft pool was built from a 500-row slice of
 * Player/Roster (54 assets instead of ~4,400) and S84 stats looked empty.
 *
 * `q` filters server-side and `fields` narrows the payload; both cut the
 * number of pages dramatically versus pulling whole collections.
 */
export async function listEntity(entity, { limit = 20000, sort = '', query = null, fields = null } = {}) {
  const out = [];
  const seen = new Set();
  let skip = 0;

  for (let page = 0; page < 60; page += 1) {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    if (skip) params.set('skip', String(skip));
    if (sort) params.set('sort', sort);
    if (query) params.set('q', JSON.stringify(query));
    if (fields) params.set('fields', Array.isArray(fields) ? fields.join(',') : fields);

    const rows = rowsFrom(await request('GET', `${entityUrl(entity)}?${params.toString()}`));
    if (!rows.length) break;

    let added = 0;
    for (const r of rows) {
      const key = r?.id ?? JSON.stringify(r);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      added += 1;
    }
    // Nothing new means the API ignored `skip` — stop rather than spin.
    if (added === 0) {
      console.warn(`[fantasy] ${entity}: pagination stalled at ${out.length} rows (skip may be unsupported)`);
      break;
    }
    if (out.length >= limit) break;
    if (rows.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  return out;
}

export async function createEntity(entity, payload) {
  return request('POST', entityUrl(entity), payload);
}

export async function bulkCreateEntity(entity, payloads) {
  // Base44 accepts an array POST for bulk create; fall back to serial creates.
  try {
    return await request('POST', entityUrl(entity), payloads);
  } catch (err) {
    if (err.status && err.status < 500) {
      const out = [];
      for (const p of payloads) out.push(await createEntity(entity, p));
      return out;
    }
    throw err;
  }
}

/**
 * Update a record. Base44's write verb differs by deployment, so we probe once
 * (PUT -> PATCH -> POST) and log which one stuck, mirroring vault.js.
 */
export async function updateEntity(entity, id, updates) {
  const url = entityUrl(entity, id);
  if (writeVerb) return request(writeVerb, url, updates);

  const verbs = ['PUT', 'PATCH', 'POST'];
  let lastErr;
  for (const verb of verbs) {
    try {
      const result = await request(verb, url, updates);
      writeVerb = verb;
      console.log(`[fantasy] [WRITE] entity updates use ${verb}`);
      return result;
    } catch (err) {
      lastErr = err;
      if (err.status === 403) throw err; // permissions, not verb — don't mask it
    }
  }
  throw lastErr;
}

export async function deleteEntity(entity, id) {
  return request('DELETE', entityUrl(entity, id));
}

// ---------------------------------------------------------------------------
// Cached reads for the big collections
// ---------------------------------------------------------------------------

const caches = new Map(); // entity -> { rows, at } | { promise }

// Single-flight: the cache is populated with the IN-FLIGHT PROMISE the
// instant a request starts, not just with its eventual result. Without
// this, concurrent callers that arrive before the first request resolves
// (e.g. several autocomplete keystrokes fired within the same handful of
// milliseconds) all see an empty cache and all fire their own redundant
// Base44 request — confirmed live: six separate FantasyLeague reads 429'd
// within the same second, each from a different getLeague() call, none of
// which had waited long enough for the other's result to land in the
// cache. Concurrent callers now join the one request already underway.
export async function cachedList(cacheKey, ttlMs = 5 * 60 * 1000, opts = {}) {
  const hit = caches.get(cacheKey);
  if (hit) {
    if (hit.promise) return hit.promise;
    if (Date.now() - hit.at < ttlMs) return hit.rows;
  }

  const promise = listEntity(opts.entity || cacheKey, { query: opts.query || null });
  caches.set(cacheKey, { promise });

  try {
    const rows = await promise;
    caches.set(cacheKey, { rows, at: Date.now() });
    return rows;
  } catch (err) {
    caches.delete(cacheKey); // don't cache a failure — let the next caller try fresh
    throw err;
  }
}

export function invalidate(entity) {
  if (entity) caches.delete(entity);
  else caches.clear();
}

// ---------------------------------------------------------------------------
// Fantasy-specific reads
// ---------------------------------------------------------------------------

export const ENTITIES = {
  league: 'FantasyLeague',
  team: 'FantasyTeam',
  pick: 'FantasyPick',
  matchup: 'FantasyMatchup',
  weekScore: 'FantasyWeekScore',
};

// League/team/pick reads are the ones hit on every single autocomplete
// keystroke in /fantasy pick and /fantasy queue (and every draft-watcher
// tick) -- confirmed live: Base44 started 429ing FantasyPick reads with
// "App entity read traffic volume limit exceeded" during an active draft.
// Every write path already calls invalidate(ENTITIES.league/team/pick), as
// if these were meant to be cached from the start; they just never
// actually were. A short TTL is enough to absorb a burst of keystrokes
// (typically well under 10s) without making draft state feel stale.
const FANTASY_READ_TTL_MS = 10_000;

export async function getLeague() {
  const rows = await cachedList(ENTITIES.league, FANTASY_READ_TTL_MS);
  if (!rows.length) return null;
  const active = rows.find((r) => r.status && r.status !== 'complete');
  return active || rows[rows.length - 1];
}

export async function getTeams(leagueId) {
  const rows = await cachedList(ENTITIES.team, FANTASY_READ_TTL_MS);
  return rows
    .filter((t) => t.league_id === leagueId)
    .sort((a, b) => (a.draft_slot || 99) - (b.draft_slot || 99));
}

export async function getPicks(leagueId) {
  const rows = await cachedList(ENTITIES.pick, FANTASY_READ_TTL_MS);
  const forLeague = rows.filter((p) => p.league_id === leagueId);

  // FantasyPick is create-only for this Base44 app — update comes back 403
  // Permission denied and delete comes back 404, confirmed by /fantasy
  // undo-pick hitting each in turn. A follow-up attempt to cancel a pick
  // out with a second row carrying an extra `undo_of` field *looked* like
  // it worked (the create succeeded, no error) but that field silently
  // didn't persist -- confirmed live: /fantasy board showed every reversed
  // pick twice, and the player stayed stuck as "taken." A field that was
  // never part of this entity's original schema apparently doesn't stick
  // on create either, not just on update.
  //
  // So a pick can only ever be reversed using fields that already existed
  // on day one. A reversal is a second row at the SAME pick_number with
  // player_key: null (which can never match a real asset) and a later
  // picked_at than what it's replacing. For each pick_number, only the
  // most recent row is authoritative -- an original pick, an undo, and a
  // subsequent re-pick can all coexist as rows, and whichever has the
  // latest picked_at wins. A pick_number whose latest row has no
  // player_key is simply "open again," not shown anywhere.
  const latestByPickNumber = new Map();
  for (const p of forLeague) {
    const current = latestByPickNumber.get(p.pick_number);
    if (!current || new Date(p.picked_at || 0) > new Date(current.picked_at || 0)) {
      latestByPickNumber.set(p.pick_number, p);
    }
  }

  return [...latestByPickNumber.values()]
    .filter((p) => p.player_key)
    .sort((a, b) => (a.pick_number || 0) - (b.pick_number || 0));
}

export async function getMatchups(leagueId, week = null) {
  const rows = await listEntity(ENTITIES.matchup);
  return rows.filter((m) => m.league_id === leagueId && (week == null || m.week === week));
}

// Cached -- previously an uncached listEntity() call, hit twice per scored
// week by fantasyLeague.js's runScoringPass() alone. scoreWeek() already
// calls invalidate(ENTITIES.weekScore) on write, so a freshly-scored week is
// visible immediately regardless of TTL; the cache only bounds staleness
// between scoring events, which is fine at this TTL since it's well under
// the 10-minute scoring-watcher interval.
export async function getWeekScores(leagueId, week = null) {
  const rows = await cachedList(ENTITIES.weekScore, 180_000);
  return rows.filter((s) => s.league_id === leagueId && (week == null || s.week === week));
}

export async function getPlayers(cycle = null) {
  return cachedList(`Player${cycle ? `:${cycle}` : ''}`, 10 * 60 * 1000, {
    entity: 'Player',
    query: cycle ? { cycle } : null,
  });
}

export async function getRosters(cycle = null) {
  return cachedList(`Roster${cycle ? `:${cycle}` : ''}`, 10 * 60 * 1000, {
    entity: 'Roster',
    query: cycle ? { cycle } : null,
  });
}

export async function getGames(season = null) {
  return cachedList(`Game${season != null ? `:${season}` : ''}`, 2 * 60 * 1000, {
    entity: 'Game',
    query: season != null ? { season_number: season } : null,
  });
}

export async function getWeeklyStats(season = null) {
  return cachedList(`WeeklyStats${season != null ? `:${season}` : ''}`, 2 * 60 * 1000, {
    entity: 'WeeklyStats',
    query: season != null ? { season_index: season } : null,
  });
}

// Delegates to vault.js's own LeagueMember cache (its own separate
// cachedList('LeagueMember', ...) entry used to fetch the same collection on
// an independent schedule -- two unrelated fetch schedules for one table).
// Lazy import, same pattern as borrowVaultToken() above, to avoid a static
// circular import between the two modules.
export async function getLeagueMembers() {
  const vault = await import('./vault.js');
  return vault.getLeagueMembers();
}

export async function getAppConfig() {
  const rows = await cachedList('AppConfig', 30 * 60 * 1000);
  // AppConfig is a key/value entity: rows carrying `key` and `value`.
  const row = rows.find((r) => r.key === 'current_cycle');
  return { currentCycle: row ? row.value : null, rows };
}
