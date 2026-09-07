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

// conf/div: real-NFL conference/division alignment. Every team in this
// league is a real NFL franchise, so this is exact and current (not
// something the export/TeamMap/TeamStat data carries at all -- confirmed
// live via the Base44 schema) and won't drift on its own. Used by
// getPlayoffPicture() in vault.js to group Madden's own per-conference
// `seed` (TeamStat.seed) into an AFC/NFC playoff picture.
const TEAMS = {
  ARI: { name: 'Cardinals', color: '#97233F', logoFile: 'cardinals', conf: 'NFC', div: 'West' },
  ATL: { name: 'Falcons', color: '#A71930', logoFile: 'falcons', conf: 'NFC', div: 'South' },
  BAL: { name: 'Ravens', color: '#241773', logoFile: 'ravens', conf: 'AFC', div: 'North' },
  BUF: { name: 'Bills', color: '#00338D', logoFile: 'bills', conf: 'AFC', div: 'East' },
  CAR: { name: 'Panthers', color: '#0085CA', logoFile: 'panthers', conf: 'NFC', div: 'South' },
  CHI: { name: 'Bears', color: '#0B162A', logoFile: 'bears', conf: 'NFC', div: 'North' },
  CIN: { name: 'Bengals', color: '#FB4F14', logoFile: 'bengals', conf: 'AFC', div: 'North' },
  CLE: { name: 'Browns', color: '#311D00', logoFile: 'browns', conf: 'AFC', div: 'North' },
  DAL: { name: 'Cowboys', color: '#041E42', logoFile: 'cowboys', conf: 'NFC', div: 'East' },
  DEN: { name: 'Broncos', color: '#FB4F14', logoFile: 'broncos', conf: 'AFC', div: 'West' },
  DET: { name: 'Lions', color: '#0076B6', logoFile: 'lions', conf: 'NFC', div: 'North' },
  GB:  { name: 'Packers', color: '#203731', logoFile: 'packers', conf: 'NFC', div: 'North' },
  HOU: { name: 'Texans', color: '#03202F', logoFile: 'texans', conf: 'AFC', div: 'South' },
  IND: { name: 'Colts', color: '#002C5F', logoFile: 'colts', conf: 'AFC', div: 'South' },
  JAX: { name: 'Jaguars', color: '#006778', logoFile: 'jaguars', conf: 'AFC', div: 'South' },
  KC:  { name: 'Chiefs', color: '#E31837', logoFile: 'chiefs', conf: 'AFC', div: 'West' },
  LAC: { name: 'Chargers', color: '#0080C6', logoFile: 'chargers', conf: 'AFC', div: 'West' },
  LAR: { name: 'Rams', color: '#003594', logoFile: 'rams', conf: 'NFC', div: 'West' },
  LV:  { name: 'Raiders', color: '#000000', logoFile: 'raiders', conf: 'AFC', div: 'West' },
  MIA: { name: 'Dolphins', color: '#008E97', logoFile: 'dolphins', conf: 'AFC', div: 'East' },
  MIN: { name: 'Vikings', color: '#4F2683', logoFile: 'vikings', conf: 'NFC', div: 'North' },
  NE:  { name: 'Patriots', color: '#002244', logoFile: 'patriots', conf: 'AFC', div: 'East' },
  NO:  { name: 'Saints', color: '#D3BC8D', logoFile: 'saints', conf: 'NFC', div: 'South' },
  NYG: { name: 'Giants', color: '#0B2265', logoFile: 'giants', conf: 'NFC', div: 'East' },
  NYJ: { name: 'Jets', color: '#125740', logoFile: 'jets', conf: 'AFC', div: 'East' },
  PHI: { name: 'Eagles', color: '#004C54', logoFile: 'eagles', conf: 'NFC', div: 'East' },
  PIT: { name: 'Steelers', color: '#FFB612', logoFile: 'steelers', conf: 'AFC', div: 'North' },
  SEA: { name: 'Seahawks', color: '#002244', logoFile: 'seahawks', conf: 'NFC', div: 'West' },
  SF:  { name: '49ers', color: '#AA0000', logoFile: '49ers', conf: 'NFC', div: 'West' },
  TB:  { name: 'Buccaneers', color: '#D50A0A', logoFile: 'buccaneers', conf: 'NFC', div: 'South' },
  TEN: { name: 'Titans', color: '#0C2340', logoFile: 'titans', conf: 'AFC', div: 'South' },
  WAS: { name: 'Commanders', color: '#5A1414', logoFile: 'redskins', conf: 'NFC', div: 'East' } // stale asset, see note above
};

function getTeam(abbr) {
  const key = abbr.toUpperCase();
  const t = TEAMS[key];
  if (!t) throw new Error(`Unknown team abbreviation: ${abbr}`);
  return {
    abbr: key,
    name: t.name,
    color: t.color,
    logoUrl: `${LOGO_BASE}/${t.logoFile}.png`,
    conf: t.conf,
    div: t.div,
  };
}

export { TEAMS, getTeam };
