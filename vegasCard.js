// vegasCard.js
//
// Renders the Vegas odds board (moneyline/spread/total for one featured
// game) and a compact bet-confirmation receipt, matching the visual
// language cardKit.js already established for scorebugCard.js/
// suspensionCard.js (Satori -> PNG via resvg, gold border, dark background,
// Anton headline / Barlow body).

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { getTeam } from './teamLogos.js';
import { loadFonts, loadLogoDataUri, GOLD, DARK_BG } from './cardKit.js';

const W = 900;
const HERO_H = 240;
const ROW_H = 96;
const FOOTER_H = 56;
const HELMET_W = 300;
const HELMET_H = Math.round(HELMET_W * (96 / 112));
const SEAM_ANGLE = 10;

// The XCFL Vault's own icon -- already public (used as the app's favicon /
// og:image) -- as the card's center badge, sitting on the seam between the
// two helmets like the league shield in the reference NFL/Prime graphic.
const LEAGUE_BADGE_URL = 'https://media.base44.com/images/public/69d09944c8636f39abaa7ef0/ea59f960b_Untitleddesign10.png';

// The app's own pixel-art helmets (src/lib/nflTeamLogos.js's
// teamHelmetUrl()/`<Helmet>`) -- confirmed live at the app's own domain,
// not part of this bot's repo. Only one abbreviation differs between this
// bot's own scheme (emoji.js's abbrFromName) and the app's: Washington is
// WAS here, WSH there.
const HELMET_ABBR_OVERRIDES = { WAS: 'WSH' };
function helmetUrl(abbr) {
  return `https://xcfl-companion.com/helmets/${HELMET_ABBR_OVERRIDES[abbr] || abbr}.png`;
}

// Native helmet art is 112x96 pixel art (same source the app's <Helmet>
// component renders with image-rendering:pixelated). Satori/resvg have no
// equivalent "keep it blocky" hint for an embedded raster image, so the
// crispness has to be baked into the pixels themselves -- fetch once, then
// nearest-neighbor upscale well past the card's final render resolution
// before handing it to Satori as a data URI, so any later resampling stays
// looking like pixel art instead of blurring into mush.
const helmetCache = new Map();
async function loadHelmetDataUri(abbr) {
  const url = helmetUrl(abbr);
  if (helmetCache.has(url)) return helmetCache.get(url);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Helmet fetch failed (${res.status}): ${url}`);
  const raw = Buffer.from(await res.arrayBuffer());

  const upscaled = await sharp(raw)
    .resize({ width: 112 * 8, height: 96 * 8, kernel: 'nearest' })
    .png()
    .toBuffer();

  const dataUri = 'data:image/png;base64,' + upscaled.toString('base64');
  helmetCache.set(url, dataUri);
  return dataUri;
}

// Diagonal seam geometry, same technique scorebugCard.js already uses and
// has confirmed renders cleanly through Satori -- a big rotated rectangle
// sized/positioned so its own internal gradient lines up into a continuous
// seam across the card at `angleDeg`.
function seamRectGeometry(angleDeg, sectionH, size = 700) {
  const rad = (angleDeg * Math.PI) / 180;
  const cx = W / 2 + (size / 2) * Math.cos(rad);
  const cy = sectionH / 2 + (size / 2) * Math.sin(rad);
  return { left: cx - size / 2, top: cy - size / 2, size };
}

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
  const H = HERO_H + ROW_H * 3 + FOOTER_H + 16;

  const [fonts, awayHelmet, homeHelmet, badgeLogo] = await Promise.all([
    loadFonts(),
    loadHelmetDataUri(line.awayAbbr),
    loadHelmetDataUri(line.homeAbbr),
    loadLogoDataUri(LEAGUE_BADGE_URL),
  ]);

  const spreadAwayValue = line.spreadHome != null ? -line.spreadHome : null;
  const seam = seamRectGeometry(SEAM_ANGLE, HERO_H);
  const helmetTop = HERO_H - HELMET_H * 0.88;

  const hero = {
    type: 'div',
    props: {
      style: {
        width: W, height: HERO_H, display: 'flex', position: 'relative',
        overflow: 'hidden', background: `linear-gradient(90deg, ${away.color} 0%, #000000 78%)`,
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex',
              width: seam.size, height: seam.size,
              top: seam.top, left: seam.left,
              transform: `rotate(${SEAM_ANGLE}deg)`,
              background: `linear-gradient(90deg, #000000 22%, ${home.color} 100%)`,
            },
          },
        },
        // Helmets face each other across the seam, angled in like they're
        // squaring off -- away (native orientation faces right) tilts in
        // from the left; home is flipped to face left, tilting in from the
        // right. Both are sized past the hero's edges and bottom so
        // overflow:hidden crops them into a dynamic "bursting the frame"
        // look instead of a neatly-contained thumbnail.
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex',
              top: helmetTop, left: -HELMET_W * 0.18,
              transform: 'rotate(-9deg)',
            },
            children: { type: 'img', props: { src: awayHelmet, width: HELMET_W, height: HELMET_H, style: { display: 'flex' } } },
          },
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex',
              top: helmetTop, right: -HELMET_W * 0.18,
              transform: 'rotate(9deg)',
            },
            children: {
              type: 'div',
              props: {
                style: { display: 'flex', transform: 'scaleX(-1)' },
                children: { type: 'img', props: { src: homeHelmet, width: HELMET_W, height: HELMET_H, style: { display: 'flex' } } },
              },
            },
          },
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 14, left: '50%',
              transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.75)',
              fontFamily: 'Barlow', fontSize: 15, letterSpacing: 2,
            },
            children: [
              line.week != null ? `WEEK ${line.week}` : '',
              line.matchNumber != null ? ` · #${line.matchNumber}` : '',
            ].join(''),
          },
        },
        // Bold lettering deliberately overlaps the bottom of the helmets --
        // the poster-typography layering the reference graphic uses -- so a
        // dark backing panel sits behind each so it stays legible over
        // lighter helmets (Dolphins, Bills, etc).
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', flexDirection: 'column',
              bottom: 14, left: 20, padding: '6px 14px', borderRadius: 4,
              background: 'rgba(0,0,0,0.45)',
            },
            children: [
              { type: 'div', props: { style: { display: 'flex', color: '#FFFFFF', fontFamily: 'Anton', fontSize: 60, lineHeight: 1 }, children: line.awayAbbr } },
              { type: 'div', props: { style: { display: 'flex', color: 'rgba(255,255,255,0.8)', fontFamily: 'Barlow', fontSize: 15, marginTop: 2 }, children: away.name || '' } },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
              bottom: 14, right: 20, padding: '6px 14px', borderRadius: 4,
              background: 'rgba(0,0,0,0.45)',
            },
            children: [
              { type: 'div', props: { style: { display: 'flex', color: '#FFFFFF', fontFamily: 'Anton', fontSize: 60, lineHeight: 1 }, children: line.homeAbbr } },
              { type: 'div', props: { style: { display: 'flex', color: 'rgba(255,255,255,0.8)', fontFamily: 'Barlow', fontSize: 15, marginTop: 2 }, children: home.name || '' } },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', alignItems: 'center', justifyContent: 'center',
              top: HERO_H - 40, left: '50%', transform: 'translate(-50%, -50%)',
              width: 68, height: 68, borderRadius: 34,
              background: DARK_BG, border: `3px solid ${GOLD}`,
            },
            children: badgeLogo
              ? { type: 'img', props: { src: badgeLogo, width: 44, height: 44, style: { display: 'flex', borderRadius: 22 } } }
              : { type: 'div', props: { style: { display: 'flex', color: GOLD, fontFamily: 'Anton', fontSize: 20 }, children: 'VS' } },
          },
        },
      ],
    },
  };

  const tree = {
    type: 'div',
    props: {
      style: {
        width: W, height: H, display: 'flex', flexDirection: 'column',
        position: 'relative', overflow: 'hidden', borderRadius: 10,
        border: `3px solid ${GOLD}`, background: DARK_BG,
      },
      children: [
        hero,
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
