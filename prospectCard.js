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

import { loadFonts, loadLogoDataUri } from './cardKit.js';
import { getCollegeLogoUrl, getCollegeColor } from './d1Teams.js';
import { attrDisplay } from './prospectGateDisplay.js';
import {
  GREEN, parseHex, toHex, FALLBACK_ACCENT, visibleAccent, renderMedallion, nameBlock, pill, badge, headerRow,
  pillRow, statCell, section, muted, barRow, barGrid, renderHeroCard, LABEL, div,
} from './heroCard.js';

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

// The card's accent: the colour sampled from the portrait (so the card
// matches the photo, as in the app), else the school's colour, else slate.
function accentFor(p) {
  return (
    parseHex(p.headshot_bg) ||
    (p.college ? parseHex(getCollegeColor(p.college)) : null) ||
    FALLBACK_ACCENT
  );
}

// Bar length and colour come from the midpoint of the DISPLAYED range, never
// the true rating. (prospectGateDisplay's attrBarWidth() is not safe for this:
// at gate 3 it returns exactly the true value, so a bar sized from it can be
// measured to recover the hidden rating.)
function ratingRow(p, field, gate) {
  const range = attrDisplay(Number(p[field]), gate, field);
  const [lo, hi] = range.split('-').map(Number);
  return barRow(ATTR_LABELS[field] || field, (lo + hi) / 2, range);
}

/**
 * @param {object} p      DraftProspect row
 * @param {number} gate   ScoutingGate.gate_level for the prospect's class (0-4)
 * @returns {Promise<Buffer>} PNG
 */
export async function renderProspectCard(p, gate) {
  const accent = visibleAccent(accentFor(p));
  const showPhysical = gate >= 1;
  const showGrade = gate >= 3 && !!p.overall_grade;
  const showRank = gate >= 3 && p.overall_rank != null;

  const portraitSrc = p.headshot_url || p.portrait_url;
  const [fonts, logo, photo] = await Promise.all([
    loadFonts(),
    p.college ? loadLogoDataUri(getCollegeLogoUrl(p.college)).catch(() => null) : Promise.resolve(null),
    portraitSrc ? loadLogoDataUri(portraitSrc).catch(() => null) : Promise.resolve(null),
  ]);
  const medallion = await renderMedallion(photo, toHex(accent), p.player_fullName, fonts);

  const pos = positionGroup(p.player_position);
  const name = String(p.player_fullName || 'Unknown');
  const locked = '—';

  // Ratings: physical + the position's key ratings, skipping any the row
  // doesn't carry. Two per line; the card grows to fit.
  const has = (f) => p[f] != null && Number.isFinite(Number(p[f]));
  const sections = [
    { title: 'Physical', fields: PHYSICAL_KEYS.filter(has) },
    { title: `Key ${pos} Ratings`, fields: (POSITION_KEYS[pos] || []).filter(has) },
  ].filter((x) => x.fields.length);
  const rangeNote = gate >= 1 ? `Scouting ranges · ${GATE_RANGE[Math.min(gate, 4)]}` : null;

  const children = [
    headerRow(
      [
        nameBlock(logo, name),
        pillRow([
          pill(pos),
          p.college_year ? div({ fontSize: 21, color: LABEL }, p.college_year) : null,
          showGrade ? badge(p.overall_grade, GREEN) : null,
        ]),
      ],
      'Overall Rank',
      showRank ? `#${p.overall_rank}` : locked,
      { dim: !showRank }
    ),
    div({ marginTop: 34 }, [
      statCell('Height', showPhysical && p.height ? p.height : locked),
      statCell('Weight', showPhysical && p.weight ? String(p.weight) : locked, { unit: showPhysical && p.weight ? 'lbs' : null }),
      statCell('Age', showPhysical && p.age ? String(p.age) : locked),
      statCell('Position', pos),
    ]),
    ...sections.map((sec, i) =>
      section(
        sec.title,
        gate >= 1 ? barGrid(sec.fields.map((f) => ratingRow(p, f, gate))) : muted('Locked — no scouting intel on this class yet'),
        i === 0 ? rangeNote : null
      )
    ),
  ];

  return renderHeroCard({ accent, medallion, children, fonts });
}
