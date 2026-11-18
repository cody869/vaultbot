// prospectCard.js — renders the /prospect card (Satori -> PNG via resvg).
//
// Matches the Vault app's prospect hero card: a circular portrait medallion
// sitting on top of a dark panel tinted with the photo's own background
// colour, the school logo + name, a position pill, class year, letter grade,
// overall rank, and a height/weight/age/position grid.
//
// CRITICAL CONSTRAINT: a DraftProspect is not a real Madden player yet. Every
// rating on the entity is the TRUE underlying number and nothing here may
// ever print one. This card shows no ratings at all -- only bio facts and
// value-independent labels -- and what it shows is gated exactly like the
// app's ProspectPage.jsx on the class's ScoutingGate level:
//   gate 0   name, school, position, class year
//   gate 1+  height / weight / age
//   gate 3+  letter grade (overall_grade) and overall rank

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { loadFonts, loadLogoDataUri } from './cardKit.js';
import { getCollegeLogoUrl, getCollegeColor } from './d1Teams.js';

// Rendered at half size and rasterized at 2x (1260 px wide output).
const W = 630;
const H = 710;

const PAGE_BG = '#0A0B0D';
const PANEL_TOP = 236;
const PANEL_X = 24;
const MEDAL = 316;            // medallion diameter
const MEDAL_TOP = 16;
const LABEL = '#B8A9A9';
const GREEN = '#6FD08C';

// Raw Madden positions -> the group the app shows (src/lib/draftShow.js).
const POSITION_GROUP = {
  QB: 'QB',
  HB: 'RB', RB: 'RB', FB: 'RB',
  WR: 'WR',
  TE: 'TE',
  LT: 'OT', RT: 'OT', OT: 'OT', T: 'OT',
  LG: 'IOL', RG: 'IOL', G: 'IOL', OG: 'IOL', C: 'IOL', IOL: 'IOL',
  LE: 'EDGE', RE: 'EDGE', DE: 'EDGE', LEDGE: 'EDGE', REDGE: 'EDGE', EDGE: 'EDGE',
  DT: 'DL', NT: 'DL', DL: 'DL',
  MIKE: 'LB', SAM: 'LB', WILL: 'LB', MLB: 'LB', LOLB: 'LB', ROLB: 'LB', OLB: 'LB', ILB: 'LB', LB: 'LB',
  CB: 'CB',
  FS: 'S', SS: 'S', S: 'S',
  K: 'K', P: 'P',
};

export function positionGroup(pos) {
  const p = String(pos || '').trim().toUpperCase();
  return POSITION_GROUP[p] || p || '?';
}

// --- colour helpers ---------------------------------------------------------

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

// a*(1-t) + b*t
function mix(a, b, t) {
  return [0, 1, 2].map((i) => a[i] * (1 - t) + b[i] * t);
}

// The card's accent: the colour sampled from the portrait (so the card
// matches the photo, as in the app), else the school's colour, else slate.
function accentFor(p) {
  return (
    parseHex(p.headshot_bg) ||
    (p.college ? parseHex(getCollegeColor(p.college)) : null) ||
    parseHex('#475569')
  );
}

// --- medallion --------------------------------------------------------------

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The portrait disc, rendered straight to a PNG data URI with resvg (Satori's
 * transform/clip support isn't enough for this). Same framing as the app's
 * ProspectMedallion: a radial glow in the accent colour over a near-black
 * base, the photo zoomed 1.2x and pushed down so its bottom edge always sits
 * below the rim, all clipped to a circle. No photo -> initials.
 */
async function renderMedallion(photoDataUri, accentHex, name, fonts) {
  const D = MEDAL * 2; // rasterize at output resolution
  const img = D * 1.2;
  // CSS: transform: translateY(13%) scale(1.2); transform-origin: 50% 22%
  const x = 0.5 * D - 0.5 * img;
  const y = 0.22 * D - 0.22 * img + 0.13 * D;
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
  if (photoDataUri) return 'data:image/png;base64,' + Buffer.from(disc).toString('base64');

  // Initials fallback: lay the letters over the disc with Satori.
  const discUri = 'data:image/png;base64,' + Buffer.from(disc).toString('base64');
  const tree = {
    type: 'div',
    props: {
      style: { display: 'flex', width: D, height: D, alignItems: 'center', justifyContent: 'center', position: 'relative' },
      children: [
        { type: 'img', props: { src: discUri, width: D, height: D, style: { position: 'absolute', top: 0, left: 0 } } },
        { type: 'div', props: { style: { display: 'flex', fontFamily: 'Barlow', fontSize: D * 0.28, color: 'rgba(255,255,255,0.8)' }, children: initialsOf(name) } },
      ],
    },
  };
  const out = new Resvg(await satori(tree, { width: D, height: D, fonts })).render().asPng();
  return 'data:image/png;base64,' + Buffer.from(out).toString('base64');
}

// --- small pieces -----------------------------------------------------------

const div = (style, children) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } });

function statCell(label, value, unit) {
  return div({ flexDirection: 'column', width: '50%', marginBottom: 26 }, [
    div({ fontSize: 15, letterSpacing: 2.5, color: LABEL, marginBottom: 6 }, label.toUpperCase()),
    div({ alignItems: 'flex-end' }, [
      div({ fontSize: 30, color: '#FFFFFF', lineHeight: 1 }, value),
      unit ? div({ fontSize: 19, color: LABEL, marginLeft: 6, marginBottom: 2 }, unit) : null,
    ].filter(Boolean)),
  ]);
}

/**
 * @param {object} p      DraftProspect row
 * @param {number} gate   ScoutingGate.gate_level for the prospect's class (0-4)
 * @returns {Promise<Buffer>} PNG
 */
export async function renderProspectCard(p, gate) {
  const accent = accentFor(p);
  const accentHex = toHex(accent);
  const panelBg = toHex(mix([11, 11, 13], accent, 0.17));
  const panelBorder = toHex(mix([11, 11, 13], accent, 0.45));
  const ring = toHex(mix(accent, [0, 0, 0], 0.15));

  const showPhysical = gate >= 1;
  const showGrade = gate >= 3 && !!p.overall_grade;
  const showRank = gate >= 3 && p.overall_rank != null;

  const portraitSrc = p.headshot_url || p.portrait_url;
  const [fonts, logo, photo] = await Promise.all([
    loadFonts(),
    p.college ? loadLogoDataUri(getCollegeLogoUrl(p.college)).catch(() => null) : Promise.resolve(null),
    portraitSrc ? loadLogoDataUri(portraitSrc).catch(() => null) : Promise.resolve(null),
  ]);
  const medallion = await renderMedallion(photo, accentHex, p.player_fullName, fonts);

  const pos = positionGroup(p.player_position);
  const name = String(p.player_fullName || 'Unknown');
  // Shrink long names so they never run under the rank column.
  const nameSize = Math.min(44, Math.floor(330 / Math.max(1, name.length * 0.42)));
  const locked = '—';

  const tree = div(
    { width: W, height: H, background: PAGE_BG, position: 'relative', fontFamily: 'Barlow' },
    [
      // Panel
      div({
        position: 'absolute', left: PANEL_X, top: PANEL_TOP, width: W - PANEL_X * 2, height: H - PANEL_TOP - 22,
        background: panelBg, borderRadius: 10, border: `1px solid ${panelBorder}`,
        borderTop: `4px solid ${ring}`, flexDirection: 'column', padding: '0 38px',
      }, [
        // Name block + rank
        div({ marginTop: 116, justifyContent: 'space-between', alignItems: 'flex-start' }, [
          div({ flexDirection: 'column', flex: 1 }, [
            div({ alignItems: 'center' }, [
              div({
                width: 48, height: 48, borderRadius: 24, background: '#151515', border: '1px solid rgba(255,255,255,0.12)',
                alignItems: 'center', justifyContent: 'center', marginRight: 14, flexShrink: 0,
              }, logo ? [{ type: 'img', props: { src: logo, width: 34, height: 34, style: { objectFit: 'contain' } } }] : []),
              div({ fontSize: nameSize, color: '#FFFFFF', lineHeight: 1.1 }, name),
            ]),
            div({ alignItems: 'center', marginTop: 16 }, [
              div({ background: 'rgba(255,255,255,0.13)', borderRadius: 6, padding: '6px 13px', fontSize: 19, color: '#FFFFFF' }, pos),
              p.college_year ? div({ fontSize: 21, color: LABEL, marginLeft: 14 }, p.college_year) : null,
              showGrade ? div({
                marginLeft: 14, padding: '5px 15px', fontSize: 20, color: GREEN,
                background: 'rgba(111,208,140,0.10)', border: '1px solid rgba(111,208,140,0.45)', borderRadius: 2,
              }, p.overall_grade) : null,
            ].filter(Boolean)),
          ]),
          div({ flexDirection: 'column', alignItems: 'flex-end', marginTop: 4 }, [
            div({ fontSize: 15, letterSpacing: 2.5, color: LABEL }, 'OVERALL RANK'),
            div({ fontSize: showRank ? 64 : 40, color: showRank ? '#FFFFFF' : LABEL, lineHeight: 1.1, marginTop: 6 },
              showRank ? `#${p.overall_rank}` : locked),
          ]),
        ]),
        // Bio grid
        div({ flexWrap: 'wrap', marginTop: 38 }, [
          statCell('Height', showPhysical && p.height ? p.height : locked),
          statCell('Weight', showPhysical && p.weight ? String(p.weight) : locked, showPhysical && p.weight ? 'lbs' : null),
          statCell('Age', showPhysical && p.age ? String(p.age) : locked),
          statCell('Position', pos),
        ]),
      ]),
      // Medallion (drawn last so it overlaps the panel's top edge)
      div({
        position: 'absolute', top: MEDAL_TOP, left: (W - MEDAL) / 2, width: MEDAL, height: MEDAL,
        borderRadius: MEDAL / 2, border: `3px solid ${ring}`, boxShadow: '0 0 0 3px rgba(0,0,0,0.35)', overflow: 'hidden',
      }, [{ type: 'img', props: { src: medallion, width: MEDAL - 6, height: MEDAL - 6 } }]),
    ]
  );

  const svg = await satori(tree, { width: W, height: H, fonts });
  return new Resvg(svg, { fitTo: { mode: 'width', value: W * 2 } }).render().asPng();
}
