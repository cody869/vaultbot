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
export async function loadEmoji(client) {
  cache.clear();
  let count = 0;

  // Make sure the guild list itself is populated (can be empty right at ready).
  let guilds = [...client.guilds.cache.values()];
  if (!guilds.length) {
    try {
      guilds = [...(await client.guilds.fetch()).values()];
    } catch {
      /* fall through with whatever we have */
    }
  }

  for (const g of guilds) {
    try {
      // Resolve to a full Guild object, then fetch emoji from the API so we
      // don't depend on whatever happened to be cached at startup.
      const guild = g.emojis ? g : await client.guilds.fetch(g.id);
      const emojis = await guild.emojis.fetch();
      for (const emoji of emojis.values()) {
        if (!emoji.name) continue;
        const key = emoji.name.toLowerCase();
        if (!cache.has(key)) {
          cache.set(key, emoji.toString()); // -> "<:name:id>" / "<a:name:id>"
          count++;
        }
      }
    } catch (err) {
      console.error(`Could not fetch emoji for a guild:`, err.message);
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

// Resolve a team abbreviation (uppercase) from a full or nickname team name.
// Returns "" if unknown.
export function abbrFromName(teamName) {
  if (!teamName) return "";
  const key = teamName.toLowerCase().trim();
  const nick = key.split(/\s+/).pop();
  return (NAME_TO_ABBR[key] || NAME_TO_ABBR[nick] || "").toUpperCase();
}

// Resolve a helmet from either an abbreviation or a full/nick team name.
export function teamEmojiByName(teamName) {
  if (!teamName) return teamEmoji("");
  const key = teamName.toLowerCase().trim();
  // Try the last word (handles "Cleveland Browns" -> "browns").
  const nick = key.split(/\s+/).pop();
  const abbr = NAME_TO_ABBR[key] || NAME_TO_ABBR[nick];
  return teamEmoji(abbr || teamName);
}

// Dev-trait gem by trait value. Madden stores this as a numeric code
// (0=Normal, 1=Star, 2=Superstar, 3=X-Factor) but it may also arrive as a
// word ("X-Factor"). Handle both.
export function devEmoji(trait) {
  const raw = String(trait ?? "").toLowerCase().trim();
  let name = "normal_dev";
  if (raw === "3" || raw.includes("x-factor") || raw.includes("xfactor")) name = "xfactor_dev";
  else if (raw === "2" || raw.includes("superstar")) name = "superstar_dev";
  else if (raw === "1" || raw === "star" || (raw.includes("star") && !raw.includes("super"))) name = "star_dev";
  else name = "normal_dev"; // "0", "normal", or anything else
  return resolve(name, DEV_FALLBACK[name]);
}
