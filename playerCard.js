// playerCard.js — renders the /player card in the same hero-card style as
// /prospect (see heroCard.js), one image per dropdown view:
//
//   overview  contract, key ratings for the position, abilities
//   ratings   every rating on file
//   weekly    the latest season's game-by-game lines
//   season    season-by-season totals
//
// Content is the same as the text card it replaces (embeds.js playerEmbed),
// reusing its rating picks, money formatting and stat lines. Unlike a
// prospect, a rostered player's ratings are public, so exact values show.
//
// The header is shared by every view: EA portrait in a medallion tinted with
// the team colour, team logo + name, position / jersey / dev-trait pills,
// OVR on the right, and an age / height / weight / experience row.

import { loadFonts, loadLogoDataUri } from './cardKit.js';
import { TEAMS, getTeam } from './teamLogos.js';
import { normalizeAbbr, abbrFromName } from './emoji.js';
import {
  fmtMoney, ALL_RATINGS, relevantRatings, weeklyStatLine, seasonStatLines,
} from './embeds.js';
import {
  parseHex, toHex, FALLBACK_ACCENT, visibleAccent, renderMedallion, nameBlock, pill, badge, headerRow,
  pillRow, statCell, section, muted, barRow, barGrid, renderHeroCard, div, LABEL,
} from './heroCard.js';

// Same portrait sources as the app's PlayerPortrait.jsx: M27 face-cropped
// first, then the M26 image.
const M27_PORTRAIT = (id) =>
  `https://ratings-images-prod.pulse.ea.com/madden-nfl-27/portraits/${id}.png?im=FaceCrop,padding=0.7;Resize=(640)&q=80`;
const M26_PORTRAIT = (id) => `https://ratings-images-prod.pulse.ea.com/madden-nfl-26/portraits/${id}.png`;

// EA portraits are head-and-shoulders cut-outs already framed by the face
// crop, so they need far less zoom than the prospect portraits.
const PORTRAIT_FRAMING = { scale: 1.05, originY: 0.5, dy: 0.06 };

const DEV_TRAITS = {
  xfactor: { label: 'X-Factor', color: '#F87171' },
  superstar: { label: 'Superstar', color: '#C084FC' },
  star: { label: 'Star', color: '#FACC15' },
  normal: null, // no badge
};

function devTrait(raw) {
  const t = String(raw ?? '').toLowerCase().trim();
  if (t === '3' || t.includes('x-factor') || t.includes('xfactor')) return DEV_TRAITS.xfactor;
  if (t === '2' || t.includes('superstar')) return DEV_TRAITS.superstar;
  if (t === '1' || t === 'star') return DEV_TRAITS.star;
  return DEV_TRAITS.normal;
}

const ABILITY_COLORS = { Platinum: '#E5E7EB', Gold: '#FACC15', Silver: '#CBD5E1', Bronze: '#D69E6B' };

function ordinal(n) {
  const s = n % 100;
  if (s >= 11 && s <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

function heightText(h) {
  if (h == null || h === '') return null;
  if (/^\d+$/.test(String(h).trim())) {
    const inches = parseInt(h, 10);
    return `${Math.floor(inches / 12)}'${inches % 12}"`;
  }
  return String(h);
}

async function loadPortrait(portraitId) {
  if (!portraitId) return null;
  const id = String(portraitId).trim();
  for (const url of [M27_PORTRAIT(id), M26_PORTRAIT(id)]) {
    try {
      return await loadLogoDataUri(url);
    } catch {
      /* try the next source */
    }
  }
  return null;
}

// --- view bodies -----------------------------------------------------------

function overviewBody(p) {
  const cl = p.player_contractLength;
  const yl = p.player_contractYrsLeft;
  const length = cl != null && yl != null ? `${yl}/${cl}` : cl != null ? `${cl}` : '—';
  const cell = (label, value, unit) => statCell(label, value, { unit, width: '33.3%', size: 24, mb: 16 });
  const out = [
    section('Contract', div({ flexWrap: 'wrap' }, [
      cell('Length', length, cl != null ? 'yrs' : null),
      cell('Salary', fmtMoney(p.player_contractSalary)),
      cell('Cap Hit', fmtMoney(p.player_capHit)),
      cell('Bonus', fmtMoney(p.player_contractBonus)),
      cell('Savings', fmtMoney(p.player_capSavings)),
      cell('Penalty', fmtMoney(p.player_capPenalty)),
    ])),
  ];

  const pairs = relevantRatings(p);
  if (pairs.length) {
    out.push(section('Key Ratings', barGrid(pairs.map(([label, k]) => barRow(label, Number(p[k]), p[k])))));
  }

  const abilities = Array.isArray(p.abilities) ? p.abilities.filter((a) => a?.title) : [];
  if (abilities.length) {
    out.push(section('Abilities', div({ flexWrap: 'wrap' }, abilities.map((a) =>
      div({ marginRight: 10, marginBottom: 10 }, [badge(a.title, ABILITY_COLORS[a.rank] || '#E5E7EB')])
    ))));
  }
  return out;
}

function ratingsBody(p) {
  const pairs = ALL_RATINGS.filter(([, k]) => p[k] != null);
  return [section('Full Ratings', pairs.length
    ? barGrid(pairs.map(([label, k]) => barRow(label, Number(p[k]), p[k])))
    : muted('No ratings on file.'))];
}

// A label column on the left, one or more lines of text on the right.
function statLine(label, lines) {
  return div({ alignItems: 'flex-start', marginBottom: 12 }, [
    div({ width: 118, flexShrink: 0, fontSize: 16, color: '#E5DADA' }, label),
    div({ flexDirection: 'column', flex: 1 }, lines.map((l) => div({ fontSize: 16, color: '#FFFFFF', marginBottom: 3 }, l))),
  ]);
}

function weeklyBody(weekly) {
  const { season = null, weeks: all = [] } = weekly ?? {};
  const rows = all.slice(0, 12)
    .map((w) => ({ w, line: weeklyStatLine(w) }))
    .filter((r) => r.line);
  const title = `Weekly Stats${season != null ? ` — Season ${season}` : ''}`;
  if (!all.length) return [section(title, muted('No weekly stats on file for this player.'))];
  if (!rows.length) return [section(title, muted('No recorded stats in these weeks.'))];
  return [section(title, div({ flexDirection: 'column' },
    rows.map(({ w, line }) => statLine(`Week ${w.week_index ?? '?'}`, line.split(' • ')))))];
}

function seasonBody(seasonRows) {
  const rows = (Array.isArray(seasonRows) ? seasonRows : []).slice(0, 8)
    .map((r) => ({ r, parts: seasonStatLines(r) }))
    .filter((x) => x.parts.length);
  if (!Array.isArray(seasonRows) || !seasonRows.length) return [section('Season Stats', muted('No season stats on file for this player.'))];
  if (!rows.length) return [section('Season Stats', muted('No recorded stats in these seasons.'))];
  return [section('Season Stats', div({ flexDirection: 'column' },
    rows.map(({ r, parts }) => statLine(`Season ${r.season}${r.gamesPlayed ? ` · ${r.gamesPlayed} GP` : ''}`, parts))))];
}

/**
 * @param {object} p      Player row
 * @param {object} team   roster/team row from getRosterFor (may be null)
 * @param {string} view   "overview" | "ratings" | "weekly" | "season"
 * @param {object} data   { weekly, season } for those views
 * @returns {Promise<Buffer>} PNG
 */
export async function renderPlayerCard(p, team = null, view = 'overview', data = {}) {
  const teamName = team?.team_name ?? p.team_name ?? '';
  const abbr = normalizeAbbr(team?.team_abbrName ?? p.team_abbrName) || abbrFromName(teamName);
  const teamInfo = abbr && TEAMS[abbr] ? getTeam(abbr) : null;
  const accent = visibleAccent(parseHex(teamInfo?.color) || FALLBACK_ACCENT);

  const [fonts, logo, photo] = await Promise.all([
    loadFonts(),
    teamInfo ? loadLogoDataUri(teamInfo.logoUrl).catch(() => null) : Promise.resolve(null),
    loadPortrait(p.portraitId),
  ]);
  const medallion = await renderMedallion(photo, toHex(accent), p.player_fullName, fonts, PORTRAIT_FRAMING);

  const dev = devTrait(p.player_devTrait);
  const jersey = p.player_jerseyNum != null && p.player_jerseyNum !== '' ? `#${p.player_jerseyNum}` : null;
  const yrs = p.player_yrsPro != null ? Number(p.player_yrsPro) : null;
  const height = heightText(p.player_height);

  const body =
    view === 'ratings' ? ratingsBody(p)
      : view === 'weekly' ? weeklyBody(data.weekly)
        : view === 'season' ? seasonBody(data.season)
          : overviewBody(p);

  const children = [
    headerRow(
      [
        nameBlock(logo, String(p.player_fullName || 'Unknown')),
        pillRow([
          pill(p.player_position ?? '?'),
          jersey ? div({ fontSize: 21, color: LABEL }, jersey) : null,
          dev ? badge(dev.label, dev.color) : null,
          !teamInfo && teamName === '' ? div({ fontSize: 21, color: LABEL }, 'Free Agent') : null,
        ]),
      ],
      'Overall',
      p.player_ovr != null ? String(p.player_ovr) : '—',
      { dim: p.player_ovr == null }
    ),
    div({ marginTop: 34 }, [
      statCell('Age', p.player_age != null ? String(p.player_age) : '—'),
      statCell('Height', height ?? '—'),
      statCell('Weight', p.player_weight ? String(p.player_weight) : '—', { unit: p.player_weight ? 'lbs' : null }),
      statCell('Experience', yrs == null ? '—' : yrs === 0 ? 'Rookie' : ordinal(yrs + 1), { unit: yrs ? 'yr' : null }),
    ]),
    ...body,
  ];

  return renderHeroCard({ accent, medallion, children, fonts });
}
