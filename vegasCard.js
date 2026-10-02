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
import { findMemberByTeam, memberDisplayName, getLeagueMembers, getMemberByDiscordId, list } from './vault.js';

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

// Blends a team's (often quite saturated) brand color toward the card's
// dark background so the hero gradient reads as muted rather than a raw
// hex-code wash.
function muteColor(hex, amount = 0.35) {
  const h = hex.replace('#', '');
  const d = DARK_BG.replace('#', '');
  const mix = (a, b) => Math.round(a + (b - a) * amount);
  const toHex = (n) => n.toString(16).padStart(2, '0');
  const r = mix(parseInt(h.slice(0, 2), 16), parseInt(d.slice(0, 2), 16));
  const g = mix(parseInt(h.slice(2, 4), 16), parseInt(d.slice(2, 4), 16));
  const b = mix(parseInt(h.slice(4, 6), 16), parseInt(d.slice(4, 6), 16));
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// A single subtle grain overlay, generated once and reused for every card
// (team-independent) -- low per-pixel alpha, laid over the gradient so the
// hero doesn't read as a flat, glossy color fill.
let noiseTextureCache = null;
async function getNoiseTexture() {
  if (noiseTextureCache) return noiseTextureCache;
  const buf = Buffer.alloc(W * HERO_H * 4);
  for (let i = 0; i < W * HERO_H; i++) {
    const v = 90 + Math.floor(Math.random() * 140);
    const a = 8 + Math.floor(Math.random() * 14);
    buf[i * 4] = v; buf[i * 4 + 1] = v; buf[i * 4 + 2] = v; buf[i * 4 + 3] = a;
  }
  const png = await sharp(buf, { raw: { width: W, height: HERO_H, channels: 4 } }).png().toBuffer();
  noiseTextureCache = 'data:image/png;base64,' + png.toString('base64');
  return noiseTextureCache;
}

// Soft, mostly-transparent smoke rising from the bottom of the hero --
// a coarse random grid smoothed way up (bicubic resize turns blocky noise
// into soft cloud-like blobs) with a vertical alpha falloff so it's dense
// near the floor and fully gone by the upper third. Team-independent, so
// it's generated once and cached like the grain layer.
let smokeTextureCache = null;
async function getSmokeTexture() {
  if (smokeTextureCache) return smokeTextureCache;
  const gw = 22, gh = 14;
  const grid = Buffer.alloc(gw * gh * 4);
  for (let i = 0; i < gw * gh; i++) {
    const v = 235 + Math.floor(Math.random() * 20);
    grid[i * 4] = v; grid[i * 4 + 1] = v; grid[i * 4 + 2] = v; grid[i * 4 + 3] = 255;
  }
  const { data } = await sharp(grid, { raw: { width: gw, height: gh, channels: 4 } })
    .resize({ width: W, height: HERO_H, kernel: 'cubic' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const out = Buffer.alloc(W * HERO_H * 4);
  for (let y = 0; y < HERO_H; y++) {
    const fromBottom = 1 - y / HERO_H;
    const falloff = Math.max(0, Math.min(1, (fromBottom - 0.38) / 0.62));
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const wisp = (data[p] - 235) / 20;
      out[p] = 255; out[p + 1] = 255; out[p + 2] = 255;
      out[p + 3] = Math.round(falloff * (26 + wisp * 55));
    }
  }
  const png = await sharp(out, { raw: { width: W, height: HERO_H, channels: 4 } }).png().toBuffer();
  smokeTextureCache = 'data:image/png;base64,' + png.toString('base64');
  return smokeTextureCache;
}

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

// Builds the diagonal-free hero banner shared by the odds card and the
// settlement card: gradient (dipping dark in the middle for label
// contrast) + grain + smoke, player/helmet art bottom-anchored on each
// side, big abbreviation lettering, and the league badge centered on the
// seam. `topLabel` is whatever short string sits top-center (the odds
// card's "WEEK X · #N", the settlement card's "FINAL").
//
// Player art is never mirrored -- it carries a readable jersey number, so
// flipping it would print the number backwards (confirmed on a test
// render). Whichever pose the art was generated in is however it prints.
// The helmet fallback has no such problem (no legible text on it) and
// keeps the old flip-to-face-center + slight rotate treatment.
function buildHero({ away, home, awayAbbr, homeAbbr, awayPlayer, homePlayer, awayHelmet, homeHelmet, badgeLogo, noiseTexture, smokeTexture, topLabel }) {
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

  // Muted (blended toward the card's dark background) rather than the raw
  // brand hex, which read as a harsh, glossy wash across the whole banner.
  const awayBg = muteColor(away.color);
  const homeBg = muteColor(home.color);

  return {
    type: 'div',
    props: {
      style: {
        width: W, height: HERO_H, display: 'flex', position: 'relative',
        // Each side holds its own solid team color, dipping to the card's
        // dark background across a wide band in the middle instead of
        // blending straight from one team color into the other. A plain
        // two-stop lerp put a long muddy, unpredictably-lit patch right
        // behind the center label (RGB interpolation isn't perceptually
        // even, so how readable that patch was depended on which two
        // colors happened to be playing) -- dipping to a color that's
        // always dark guarantees the label has contrast no matter the
        // matchup.
        overflow: 'hidden',
        background: `linear-gradient(90deg, ${awayBg} 0%, ${awayBg} 25%, ${DARK_BG} 44%, ${DARK_BG} 56%, ${homeBg} 75%, ${homeBg} 100%)`,
      },
      children: [
        // Flat per-pixel grain, low alpha, sized to exactly cover the hero
        // -- breaks up what would otherwise be a perfectly smooth gradient
        // fill, same idea as film grain over a color wash.
        { type: 'img', props: { src: noiseTexture, width: W, height: HERO_H, style: { position: 'absolute', top: 0, left: 0, display: 'flex' } } },
        // Soft smoke rising from the floor of the hero, mostly transparent.
        { type: 'img', props: { src: smokeTexture, width: W, height: HERO_H, style: { position: 'absolute', top: 0, left: 0, display: 'flex' } } },
        topLabel && {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', top: 10, left: '50%',
              transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.7)',
              fontFamily: 'Barlow', fontSize: 13, letterSpacing: 2,
            },
            children: topLabel,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute', display: 'flex', alignItems: 'flex-end',
              top: 0, left: 0, right: 0, bottom: 0, padding: '0 28px',
            },
            children: [
              heroArt(awayAbbr, awayPlayer, awayHelmet, 'away'),
              abbrBox(awayAbbr, 'flex-start'),
              abbrBox(homeAbbr, 'flex-end'),
              heroArt(homeAbbr, homePlayer, homeHelmet, 'home'),
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
              ? { type: 'img', props: { src: badgeLogo, width: 104, height: 104, style: { display: 'flex' } } }
              : { type: 'div', props: { style: { display: 'flex', color: '#FFFFFF', fontFamily: 'Anton', fontSize: 26, textShadow: '0 3px 10px rgba(0,0,0,0.5)' }, children: 'VS' } },
          },
        },
      ].filter(Boolean),
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
  const [fonts, awayPlayer, homePlayer, badgeLogo, noiseTexture, smokeTexture, awayMember, homeMember, leaders] = await Promise.all([
    loadFonts(),
    loadPlayerDataUri(line.awayAbbr),
    loadPlayerDataUri(line.homeAbbr),
    loadLogoDataUri(LEAGUE_BADGE_URL),
    getNoiseTexture(),
    getSmokeTexture(),
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

  const hero = buildHero({
    away, home, awayAbbr: line.awayAbbr, homeAbbr: line.homeAbbr,
    awayPlayer, homePlayer, awayHelmet, homeHelmet, badgeLogo, noiseTexture, smokeTexture,
    topLabel: line.week != null
      ? [`WEEK ${line.week}`, line.matchNumber != null ? ` · #${line.matchNumber}` : ''].join('')
      : null,
  });

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

// What a bet actually backed, in plain English -- home/away selections
// resolve against the line's own team abbreviations (moneyline/spread),
// while a total bet has no team side at all (over/under).
function describeBetSelection(bet, awayAbbr, homeAbbr) {
  if (bet.market === 'total') {
    const side = bet.selection === 'over' ? 'Over' : 'Under';
    return bet.line_value != null ? `${side} ${bet.line_value}` : side;
  }
  const team = bet.selection === 'home' ? homeAbbr : awayAbbr;
  if (bet.market === 'spread' && bet.line_value != null) {
    return `${team} ${bet.line_value > 0 ? '+' : ''}${bet.line_value}`;
  }
  return `${team} ML`;
}

const RESULT_ROW_H = 24;
const RESULT_LABEL_H = 24;
const RESULT_MAX_SHOWN = 12;
const RESULT_FONT = 14;
const RESULT_COLORS = { won: '#3FA34D', lost: '#C60C30' };

function resultListBlock(label, bets, names, awayAbbr, homeAbbr, status) {
  const shown = bets.slice(0, RESULT_MAX_SHOWN);
  const overflow = bets.length - shown.length;
  const color = RESULT_COLORS[status];

  const rows = shown.map((bet, i) => {
    const name = names.get(bet.id) || bet.team_name || 'Unknown bettor';
    const stake = Number(bet.stake) || 0;
    const tail = status === 'won'
      ? `$${Math.round(Number(bet.potential_payout) || 0).toLocaleString('en-US')}`
      : `-$${stake.toLocaleString('en-US')}`;
    return {
      type: 'div',
      props: {
        style: {
          position: 'absolute', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', top: RESULT_LABEL_H + i * RESULT_ROW_H, left: 0, width: '100%',
        },
        children: [
          {
            type: 'div',
            props: {
              style: { display: 'flex', color: '#FFFFFF', fontFamily: 'Barlow', fontSize: RESULT_FONT },
              children: `${name} — ${describeBetSelection(bet, awayAbbr, homeAbbr)}, $${stake.toLocaleString('en-US')}`,
            },
          },
          { type: 'div', props: { style: { display: 'flex', color, fontFamily: 'Barlow', fontSize: RESULT_FONT }, children: tail } },
        ],
      },
    };
  });

  const bodyEnd = RESULT_LABEL_H + shown.length * RESULT_ROW_H;
  const H = bodyEnd + (overflow > 0 ? 20 : 0);

  return {
    height: H,
    node: {
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'column', position: 'relative', flex: 1, height: H },
        children: [
          { type: 'div', props: { style: { display: 'flex', color, fontFamily: 'Barlow', fontSize: 13, letterSpacing: 1.5 }, children: label } },
          ...rows,
          overflow > 0 && {
            type: 'div',
            props: {
              style: { position: 'absolute', display: 'flex', top: bodyEnd, left: 0, color: 'rgba(255,255,255,0.5)', fontFamily: 'Barlow', fontSize: 12 },
              children: `+${overflow} more`,
            },
          },
        ].filter(Boolean),
      },
    },
  };
}

/**
 * Posted once a featured line's game goes final -- reuses the odds card's
 * hero (same gradient/grain/smoke/player-art treatment, "FINAL" in place
 * of the week label) instead of a separate plain-text embed, so a settled
 * result still reads as one of these cards.
 *
 * @param {object} result
 * @param {string} result.awayAbbr
 * @param {string} result.homeAbbr
 * @param {number} result.awayScore
 * @param {number} result.homeScore
 * @param {number} [result.week]
 * @param {number} [result.matchNumber]
 * @param {number} result.won
 * @param {number} result.lost
 * @param {number} result.push
 * @param {object[]} [result.bets] - settled VegasBet rows for this line (market, selection,
 *   line_value, stake, potential_payout, status, discord_user_id, team_name) -- won/lost
 *   ones are listed by name directly on the card.
 * @returns {Promise<Buffer>} PNG bytes
 */
async function renderSettlementCard(result) {
  const home = getTeam(result.homeAbbr);
  const away = getTeam(result.awayAbbr);

  const wonBets = (result.bets || []).filter((b) => b.status === 'won');
  const lostBets = (result.bets || []).filter((b) => b.status === 'lost');
  const namedBets = [...wonBets, ...lostBets].slice(0, RESULT_MAX_SHOWN * 2);

  // Same privacy rule as suspensionWatcher.js's resolveOwnerMention():
  // VegasBet.username is a LeagueMember join key and often an email, so it
  // must never appear on the card. discord_user_id resolves to a real,
  // safe display name; team_name (the row's own fallback) is used when a
  // member can't be found.
  const namePairs = await Promise.all(namedBets.map(async (bet) => {
    try {
      const member = await getMemberByDiscordId(bet.discord_user_id);
      return [bet.id, member ? memberDisplayName(member) : null];
    } catch {
      return [bet.id, null];
    }
  }));
  const names = new Map(namePairs);

  const winnersBlock = wonBets.length ? resultListBlock('🏆 WINNERS', wonBets, names, result.awayAbbr, result.homeAbbr, 'won') : null;
  const losersBlock = lostBets.length ? resultListBlock('💀 LOSERS', lostBets, names, result.awayAbbr, result.homeAbbr, 'lost') : null;
  const RESULTS_H = (winnersBlock || losersBlock)
    ? 16 + Math.max(winnersBlock?.height || 0, losersBlock?.height || 0) + 20
    : 0;

  const STAT_H = 175;
  const H = HERO_H + STAT_H + RESULTS_H;

  const [fonts, awayPlayer, homePlayer, badgeLogo, noiseTexture, smokeTexture] = await Promise.all([
    loadFonts(),
    loadPlayerDataUri(result.awayAbbr),
    loadPlayerDataUri(result.homeAbbr),
    loadLogoDataUri(LEAGUE_BADGE_URL),
    getNoiseTexture(),
    getSmokeTexture(),
  ]);
  const [awayHelmet, homeHelmet] = await Promise.all([
    awayPlayer ? null : loadHelmetDataUri(result.awayAbbr).catch(() => null),
    homePlayer ? null : loadHelmetDataUri(result.homeAbbr).catch(() => null),
  ]);

  const hero = buildHero({
    away, home, awayAbbr: result.awayAbbr, homeAbbr: result.homeAbbr,
    awayPlayer, homePlayer, awayHelmet, homeHelmet, badgeLogo, noiseTexture, smokeTexture,
    topLabel: [
      'FINAL',
      result.week != null ? `WEEK ${result.week}` : null,
      result.matchNumber != null ? `#${result.matchNumber}` : null,
    ].filter(Boolean).join(' · '),
  });

  const awayWon = result.awayScore > result.homeScore;
  const homeWon = result.homeScore > result.awayScore;
  const scoreColor = (won) => (won ? GOLD : 'rgba(255,255,255,0.55)');

  const statTile = (label, value, color) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1,
        background: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: '12px 4px', gap: 4,
      },
      children: [
        { type: 'div', props: { style: { display: 'flex', color, fontFamily: 'Anton', fontSize: 32 }, children: String(value) } },
        { type: 'div', props: { style: { display: 'flex', color: 'rgba(255,255,255,0.55)', fontFamily: 'Barlow', fontSize: 13, letterSpacing: 2 }, children: label } },
      ],
    },
  });

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
            style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, padding: '18px 32px 6px' },
            children: [
              { type: 'div', props: { style: { display: 'flex', color: scoreColor(awayWon), fontFamily: 'Anton', fontSize: 30 }, children: `${away.name || result.awayAbbr} ${result.awayScore}` } },
              { type: 'div', props: { style: { display: 'flex', color: 'rgba(255,255,255,0.4)', fontFamily: 'Barlow', fontSize: 20 }, children: '—' } },
              { type: 'div', props: { style: { display: 'flex', color: scoreColor(homeWon), fontFamily: 'Anton', fontSize: 30 }, children: `${home.name || result.homeAbbr} ${result.homeScore}` } },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', gap: 12, padding: '8px 32px 20px' },
            children: [
              statTile('WON', result.won, '#3FA34D'),
              statTile('LOST', result.lost, '#C60C30'),
              statTile('PUSH', result.push, GOLD),
            ],
          },
        },
        RESULTS_H > 0 && {
          type: 'div',
          props: {
            style: {
              display: 'flex', gap: 24, padding: '16px 32px 20px',
              borderTop: '1px solid rgba(212,168,67,0.3)',
            },
            children: [winnersBlock?.node, losersBlock?.node].filter(Boolean),
          },
        },
      ].filter(Boolean),
    },
  };

  const svg = await satori(tree, { width: W, height: H, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: W * 2 } });
  return resvg.render().asPng();
}

export { renderOddsCard, renderBetReceiptCard, renderSettlementCard };
