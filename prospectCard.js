// prospectCard.js — renders the /prospect card (Satori -> PNG via resvg).
//
// Matches the Vault app's prospect hero card: a circular portrait medallion
// sitting on top of a dark panel tinted with the photo's own background
// colour, the school logo + name, a position pill, class year, letter grade,
// overall rank, and a height/weight/age/position grid.
//
// CRITICAL CONSTRAINT: a DraftProspect is not a real Madden player yet. Every
// rating on the entity is the TRUE underlying number and nothing here may
// ever print one. Ratings appear only as the `lo-hi` ranges from
// prospectGateDisplay.js's attrDisplay() -- byte-identical to what the app
// shows for the same ScoutingGate level -- and everything is gated exactly
// like the app's ProspectPage.jsx on the class's gate level:
//   gate 0   name, school, position, class year (ratings locked)
//   gate 1+  height / weight / age, physical + key positional rating ranges
//            (the ranges narrow as the gate rises: ~20 / 12 / 7 / 4 pts)
//   gate 3+  letter grade (overall_grade) and overall rank

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { loadFonts, loadLogoDataUri } from './cardKit.js';
import { getCollegeLogoUrl, getCollegeColor } from './d1Teams.js';
import { attrDisplay, RATING_FLOOR, RATING_CEIL } from './prospectGateDisplay.js';

// Rendered at half size and rasterized at 2x (1260 px wide output).
const W = 630;

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

// --- ratings ----------------------------------------------------------------

const ATTR_LABELS = {
  spd: 'Speed', acc: 'Acceleration', agi: 'Agility', str: 'Strength', awa: 'Awareness',
  jmp: 'Jumping', sta: 'Stamina', tgh: 'Toughness', inj: 'Injury', changeOfDir: 'Change of Dir',
  throwPower: 'Throw Power', shortAcc: 'Short Acc', midAcc: 'Medium Acc', deepAcc: 'Deep Acc',
  throwOnRun: 'Throw on Run', playAction: 'Play Action', breakSack: 'Break Sack', underPressure: 'Under Pressure',
  carry: 'Carrying', spinMove: 'Spin Move', jukeMove: 'Juke Move', breakTackle: 'Break Tackle',
  ballCarryVision: 'BC Vision', trucking: 'Trucking', stiffArm: 'Stiff Arm',
  catch: 'Catching', specCatch: 'Spec Catch', release: 'Release', catchInTraffic: 'Catch in Traffic',
  shortRouteRun: 'Short Route', medRouteRun: 'Medium Route', deepRouteRun: 'Deep Route', kickReturn: 'Kick Return',
  passBlock: 'Pass Block', passBlockPwr: 'PB Power', passBlockFin: 'PB Finesse',
  runBlock: 'Run Block', runBlockPwr: 'RB Power', runBlockFin: 'RB Finesse', leadBlock: 'Lead Block', impactBlock: 'Impact Block',
  blockShed: 'Block Shedding', finesseMoves: 'Finesse Moves', powerMoves: 'Power Moves',
  manCoverage: 'Man Coverage', zoneCoverage: 'Zone Coverage', press: 'Press',
  tackle: 'Tackle', hitPower: 'Hit Power', pursuit: 'Pursuit', playRecog: 'Play Recognition',
  kickPower: 'Kick Power', kickAcc: 'Kick Accuracy',
};

const PHYSICAL_KEYS = ['spd', 'acc', 'agi', 'changeOfDir', 'str', 'jmp', 'awa', 'sta'];

// The ratings that define each position group (keyed by positionGroup()).
const POSITION_KEYS = {
  QB: ['throwPower', 'shortAcc', 'midAcc', 'deepAcc', 'throwOnRun', 'playAction', 'underPressure', 'breakSack'],
  RB: ['carry', 'ballCarryVision', 'breakTackle', 'jukeMove', 'spinMove', 'trucking', 'stiffArm', 'catch'],
  WR: ['catch', 'specCatch', 'catchInTraffic', 'release', 'shortRouteRun', 'medRouteRun', 'deepRouteRun', 'kickReturn'],
  TE: ['catch', 'catchInTraffic', 'specCatch', 'shortRouteRun', 'medRouteRun', 'runBlock', 'passBlock', 'impactBlock'],
  OT: ['passBlock', 'passBlockPwr', 'passBlockFin', 'runBlock', 'runBlockPwr', 'runBlockFin', 'impactBlock', 'leadBlock'],
  IOL: ['runBlock', 'runBlockPwr', 'runBlockFin', 'passBlock', 'passBlockPwr', 'passBlockFin', 'impactBlock', 'leadBlock'],
  EDGE: ['powerMoves', 'finesseMoves', 'blockShed', 'pursuit', 'tackle', 'hitPower', 'playRecog'],
  DL: ['blockShed', 'powerMoves', 'finesseMoves', 'tackle', 'hitPower', 'pursuit', 'playRecog'],
  LB: ['tackle', 'hitPower', 'pursuit', 'playRecog', 'blockShed', 'zoneCoverage', 'manCoverage'],
  CB: ['manCoverage', 'zoneCoverage', 'press', 'playRecog', 'catch', 'tackle'],
  S: ['zoneCoverage', 'manCoverage', 'playRecog', 'tackle', 'hitPower', 'pursuit', 'press'],
  K: ['kickPower', 'kickAcc'],
  P: ['kickPower', 'kickAcc'],
};

const GATE_RANGE = { 1: '~20 pt', 2: '~12 pt', 3: '~7 pt', 4: '~4 pt' };

// Bar length and colour come from the midpoint of the DISPLAYED range, never
// the true rating. (prospectGateDisplay's attrBarWidth() is not safe for this:
// at gate 3 it returns exactly the true value, so a bar sized from it can be
// measured to recover the hidden rating.)
function tierColor(v) {
  if (v >= 90) return '#4ADE80';
  if (v >= 80) return '#60A5FA';
  if (v >= 70) return '#FACC15';
  if (v >= 60) return '#FB923C';
  return '#F87171';
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
  return div({ flexDirection: 'column', width: '25%' }, [
    div({ fontSize: 15, letterSpacing: 2.5, color: LABEL, marginBottom: 6 }, label.toUpperCase()),
    div({ alignItems: 'flex-end' }, [
      div({ fontSize: 30, color: '#FFFFFF', lineHeight: 1 }, value),
      unit ? div({ fontSize: 19, color: LABEL, marginLeft: 6, marginBottom: 2 }, unit) : null,
    ].filter(Boolean)),
  ]);
}

function ratingRow(p, field, gate) {
  const val = Number(p[field]);
  const range = attrDisplay(val, gate, field);
  const [lo, hi] = range.split('-').map(Number);
  const mid = (lo + hi) / 2;
  const pct = ((mid - RATING_FLOOR) / (RATING_CEIL - RATING_FLOOR)) * 100;
  return div({ width: '50%', alignItems: 'center', paddingRight: 18, marginBottom: 13 }, [
    div({ width: 112, fontSize: 15, color: '#E5DADA' }, ATTR_LABELS[field] || field),
    div({ flex: 1, height: 7, borderRadius: 4, background: 'rgba(255,255,255,0.09)', overflow: 'hidden' }, [
      div({ width: `${Math.max(4, Math.min(100, pct))}%`, height: '100%', borderRadius: 4, background: tierColor(mid) }, []),
    ]),
    div({ width: 54, justifyContent: 'flex-end', fontSize: 16, color: '#FFFFFF' }, range),
  ]);
}

function ratingSection(title, fields, p, gate, note) {
  return div({ flexDirection: 'column', marginTop: 22 }, [
    div({ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12,
      paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.08)' }, [
      div({ fontSize: 15, letterSpacing: 2.5, color: LABEL }, title.toUpperCase()),
      note ? div({ fontSize: 13, color: LABEL }, note) : null,
    ].filter(Boolean)),
    gate >= 1
      ? div({ flexWrap: 'wrap' }, fields.map((f) => ratingRow(p, f, gate)))
      : div({ fontSize: 16, color: LABEL, marginBottom: 6 }, 'Locked — no scouting intel on this class yet'),
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

  // Ratings: physical + the position's key ratings, skipping any the row
  // doesn't carry. Two per line; the card grows to fit.
  const has = (f) => p[f] != null && Number.isFinite(Number(p[f]));
  const physical = PHYSICAL_KEYS.filter(has);
  const keyFields = (POSITION_KEYS[pos] || []).filter(has);
  const sections = [
    { title: 'Physical', fields: physical },
    keyFields.length ? { title: `Key ${pos} Ratings`, fields: keyFields } : null,
  ].filter((x) => x && x.fields.length);
  const rowsOf = (n) => (gate >= 1 ? Math.ceil(n / 2) : 1);
  const H = 600 + sections.reduce((h, sec) => h + 66 + rowsOf(sec.fields.length) * 28, 0) + 26;
  const rangeNote = gate >= 1 ? `Scouting ranges · ${GATE_RANGE[Math.min(gate, 4)]}` : null;

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
        // Bio row
        div({ marginTop: 34 }, [
          statCell('Height', showPhysical && p.height ? p.height : locked),
          statCell('Weight', showPhysical && p.weight ? String(p.weight) : locked, showPhysical && p.weight ? 'lbs' : null),
          statCell('Age', showPhysical && p.age ? String(p.age) : locked),
          statCell('Position', pos),
        ]),
        // Ratings
        ...sections.map((sec, i) => ratingSection(sec.title, sec.fields, p, gate, i === 0 ? rangeNote : null)),
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
