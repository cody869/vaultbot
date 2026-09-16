// prospectGateDisplay.js — gated attribute display for scouting.
//
// Ported verbatim from the XCFL Vault app's src/lib/prospectGateDisplay.js.
// This must produce byte-identical output to the app for the same
// value+field+gate, since /prospect's whole point is showing exactly what
// the app's own ScoutingGate would reveal -- never a precise rating.

// Stable pseudo-random offset seeded by value + field name, so the displayed
// range doesn't jump around on re-render.
export function seededOffset(val, field) {
  let h = val * 31;
  for (let i = 0; i < field.length; i++) h = (h * 7 + field.charCodeAt(i)) & 0xffff;
  return (h % 3) - 1; // -1, 0, or +1 shift on the range start
}

// Rating scale bounds — nothing displayed may fall outside these.
export const RATING_FLOOR = 40;
export const RATING_CEIL = 99;

// Builds a `lo-hi` label of a fixed width that always sits inside 40-99.
// The window SLIDES DOWN at the top of the scale instead of running past 99,
// so a 99-rated prospect shows a full-width range (e.g. 96-99) rather than
// something like 99-102. The true value stays inside the range either way.
function gatedRange(val, back, width, offset) {
  const lo = Math.min(Math.max(RATING_FLOOR, val - back + offset), RATING_CEIL - width);
  return `${lo}-${lo + width}`;
}

// Returns a range label depending on the scouting gate level.
//   gate 0  → hidden (caller should render a lock, not call this)
//   gate 1  → ~20pt range   (First Look)
//   gate 2  → ~12pt range   (Film Study)
//   gate 3  → ~7pt range    (Advanced Scouting)
//   gate 4  → ~4pt range    (Full Dossier)
export function attrDisplay(val, gate, field = '') {
  const offset = seededOffset(val, field);
  if (gate >= 4) return gatedRange(val, 1, 3, offset);
  if (gate === 3) return gatedRange(val, 3, 6, offset);
  if (gate === 2) return gatedRange(val, 5, 11, offset);
  // gate 1 — 20pt range
  return gatedRange(val, 9, 19, offset);
}

// Bar width for gated display — midpoint of the displayed range.
export function attrBarWidth(val, gate) {
  const clamp = (n) => Math.max(RATING_FLOOR, Math.min(RATING_CEIL, n));
  if (gate >= 4) return clamp(val - 1 + (seededOffset(val, 'bar') === -1 ? 0 : seededOffset(val, 'bar') === 1 ? 2 : 1));
  if (gate === 3) return clamp(val - 3 + Math.round(6 / 2));
  if (gate === 2) return clamp(val - 5 + Math.round(11 / 2));
  return clamp(val - 9 + Math.round(19 / 2));
}
