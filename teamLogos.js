// Standalone team color/logo table for vaultbot's scorebug card.
// Mirrors the intent of src/lib/nflTeamLogos.js in the app repo, but kept
// as its own copy here since vaultbot is a separate Node process/repo --
// same pattern already used for tradeValueEngine.js.
//
// logoUrl uses ESPN's team logo CDN (the app's own earlier convention,
// before the Helmet pixel-art component). Swap any entry's logoUrl if a
// different asset source is preferred -- the render function just needs a
// URL or local file path it can read/fetch, format is not load-bearing.

const TEAMS = {
  ARI: { name: 'Cardinals', color: '#97233F' },
  ATL: { name: 'Falcons', color: '#A71930' },
  BAL: { name: 'Ravens', color: '#241773' },
  BUF: { name: 'Bills', color: '#00338D' },
  CAR: { name: 'Panthers', color: '#0085CA' },
  CHI: { name: 'Bears', color: '#0B162A' },
  CIN: { name: 'Bengals', color: '#FB4F14' },
  CLE: { name: 'Browns', color: '#311D00' },
  DAL: { name: 'Cowboys', color: '#041E42' },
  DEN: { name: 'Broncos', color: '#FB4F14' },
  DET: { name: 'Lions', color: '#0076B6' },
  GB:  { name: 'Packers', color: '#203731' },
  HOU: { name: 'Texans', color: '#03202F' },
  IND: { name: 'Colts', color: '#002C5F' },
  JAX: { name: 'Jaguars', color: '#006778' },
  KC:  { name: 'Chiefs', color: '#E31837' },
  LAC: { name: 'Chargers', color: '#0080C6' },
  LAR: { name: 'Rams', color: '#003594' },
  LV:  { name: 'Raiders', color: '#000000' },
  MIA: { name: 'Dolphins', color: '#008E97' },
  MIN: { name: 'Vikings', color: '#4F2683' },
  NE:  { name: 'Patriots', color: '#002244' },
  NO:  { name: 'Saints', color: '#D3BC8D' },
  NYG: { name: 'Giants', color: '#0B2265' },
  NYJ: { name: 'Jets', color: '#125740' },
  PHI: { name: 'Eagles', color: '#004C54' },
  PIT: { name: 'Steelers', color: '#FFB612' },
  SEA: { name: 'Seahawks', color: '#002244' },
  SF:  { name: '49ers', color: '#AA0000' },
  TB:  { name: 'Buccaneers', color: '#D50A0A' },
  TEN: { name: 'Titans', color: '#0C2340' },
  WAS: { name: 'Commanders', color: '#5A1414' }
};

function getTeam(abbr) {
  const key = abbr.toUpperCase();
  const t = TEAMS[key];
  if (!t) throw new Error(`Unknown team abbreviation: ${abbr}`);
  return {
    abbr: key,
    name: t.name,
    color: t.color,
    logoUrl: `https://a.espncdn.com/i/teamlogos/nfl/500/${key}.png`
  };
}

export { TEAMS, getTeam };
