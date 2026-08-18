// fantasyStore.js — Base44 access layer for the fantasy league.
//
// Reuses vault.js's auth if it exposes it; otherwise logs in itself with
// BOT_EMAIL / BOT_PASSWORD (or a pre-issued BASE44_TOKEN), exactly like the
// rest of vaultbot. Query-param filters on Base44 REST are unreliable from the
// bot, so every read pulls the collection and filters in memory.

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

async function request(method, url, body, { retryAuth = true } = {}) {
  const res = await fetch(url, {
    method,
    headers: await authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && retryAuth) {
    cachedToken = null;
    return request(method, url, body, { retryAuth: false });
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

export async function listEntity(entity, { limit = 10000, sort = '' } = {}) {
  const params = new URLSearchParams();
  if (limit) params.set('limit', String(limit));
  if (sort) params.set('sort', sort);
  const url = `${entityUrl(entity)}?${params.toString()}`;
  const data = await request('GET', url);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.data)) return data.data;
  return [];
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

const caches = new Map(); // entity -> { rows, at }

export async function cachedList(entity, ttlMs = 5 * 60 * 1000) {
  const hit = caches.get(entity);
  if (hit && Date.now() - hit.at < ttlMs) return hit.rows;
  const rows = await listEntity(entity);
  caches.set(entity, { rows, at: Date.now() });
  return rows;
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

export async function getLeague() {
  const rows = await listEntity(ENTITIES.league);
  if (!rows.length) return null;
  const active = rows.find((r) => r.status && r.status !== 'complete');
  return active || rows[rows.length - 1];
}

export async function getTeams(leagueId) {
  const rows = await listEntity(ENTITIES.team);
  return rows
    .filter((t) => t.league_id === leagueId)
    .sort((a, b) => (a.draft_slot || 99) - (b.draft_slot || 99));
}

export async function getPicks(leagueId) {
  const rows = await listEntity(ENTITIES.pick);
  return rows
    .filter((p) => p.league_id === leagueId)
    .sort((a, b) => (a.pick_number || 0) - (b.pick_number || 0));
}

export async function getMatchups(leagueId, week = null) {
  const rows = await listEntity(ENTITIES.matchup);
  return rows.filter((m) => m.league_id === leagueId && (week == null || m.week === week));
}

export async function getWeekScores(leagueId, week = null) {
  const rows = await listEntity(ENTITIES.weekScore);
  return rows.filter((s) => s.league_id === leagueId && (week == null || s.week === week));
}

export async function getPlayers() {
  return cachedList('Player', 10 * 60 * 1000);
}

export async function getRosters() {
  return cachedList('Roster', 10 * 60 * 1000);
}

export async function getGames() {
  return cachedList('Game', 2 * 60 * 1000);
}

export async function getWeeklyStats() {
  return cachedList('WeeklyStats', 2 * 60 * 1000);
}

export async function getLeagueMembers() {
  return cachedList('LeagueMember', 30 * 60 * 1000);
}

export async function getAppConfig() {
  const rows = await cachedList('AppConfig', 30 * 60 * 1000);
  // AppConfig is a key/value entity: rows carrying `key` and `value`.
  const row = rows.find((r) => r.key === 'current_cycle');
  return { currentCycle: row ? row.value : null, rows };
}
