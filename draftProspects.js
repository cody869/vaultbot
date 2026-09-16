// draftProspects.js — reads DraftProspect / ScoutingGate from the Vault for
// /prospect. Mirrors vault.js's own player-cache pattern (stale-while-
// revalidate, shared in-flight refresh) since this is the same shape of
// problem: a name-search autocomplete that can't afford a live Base44 read
// on every keystroke.

import { list } from "./vault.js";

// --- prospects --------------------------------------------------------

let _prospectCache = { at: 0, rows: [] };
let _prospectRefresh = null;
const PROSPECT_TTL_MS = 300_000; // 5 minutes, same as vault.js's player cache

async function loadProspects() {
  const rows = await list("DraftProspect", {}, { limit: 5000 });
  _prospectCache = { at: Date.now(), rows };
  console.log(`[PROSPECT] ${rows.length} draft prospects cached`);
  return rows;
}

function refreshProspectsInBackground() {
  if (_prospectRefresh) return _prospectRefresh;
  _prospectRefresh = loadProspects()
    .catch((err) => {
      console.error("[PROSPECT] background refresh failed:", err.message);
      return _prospectCache.rows;
    })
    .finally(() => {
      _prospectRefresh = null;
    });
  return _prospectRefresh;
}

export async function warmProspectCache() {
  try {
    await loadProspects();
    console.log("🔥 Draft prospect cache warmed.");
  } catch (err) {
    console.error("[PROSPECT] warm failed:", err.message);
  }
}

async function getAllProspects() {
  const fresh = Date.now() - _prospectCache.at < PROSPECT_TTL_MS;
  if (_prospectCache.rows.length) {
    if (!fresh) refreshProspectsInBackground();
    return _prospectCache.rows;
  }
  return refreshProspectsInBackground();
}

// Suggestions for autocomplete — same ranking convention as vault.js's
// suggestPlayers: exact > starts-with > word-match > substring, tie-broken
// by overall_rank (lower/better first). Bust-outs/transfers-out
// (is_active:false) are excluded, same as the app's own Big Board query.
export async function suggestProspects(partial, limit = 25) {
  const all = await getAllProspects();
  const q = (partial ?? "").trim().toLowerCase();

  const scored = all
    .filter((p) => p.is_active !== false)
    .map((p) => {
      const n = (p.player_fullName ?? "").toLowerCase();
      const words = n.split(/\s+/);
      let tier = 0;
      if (!q) tier = 1;
      else if (n === q) tier = 4;
      else if (n.startsWith(q)) tier = 3;
      else if (words.some((w) => w.startsWith(q))) tier = 2;
      else if (n.includes(q)) tier = 1;
      return { p, tier };
    })
    .filter((x) => x.tier > 0)
    .sort((a, b) => b.tier - a.tier || (a.p.overall_rank ?? 999) - (b.p.overall_rank ?? 999))
    .slice(0, limit);

  return scored.map(({ p }) => {
    const bits = [p.player_position, p.college, p.draft_class_season ? `S${p.draft_class_season}` : null].filter(Boolean);
    const label = `${p.player_fullName}${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
    return { name: label.slice(0, 100), value: p.id };
  });
}

export async function getProspectById(id) {
  const all = await getAllProspects();
  return all.find((p) => p.id === id) ?? null;
}

// --- scouting gates -----------------------------------------------------

let _gateCache = { at: 0, byseason: new Map() };
const GATE_TTL_MS = 300_000;

async function loadGates() {
  const rows = await list("ScoutingGate", {}, { limit: 500 });
  const byseason = new Map(rows.map((g) => [g.draft_class_season, g]));
  _gateCache = { at: Date.now(), byseason };
  return byseason;
}

// gate_level: 0=No Intel, 1=First Look, 2=Film Study, 3=Advanced Scouting,
// 4=Full Dossier. No ScoutingGate row for a class means gate 0 — same
// `?? 0` fallback the app uses everywhere.
export async function getGateLevel(draftClassSeason) {
  const fresh = Date.now() - _gateCache.at < GATE_TTL_MS;
  if (!fresh || !_gateCache.byseason.size) await loadGates();
  return _gateCache.byseason.get(draftClassSeason)?.gate_level ?? 0;
}
