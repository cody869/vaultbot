// cardKit.js — shared satori/resvg card-rendering helpers.
//
// Extracted out of scorebugCard.js so a second card (suspensionCard.js) can
// share the same fonts, logo-loading/caching, and visual language instead of
// duplicating them. scorebugCard.js was refactored to use this module too —
// behavior there is unchanged, just no longer duplicated.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripWhiteBackground } from './logoTransparency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Shared visual language across every generated card.
export const GOLD = '#D4A843';
export const DARK_BG = '#12161C';

let fontsCache = null;
export async function loadFonts() {
  if (fontsCache) return fontsCache;
  const anton = fs.readFileSync(path.join(__dirname, 'Anton-Regular.ttf'));
  const barlow = fs.readFileSync(path.join(__dirname, 'Barlow-Bold.ttf'));
  fontsCache = [
    { name: 'Anton', data: anton, weight: 400, style: 'normal' },
    { name: 'Barlow', data: barlow, weight: 700, style: 'normal' },
  ];
  return fontsCache;
}

// Small in-memory cache so repeated calls in the same process don't
// re-fetch the same team's logo every time.
const logoCache = new Map();

// PNG files start with this exact 8-byte signature -- cheap, reliable way to
// catch "the request succeeded but what came back wasn't really a PNG" (an
// HTML error page, a truncated response, etc.), which a bare `res.ok` check
// doesn't catch since the HTTP status can still be 200.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function loadLogoDataUri(url) {
  if (logoCache.has(url)) return logoCache.get(url);

  let buf;
  if (/^https?:\/\//.test(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Logo fetch failed (${res.status}): ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    buf = fs.readFileSync(url);
  }

  if (buf.length < 512 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(
      `Logo at ${url} doesn't look like a real PNG (${buf.length} bytes) -- ` +
      `request likely succeeded with a non-image response instead of failing outright.`
    );
  }

  // A few assets in the source repo (Dolphins confirmed) are flat opaque
  // PNGs with a baked-in white square instead of a transparent background.
  // No-op for logos that are already transparent -- see logoTransparency.js.
  const cleaned = stripWhiteBackground(buf);

  const dataUri = 'data:image/png;base64,' + cleaned.toString('base64');
  logoCache.set(url, dataUri);
  return dataUri;
}
