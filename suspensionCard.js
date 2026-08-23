// suspensionCard.js
//
// Renders a stylized 70/30 Rule suspension/warning card (Satori -> PNG via
// resvg), matching scorebugCard.js's visual language (gold border, dark
// background, team color accent, Anton headline / Barlow body).
//
// Usage:
//   const { renderSuspensionCard } = require('./suspensionCard');
//   const png = await renderSuspensionCard({
//     abbr: 'CIN',                 // resolved by the caller (abbrFromName)
//     teamName: 'Cincinnati Bengals',
//     season: 84,
//     week: 6,                     // violation week
//     passRatio: 63,               // violation_pass_ratio
//     violationNumber: 2,
//     games: 2,                   // suspension_games -- 0 means warning-only
//     positions: ['QB', 'HB'],
//     players: ['J. Burrow', 'C. Brown'],
//     appliesToWeek: 7,
//   });

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { getTeam } from './teamLogos.js';
import { loadFonts, loadLogoDataUri, GOLD, DARK_BG } from './cardKit.js';

const W = 900;
const H = 280;
const LOGO_SIZE = 420;

const RED = '#C60C30';
const AMBER = '#FFB612';

const VIOLATION_LABELS = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };
const violationLabel = (n) => VIOLATION_LABELS[n] || `${n}th`;

/**
 * @param {object} s
 * @param {string} s.abbr - team abbreviation, already resolved by the caller
 * @param {string} [s.teamName] - full team name, used if abbr lookup fails
 * @param {number} [s.season]
 * @param {number} [s.week] - violation week
 * @param {number} [s.passRatio] - violation_pass_ratio (%)
 * @param {number} [s.violationNumber]
 * @param {number} s.games - suspension_games; 0 means warning-only
 * @param {string[]} [s.positions]
 * @param {string[]} [s.players]
 * @param {number} [s.appliesToWeek]
 * @returns {Promise<Buffer>} PNG bytes
 */
async function renderSuspensionCard(s) {
  const team = { ...getTeam(s.abbr), ...s };
  const isWarning = !s.games;

  const [fonts, logo] = await Promise.all([loadFonts(), loadLogoDataUri(team.logoUrl)]);

  const headline = isWarning ? 'WARNING' : 'SUSPENDED';
  const headlineColor = isWarning ? AMBER : RED;

  const badgeText = isWarning ? 'WARNING' : `${s.games} GAME${s.games === 1 ? '' : 'S'}`;
  const badgeBg = isWarning ? AMBER : RED;
  const badgeColor = isWarning ? '#111111' : '#FFFFFF';

  const playerLines = isWarning
    ? ['No suspension — next violation this season triggers one.']
    : (s.players && s.players.length
        ? s.players.map((name, i) => `${name}${s.positions?.[i] ? ` (${s.positions[i]})` : ''}`)
        : (s.positions || []));

  const tree = {
    type: 'div',
    props: {
      style: {
        width: W, height: H, display: 'flex', flexDirection: 'column',
        position: 'relative', overflow: 'hidden', borderRadius: 10,
        border: `3px solid ${GOLD}`, background: `linear-gradient(120deg, ${team.color} 0%, ${DARK_BG} 55%)`,
      },
      children: [
        // Faded team logo bleeding off the right edge, matching scorebug's treatment.
        {
          type: 'img',
          props: {
            src: logo, width: LOGO_SIZE, height: LOGO_SIZE,
            style: { position: 'absolute', top: (H - LOGO_SIZE) / 2, right: -LOGO_SIZE * 0.2, opacity: 0.16 },
          },
        },
        // Top label: week/season context, matching scorebug's "WEEK N" convention.
        (s.season != null || s.week != null) && {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 18, left: 32,
              color: 'rgba(255,255,255,0.75)', fontFamily: 'Barlow', fontSize: 16, letterSpacing: 2,
            },
            children: [s.season != null && `SEASON ${s.season}`, s.week != null && `WEEK ${s.week}`].filter(Boolean).join(' · '),
          },
        },
        // Badge, top-right: games suspended, or WARNING.
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 16, right: 32,
              background: badgeBg, color: badgeColor, fontFamily: 'Barlow',
              fontSize: 20, padding: '6px 14px', borderRadius: 4, letterSpacing: 1,
            },
            children: badgeText,
          },
        },
        // Headline.
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 56, left: 32,
              fontSize: 64, fontFamily: 'Anton', color: headlineColor, letterSpacing: 1,
            },
            children: headline,
          },
        },
        // Team name.
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 132, left: 34,
              fontSize: 26, fontFamily: 'Barlow', color: '#FFFFFF',
            },
            children: team.teamName || team.name,
          },
        },
        // Player/position lines.
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', flexDirection: 'column',
              top: 172, left: 34, gap: 4,
            },
            children: playerLines.slice(0, 3).map((line) => ({
              type: 'div',
              props: {
                style: { display: 'flex', color: 'rgba(255,255,255,0.9)', fontFamily: 'Barlow', fontSize: 18 },
                children: `• ${line}`,
              },
            })),
          },
        },
        // Bottom stat line: violation stat + which week it applies to.
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', bottom: 18, left: 34,
              color: 'rgba(255,255,255,0.6)', fontFamily: 'Barlow', fontSize: 15,
            },
            children: [
              s.passRatio != null && `${s.passRatio}% pass rate`,
              s.violationNumber != null && `${violationLabel(s.violationNumber)} violation this season`,
              s.appliesToWeek != null && !isWarning && `applies to week ${s.appliesToWeek}`,
            ].filter(Boolean).join(' · '),
          },
        },
      ].filter(Boolean),
    },
  };

  const svg = await satori(tree, { width: W, height: H, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: W * 2 } });
  return resvg.render().asPng();
}

export { renderSuspensionCard };
