// d1Teams.js — All FBS (D1) NCAA teams with ESPN logo IDs and brand colors.
// Ported verbatim from the XCFL Vault app's src/lib/d1Teams.js so /prospect's
// college logos/colors match the app exactly -- same reasoning as
// teamLogos.js already keeping its own copy of the NFL table.

const D1_TEAMS = [
  { name: 'Air Force', espnId: 2005, color: '003087' },
  { name: 'Akron', espnId: 2006, color: '002147' },
  { name: 'Alabama', espnId: 333, color: '9E1B32' },
  { name: 'Appalachian State', espnId: 2026, color: '232F4B' },
  { name: 'Arizona', espnId: 12, color: '003369' },
  { name: 'Arizona State', espnId: 9, color: '8C1D40' },
  { name: 'Arkansas', espnId: 8, color: '9D2235' },
  { name: 'Arkansas State', espnId: 2032, color: 'CC0000' },
  { name: 'Army', espnId: 349, color: '000000' },
  { name: 'Auburn', espnId: 2, color: '0C2340' },
  { name: 'Ball State', espnId: 2050, color: 'BA0C2F' },
  { name: 'Baylor', espnId: 239, color: '154733' },
  { name: 'Boise State', espnId: 68, color: '0033A0' },
  { name: 'Boston College', espnId: 103, color: '8B0000' },
  { name: 'Bowling Green', espnId: 189, color: 'F56600' },
  { name: 'Buffalo', espnId: 2084, color: '005BBB' },
  { name: 'BYU', espnId: 252, color: '0062B8' },
  { name: 'California', espnId: 25, color: '003262' },
  { name: 'Central Michigan', espnId: 2117, color: '6A0032' },
  { name: 'Charlotte', espnId: 2429, color: '046A38' },
  { name: 'Cincinnati', espnId: 2132, color: 'E00122' },
  { name: 'Clemson', espnId: 228, color: 'F56600' },
  { name: 'Coastal Carolina', espnId: 324, color: '006F71' },
  { name: 'Colorado', espnId: 38, color: 'CFB87C' },
  { name: 'Colorado State', espnId: 36, color: '1E4D2B' },
  { name: 'Duke', espnId: 150, color: '003087' },
  { name: 'East Carolina', espnId: 151, color: '592A8A' },
  { name: 'Eastern Michigan', espnId: 2199, color: '006633' },
  { name: 'Florida', espnId: 57, color: '0021A5' },
  { name: 'Florida Atlantic', espnId: 2226, color: '003366' },
  { name: 'Florida State', espnId: 52, color: '782F40' },
  { name: 'Fresno State', espnId: 278, color: '192250' },
  { name: 'Georgia', espnId: 61, color: 'BA0C2F' },
  { name: 'Georgia Southern', espnId: 290, color: '012169' },
  { name: 'Georgia State', espnId: 2247, color: '0039A6' },
  { name: 'Georgia Tech', espnId: 59, color: 'B3A369' },
  { name: 'Hawai\'i', espnId: 62, color: '024731' },
  { name: 'Houston', espnId: 248, color: 'C8102E' },
  { name: 'Idaho', espnId: 70, color: 'B3A369' },
  { name: 'Illinois', espnId: 356, color: '13294B' },
  { name: 'Indiana', espnId: 84, color: '990000' },
  { name: 'Iowa', espnId: 2294, color: 'FFCD00' },
  { name: 'Iowa State', espnId: 66, color: 'C8102E' },
  { name: 'Jacksonville State', espnId: 55, color: 'CC0000' },
  { name: 'James Madison', espnId: 256, color: '450084' },
  { name: 'Kansas', espnId: 2305, color: '0022A5' },
  { name: 'Kansas State', espnId: 2306, color: '512888' },
  { name: 'Kent State', espnId: 2309, color: '002664' },
  { name: 'Kentucky', espnId: 96, color: '0033A0' },
  { name: 'Liberty', espnId: 2335, color: '002868' },
  { name: 'Louisiana', espnId: 309, color: 'CE181E' },
  { name: 'Louisiana Monroe', espnId: 2433, color: '840029' },
  { name: 'Louisiana Tech', espnId: 2348, color: '002F8B' },
  { name: 'Louisville', espnId: 97, color: 'AD0000' },
  { name: 'LSU', espnId: 99, color: '461D7C' },
  { name: 'Marshall', espnId: 276, color: '00582A' },
  { name: 'Maryland', espnId: 120, color: 'E03a3e' },
  { name: 'Memphis', espnId: 235, color: '003087' },
  { name: 'Miami (FL)', espnId: 2390, color: '005030' },
  { name: 'Miami (OH)', espnId: 193, color: 'B61E2E' },
  { name: 'Michigan', espnId: 130, color: '00274C' },
  { name: 'Michigan State', espnId: 127, color: '18453B' },
  { name: 'Middle Tennessee', espnId: 2393, color: '0066CC' },
  { name: 'Minnesota', espnId: 135, color: '7A0019' },
  { name: 'Mississippi State', espnId: 344, color: '5D1725' },
  { name: 'Missouri', espnId: 142, color: 'F1B82D' },
  { name: 'Navy', espnId: 2426, color: '00205B' },
  { name: 'NC State', espnId: 152, color: 'CC0000' },
  { name: 'Nebraska', espnId: 158, color: 'E4002B' },
  { name: 'Nevada', espnId: 2440, color: '003366' },
  { name: 'New Mexico', espnId: 167, color: 'BA0C2F' },
  { name: 'New Mexico State', espnId: 2443, color: '890000' },
  { name: 'North Carolina', espnId: 153, color: '4B9CD3' },
  { name: 'North Texas', espnId: 249, color: '00853E' },
  { name: 'Northern Illinois', espnId: 2459, color: 'CC0000' },
  { name: 'Northwestern', espnId: 77, color: '4E2A84' },
  { name: 'Notre Dame', espnId: 87, color: '0C2340' },
  { name: 'Ohio', espnId: 195, color: '00694E' },
  { name: 'Ohio State', espnId: 194, color: 'BB0000' },
  { name: 'Oklahoma', espnId: 201, color: '841617' },
  { name: 'Oklahoma State', espnId: 197, color: 'D74014' },
  { name: 'Ole Miss', espnId: 145, color: 'CE1126' },
  { name: 'Oregon', espnId: 2483, color: '154734' },
  { name: 'Oregon State', espnId: 204, color: 'DC4405' },
  { name: 'Penn State', espnId: 213, color: '041E42' },
  { name: 'Pittsburgh', espnId: 221, color: '003594' },
  { name: 'Purdue', espnId: 2509, color: 'CEB888' },
  { name: 'Rice', espnId: 242, color: '002469' },
  { name: 'Rutgers', espnId: 164, color: 'CC0033' },
  { name: 'Sam Houston State', espnId: 2534, color: 'F77F00' },
  { name: 'San Diego State', espnId: 21, color: 'A6192E' },
  { name: 'San José State', espnId: 23, color: '0055A2' },
  { name: 'SMU', espnId: 256, color: '0033A0' },
  { name: 'South Alabama', espnId: 6, color: '00205B' },
  { name: 'South Carolina', espnId: 2579, color: '73000A' },
  { name: 'South Florida', espnId: 58, color: '006747' },
  { name: 'Southern Miss', espnId: 2572, color: 'FFD046' },
  { name: 'Stanford', espnId: 24, color: '8C1515' },
  { name: 'Syracuse', espnId: 183, color: 'F76900' },
  { name: 'TCU', espnId: 2628, color: '4D1979' },
  { name: 'Temple', espnId: 218, color: '9D2235' },
  { name: 'Tennessee', espnId: 2633, color: 'FF8200' },
  { name: 'Texas', espnId: 251, color: 'BF5700' },
  { name: 'Texas A&M', espnId: 245, color: '500000' },
  { name: 'Texas State', espnId: 326, color: '501214' },
  { name: 'Texas Tech', espnId: 2641, color: 'CC0000' },
  { name: 'Toledo', espnId: 2649, color: '15397F' },
  { name: 'Troy', espnId: 2653, color: 'CC0000' },
  { name: 'Tulane', espnId: 2655, color: '00583D' },
  { name: 'Tulsa', espnId: 202, color: '003366' },
  { name: 'UAB', espnId: 5, color: '1E6B52' },
  { name: 'UCF', espnId: 2116, color: 'BA9B37' },
  { name: 'UCLA', espnId: 26, color: '2774AE' },
  { name: 'UMass', espnId: 113, color: '881C1C' },
  { name: 'UNLV', espnId: 2439, color: 'CF0A2C' },
  { name: 'USC', espnId: 30, color: '990000' },
  { name: 'Utah', espnId: 254, color: 'CC0000' },
  { name: 'Utah State', espnId: 328, color: '0F1A7E' },
  { name: 'Vanderbilt', espnId: 238, color: '866D4B' },
  { name: 'Virginia', espnId: 258, color: '232D4B' },
  { name: 'Virginia Tech', espnId: 259, color: '630031' },
  { name: 'Wake Forest', espnId: 154, color: '9E7E38' },
  { name: 'Washington', espnId: 264, color: '4B2E83' },
  { name: 'Washington State', espnId: 265, color: '981E32' },
  { name: 'West Virginia', espnId: 277, color: '002855' },
  { name: 'Western Kentucky', espnId: 98, color: 'C8102E' },
  { name: 'Western Michigan', espnId: 2711, color: '6C4023' },
  { name: 'Wisconsin', espnId: 275, color: 'C5050C' },
  { name: 'Wyoming', espnId: 2751, color: '492F24' },
];

const D1_TEAM_MAP = Object.fromEntries(D1_TEAMS.map((t) => [t.name, t]));

// Alias map for shortened/alternate team names stored in data.
const TEAM_ALIASES = {
  'Miami': 'Miami (FL)',
};

// Fuzzy-match normalization for college names stored with inconsistent casing
// or diacritics (e.g. "Tcu" -> "TCU", "Ucla" -> "UCLA", "Hawaii" -> "Hawai'i",
// "San Jose State" -> "San José State"). Lowercase, strip diacritics, strip
// apostrophes/periods, collapse whitespace, trim.
const normalizeTeamName = (name) =>
  (name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.'’‘’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const D1_NORM_LOOKUP = Object.fromEntries(D1_TEAMS.map((t) => [normalizeTeamName(t.name), t]));

function resolveTeam(teamName) {
  const aliasResolved = TEAM_ALIASES[teamName] || teamName;
  return D1_TEAM_MAP[aliasResolved] || D1_NORM_LOOKUP[normalizeTeamName(aliasResolved)];
}

export function getCollegeLogoUrl(teamName) {
  const team = resolveTeam(teamName);
  return team ? `https://a.espncdn.com/i/teamlogos/ncaa/500/${team.espnId}.png` : null;
}

export function getCollegeColor(teamName) {
  const team = resolveTeam(teamName);
  return team ? team.color : '1a1a2e';
}
