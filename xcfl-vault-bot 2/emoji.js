// emoji.js — resolves custom server emoji by name into <:name:id> codes.
// Populated at startup from the bot's cached guild emoji, so shortcodes like
// "ari" or "xfactor_dev" render as real custom emoji instead of plain text.

const cache = new Map(); // name (lowercase) -> "<:name:id>"

// Unicode fallbacks used only when a custom emoji isn't found on the server.
const TEAM_FALLBACK = {
  ari: "🔴", atl: "🦅", bal: "🟣", buf: "🔵", car: "🐈‍⬛", chi: "🐻",
  cin: "🐅", cle: "🟤", dal: "⭐", den: "🐴", det: "🦁", gb: "🧀",
  hou: "🐂", ind: "🐎", jax: "🐆", kc: "🏹", lv: "🏴‍☠️", lac: "⚡",
  lar: "🐏", mia: "🐬", min: "🟣", ne: "🔵", no: "⚜️", nyg: "🔵",
  nyj: "🛩️", phi: "🦅", pit: "🟡", sf: "🌉", sea: "🐦‍⬛", tb: "🏴‍☠️",
  ten: "🗡️", was: "🪶",
};

const DEV_FALLBACK = {
  xfactor_dev: "💎",
  superstar_dev: "⭐",
  star_dev: "🌟",
  normal_dev: "🔘",
};

// Call once the client is ready. Walks every guild the bot is in and caches
// each custom emoji by its (lowercased) name.
export function loadEmoji(client) {
  cache.clear();
  let count = 0;
  for (const guild of client.guilds.cache.values()) {
    for (const emoji of guild.emojis.cache.values()) {
      if (!emoji.name) continue;
      // First one wins if the same name exists in multiple servers.
      const key = emoji.name.toLowerCase();
      if (!cache.has(key)) {
        cache.set(key, emoji.toString()); // -> "<:name:id>" or "<a:name:id>"
        count++;
      }
    }
  }
  console.log(`🎨 Cached ${count} custom emoji.`);
}

// Generic resolver: returns the custom emoji code if found, else the fallback.
function resolve(name, fallback) {
  const key = (name ?? "").toLowerCase();
  return cache.get(key) ?? fallback ?? "";
}

// Team helmet by abbreviation (e.g. "CLE" -> :cle:).
export function teamEmoji(abbr) {
  const key = (abbr ?? "").toLowerCase();
  return resolve(key, TEAM_FALLBACK[key] || "🏈");
}

// Maps full team names (as stored in SeasonRecord/TradeBlock "team_name") to
// the abbreviation used for emoji lookup. Covers nickname-only and city forms.
const NAME_TO_ABBR = {
  cardinals: "ari", falcons: "atl", ravens: "bal", bills: "buf",
  panthers: "car", bears: "chi", bengals: "cin", browns: "cle",
  cowboys: "dal", broncos: "den", lions: "det", packers: "gb",
  texans: "hou", colts: "ind", jaguars: "jax", chiefs: "kc",
  raiders: "lv", chargers: "lac", rams: "lar", dolphins: "mia",
  vikings: "min", patriots: "ne", saints: "no", giants: "nyg",
  jets: "nyj", eagles: "phi", steelers: "pit", "49ers": "sf",
  seahawks: "sea", buccaneers: "tb", titans: "ten", commanders: "was",
};

// Resolve a helmet from either an abbreviation or a full/nick team name.
export function teamEmojiByName(teamName) {
  if (!teamName) return teamEmoji("");
  const key = teamName.toLowerCase().trim();
  // Try the last word (handles "Cleveland Browns" -> "browns").
  const nick = key.split(/\s+/).pop();
  const abbr = NAME_TO_ABBR[key] || NAME_TO_ABBR[nick];
  return teamEmoji(abbr || teamName);
}

// Dev-trait gem by trait string (e.g. "X-Factor" -> :xfactor_dev:).
export function devEmoji(trait) {
  const t = (trait ?? "").toLowerCase();
  let name = "normal_dev";
  if (t.includes("x-factor") || t.includes("xfactor")) name = "xfactor_dev";
  else if (t.includes("superstar")) name = "superstar_dev";
  else if (t.includes("star")) name = "star_dev";
  return resolve(name, DEV_FALLBACK[name]);
}
