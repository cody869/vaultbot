// vegasCard.js
//
// Renders the Vegas odds board (moneyline/spread/total for one featured
// game) and a compact bet-confirmation receipt, matching the visual
// language cardKit.js already established for scorebugCard.js/
// suspensionCard.js (Satori -> PNG via resvg, gold border, dark background,
// Anton headline / Barlow body).

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { getTeam } from './teamLogos.js';
import { loadFonts, loadLogoDataUri, GOLD, DARK_BG } from './cardKit.js';

const W = 900;
const HEADER_H = 84;
const ROW_H = 96;
const FOOTER_H = 56;
const LOGO_SIZE = 360;

function americanOdds(n) {
  if (n == null) return '—';
  return n > 0 ? `+${n}` : `${n}`;
}

// One market row: a label on the left, two selection boxes on the right.
function marketRow(label, left, right) {
  const box = (b) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex', flexDirection: 'column', flex: 1,
        background: 'rgba(255,255,255,0.05)', borderRadius: 6,
        padding: '10px 16px', gap: 2,
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', color: '#FFFFFF', fontFamily: 'Barlow', fontSize: 20, fontWeight: 700 },
            children: b.title,
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', color: GOLD, fontFamily: 'Barlow', fontSize: 17 },
            children: b.odds,
          },
        },
      ],
    },
  });

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex', width: W - 64, height: ROW_H - 16,
        flexDirection: 'column', gap: 8, padding: '8px 0',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              display: 'flex', color: 'rgba(255,255,255,0.55)', fontFamily: 'Barlow',
              fontSize: 14, letterSpacing: 2,
            },
            children: label,
          },
        },
        {
          type: 'div',
          props: { style: { display: 'flex', gap: 12 }, children: [box(left), box(right)] },
        },
      ],
    },
  };
}

/**
 * @param {object} line
 * @param {number} [line.matchNumber]
 * @param {number} [line.week]
 * @param {string} line.homeAbbr
 * @param {string} line.awayAbbr
 * @param {number} [line.moneylineHome]
 * @param {number} [line.moneylineAway]
 * @param {number} [line.spreadHome]
 * @param {number} [line.spreadHomeOdds]
 * @param {number} [line.spreadAwayOdds]
 * @param {number} [line.totalLine]
 * @param {number} [line.totalOverOdds]
 * @param {number} [line.totalUnderOdds]
 * @param {number} line.minBet
 * @param {number} line.maxBet
 * @param {string} [line.cutoffLabel] - pre-formatted human string
 * @returns {Promise<Buffer>} PNG bytes
 */
async function renderOddsCard(line) {
  const home = getTeam(line.homeAbbr);
  const away = getTeam(line.awayAbbr);
  const H = HEADER_H + ROW_H * 3 + FOOTER_H + 32;

  const [fonts, homeLogo, awayLogo] = await Promise.all([
    loadFonts(),
    loadLogoDataUri(home.logoUrl),
    loadLogoDataUri(away.logoUrl),
  ]);

  const spreadAwayValue = line.spreadHome != null ? -line.spreadHome : null;

  const tree = {
    type: 'div',
    props: {
      style: {
        width: W, height: H, display: 'flex', flexDirection: 'column',
        position: 'relative', overflow: 'hidden', borderRadius: 10,
        border: `3px solid ${GOLD}`, background: DARK_BG,
      },
      children: [
        {
          type: 'img',
          props: {
            src: awayLogo, width: LOGO_SIZE, height: LOGO_SIZE,
            style: { position: 'absolute', top: -40, left: -LOGO_SIZE * 0.25, opacity: 0.1 },
          },
        },
        {
          type: 'img',
          props: {
            src: homeLogo, width: LOGO_SIZE, height: LOGO_SIZE,
            style: { position: 'absolute', top: -40, right: -LOGO_SIZE * 0.25, opacity: 0.1 },
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex', flexDirection: 'column', height: HEADER_H,
              padding: '14px 32px 0', position: 'relative',
            },
            children: [
              line.week != null && {
                type: 'div',
                props: {
                  style: {
                    display: 'flex', color: 'rgba(255,255,255,0.6)', fontFamily: 'Barlow',
                    fontSize: 14, letterSpacing: 2,
                  },
                  children: [
                    `WEEK ${line.week}`,
                    line.matchNumber != null ? ` · #${line.matchNumber}` : '',
                  ].join(''),
                },
              },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', color: '#FFFFFF', fontFamily: 'Anton', fontSize: 34, marginTop: 2 },
                  children: `${away.name || line.awayAbbr} @ ${home.name || line.homeAbbr}`,
                },
              },
            ].filter(Boolean),
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', padding: '0 32px', gap: 4 },
            children: [
              marketRow(
                'MONEYLINE',
                { title: away.name || line.awayAbbr, odds: americanOdds(line.moneylineAway) },
                { title: home.name || line.homeAbbr, odds: americanOdds(line.moneylineHome) }
              ),
              marketRow(
                'POINT SPREAD',
                { title: `${away.name || line.awayAbbr} ${spreadAwayValue > 0 ? '+' : ''}${spreadAwayValue ?? '—'}`, odds: americanOdds(line.spreadAwayOdds) },
                { title: `${home.name || line.homeAbbr} ${line.spreadHome > 0 ? '+' : ''}${line.spreadHome ?? '—'}`, odds: americanOdds(line.spreadHomeOdds) }
              ),
              marketRow(
                'TOTAL',
                { title: `Over ${line.totalLine ?? '—'}`, odds: americanOdds(line.totalOverOdds) },
                { title: `Under ${line.totalLine ?? '—'}`, odds: americanOdds(line.totalUnderOdds) }
              ),
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex', justifyContent: 'space-between', padding: '10px 32px',
              color: 'rgba(255,255,255,0.55)', fontFamily: 'Barlow', fontSize: 15,
              borderTop: '1px solid rgba(212,168,67,0.3)', marginTop: 8,
            },
            children: [
              {
                type: 'div',
                props: { style: { display: 'flex' }, children: `min $${line.minBet} / max $${line.maxBet}` },
              },
              line.cutoffLabel && {
                type: 'div',
                props: { style: { display: 'flex' }, children: `Cutoff: ${line.cutoffLabel}` },
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

/**
 * A compact receipt for one placed bet -- posted (or DM'd) as confirmation,
 * and reused for the settled result (win/loss/push) with a different accent.
 *
 * @param {object} bet
 * @param {string} bet.headline - e.g. "BET PLACED" / "YOU WON" / "PUSH"
 * @param {string} bet.teamAbbr - for the color accent / logo; may be null for a total bet
 * @param {string} bet.description - e.g. "Eagles Moneyline" or "Over 62.5"
 * @param {number} bet.stake
 * @param {number} bet.odds
 * @param {number} [bet.payout] - shown when settled
 * @param {'pending'|'won'|'lost'|'push'|'void'} bet.status
 */
async function renderBetReceiptCard(bet) {
  const W2 = 640, H2 = 220;
  const team = bet.teamAbbr ? getTeam(bet.teamAbbr) : null;
  const accent = { won: '#3FA34D', lost: '#C60C30', push: GOLD, void: 'rgba(255,255,255,0.4)', pending: GOLD }[bet.status] || GOLD;

  const [fonts, logo] = await Promise.all([
    loadFonts(),
    team ? loadLogoDataUri(team.logoUrl) : Promise.resolve(null),
  ]);

  const tree = {
    type: 'div',
    props: {
      style: {
        width: W2, height: H2, display: 'flex', flexDirection: 'column',
        position: 'relative', overflow: 'hidden', borderRadius: 10,
        border: `3px solid ${accent}`,
        background: team ? `linear-gradient(120deg, ${team.color} 0%, ${DARK_BG} 55%)` : DARK_BG,
      },
      children: [
        logo && {
          type: 'img',
          props: {
            src: logo, width: 320, height: 320,
            style: { position: 'absolute', top: -60, right: -80, opacity: 0.16 },
          },
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 20, left: 28,
              fontSize: 40, fontFamily: 'Anton', color: accent, letterSpacing: 1,
            },
            children: bet.headline,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 84, left: 30,
              fontSize: 24, fontFamily: 'Barlow', color: '#FFFFFF',
            },
            children: bet.description,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', bottom: 24, left: 30,
              fontSize: 17, fontFamily: 'Barlow', color: 'rgba(255,255,255,0.75)',
            },
            children: `$${bet.stake} @ ${americanOdds(bet.odds)}${bet.payout != null ? ` · pays $${bet.payout}` : ''}`,
          },
        },
      ].filter(Boolean),
    },
  };

  const svg = await satori(tree, { width: W2, height: H2, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: W2 * 2 } });
  return resvg.render().asPng();
}

export { renderOddsCard, renderBetReceiptCard };
