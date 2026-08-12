// Standalone team color/logo table for vaultbot's scorebug card.
// Mirrors the intent of src/lib/nflTeamLogos.js in the app repo, but kept
// as its own copy here since vaultbot is a separate Node process/repo --
// same pattern already used for tradeValueEngine.js.
//
// logoUrl points at a GitHub-hosted logo set (klunn91/team-logos), not
// ESPN's CDN. ESPN's CDN was the original choice, but a live post showed a
// missing/blank team logo with no error in the logs -- meaning ESPN
// returned something that wasn't a usable image without actually failing
// the HTTP request. This repo's images were verified end-to-end (rendered
// correctly through the real card pipeline before switching). One caveat:
// it's a personal repo, not an official asset source -- it could disappear
// or go stale (its Washington entry is still "redskins.png", the pre-2022
// branding). If a team's logo ever looks wrong or breaks, that mapping is
// the first thing to check.

const LOGO_BASE = 'https://raw.githubusercontent.com/klunn91/team-logos/master/NFL';

const TEAMS = {
  ARI: { name: 'Cardinals', color: '#97233F', logoFile: 'cardinals' },
  ATL: { name: 'Falcons', color: '#A71930', logoFile: 'falcons' },
  BAL: { name: 'Ravens', color: '#241773', logoFile: 'ravens' },
  BUF: { name: 'Bills', color: '#00338D', logoFile: 'bills' },
  CAR: { name: 'Panthers', color: '#0085CA', logoFile: 'panthers' },
  CHI: { name: 'Bears', color: '#0B162A', logoFile: 'bears' },
  CIN: { name: 'Bengals', color: '#FB4F14', logoFile: 'bengals' },
  CLE: { name: 'Browns', color: '#311D00', logoFile: 'browns' },
  DAL: { name: 'Cowboys', color: '#041E42', logoFile: 'cowboys' },
  DEN: { name: 'Broncos', color: '#FB4F14', logoFile: 'broncos' },
  DET: { name: 'Lions', color: '#0076B6', logoFile: 'lions' },
  GB:  { name: 'Packers', color: '#203731', logoFile: 'packers' },
  HOU: { name: 'Texans', color: '#03202F', logoFile: 'texans' },
  IND: { name: 'Colts', color: '#002C5F', logoFile: 'colts' },
  JAX: { name: 'Jaguars', color: '#006778', logoFile: 'jaguars' },
  KC:  { name: 'Chiefs', color: '#E31837', logoFile: 'chiefs' },
  LAC: { name: 'Chargers', color: '#0080C6', logoFile: 'chargers' },
  LAR: { name: 'Rams', color: '#003594', logoFile: 'rams' },
  LV:  { name: 'Raiders', color: '#000000', logoFile: 'raiders' },
  MIA: { name: 'Dolphins', color: '#008E97', logoFile: 'dolphins' },
  MIN: { name: 'Vikings', color: '#4F2683', logoFile: 'vikings' },
  NE:  { name: 'Patriots', color: '#002244', logoFile: 'patriots' },
  NO:  { name: 'Saints', color: '#D3BC8D', logoFile: 'saints' },
  NYG: { name: 'Giants', color: '#0B2265', logoFile: 'giants' },
  NYJ: { name: 'Jets', color: '#125740', logoFile: 'jets' },
  PHI: { name: 'Eagles', color: '#004C54', logoFile: 'eagles' },
  PIT: { name: 'Steelers', color: '#FFB612', logoFile: 'steelers' },
  SEA: { name: 'Seahawks', color: '#002244', logoFile: 'seahawks' },
  SF:  { name: '49ers', color: '#AA0000', logoFile: '49ers' },
  TB:  { name: 'Buccaneers', color: '#D50A0A', logoFile: 'buccaneers' },
  TEN: { name: 'Titans', color: '#0C2340', logoFile: 'titans' },
  WAS: { name: 'Commanders', color: '#5A1414', logoFile: 'redskins' } // stale asset, see note above
};

function getTeam(abbr) {
  const key = abbr.toUpperCase();
  const t = TEAMS[key];
  if (!t) throw new Error(`Unknown team abbreviation: ${abbr}`);
  return {
    abbr: key,
    name: t.name,
    color: t.color,
    logoUrl: `${LOGO_BASE}/${t.logoFile}.png`
  };
}

export { TEAMS, getTeam };
