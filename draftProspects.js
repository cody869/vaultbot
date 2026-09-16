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

function matchesSeason(p, season) {
  return season == null || p.draft_class_season === season;
}

// Suggestions for autocomplete — same ranking convention as vault.js's
// suggestPlayers: exact > starts-with > word-match > substring, tie-broken
// by overall_rank (lower/better first, i.e. draft rank when nothing's been
// typed yet). Bust-outs/transfers-out (is_active:false) are excluded, same
// as the app's own Big Board query. /prospect asks for season first, so by
// the time the user is typing a name the list is already narrowed to that
// draft class.
export async function suggestProspects(partial, limit = 25, { season } = {}) {
  const all = await getAllProspects();
  const q = (partial ?? "").trim().toLowerCase();

  const scored = all
    .filter((p) => p.is_active !== false)
    .filter((p) => matchesSeason(p, season))
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

// Distinct draft classes present in the data, most recent first — feeds the
// /prospect "season" option's own autocomplete (an Integer option, so value
// stays numeric while the label gets the "Season N" framing).
export async function suggestDraftSeasons(partial, limit = 25) {
  const all = await getAllProspects();
  const seasons = [...new Set(all.map((p) => p.draft_class_season).filter((s) => s != null))].sort(
    (a, b) => b - a
  );
  const q = String(partial ?? "").trim();
  const filtered = q ? seasons.filter((s) => String(s).includes(q)) : seasons;
  return filtered.slice(0, limit).map((s) => ({ name: `Season ${s}`, value: s }));
}

export async function getProspectById(id) {
  const all = await getAllProspects();
  return all.find((p) => p.id === id) ?? null;
}

// Fallback for when the name option was submitted as free text instead of
// an autocomplete pick (still possible in Discord even with autocomplete
// on) — same tiered exact/starts-with/word/substring match as
// suggestProspects, narrowed by whatever season was already chosen, so a
// plain name is enough as long as it's unambiguous within that class.
export async function findProspect(nameInput, { season } = {}) {
  const all = await getAllProspects();
  const q = (nameInput ?? "").trim().toLowerCase();
  if (!q) return { matches: [], unambiguous: false };

  const scored = all
    .filter((p) => p.is_active !== false)
    .filter((p) => matchesSeason(p, season))
    .map((p) => {
      const n = (p.player_fullName ?? "").toLowerCase();
      const words = n.split(/\s+/);
      let tier = 0;
      if (n === q) tier = 4;
      else if (n.startsWith(q)) tier = 3;
      else if (words.includes(q)) tier = 2;
      else if (n.includes(q)) tier = 1;
      return { p, tier };
    })
    .filter((x) => x.tier > 0)
    .sort((a, b) => b.tier - a.tier || (a.p.overall_rank ?? 999) - (b.p.overall_rank ?? 999));

  const matches = scored.map((x) => x.p);
  const exact = scored.filter((x) => x.tier === 4);
  const unambiguous = matches.length === 1 || exact.length === 1;
  return { matches, unambiguous };
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

// --- scouting news stories -----------------------------------------------

let _storyCache = { at: 0, rows: [] };
let _storyRefresh = null;
const STORY_TTL_MS = 300_000;

async function loadStories() {
  const rows = await list(
    "ScoutingNewsStory",
    { is_published: true },
    { sort: "-created_date", limit: 2000 }
  );
  _storyCache = { at: Date.now(), rows };
  return rows;
}

function refreshStoriesInBackground() {
  if (_storyRefresh) return _storyRefresh;
  _storyRefresh = loadStories()
    .catch((err) => {
      console.error("[PROSPECT] story refresh failed:", err.message);
      return _storyCache.rows;
    })
    .finally(() => {
      _storyRefresh = null;
    });
  return _storyRefresh;
}

async function getAllStories() {
  const fresh = Date.now() - _storyCache.at < STORY_TTL_MS;
  if (_storyCache.rows.length) {
    if (!fresh) refreshStoriesInBackground();
    return _storyCache.rows;
  }
  return refreshStoriesInBackground();
}

// Stories tied to a prospect, newest first -- mirrors ProspectPage.jsx's own
// filter exactly: a story counts as related if the prospect is either the
// primary subject (prospect_id) or one of the additional tagged prospects
// (additional_prospect_ids), which a simple {prospect_id: id} server-side
// filter alone would miss.
export async function getProspectStories(prospectId, limit = 4) {
  const all = await getAllStories();
  return all
    .filter((s) => s.prospect_id === prospectId || s.additional_prospect_ids?.includes(prospectId))
    .slice(0, limit);
}
