// prospectCard.js — renders a /prospect scouting card (Satori -> PNG via
// resvg), matching the visual language of this bot's other cards (gold
// border, dark background, Anton headline / Barlow body -- see cardKit.js)
// while following the Franchise Hub player-card layout as closely as a
// scouting report reasonably can.
//
// CRITICAL CONSTRAINT: a DraftProspect is not a real Madden player yet --
// every rating on the entity is the TRUE underlying number, but nothing
// here may ever print one. Every number-shaped thing on this card is
// either a `lo-hi` range from prospectGateDisplay.js's attrDisplay() (byte-
// identical to what the app itself would show for the same ScoutingGate
// level) or a value-independent label (a letter grade, a round projection,
// a bust-risk tier). Section VISIBILITY is also gated exactly like the
// app's ProspectPage.jsx: gate 0 shows almost nothing, gate 1+ reveals
// physical/attribute-ranges/articles, gate 2+ adds archetype, gate 3+ adds
// grade/round/bust-risk/ranks/strengths.
//
// Two things the reference Franchise Hub card has that a prospect
// fundamentally can't: a precise OVR badge (replaced with the letter
// `overall_grade`, gate 3+) and Madden abilities/X-Factor (replaced with a
// Scouting Report panel: archetype, round projection, bust risk, ranks --
// the actual DraftProspect equivalent of "here's the evaluation"). The
// gauge row is also an adaptation -- there's no prospect equivalent of a
// ranked stat, so it lists the prospect's related ScoutingNewsStory
// headlines instead.

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { loadFonts, loadLogoDataUri, GOLD, DARK_BG } from './cardKit.js';
import { getCollegeLogoUrl, getCollegeColor } from './d1Teams.js';
import { attrDisplay, attrBarWidth } from './prospectGateDisplay.js';

const W = 900;
const H_FULL = 760;
const H_LOCKED = 300; // gate 0: almost nothing renders -- a full-height card is mostly empty

const GREEN = '#4ADE80';
const BLUE = '#60A5FA';
const YELLOW = '#FACC15';
const ORANGE = '#FB923C';
const RED = '#F87171';
const MUTED = '#8B93A1';

function tierColor(val) {
  if (val >= 90) return GREEN;
  if (val >= 80) return BLUE;
  if (val >= 70) return YELLOW;
  if (val >= 60) return ORANGE;
  return RED;
}

function gradeColor(grade) {
  if (!grade) return MUTED;
  if (grade.startsWith('A')) return GREEN;
  if (grade.startsWith('B')) return BLUE;
  if (grade.startsWith('C')) return YELLOW;
  return MUTED;
}

const BUST_COLOR = { Low: GREEN, Medium: YELLOW, High: RED };

const ATTR_LABELS = {
  spd: 'Speed', acc: 'Acceleration', agi: 'Agility', str: 'Strength', awa: 'Awareness',
  jmp: 'Jumping', sta: 'Stamina', tgh: 'Toughness', inj: 'Injury', changeOfDir: 'Change of Dir',
  throwPower: 'Throw Power', shortAcc: 'Short Acc', midAcc: 'Mid Acc', deepAcc: 'Deep Acc',
  throwOnRun: 'Throw on Run', playAction: 'Play Action', breakSack: 'Break Sack', underPressure: 'Under Pressure',
  carry: 'Carrying', spinMove: 'Spin Move', jukeMove: 'Juke Move', breakTackle: 'Break Tackle',
  ballCarryVision: 'Ball Carry Vision', trucking: 'Trucking', stiffArm: 'Stiff Arm',
  catch: 'Catching', specCatch: 'Spec Catch', release: 'Release', catchInTraffic: 'CIT',
  shortRouteRun: 'Short Route', medRouteRun: 'Med Route', deepRouteRun: 'Deep Route', kickReturn: 'Kick Return',
  passBlock: 'Pass Block', passBlockPwr: 'PB Power', passBlockFin: 'PB Finesse',
  runBlock: 'Run Block', runBlockPwr: 'RB Power', runBlockFin: 'RB Finesse', leadBlock: 'Lead Block', impactBlock: 'Impact Block',
  blockShed: 'Block Shed', finesseMoves: 'Finesse Moves', powerMoves: 'Power Moves',
  manCoverage: 'Man Coverage', zoneCoverage: 'Zone Coverage', press: 'Press',
  tackle: 'Tackle', hitPower: 'Hit Power', pursuit: 'Pursuit', playRecog: 'Play Recognition',
  kickPower: 'Kick Power', kickAcc: 'Kick Accuracy',
};

// Same grouping as the app's ProspectPage.jsx (ATTR_GROUPS), trimmed to what
// this card has room for. Order matters -- primary group for the position
// renders first.
const ATTR_GROUPS = {
  Physical: ['spd', 'acc', 'agi', 'changeOfDir', 'str', 'awa'],
  Passing: ['throwPower', 'shortAcc', 'midAcc', 'deepAcc', 'throwOnRun', 'underPressure'],
  Rushing: ['carry', 'spinMove', 'jukeMove', 'breakTackle', 'ballCarryVision', 'trucking'],
  Receiving: ['catch', 'specCatch', 'release', 'catchInTraffic', 'shortRouteRun', 'deepRouteRun'],
  Blocking: ['passBlock', 'runBlock', 'leadBlock', 'impactBlock'],
  'Pass Rush': ['blockShed', 'finesseMoves', 'powerMoves'],
  Coverage: ['manCoverage', 'zoneCoverage', 'press'],
  Tackling: ['tackle', 'hitPower', 'pursuit', 'playRecog'],
  Kicking: ['kickPower', 'kickAcc'],
};

const POSITION_PRIMARY_GROUPS = {
  QB: ['Physical', 'Passing'], RB: ['Physical', 'Rushing', 'Receiving'], WR: ['Physical', 'Receiving'],
  TE: ['Physical', 'Receiving', 'Blocking'], OT: ['Physical', 'Blocking'], OG: ['Physical', 'Blocking'],
  C: ['Physical', 'Blocking'], DE: ['Physical', 'Pass Rush', 'Tackling'], DT: ['Physical', 'Pass Rush', 'Tackling'],
  LB: ['Physical', 'Tackling', 'Coverage'], CB: ['Physical', 'Coverage', 'Tackling'], S: ['Physical', 'Coverage', 'Tackling'],
  K: ['Physical', 'Kicking'], P: ['Physical', 'Kicking'],
};

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function pill(text, { bg = 'rgba(255,255,255,0.12)', color = '#FFFFFF', border } = {}) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex', fontFamily: 'Barlow', fontSize: 14, fontWeight: 700,
        color, background: bg, padding: '5px 12px', borderRadius: 6, letterSpacing: 1,
        ...(border ? { border: `1px solid ${border}` } : {}),
      },
      children: text,
    },
  };
}

// No emoji glyphs are loaded (only Anton/Barlow -- see cardKit.js), so a
// 🔒 character renders as a missing-glyph box. Plain text reads the same
// intent without depending on a font this card doesn't ship.
function mutedRow(text) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex', alignItems: 'center', fontFamily: 'Barlow', fontSize: 14,
        color: 'rgba(255,255,255,0.35)', fontStyle: 'italic', padding: '6px 0',
      },
      children: text,
    },
  };
}

function lockedRow(label = 'Locked — insufficient scouting intel') {
  return mutedRow(`[ LOCKED ] ${label}`);
}

const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

// One row in the Related Articles list -- a ScoutingNewsStory headline plus
// its date. No body/photo (there's no room on a card this size); this is a
// pointer to the story, not the story itself.
function storyRow(story) {
  const date = story.created_date ? DATE_FMT.format(new Date(story.created_date)) : null;
  return {
    type: 'div',
    props: {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, fontSize: 14, padding: '4px 0' },
      children: [
        {
          type: 'div',
          props: { style: { display: 'flex', color: '#FFFFFF', fontWeight: 600 }, children: (story.headline || 'Untitled').slice(0, 70) },
        },
        date && {
          type: 'div',
          props: { style: { display: 'flex', color: 'rgba(255,255,255,0.4)', fontSize: 12, whiteSpace: 'nowrap' }, children: date },
        },
      ].filter(Boolean),
    },
  };
}

function attrBarRow(field, val, gate) {
  const barW = attrBarWidth(val, gate);
  const pct = Math.round(((barW - 40) / (99 - 40)) * 100);
  return {
    type: 'div',
    props: {
      style: { display: 'flex', alignItems: 'center', gap: 10 },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', width: 108, fontFamily: 'Barlow', fontSize: 13, color: 'rgba(255,255,255,0.65)' },
            children: ATTR_LABELS[field] || field,
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flex: 1, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' },
            children: {
              type: 'div',
              props: { style: { display: 'flex', width: `${pct}%`, height: '100%', borderRadius: 4, background: tierColor(val) } },
            },
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', width: 54, justifyContent: 'flex-end', fontFamily: 'Barlow', fontSize: 13, fontWeight: 700, color: tierColor(val) },
            children: attrDisplay(val, gate, field),
          },
        },
      ],
    },
  };
}

function sectionLabel(text) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex', fontFamily: 'Barlow', fontSize: 14, fontWeight: 700, color: GOLD,
        letterSpacing: 2, borderBottom: `1px solid rgba(212,168,67,0.35)`, paddingBottom: 8, marginBottom: 12,
      },
      children: text.toUpperCase(),
    },
  };
}

/**
 * @param {object} p - a DraftProspect row (raw Base44 fields)
 * @param {number} gate - ScoutingGate.gate_level for this prospect's draft class (0-4)
 * @param {object[]} stories - related ScoutingNewsStory rows (see draftProspects.js's getProspectStories), newest first
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function renderProspectCard(p, gate, stories = []) {
  // portrait_url (AI-generated Big Board portrait) is the intended headshot
  // source, but is currently null for every prospect in the app's own data
  // -- headshot_url (the CFB27 skin-tone-matched portrait) is what's
  // actually populated today, so it's the fallback rather than the primary.
  const portraitSrc = p.portrait_url || p.headshot_url;

  const [fonts, logo, headshot] = await Promise.all([
    loadFonts(),
    p.college ? loadLogoDataUri(getCollegeLogoUrl(p.college)).catch(() => null) : Promise.resolve(null),
    portraitSrc ? loadLogoDataUri(portraitSrc).catch(() => null) : Promise.resolve(null),
  ]);

  const collegeColor = p.college ? `#${getCollegeColor(p.college)}` : DARK_BG;
  const showPhysical = gate >= 1;
  const showAttrs = gate >= 1;
  const showArchetype = gate >= 2;
  const showGrade = gate >= 3;
  const showRanks = gate >= 3;
  const showStrengths = gate >= 3;

  const primaryGroups = POSITION_PRIMARY_GROUPS[p.player_position] || ['Physical'];
  const attrFields = primaryGroups
    .flatMap((g) => ATTR_GROUPS[g] || [])
    .filter((f) => p[f] != null && p[f] > 0)
    .slice(0, 9);

  const H = gate < 1 ? H_LOCKED : H_FULL;

  const tree = {
    type: 'div',
    props: {
      style: {
        width: W, height: H, display: 'flex', flexDirection: 'column',
        position: 'relative', overflow: 'hidden', borderRadius: 14,
        border: `3px solid ${GOLD}`, background: DARK_BG, fontFamily: 'Barlow',
      },
      children: [
        // ---- Hero ----
        {
          type: 'div',
          props: {
            style: {
              display: 'flex', position: 'relative', width: W, height: 230, overflow: 'hidden',
              background: `linear-gradient(115deg, ${collegeColor} 0%, ${DARK_BG} 62%)`,
              borderBottom: `2px solid ${GOLD}`,
            },
            children: [
              logo && {
                type: 'img',
                props: {
                  src: logo, width: 380, height: 380,
                  style: { position: 'absolute', top: -60, right: -60, opacity: 0.14 },
                },
              },
              headshot && {
                type: 'img',
                props: {
                  src: headshot, width: 230, height: 230,
                  style: { position: 'absolute', top: 0, right: 0, objectFit: 'cover', opacity: 0.92 },
                },
              },
              !headshot && {
                type: 'div',
                props: {
                  style: {
                    display: 'flex', position: 'absolute', top: 40, right: 40, width: 150, height: 150,
                    borderRadius: 16, background: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'Anton', fontSize: 48, color: 'rgba(255,255,255,0.5)',
                  },
                  children: initialsOf(p.player_fullName),
                },
              },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column', position: 'relative', padding: '28px 32px', gap: 10, maxWidth: 560 },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', gap: 8 },
                        children: [
                          pill('DRAFT PROSPECT', { bg: 'rgba(0,0,0,0.35)' }),
                          p.college && pill(p.college, { bg: 'rgba(0,0,0,0.35)' }),
                        ].filter(Boolean),
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 },
                        children: [
                          {
                            type: 'div',
                            props: {
                              style: { display: 'flex', fontFamily: 'Barlow', fontSize: 18, fontWeight: 700, color: '#FFFFFF', background: 'rgba(0,0,0,0.35)', padding: '4px 10px', borderRadius: 6 },
                              children: p.player_position || '?',
                            },
                          },
                          showGrade && p.overall_grade
                            ? pill(p.overall_grade, { bg: 'rgba(0,0,0,0.4)', color: gradeColor(p.overall_grade), border: gradeColor(p.overall_grade) })
                            : pill('??? GRADE', { bg: 'rgba(0,0,0,0.3)', color: 'rgba(255,255,255,0.35)' }),
                        ].filter(Boolean),
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', fontFamily: 'Anton', fontSize: 52, color: '#FFFFFF', letterSpacing: 1, lineHeight: 1 },
                        children: (p.player_fullName || 'Unknown Prospect').toUpperCase(),
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', gap: 18, fontFamily: 'Barlow', fontSize: 15, color: 'rgba(255,255,255,0.85)' },
                        children: [
                          p.college_year,
                          p.height,
                          p.weight ? `${p.weight} lbs` : null,
                          showPhysical && p.age ? `${p.age} yrs` : null,
                        ].filter(Boolean).join('   ·   '),
                      },
                    },
                  ],
                },
              },
            ].filter(Boolean),
          },
        },

        // ---- Body ----
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', padding: '24px 32px', gap: 22, flex: 1 },
            children: [
              // Related articles row
              gate < 1
                ? lockedRow('No scouting intel released for this draft class yet')
                : {
                    type: 'div',
                    props: {
                      style: { display: 'flex', flexDirection: 'column' },
                      children: [
                        sectionLabel('Related Articles'),
                        {
                          type: 'div',
                          props: {
                            style: { display: 'flex', flexDirection: 'column' },
                            children: stories.length
                              ? stories.map(storyRow)
                              : [mutedRow('No scouting stories on file yet')],
                          },
                        },
                      ],
                    },
                  },

              // Two-column: scouting report | attributes
              gate >= 1 && {
                type: 'div',
                props: {
                  style: { display: 'flex', gap: 28 },
                  children: [
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', flexDirection: 'column', width: 380 },
                        children: [
                          sectionLabel('Scouting Report'),
                          {
                            type: 'div',
                            props: {
                              style: { display: 'flex', flexDirection: 'column', gap: 10 },
                              children: [
                                showArchetype && p.archetype && {
                                  type: 'div',
                                  props: {
                                    style: { display: 'flex', justifyContent: 'space-between', fontSize: 14 },
                                    children: [
                                      { type: 'div', props: { style: { display: 'flex', color: 'rgba(255,255,255,0.55)' }, children: 'Archetype' } },
                                      { type: 'div', props: { style: { display: 'flex', color: '#FFFFFF', fontWeight: 700 }, children: p.archetype } },
                                    ],
                                  },
                                },
                                showRanks && p.round_projection && {
                                  type: 'div',
                                  props: {
                                    style: { display: 'flex', justifyContent: 'space-between', fontSize: 14 },
                                    children: [
                                      { type: 'div', props: { style: { display: 'flex', color: 'rgba(255,255,255,0.55)' }, children: 'Round Proj.' } },
                                      { type: 'div', props: { style: { display: 'flex', color: '#FFFFFF', fontWeight: 700 }, children: p.round_projection } },
                                    ],
                                  },
                                },
                                showRanks && p.overall_rank && {
                                  type: 'div',
                                  props: {
                                    style: { display: 'flex', justifyContent: 'space-between', fontSize: 14 },
                                    children: [
                                      { type: 'div', props: { style: { display: 'flex', color: 'rgba(255,255,255,0.55)' }, children: 'Overall Rank' } },
                                      { type: 'div', props: { style: { display: 'flex', color: '#FFFFFF', fontWeight: 700 }, children: `#${p.overall_rank}` } },
                                    ],
                                  },
                                },
                                showRanks && p.position_rank && {
                                  type: 'div',
                                  props: {
                                    style: { display: 'flex', justifyContent: 'space-between', fontSize: 14 },
                                    children: [
                                      { type: 'div', props: { style: { display: 'flex', color: 'rgba(255,255,255,0.55)' }, children: 'Position Rank' } },
                                      { type: 'div', props: { style: { display: 'flex', color: '#FFFFFF', fontWeight: 700 }, children: `#${p.position_rank} ${p.player_position || ''}` } },
                                    ],
                                  },
                                },
                                showRanks && p.bust_risk && {
                                  type: 'div',
                                  props: {
                                    style: { display: 'flex', justifyContent: 'space-between', fontSize: 14, alignItems: 'center' },
                                    children: [
                                      { type: 'div', props: { style: { display: 'flex', color: 'rgba(255,255,255,0.55)' }, children: 'Bust Risk' } },
                                      pill(p.bust_risk, { bg: 'rgba(255,255,255,0.06)', color: BUST_COLOR[p.bust_risk] || MUTED, border: BUST_COLOR[p.bust_risk] }),
                                    ],
                                  },
                                },
                                !showArchetype && !showRanks && lockedRow('Advanced scouting not yet available'),
                                showStrengths && (p.strengths || []).length > 0 && {
                                  type: 'div',
                                  props: {
                                    style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 },
                                    children: [
                                      { type: 'div', props: { style: { display: 'flex', fontSize: 12, color: GREEN, fontWeight: 700, letterSpacing: 1 }, children: 'STRENGTHS' } },
                                      {
                                        type: 'div',
                                        props: {
                                          style: { display: 'flex', flexWrap: 'wrap', gap: 6 },
                                          children: p.strengths.slice(0, 3).map((s) => pill(s, { bg: 'rgba(74,222,128,0.1)', color: GREEN })),
                                        },
                                      },
                                    ],
                                  },
                                },
                                showStrengths && (p.weaknesses || []).length > 0 && {
                                  type: 'div',
                                  props: {
                                    style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 },
                                    children: [
                                      { type: 'div', props: { style: { display: 'flex', fontSize: 12, color: RED, fontWeight: 700, letterSpacing: 1 }, children: 'WEAKNESSES' } },
                                      {
                                        type: 'div',
                                        props: {
                                          style: { display: 'flex', flexWrap: 'wrap', gap: 6 },
                                          children: p.weaknesses.slice(0, 3).map((s) => pill(s, { bg: 'rgba(248,113,113,0.1)', color: RED })),
                                        },
                                      },
                                    ],
                                  },
                                },
                              ].filter(Boolean),
                            },
                          },
                        ],
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', flexDirection: 'column', flex: 1 },
                        children: [
                          sectionLabel(`Core Attributes  ·  ${gate >= 4 ? '~4pt' : gate === 3 ? '~7pt' : gate === 2 ? '~12pt' : '~20pt'} range`),
                          {
                            type: 'div',
                            props: {
                              style: { display: 'flex', flexDirection: 'column', gap: 9 },
                              children: showAttrs && attrFields.length
                                ? attrFields.map((f) => attrBarRow(f, p[f], gate))
                                : [lockedRow('No ratings intel available')],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            ].filter(Boolean),
          },
        },
      ],
    },
  };

  const svg = await satori(tree, { width: W, height: H, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: W * 2 } });
  return resvg.render().asPng();
}
