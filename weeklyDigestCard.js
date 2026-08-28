// weeklyDigestCard.js
//
// Renders the weekly recap card (Satori -> PNG via resvg), matching
// scorebugCard.js/suspensionCard.js's visual language (gold border, dark
// background, team color accent, Anton headline / Barlow body).
//
// The card carries the "computed deterministically" parts of a WeeklyDigest
// record that fit a compact visual (headline, top game, stat leaders) --
// the full narrative/storylines are long-form text and go in the Discord
// message content alongside the card, not baked into the image.
//
// Usage:
//   const { renderWeeklyDigestCard } = require('./weeklyDigestCard');
//   const png = await renderWeeklyDigestCard({
//     week: 7, seasonNumber: 84,
//     headline: 'Chaos in the AFC North',
//     summary: 'A last-second upset flips the division race on its head.',
//     topGame: {
//       awayTeam: 'Cincinnati Bengals', homeTeam: 'Baltimore Ravens',
//       awayScore: 27, homeScore: 24,
//       awayOwner: 'j_smith', homeOwner: 'chaosrevolver', // optional
//     },
//     statLeaders: [ // 0-4 entries, one per category
//       { category: 'passing', playerFullName: 'J. Burrow', teamName: 'Bengals', statLine: '312 yds, 4 TD' },
//       ...
//     ],
//   });

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { getTeam } from './teamLogos.js';
import { abbrFromName } from './emoji.js';
import { loadFonts, loadLogoDataUri, GOLD, DARK_BG } from './cardKit.js';

const W = 900;
const TOP_H = 250;
const STRIP_H = 100; // added when statLeaders has at least one entry
const LOGO_SIZE = 460;

const CATEGORY_LABELS = {
  passing: 'PASSING',
  rushing: 'RUSHING',
  receiving: 'RECEIVING',
  defense: 'DEFENSE',
};

// Team lookup is best-effort -- topGame's team names come from free text in
// the digest record, not a controlled team-id field, so a name that doesn't
// resolve (typo, nickname the abbr table doesn't know) falls back to a
// neutral treatment rather than throwing and losing the whole card.
function resolveTeam(name) {
  try {
    const abbr = abbrFromName(name);
    if (abbr) return { ...getTeam(abbr), fullName: name };
  } catch {
    /* fall through */
  }
  return { abbr: null, name, fullName: name, color: GOLD, logoUrl: null };
}

function statLeaderChips(statLeaders) {
  const shown = statLeaders.slice(0, 4);
  const margin = 24;
  const usable = W - margin * 2;
  const colWidth = usable / shown.length;
  return shown.map((s, i) => ({
    type: 'div',
    props: {
      style: {
        position: 'absolute', display: 'flex', flexDirection: 'column',
        top: 18, left: margin + i * colWidth, width: colWidth - 16,
      },
      children: [
        {
          type: 'div',
          props: {
            style: { display: 'flex', color: GOLD, fontFamily: 'Barlow', fontSize: 13, letterSpacing: 1 },
            children: CATEGORY_LABELS[s.category] || String(s.category || '').toUpperCase(),
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', color: '#FFFFFF', fontFamily: 'Barlow', fontSize: 17, marginTop: 4 },
            children: `${s.playerFullName}${s.teamName ? ` — ${s.teamName}` : ''}`,
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', color: 'rgba(255,255,255,0.6)', fontFamily: 'Barlow', fontSize: 15, marginTop: 4 },
            children: s.statLine || '',
          },
        },
      ],
    },
  }));
}

/**
 * @param {object} d
 * @param {number} [d.week]
 * @param {number} [d.seasonNumber]
 * @param {string} d.headline
 * @param {string} [d.summary]
 * @param {object} [d.topGame] - {awayTeam, homeTeam, awayScore, homeScore, awayOwner, homeOwner}
 * @param {{category: string, playerFullName: string, teamName?: string, statLine?: string}[]} [d.statLeaders]
 * @returns {Promise<Buffer>} PNG bytes
 */
async function renderWeeklyDigestCard(d) {
  const { week, seasonNumber, headline, summary, topGame, statLeaders } = d;
  const hasTopGame = !!(topGame && topGame.homeTeam && topGame.awayTeam);
  const hasStrip = Array.isArray(statLeaders) && statLeaders.length > 0;
  const H = TOP_H + (hasStrip ? STRIP_H : 0);

  const home = hasTopGame ? resolveTeam(topGame.homeTeam) : null;
  const away = hasTopGame ? resolveTeam(topGame.awayTeam) : null;

  const [fonts, homeLogo] = await Promise.all([
    loadFonts(),
    home?.logoUrl ? loadLogoDataUri(home.logoUrl) : Promise.resolve(null),
  ]);

  const topGameLine = hasTopGame
    ? `${away.abbr || away.fullName} ${topGame.awayScore ?? '–'} @ ${home.abbr || home.fullName} ${topGame.homeScore ?? '–'}` +
      (topGame.awayOwner && topGame.homeOwner ? `  ·  ${topGame.awayOwner} vs ${topGame.homeOwner}` : '')
    : null;

  const top = {
    type: 'div',
    props: {
      style: {
        width: W, height: TOP_H, display: 'flex', flexDirection: 'column',
        position: 'relative', overflow: 'hidden',
        background: `linear-gradient(120deg, ${home?.color || GOLD} 0%, ${DARK_BG} 55%)`,
      },
      children: [
        homeLogo && {
          type: 'img',
          props: {
            src: homeLogo, width: LOGO_SIZE, height: LOGO_SIZE,
            style: { position: 'absolute', top: (TOP_H - LOGO_SIZE) / 2, right: -LOGO_SIZE * 0.2, opacity: 0.14 },
          },
        },
        (week != null || seasonNumber != null) && {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 20, left: 32,
              color: 'rgba(255,255,255,0.75)', fontFamily: 'Barlow', fontSize: 16, letterSpacing: 2,
            },
            children: [seasonNumber != null && `SEASON ${seasonNumber}`, week != null && `WEEK ${week}`].filter(Boolean).join(' · '),
          },
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 56, left: 32, right: 32,
              fontSize: 48, fontFamily: 'Anton', color: '#FFFFFF', letterSpacing: 0.5,
              lineHeight: 1.05,
            },
            children: headline,
          },
        },
        summary && {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 138, left: 34, right: 34,
              color: 'rgba(255,255,255,0.75)', fontFamily: 'Barlow', fontSize: 18,
            },
            children: summary,
          },
        },
        topGameLine && {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', bottom: 22, left: 34,
              background: 'rgba(0,0,0,0.4)', color: GOLD, fontFamily: 'Barlow',
              fontSize: 18, padding: '6px 14px', borderRadius: 4, letterSpacing: 0.5,
            },
            children: topGameLine,
          },
        },
      ].filter(Boolean),
    },
  };

  const children = [top];
  if (hasStrip) {
    children.push({
      type: 'div',
      props: {
        style: { width: W, height: STRIP_H, display: 'flex', position: 'relative', background: '#12161C' },
        children: [
          {
            type: 'div',
            props: {
              style: {
                position: 'absolute', display: 'flex', top: 0, left: 0,
                width: W, height: 1, background: 'rgba(212,168,67,0.4)',
              },
            },
          },
          ...statLeaderChips(statLeaders),
        ],
      },
    });
  }

  // Same clipping caveat as scorebugCard.js: Satori doesn't reliably clip
  // through two nested overflow:hidden boundaries, so the outer wrapper is
  // skipped entirely in the common no-strip case.
  let tree;
  if (hasStrip) {
    tree = {
      type: 'div',
      props: {
        style: {
          width: W, height: H, display: 'flex', flexDirection: 'column',
          position: 'relative', overflow: 'hidden', borderRadius: 10,
          border: `3px solid ${GOLD}`,
        },
        children,
      },
    };
  } else {
    top.props.style.borderRadius = 10;
    top.props.style.border = `3px solid ${GOLD}`;
    tree = top;
  }

  const svg = await satori(tree, { width: W, height: H, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: W * 2 } });
  return resvg.render().asPng();
}

export { renderWeeklyDigestCard };
