// heroCard.js — the shared "hero card" layout behind /prospect and /player.
//
// A circular portrait medallion overlapping the top edge of a dark panel
// tinted with an accent colour, mirroring the Vault app's prospect hero card.
// Each card builds its own panel contents from the pieces here; this module
// owns the colours, the medallion, the common building blocks and the
// render (Satori -> resvg PNG, auto-trimmed to the panel's real height).

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

// Laid out at half size and rasterized at 2x (1260 px wide output).
export const W = 630;
const H_MAX = 2400;           // layout canvas; the PNG is trimmed to content
export const PAGE_BG = '#0A0B0D';
const PAGE_RGB = [10, 11, 13];
const PANEL_TOP = 236;
const PANEL_X = 24;
const MEDAL = 316;            // medallion diameter
const MEDAL_TOP = 16;
export const LABEL = '#B8A9A9';
export const GREEN = '#6FD08C';

// --- helpers ---------------------------------------------------------------

export const div = (style, children) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } });

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

// a*(1-t) + b*t
export function mix(a, b, t) {
  return [0, 1, 2].map((i) => a[i] * (1 - t) + b[i] * t);
}

export const FALLBACK_ACCENT = parseHex('#475569');

/**
 * Lift an accent that's too dark to read against the near-black page (several
 * NFL primaries are close to black: Texans #03202F, Titans, Bears...) to a
 * minimum lightness, keeping its hue and saturation. Brighter colours pass
 * through unchanged.
 */
export function visibleAccent(rgb, minLightness = 0.36) {
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let l = (max + min) / 2;
  if (l >= minLightness) return rgb;
  const d = max - min;
  let h = 0, sat = 0;
  if (d) {
    sat = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  l = minLightness;
  const c = (1 - Math.abs(2 * l - 1)) * Math.min(1, sat);
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r1 + m, g1 + m, b1 + m].map((v) => v * 255);
}

export function tierColor(v) {
  if (v >= 90) return '#4ADE80';
  if (v >= 80) return '#60A5FA';
  if (v >= 70) return '#FACC15';
  if (v >= 60) return '#FB923C';
  return '#F87171';
}

export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// --- medallion -------------------------------------------------------------

/**
 * The portrait disc, rendered straight to a PNG data URI with resvg (Satori's
 * transform/clip support isn't enough for this): a radial glow in the accent
 * colour over a near-black base, the photo clipped to a circle. No photo ->
 * initials.
 *
 * `framing` mirrors a CSS `transform: translateY(dy) scale(scale)` with
 * `transform-origin: 50% originY`. The default is the app's ProspectMedallion
 * (zoom 1.2x, pushed down so the photo's bottom edge sits below the rim).
 */
export async function renderMedallion(photoDataUri, accentHex, name, fonts,
  framing = { scale: 1.2, originY: 0.22, dy: 0.13 }) {
  const D = MEDAL * 2; // rasterize at output resolution
  const { scale, originY, dy } = framing;
  const img = D * scale;
  const x = 0.5 * D - 0.5 * img;
  const y = originY * D - originY * img + dy * D;
  const content = photoDataUri
    ? `<image href="${photoDataUri}" x="${x}" y="${y}" width="${img}" height="${img}" preserveAspectRatio="xMidYMin slice" clip-path="url(#c)"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${D}" height="${D}" viewBox="0 0 ${D} ${D}">
  <defs>
    <clipPath id="c"><circle cx="${D / 2}" cy="${D / 2}" r="${D / 2}"/></clipPath>
    <radialGradient id="g" cx="50%" cy="35%" r="65%">
      <stop offset="0%" stop-color="${accentHex}"/>
      <stop offset="45%" stop-color="${accentHex}" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#08090B" stop-opacity="0.9"/>
    </radialGradient>
  </defs>
  <circle cx="${D / 2}" cy="${D / 2}" r="${D / 2}" fill="#0B0C0E"/>
  <circle cx="${D / 2}" cy="${D / 2}" r="${D / 2}" fill="url(#g)"/>
  ${content}
</svg>`;
  const disc = new Resvg(svg).render().asPng();
  const discUri = 'data:image/png;base64,' + Buffer.from(disc).toString('base64');
  if (photoDataUri) return discUri;

  // Initials fallback: lay the letters over the disc with Satori.
  const tree = div({ width: D, height: D, alignItems: 'center', justifyContent: 'center', position: 'relative' }, [
    { type: 'img', props: { src: discUri, width: D, height: D, style: { position: 'absolute', top: 0, left: 0 } } },
    div({ fontFamily: 'Barlow', fontSize: D * 0.28, color: 'rgba(255,255,255,0.8)' }, initialsOf(name)),
  ]);
  const out = new Resvg(await satori(tree, { width: D, height: D, fonts })).render().asPng();
  return 'data:image/png;base64,' + Buffer.from(out).toString('base64');
}

// --- building blocks -------------------------------------------------------

/** Logo disc + name, sized down for long names. */
export function nameBlock(logo, name) {
  const nameSize = Math.min(44, Math.floor(330 / Math.max(1, name.length * 0.42)));
  return div({ alignItems: 'center' }, [
    div({
      width: 48, height: 48, borderRadius: 24, background: '#151515', border: '1px solid rgba(255,255,255,0.12)',
      alignItems: 'center', justifyContent: 'center', marginRight: 14, flexShrink: 0,
    }, logo ? [{ type: 'img', props: { src: logo, width: 34, height: 34, style: { objectFit: 'contain' } } }] : []),
    div({ fontSize: nameSize, color: '#FFFFFF', lineHeight: 1.1 }, name),
  ]);
}

/** The grey position-style pill. */
export function pill(text) {
  return div({ background: 'rgba(255,255,255,0.13)', borderRadius: 6, padding: '6px 13px', fontSize: 19, color: '#FFFFFF' }, text);
}

/** An outlined badge (letter grade, dev trait...). */
export function badge(text, color) {
  const rgb = parseHex(color) || [255, 255, 255];
  return div({
    padding: '5px 15px', fontSize: 20, color,
    background: `rgba(${rgb.join(',')},0.10)`, border: `1px solid rgba(${rgb.join(',')},0.45)`, borderRadius: 2,
  }, text);
}

/** Name/pills block on the left, a big labelled value on the right. */
export function headerRow(left, rightLabel, rightValue, { dim = false } = {}) {
  return div({ marginTop: 116, justifyContent: 'space-between', alignItems: 'flex-start' }, [
    div({ flexDirection: 'column', flex: 1 }, left),
    div({ flexDirection: 'column', alignItems: 'flex-end', marginTop: 4 }, [
      div({ fontSize: 15, letterSpacing: 2.5, color: LABEL }, rightLabel.toUpperCase()),
      div({ fontSize: dim ? 40 : 64, color: dim ? LABEL : '#FFFFFF', lineHeight: 1.1, marginTop: 6 }, rightValue),
    ]),
  ]);
}

/** A row of pills/badges with even spacing. */
export function pillRow(items) {
  const kids = items.filter(Boolean);
  return div({ alignItems: 'center', marginTop: 16 },
    kids.map((k, i) => (i === 0 ? k : div({ marginLeft: 14 }, [k]))));
}

/** Small uppercase label over a big value (bio row, contract grid). */
export function statCell(label, value, { unit = null, width = '25%', size = 30, mb = 0 } = {}) {
  return div({ flexDirection: 'column', width, marginBottom: mb }, [
    div({ fontSize: 15, letterSpacing: 2.5, color: LABEL, marginBottom: 6 }, label.toUpperCase()),
    div({ alignItems: 'flex-end' }, [
      div({ fontSize: size, color: '#FFFFFF', lineHeight: 1 }, value),
      unit ? div({ fontSize: Math.round(size * 0.63), color: LABEL, marginLeft: 6, marginBottom: 2 }, unit) : null,
    ].filter(Boolean)),
  ]);
}

/** Section heading with a hairline under it, then its body. */
export function section(title, body, note = null) {
  return div({ flexDirection: 'column', marginTop: 22 }, [
    div({ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12,
      paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.08)' }, [
      div({ fontSize: 15, letterSpacing: 2.5, color: LABEL }, title.toUpperCase()),
      note ? div({ fontSize: 13, color: LABEL }, note) : null,
    ].filter(Boolean)),
    body,
  ]);
}

/** Muted one-line message inside a section. */
export function muted(text) {
  return div({ fontSize: 16, color: LABEL, marginBottom: 6 }, text);
}

/**
 * One rating: label, bar, value text, half the panel wide (two per line).
 * `mid` drives the bar length/colour on the 40-99 rating scale.
 */
export function barRow(label, mid, text) {
  const pct = ((mid - 40) / (99 - 40)) * 100;
  return div({ width: '50%', alignItems: 'center', paddingRight: 18, marginBottom: 13 }, [
    div({ width: 112, fontSize: 15, color: '#E5DADA' }, label),
    div({ flex: 1, height: 7, borderRadius: 4, background: 'rgba(255,255,255,0.09)', overflow: 'hidden' }, [
      div({ width: `${Math.max(4, Math.min(100, pct))}%`, height: '100%', borderRadius: 4, background: tierColor(mid) }, []),
    ]),
    div({ width: 54, justifyContent: 'flex-end', fontSize: 16, color: '#FFFFFF' }, String(text)),
  ]);
}

export const barGrid = (rows) => div({ flexWrap: 'wrap' }, rows);

// --- render ----------------------------------------------------------------

/**
 * Lay out the page (panel + medallion) and return the PNG, trimmed to just
 * below the panel so every card is exactly as tall as its content.
 */
export async function renderHeroCard({ accent, medallion, children, fonts }) {
  const panelBg = toHex(mix(PAGE_RGB, accent, 0.17));
  const panelBorder = toHex(mix(PAGE_RGB, accent, 0.45));
  const ring = toHex(mix(accent, [0, 0, 0], 0.15));

  const tree = div({ width: W, height: H_MAX, background: PAGE_BG, position: 'relative', fontFamily: 'Barlow', flexDirection: 'column' }, [
    div({
      marginTop: PANEL_TOP, marginLeft: PANEL_X, marginRight: PANEL_X,
      background: panelBg, borderRadius: 10, border: `1px solid ${panelBorder}`,
      borderTop: `4px solid ${ring}`, flexDirection: 'column', padding: '0 38px 26px',
    }, children),
    // Medallion (drawn last so it overlaps the panel's top edge)
    div({
      position: 'absolute', top: MEDAL_TOP, left: (W - MEDAL) / 2, width: MEDAL, height: MEDAL,
      borderRadius: MEDAL / 2, border: `3px solid ${ring}`, boxShadow: '0 0 0 3px rgba(0,0,0,0.35)', overflow: 'hidden',
    }, [{ type: 'img', props: { src: medallion, width: MEDAL - 6, height: MEDAL - 6 } }]),
  ]);

  const svg = await satori(tree, { width: W, height: H_MAX, fonts });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: W * 2 } }).render().asPng();

  // Trim: find the last row that isn't plain page background.
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let last = 0;
  for (let y = height - 1; y >= 0 && !last; y--) {
    const row = y * width * channels;
    for (let x = 0; x < width; x += 4) {
      const i = row + x * channels;
      if (Math.abs(data[i] - PAGE_RGB[0]) + Math.abs(data[i + 1] - PAGE_RGB[1]) + Math.abs(data[i + 2] - PAGE_RGB[2]) > 9) {
        last = y;
        break;
      }
    }
  }
  const h = Math.min(height, last + 44);
  return sharp(png).extract({ left: 0, top: 0, width, height: h }).png().toBuffer();
}
