// weeklyDigestCard.js
//
// Renders the weekly recap card (Satori -> PNG via resvg), matching
// scorebugCard.js/suspensionCard.js's visual language (gold border, dark
// background, team color accent, Anton headline / Barlow body).
//
// Unlike those cards, this one displays free-text content of unpredictable
// length (a headline, a summary, an arbitrary number of dev-trait upgrades)
// instead of short bounded strings (scores, "WEEK N"). Satori requires an
// explicit height up front -- it does not lay out and report back a
// resulting size the way a browser would -- so every section's height is
// computed from its actual content (with a line-count estimate for wrapped
// text) BEFORE the tree is built, and sections stack in normal flow rather
// than at hardcoded pixel offsets. A first version of this card used fixed
// offsets sized for a short headline; a two-line real headline overlapped
// the summary below it (confirmed live) -- this rewrite is what fixes that
// as a class of bug, not just that one instance.
//
// The card carries the "computed deterministically" parts of a WeeklyDigest
// record (headline, top game, stat leaders, dev-trait upgrades, next week's
// marquee matchup) -- the full narrative/storylines are long-form text and
// go in the Discord message content alongside the card, not baked into the
// image.

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { getTeam } from './teamLogos.js';
import { abbrFromName, devEmojiImageUrl } from './emoji.js';
import { loadFonts, loadLogoDataUri, GOLD, DARK_BG } from './cardKit.js';

const W = 900;
const MARGIN = 32;
const USABLE_W = W - MARGIN * 2;

const CATEGORY_LABELS = {
  passing: 'PASSING',
  rushing: 'RUSHING',
  receiving: 'RECEIVING',
  defense: 'DEFENSE',
};

const DEV_TRAIT_LABELS = { 0: 'Normal', 1: 'Star', 2: 'Superstar', 3: 'X-Factor' };
function devTraitLabel(trait) {
  const raw = String(trait ?? '').trim();
  return DEV_TRAIT_LABELS[raw] ?? DEV_TRAIT_LABELS[Number(raw)] ?? raw ?? 'Normal';
}

// --- text-wrap estimation ---------------------------------------------
//
// Satori doesn't hand back a computed layout height, so section heights
// have to be decided before the tree is built. This is a character-count
// heuristic, not real font metrics -- calibrated against a real rendered
// headline (see the module comment above) and deliberately rounds UP, so
// the failure mode of a bad estimate is a little extra empty space, never
// a clipped/overlapping line.
const ANTON_CHAR_WIDTH_RATIO = 0.5; // condensed display font
const BARLOW_CHAR_WIDTH_RATIO = 0.56; // bold sans

function wrapLines(text, { fontSize, charWidthRatio, maxWidth = USABLE_W, maxLines = Infinity }) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const charsPerLine = Math.max(4, Math.floor(maxWidth / (fontSize * charWidthRatio)));

  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > charsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);

  if (lines.length >= maxLines && lines.length) {
    // Truncate whatever didn't fit with an ellipsis rather than silently
    // dropping it -- a long headline is expected, not an error case.
    const consumed = lines.slice(0, maxLines - 1);
    const last = words.join(' ').length > lines.slice(0, maxLines).join(' ').length
      ? `${lines[maxLines - 1].slice(0, Math.max(0, charsPerLine - 1))}…`
      : lines[maxLines - 1];
    return [...consumed, last];
  }
  return lines;
}

function textBlock(lines, { fontSize, lineHeight, fontFamily, color, letterSpacing = 0 }) {
  return lines.map((line) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex', fontSize, fontFamily, color, height: lineHeight,
        alignItems: 'center', letterSpacing,
      },
      children: line,
    },
  }));
}

function resolveTeam(name) {
  try {
    const abbr = abbrFromName(name);
    if (abbr) return { ...getTeam(abbr), fullName: name };
  } catch {
    /* fall through */
  }
  return { abbr: null, name, fullName: name, color: GOLD, logoUrl: null };
}

// --- sections ------------------------------------------------------------

const HEADER_PAD_TOP = 22;
const HEADER_PAD_BOTTOM = 22;
const META_H = 26;
const HEADLINE_FONT = 44;
const HEADLINE_LH = 50;
const SUMMARY_FONT = 18;
const SUMMARY_LH = 26;
const GAME_CHIP_H = 42;
const LOGO_SIZE = 460;

function buildHeader({ week, seasonNumber, headline, summary, topGame, homeTeam, homeLogo }) {
  const meta = [seasonNumber != null && `SEASON ${seasonNumber}`, week != null && `WEEK ${week}`]
    .filter(Boolean)
    .join(' · ');
  const headlineLines = wrapLines(headline, { fontSize: HEADLINE_FONT, charWidthRatio: ANTON_CHAR_WIDTH_RATIO, maxLines: 2 });
  const summaryLines = summary
    ? wrapLines(summary, { fontSize: SUMMARY_FONT, charWidthRatio: BARLOW_CHAR_WIDTH_RATIO, maxLines: 2 })
    : [];

  const hasTopGame = !!(topGame && topGame.homeTeam && topGame.awayTeam);
  const topGameLine = hasTopGame
    ? `${topGame.awayAbbr || topGame.awayTeam} ${topGame.awayScore ?? '–'} @ ${topGame.homeAbbr || topGame.homeTeam} ${topGame.homeScore ?? '–'}` +
      (topGame.awayOwner && topGame.homeOwner ? `  ·  ${topGame.awayOwner} vs ${topGame.homeOwner}` : '')
    : null;

  const H = HEADER_PAD_TOP + (meta ? META_H : 0) + headlineLines.length * HEADLINE_LH +
    (summaryLines.length ? summaryLines.length * SUMMARY_LH + 8 : 0) +
    (topGameLine ? GAME_CHIP_H + 12 : 0) + HEADER_PAD_BOTTOM;

  const node = {
    type: 'div',
    props: {
      style: {
        width: W, height: H, display: 'flex', flexDirection: 'column',
        position: 'relative', overflow: 'hidden', padding: `${HEADER_PAD_TOP}px ${MARGIN}px ${HEADER_PAD_BOTTOM}px`,
        background: `linear-gradient(120deg, ${homeTeam?.color || GOLD} 0%, ${DARK_BG} 60%)`,
      },
      children: [
        homeLogo && {
          type: 'img',
          props: {
            src: homeLogo, width: LOGO_SIZE, height: LOGO_SIZE,
            style: { position: 'absolute', top: (H - LOGO_SIZE) / 2, right: -LOGO_SIZE * 0.2, opacity: 0.14 },
          },
        },
        meta && {
          type: 'div',
          props: {
            style: { display: 'flex', height: META_H, color: 'rgba(255,255,255,0.75)', fontFamily: 'Barlow', fontSize: 16, letterSpacing: 2 },
            children: meta,
          },
        },
        ...textBlock(headlineLines, { fontSize: HEADLINE_FONT, lineHeight: HEADLINE_LH, fontFamily: 'Anton', color: '#FFFFFF', letterSpacing: 0.5 }),
        summaryLines.length && {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', marginTop: 8 },
            children: textBlock(summaryLines, { fontSize: SUMMARY_FONT, lineHeight: SUMMARY_LH, fontFamily: 'Barlow', color: 'rgba(255,255,255,0.75)' }),
          },
        },
        topGameLine && {
          type: 'div',
          props: {
            style: {
              display: 'flex', marginTop: 12, alignSelf: 'flex-start',
              background: 'rgba(0,0,0,0.4)', color: GOLD, fontFamily: 'Barlow',
              fontSize: 18, padding: '6px 14px', borderRadius: 4, letterSpacing: 0.5,
            },
            children: topGameLine,
          },
        },
      ].filter(Boolean),
    },
  };
  return { node, height: H };
}

// Tall enough for the player name/team line to wrap to 2 lines (e.g. "Joe
// Burrow — Cincinnati Bengals" in the narrowest, 4-column layout) without
// clipping the stat line below it -- confirmed live that 100 was too tight.
const STRIP_H = 132;

function buildStatLeadersStrip(statLeaders) {
  const shown = statLeaders.slice(0, 4);
  const colWidth = USABLE_W / shown.length;
  const chips = shown.map((s, i) => ({
    type: 'div',
    props: {
      style: {
        position: 'absolute', display: 'flex', flexDirection: 'column',
        top: 20, left: MARGIN + i * colWidth, width: colWidth - 16,
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

  const node = {
    type: 'div',
    props: {
      style: { width: W, height: STRIP_H, display: 'flex', position: 'relative', background: DARK_BG },
      children: [
        { type: 'div', props: { style: { position: 'absolute', top: 0, left: 0, width: W, height: 1, display: 'flex', background: 'rgba(212,168,67,0.4)' } } },
        ...chips,
      ],
    },
  };
  return { node, height: STRIP_H };
}

const STORY_LABEL_H = 30;
const STORY_FONT = 17;
const STORY_LH = 22;
const STORY_GAP = 10;
const STORY_MAX_SHOWN = 6;
const STORY_MAX_LINES_PER = 2;
const STORY_BULLET_INDENT = 22;

function buildStorylinesSection(storylines) {
  const shown = storylines.slice(0, STORY_MAX_SHOWN);
  const overflow = storylines.length - shown.length;
  const bulletMaxWidth = USABLE_W - STORY_BULLET_INDENT;
  const wrapped = shown.map((s) =>
    wrapLines(s, { fontSize: STORY_FONT, charWidthRatio: BARLOW_CHAR_WIDTH_RATIO, maxWidth: bulletMaxWidth, maxLines: STORY_MAX_LINES_PER })
  );

  let y = 20 + STORY_LABEL_H;
  const items = wrapped.map((lines) => {
    const top = y;
    y += lines.length * STORY_LH + STORY_GAP;
    return {
      type: 'div',
      props: {
        style: { position: 'absolute', display: 'flex', top, left: MARGIN },
        children: [
          { type: 'div', props: { style: { display: 'flex', width: STORY_BULLET_INDENT, color: GOLD, fontFamily: 'Barlow', fontSize: STORY_FONT }, children: '•' } },
          {
            type: 'div',
            props: {
              style: { display: 'flex', flexDirection: 'column' },
              children: textBlock(lines, { fontSize: STORY_FONT, lineHeight: STORY_LH, fontFamily: 'Barlow', color: 'rgba(255,255,255,0.85)' }),
            },
          },
        ],
      },
    };
  });

  const H = y - STORY_GAP + (overflow > 0 ? 22 : 0) + 14;

  const node = {
    type: 'div',
    props: {
      style: { width: W, height: H, display: 'flex', position: 'relative', background: '#12161C' },
      children: [
        { type: 'div', props: { style: { position: 'absolute', top: 0, left: 0, width: W, height: 1, display: 'flex', background: 'rgba(212,168,67,0.4)' } } },
        {
          type: 'div',
          props: {
            style: { position: 'absolute', display: 'flex', top: 16, left: MARGIN, color: GOLD, fontFamily: 'Barlow', fontSize: 13, letterSpacing: 1 },
            children: 'STORYLINES',
          },
        },
        ...items,
        overflow > 0 && {
          type: 'div',
          props: {
            style: { position: 'absolute', display: 'flex', top: y, left: MARGIN + STORY_BULLET_INDENT, color: 'rgba(255,255,255,0.5)', fontFamily: 'Barlow', fontSize: 14 },
            children: `+${overflow} more`,
          },
        },
      ].filter(Boolean),
    },
  };
  return { node, height: H };
}

const DEV_ROW_H = 56;
const DEV_PER_ROW = 3;
const DEV_MAX_SHOWN = 9;

function buildDevUpgradesSection(upgrades, images) {
  const shown = upgrades.slice(0, DEV_MAX_SHOWN);
  const overflow = upgrades.length - shown.length;
  const rows = Math.ceil(shown.length / DEV_PER_ROW);
  const colWidth = USABLE_W / DEV_PER_ROW;
  const bodyH = rows * DEV_ROW_H;
  const H = 44 + bodyH + (overflow > 0 ? 24 : 0) + 16;

  const badge = (trait, imgUrl) => ({
    type: 'div',
    props: {
      style: { display: 'flex', width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', background: 'rgba(212,168,67,0.15)' },
      children: imgUrl
        ? { type: 'img', props: { src: imgUrl, width: 22, height: 22, style: { display: 'flex' } } }
        : { type: 'div', props: { style: { display: 'flex', color: GOLD, fontFamily: 'Barlow', fontSize: 10, letterSpacing: 0.5 }, children: devTraitLabel(trait).slice(0, 3).toUpperCase() } },
    },
  });

  const entries = shown.map((u, i) => ({
    type: 'div',
    props: {
      style: {
        position: 'absolute', display: 'flex', alignItems: 'center',
        top: 44 + Math.floor(i / DEV_PER_ROW) * DEV_ROW_H,
        left: MARGIN + (i % DEV_PER_ROW) * colWidth,
        width: colWidth - 16,
      },
      children: [
        badge(u.fromTrait, images.get(`from:${i}`)),
        { type: 'div', props: { style: { display: 'flex', color: 'rgba(255,255,255,0.4)', fontFamily: 'Barlow', fontSize: 16, margin: '0 6px' }, children: '→' } },
        badge(u.toTrait, images.get(`to:${i}`)),
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', marginLeft: 10 },
            children: [
              { type: 'div', props: { style: { display: 'flex', color: '#FFFFFF', fontFamily: 'Barlow', fontSize: 15 }, children: u.playerFullName } },
              u.teamName && { type: 'div', props: { style: { display: 'flex', color: 'rgba(255,255,255,0.55)', fontFamily: 'Barlow', fontSize: 13 }, children: u.teamName } },
            ].filter(Boolean),
          },
        },
      ],
    },
  }));

  const node = {
    type: 'div',
    props: {
      style: { width: W, height: H, display: 'flex', position: 'relative', background: '#171C24' },
      children: [
        { type: 'div', props: { style: { position: 'absolute', top: 0, left: 0, width: W, height: 1, display: 'flex', background: 'rgba(212,168,67,0.4)' } } },
        {
          type: 'div',
          props: {
            style: { position: 'absolute', display: 'flex', top: 16, left: MARGIN, color: GOLD, fontFamily: 'Barlow', fontSize: 13, letterSpacing: 1 },
            children: 'DEV TRAIT UPGRADES',
          },
        },
        ...entries,
        overflow > 0 && {
          type: 'div',
          props: {
            style: { position: 'absolute', display: 'flex', bottom: 8, left: MARGIN, color: 'rgba(255,255,255,0.5)', fontFamily: 'Barlow', fontSize: 14 },
            children: `+${overflow} more`,
          },
        },
      ].filter(Boolean),
    },
  };
  return { node, height: H };
}

const PREVIEW_LABEL_H = 30;
const PREVIEW_TEAMS_H = 40;
const PREVIEW_BLURB_FONT = 16;
const PREVIEW_BLURB_LH = 22;

function buildNextGameSection(nextGame, awayLogo, homeLogo) {
  const blurbLines = nextGame.blurb
    ? wrapLines(nextGame.blurb, { fontSize: PREVIEW_BLURB_FONT, charWidthRatio: BARLOW_CHAR_WIDTH_RATIO, maxWidth: USABLE_W - 20, maxLines: 3 })
    : [];
  const H = 20 + PREVIEW_LABEL_H + PREVIEW_TEAMS_H + (blurbLines.length ? blurbLines.length * PREVIEW_BLURB_LH + 6 : 0) + 16;

  const logo = (url) => url
    ? { type: 'img', props: { src: url, width: 34, height: 34, style: { display: 'flex' } } }
    : { type: 'div', props: { style: { display: 'flex', width: 34, height: 34 } } };

  const node = {
    type: 'div',
    props: {
      style: { width: W, height: H, display: 'flex', flexDirection: 'column', position: 'relative', padding: `20px ${MARGIN}px 16px`, background: '#12161C' },
      children: [
        { type: 'div', props: { style: { position: 'absolute', top: 0, left: 0, width: W, height: 1, display: 'flex', background: 'rgba(212,168,67,0.4)' } } },
        {
          type: 'div',
          props: {
            style: { display: 'flex', height: PREVIEW_LABEL_H, color: GOLD, fontFamily: 'Barlow', fontSize: 13, letterSpacing: 1 },
            children: "NEXT WEEK'S GAME OF THE WEEK",
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', height: PREVIEW_TEAMS_H, alignItems: 'center' },
            children: [
              logo(awayLogo),
              { type: 'div', props: { style: { display: 'flex', color: '#FFFFFF', fontFamily: 'Barlow', fontSize: 20, margin: '0 10px' }, children: `${nextGame.awayAbbr || nextGame.awayTeam} @ ${nextGame.homeAbbr || nextGame.homeTeam}` } },
              logo(homeLogo),
            ],
          },
        },
        blurbLines.length && {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', marginTop: 6 },
            children: textBlock(blurbLines, { fontSize: PREVIEW_BLURB_FONT, lineHeight: PREVIEW_BLURB_LH, fontFamily: 'Barlow', color: 'rgba(255,255,255,0.7)' }),
          },
        },
      ].filter(Boolean),
    },
  };
  return { node, height: H };
}

/**
 * @param {object} d
 * @param {number} [d.week]
 * @param {number} [d.seasonNumber]
 * @param {string} d.headline
 * @param {string} [d.summary]
 * @param {object} [d.topGame] - {awayTeam, homeTeam, awayScore, homeScore, awayOwner, homeOwner}
 * @param {{category: string, playerFullName: string, teamName?: string, statLine?: string}[]} [d.statLeaders]
 * @param {string[]} [d.storylines]
 * @param {{playerFullName: string, teamName?: string, fromTrait: string|number, toTrait: string|number}[]} [d.devUpgrades]
 * @param {object} [d.nextGame] - {awayTeam, homeTeam, blurb}
 * @returns {Promise<Buffer>} PNG bytes
 */
async function renderWeeklyDigestCard(d) {
  const { week, seasonNumber, headline, summary, topGame, statLeaders, storylines, devUpgrades, nextGame } = d;
  const hasTopGame = !!(topGame && topGame.homeTeam && topGame.awayTeam);
  const hasStrip = Array.isArray(statLeaders) && statLeaders.length > 0;
  const hasStorylines = Array.isArray(storylines) && storylines.length > 0;
  const hasDev = Array.isArray(devUpgrades) && devUpgrades.length > 0;
  const hasNextGame = !!(nextGame && nextGame.homeTeam && nextGame.awayTeam);

  const home = hasTopGame ? resolveTeam(topGame.homeTeam) : null;
  const away = hasTopGame ? resolveTeam(topGame.awayTeam) : null;
  const nextHome = hasNextGame ? resolveTeam(nextGame.homeTeam) : null;
  const nextAway = hasNextGame ? resolveTeam(nextGame.awayTeam) : null;

  const devShown = hasDev ? devUpgrades.slice(0, DEV_MAX_SHOWN) : [];
  const devImageJobs = devShown.flatMap((u, i) => [
    ['from:' + i, devEmojiImageUrl(u.fromTrait)],
    ['to:' + i, devEmojiImageUrl(u.toTrait)],
  ]).filter(([, url]) => url);

  const [fonts, homeLogo, nextAwayLogo, nextHomeLogo, devImagePairs] = await Promise.all([
    loadFonts(),
    home?.logoUrl ? loadLogoDataUri(home.logoUrl).catch(() => null) : Promise.resolve(null),
    nextAway?.logoUrl ? loadLogoDataUri(nextAway.logoUrl).catch(() => null) : Promise.resolve(null),
    nextHome?.logoUrl ? loadLogoDataUri(nextHome.logoUrl).catch(() => null) : Promise.resolve(null),
    Promise.all(devImageJobs.map(async ([key, url]) => [key, await loadLogoDataUri(url).catch(() => null)])),
  ]);
  const devImages = new Map(devImagePairs);

  const sections = [];
  sections.push(buildHeader({
    week, seasonNumber, headline, summary,
    topGame: hasTopGame ? { ...topGame, awayAbbr: away.abbr, homeAbbr: home.abbr } : null,
    homeTeam: home, homeLogo,
  }));
  if (hasStrip) sections.push(buildStatLeadersStrip(statLeaders.map((s) => ({
    category: s.category, playerFullName: s.playerFullName, teamName: s.teamName, statLine: s.statLine,
  }))));
  if (hasStorylines) sections.push(buildStorylinesSection(storylines));
  // Pass the FULL list, not devShown -- buildDevUpgradesSection does its own
  // slicing and needs the true count to compute the "+N more" overflow note.
  // devShown above is a separate, narrower slice used only to decide which
  // emoji images are worth fetching (no point fetching one for an entry
  // that won't be shown).
  if (hasDev) sections.push(buildDevUpgradesSection(devUpgrades, devImages));
  if (hasNextGame) sections.push(buildNextGameSection(
    { ...nextGame, awayAbbr: nextAway.abbr, homeAbbr: nextHome.abbr },
    nextAwayLogo, nextHomeLogo,
  ));

  const H = sections.reduce((sum, s) => sum + s.height, 0);

  const tree = {
    type: 'div',
    props: {
      style: {
        width: W, height: H, display: 'flex', flexDirection: 'column',
        position: 'relative', overflow: 'hidden', borderRadius: 10,
        border: `3px solid ${GOLD}`,
      },
      children: sections.map((s) => s.node),
    },
  };

  const svg = await satori(tree, { width: W, height: H, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: W * 2 } });
  return resvg.render().asPng();
}

export { renderWeeklyDigestCard };
