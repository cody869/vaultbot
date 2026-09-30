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
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTeam } from './teamLogos.js';
import { loadFonts, loadLogoDataUri, GOLD, DARK_BG } from './cardKit.js';
import { findMemberByTeam, memberDisplayName, getLeagueMembers, list } from './vault.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const W = 900;
// Tall enough for full-body player art; a team with no art yet falls back
// to a small helmet bottom-anchored in the same space (see heroArt below),
// so the hero looks intentional either way while the set fills in team by
// team instead of needing all 32 before any of this ships.
const HERO_H = 320;
const ROW_H = 96;
const FOOTER_H = 56;
const PLAYER_H = Math.round(HERO_H * 0.95);
const FALLBACK_HELMET_H = 170;
const FALLBACK_HELMET_W = Math.round(FALLBACK_HELMET_H * (112 / 96));

// Full-body player art, one flat PNG per team dropped in by hand as it's
// generated (see players/README if one exists) -- real alpha transparency,
// no upscaling needed (unlike the tiny 112x96 helmet sprites). Keyed by
// this bot's own abbreviation scheme (emoji.js's abbrFromName), since these
// never touch the app's helmet-URL convention.
const PLAYERS_DIR = path.join(__dirname, 'players');
const playerCache = new Map();
async function loadPlayerDataUri(abbr) {
  const filePath = path.join(PLAYERS_DIR, `${abbr}.png`);
  if (playerCache.has(filePath)) return playerCache.get(filePath);
  if (!fs.existsSync(filePath)) {
    playerCache.set(filePath, null);
    return null;
  }
  const dataUri = 'data:image/png;base64,' + fs.readFileSync(filePath).toString('base64');
  playerCache.set(filePath, dataUri);
  return dataUri;
}

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


// Top N wallets by balance for the current season (the highest season_number
// present in VegasWallet -- there's no separate "current season" config at
// the bot layer, same idiom vault.js's own getStatLeaders/getScores use).
// Pure balance ranking, not the app's eligible-only prize order -- this is
// just a quick "who's up" flourish on the card, not the official standings.
async function getVegasLeaders(limit = 5) {
  const wallets = await list('VegasWallet', {}, { limit: 500 });
  if (!wallets.length) return [];
  const season = Math.max(...wallets.map((w) => w.season_number ?? 0));
  const members = await getLeagueMembers();

  return wallets
    .filter((w) => w.season_number === season)
    .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0))
    .slice(0, limit)
    .map((w) => ({
      name: memberDisplayName(members.find((m) => m.username === w.username) || { team_name: w.team_name }),
      balance: w.balance ?? 0,
    }));
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const RANK_COLOR = { 1: GOLD, 2: '#C7CDD6', 3: '#C98A4B' };

function americanOdds(n) {
  if (n == null) return '—';
  return n > 0 ? `+${n}` : `${n}`;
}

// One market row: a label on the left, two selection boxes on the right.
// Each box also carries the Discord username of whoever owns that team, so
// bettors can see who they're up against on every line, not just the header.
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
            style: { display: 'flex', gap: 8, alignItems: 'baseline' },
            children: [
              { type: 'div', props: { style: { display: 'flex', color: GOLD, fontFamily: 'Barlow', fontSize: 17 }, children: b.odds } },
              b.owner && {
                type: 'div',
                props: {
                  style: { display: 'flex', color: 'rgba(255,255,255,0.45)', fontFamily: 'Barlow', fontSize: 13 },
                  children: `@${b.owner}`,
                },
              },
            ].filter(Boolean),
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

  // Owner/leaderboard lookups are a nice-to-have, not load-bearing -- a
  // Vault hiccup here shouldn't stop the odds card itself from posting, so
  // both fail soft (no owner shown / no leaderboard strip) instead of
  // rejecting the whole render.
  const [fonts, awayPlayer, homePlayer, badgeLogo, awayMember, homeMember, leaders] = await Promise.all([
    loadFonts(),
    loadPlayerDataUri(line.awayAbbr),
    loadPlayerDataUri(line.homeAbbr),
    loadLogoDataUri(LEAGUE_BADGE_URL),
    findMemberByTeam(line.awayAbbr).catch(() => null),
    findMemberByTeam(line.homeAbbr).catch(() => null),
    getVegasLeaders(5).catch(() => []),
  ]);
  // The helmet fallback only needs fetching for a side that has no player
  // art yet -- skips the network call entirely once all 32 are in, and
  // fails soft (rather than killing the whole card) if the Vault app
  // happens to be down when it IS needed.
  const [awayHelmet, homeHelmet] = await Promise.all([
    awayPlayer ? null : loadHelmetDataUri(line.awayAbbr).catch(() => null),
    homePlayer ? null : loadHelmetDataUri(line.homeAbbr).catch(() => null),
  ]);
  const awayOwner = awayMember ? memberDisplayName(awayMember) : null;
  const homeOwner = homeMember ? memberDisplayName(homeMember) : null;

  const LEADERS_H = leaders.length ? 120 : 0;
  const H = HERO_H + ROW_H * 3 + FOOTER_H + LEADERS_H + 16;

  const spreadAwayValue = line.spreadHome != null ? -line.spreadHome : null;

  // Smooth gradient banner, away color to home color -- simpler and more
  // legible than the earlier diagonal-seam treatment. Player/helmet |
  // abbreviation | badge | abbreviation | player/helmet laid out as a
  // single flex row so everything stays bottom-anchored and evenly
  // spaced without hand-tuned coordinates.
  //
  // Player art is never mirrored -- it carries a readable jersey number, so
  // flipping it would print the number backwards (confirmed on a test
  // render). Whichever pose the art was generated in is however it prints.
  // The helmet fallback has no such problem (no legible text on it) and
  // keeps the old flip-to-face-center + slight rotate treatment.
  const heroArt = (abbr, playerSrc, helmetSrc, side) => {
    if (playerSrc) {
      return {
        type: 'div',
        props: {
          style: { display: 'flex' },
          children: { type: 'img', props: { src: playerSrc, height: PLAYER_H, style: { display: 'flex' } } },
        },
      };
    }
    if (!helmetSrc) return { type: 'div', props: { style: { display: 'flex', width: 1 } } };
    const flip = side === 'home';
    return {
      type: 'div',
      props: {
        style: { display: 'flex', transform: `rotate(${flip ? 4 : -4}deg)` },
        children: {
          type: 'div',
          props: {
            style: { display: 'flex', transform: flip ? 'scaleX(-1)' : 'scaleX(1)' },
            children: { type: 'img', props: { src: helmetSrc, width: FALLBACK_HELMET_W, height: FALLBACK_HELMET_H, style: { display: 'flex' } } },
          },
        },
      },
    };
  };

  const abbrBox = (abbr, align) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex', flex: 1, flexDirection: 'column',
        alignItems: align, justifyContent: 'center',
      },
      children: {
        type: 'div',
        props: {
          style: {
            display: 'flex', color: '#FFFFFF', fontFamily: 'Anton', fontSize: 68,
            lineHeight: 1, textShadow: '0 3px 10px rgba(0,0,0,0.5)',
          },
          children: abbr,
        },
      },
    },
  });

  const hero = {
    type: 'div',
    props: {
      style: {
        width: W, height: HERO_H, display: 'flex', position: 'relative',
        overflow: 'hidden', background: `linear-gradient(90deg, ${away.color} 0%, ${home.color} 100%)`,
      },
      children: [
        line.week != null && {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 10, left: '50%',
              transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.7)',
              fontFamily: 'Barlow', fontSize: 13, letterSpacing: 2,
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
            style: {
              position: 'absolute', display: 'flex', alignItems: 'flex-end',
              top: 0, left: 0, right: 0, bottom: 0, padding: '0 8px',
            },
            children: [
              heroArt(line.awayAbbr, awayPlayer, awayHelmet, 'away'),
              abbrBox(line.awayAbbr, 'flex-start'),
              abbrBox(line.homeAbbr, 'flex-end'),
              heroArt(line.homeAbbr, homePlayer, homeHelmet, 'home'),
            ],
          },
        },
        // Positioned independently of the row above, not as a flex sibling
        // between the two abbreviation boxes -- player art poses vary a lot
        // in natural width (a standing pose vs. a full-stretch dive), which
        // would skew the two flex:1 boxes unevenly and drag the badge off
        // true center. Anchoring it to the hero's horizontal center instead
        // keeps it on the split line no matter how lopsided the two side's
        // art is. No card/border around it -- just the mark itself, sized up
        // a bit so it still reads clearly without one.
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', alignItems: 'center', justifyContent: 'center',
              left: '50%', bottom: 34, transform: 'translateX(-50%)',
            },
            children: badgeLogo
              ? { type: 'img', props: { src: badgeLogo, width: 80, height: 80, style: { display: 'flex' } } }
              : { type: 'div', props: { style: { display: 'flex', color: '#FFFFFF', fontFamily: 'Anton', fontSize: 26, textShadow: '0 3px 10px rgba(0,0,0,0.5)' }, children: 'VS' } },
          },
        },
      ].filter(Boolean),
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
                { title: away.name || line.awayAbbr, odds: americanOdds(line.moneylineAway), owner: awayOwner },
                { title: home.name || line.homeAbbr, odds: americanOdds(line.moneylineHome), owner: homeOwner }
              ),
              marketRow(
                'POINT SPREAD',
                { title: `${away.name || line.awayAbbr} ${spreadAwayValue > 0 ? '+' : ''}${spreadAwayValue ?? '—'}`, odds: americanOdds(line.spreadAwayOdds), owner: awayOwner },
                { title: `${home.name || line.homeAbbr} ${line.spreadHome > 0 ? '+' : ''}${line.spreadHome ?? '—'}`, odds: americanOdds(line.spreadHomeOdds), owner: homeOwner }
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
        // Quick "who's up" flourish, not the official prize standings (that
        // stays balance-ranked with no eligibility filter -- see
        // getVegasLeaders) -- omitted entirely when no wallets exist yet.
        leaders.length && {
          type: 'div',
          props: {
            style: {
              display: 'flex', flexDirection: 'column', padding: '10px 32px 14px',
              borderTop: '1px solid rgba(212,168,67,0.3)', gap: 8,
            },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', color: 'rgba(255,255,255,0.55)', fontFamily: 'Barlow', fontSize: 13, letterSpacing: 2 },
                  children: 'SEASON LEADERS',
                },
              },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', gap: 10 },
                  children: leaders.map((l, i) => ({
                    type: 'div',
                    props: {
                      style: {
                        display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1,
                        background: 'rgba(255,255,255,0.05)', borderRadius: 6, padding: '8px 4px', gap: 2,
                      },
                      children: [
                        { type: 'div', props: { style: { display: 'flex', color: RANK_COLOR[i + 1] || 'rgba(255,255,255,0.5)', fontFamily: 'Anton', fontSize: 15 }, children: `#${i + 1}` } },
                        { type: 'div', props: { style: { display: 'flex', color: '#FFFFFF', fontFamily: 'Barlow', fontSize: 13, fontWeight: 700 }, children: truncate(l.name, 12) } },
                        { type: 'div', props: { style: { display: 'flex', color: GOLD, fontFamily: 'Barlow', fontSize: 14 }, children: `$${l.balance.toLocaleString()}` } },
                      ],
                    },
                  })),
                },
              },
            ],
          },
        },
      ].filter(Boolean),
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
