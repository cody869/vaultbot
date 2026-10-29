// streamWatcher.js — watches #twitch-streams for go-live posts (MEE6's
// "X is now live on https://twitch.tv/x !" + embed), works out which of this
// week's games the stream is for, and saves a GameStream row so Week Central
// shows the game as "In progress" with the stream link.
//
// Event-driven only (MessageCreate/MessageUpdate), so it costs nothing while
// nobody is streaming. Reads are cached for a couple of minutes because go-live
// posts tend to land in bursts at game time.
//
// How a stream is tied to a game, in order:
//   1. LeagueMember.twitch_username === the twitch login (set on the member's
//      profile in the Vault; most active streamers are pre-filled).
//   2. The login looks like one of the member's names (discord_username,
//      avatar_name, aliases): e.g. "quackscfm" -> Quacks, "xcfldrew" -> Drew.
//   3. The stream title names a team in this week's open games
//      ("XCFL Giants", "XCFL SF vs MIA", "Raiiiiiders").
// The member's team must have an unplayed game this week. Titles that point
// at something else (CFB, another league) are skipped, and a stream matched
// only by name needs either a Madden/XCFL-ish title or a scheduled kickoff
// close to now.
//
// GameStream fields written: game_id, season_number, week, team_name, url,
// platform, display_name, source='discord', live_started_at, twitch_login,
// stream_title, discord_message_id, matched_by. Week Central treats a game as
// in progress for 4 hours after live_started_at, or until it goes final.
//
// Environment:
//   STREAMS_CHANNEL_ID   channel to watch (default: XCFL's #twitch-streams)
//   STREAM_SKIP_WORDS    comma-separated title words that mean "not an XCFL
//                        game" (default below)
//   STREAM_TRUSTED_LOGINS  comma-separated twitch logins exempt from the skip
//                        words (default: boomerbaby21)
//
// Needs the Message Content intent (already on for scheduleWatcher).

import { Events } from "discord.js";
import { list, createEntity, updateEntity, pollCached, memberDisplayName } from "./vault.js";
import { abbrFromName } from "./emoji.js";
import { TEAMS } from "./teamLogos.js";

const CHANNEL_ID = process.env.STREAMS_CHANNEL_ID || "477632618205151242";
const SKIP_WORDS = (process.env.STREAM_SKIP_WORDS || "cfb,college,ncaa,fnsl,nba,2k,mlb,nhl,fortnite,warzone,cod")
  .split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
// Twitch logins whose stream titles don't follow the usual pattern but are
// always XCFL games (e.g. Zethious titles every XCFL stream "CFB"). The
// skip-word check is not applied to them; the kickoff-time check still is.
const TRUSTED_LOGINS = new Set((process.env.STREAM_TRUSTED_LOGINS || "boomerbaby21")
  .split(",").map((w) => w.trim().toLowerCase()).filter(Boolean));
const POSITIVE_RE = /\b(xcfl|madden|m2\d|franchise|cfm)\b/i;
const MAX_POST_AGE_MS = 6 * 60 * 60 * 1000;   // ignore edits to old posts
const NEW_SESSION_MS = 4 * 60 * 60 * 1000;    // same streamer + game after this = a new go-live
const CONTEXT_TTL_MS = 2 * 60 * 1000;

const URL_RE = /https?:\/\/(?:www\.|m\.)?(twitch\.tv|kick\.com|youtube\.com|youtu\.be)\/[^\s>)"]+/i;

const CITY = {
  ARI: ["arizona"], ATL: ["atlanta"], BAL: ["baltimore"], BUF: ["buffalo"], CAR: ["carolina"],
  CHI: ["chicago"], CIN: ["cincinnati", "cincy"], CLE: ["cleveland"], DAL: ["dallas"], DEN: ["denver"],
  DET: ["detroit"], GB: ["green bay", "packers"], HOU: ["houston"], IND: ["indianapolis", "indy"],
  JAX: ["jacksonville", "jags"], KC: ["kansas city"], LAC: ["bolts"], LAR: [], LV: ["las vegas", "vegas"],
  MIA: ["miami", "fins"], MIN: ["minnesota", "vikes"], NE: ["new england", "pats"], NO: ["new orleans"],
  NYG: ["big blue"], NYJ: [], PHI: ["philadelphia", "philly"], PIT: ["pittsburgh"], SEA: ["seattle"],
  SF: ["san francisco", "niners"], TB: ["tampa bay", "tampa", "bucs"], TEN: ["tennessee"], WSH: ["washington"],
};

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const looksLikeEmail = (s) => /@/.test(String(s || ""));
const nickOf = (team) => String(team || "").trim().split(/\s+/).pop().toLowerCase();
const isPlayed = (g) => Number(g.status) === 2 || Number(g.status) === 3 ||
  (Number(g.user1_score) || 0) + (Number(g.user2_score) || 0) > 0;

// ── Eastern kickoff for a ScheduledGame (same rule as the Vault's eastern.js) ──
const ET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "numeric",
  day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short",
});
function etParts(ms) {
  const p = Object.fromEntries(ET.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second,
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
function etToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = (ms) => { const p = etParts(ms); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
  let t = guess - off(guess);
  t = guess - off(t);
  return t;
}
function kickoffMs(sg) {
  if (!sg || sg.scheduled_status !== "scheduled") return null;
  const raw = String(sg.parsed_at || sg.created_date || "");
  const posted = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
  if (Number.isNaN(posted)) return null;
  const base = etParts(posted);
  const want = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    .indexOf(String(sg.scheduled_day || "").toLowerCase());
  const ahead = want >= 0 ? (want - base.dow + 7) % 7 : 0;
  const day = new Date(Date.UTC(base.y, base.mo - 1, base.d + ahead));
  const hasTime = sg.scheduled_hour_24 != null;
  return etToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(),
    hasTime ? Number(sg.scheduled_hour_24) : 23, hasTime ? Number(sg.scheduled_minute || 0) : 0);
}

// ── Context: this week's open games, members, schedule posts, streams ──
async function loadContext() {
  return pollCached("stream-watch-context", CONTEXT_TTL_MS, async () => {
    const [configs, games, members] = await Promise.all([
      list("AppConfig"),
      list("Game", {}, { limit: 20000 }),
      list("LeagueMember"),
    ]);
    const season = Number(configs.find((c) => c.key === "current_season_number")?.value) ||
      Math.max(0, ...games.map((g) => Number(g.season_number) || 0));
    const seasonGames = games.filter((g) => Number(g.season_number) === season);
    const open = seasonGames.filter((g) => !isPlayed(g) && g.week != null);
    const week = open.length ? Math.min(...open.map((g) => Number(g.week))) : null;
    const weekGames = week == null ? [] : open.filter((g) => Number(g.week) === week);
    const scheduled = week == null ? [] : (await list("ScheduledGame", {}, { limit: 5000 }))
      .filter((s) => Number(s.season_number) === season && Number(s.week) === week);
    return {
      season, week, weekGames, scheduled,
      members: members.filter((m) => (!m.status || m.status === "active") && m.team_name),
    };
  });
}

// ── Parsing ──
function parsePost(message) {
  const embed = message.embeds?.[0];
  const text = `${embed?.url || ""} ${message.content || ""}`;
  const m = text.match(URL_RE);
  if (!m) return null;
  const url = m[0].replace(/[.,!]+$/, "");
  const host = m[1].toLowerCase();
  const platform = host.startsWith("twitch") ? "twitch" : host.startsWith("kick") ? "kick" : "youtube";
  let login = "";
  try {
    login = new URL(url).pathname.split("/").filter(Boolean)[0]?.toLowerCase() || "";
  } catch { /* keep empty */ }
  return { url, platform, login, title: String(embed?.title || "").trim() };
}

// Teams named in a stream title, as abbreviations.
function teamsInTitle(title) {
  if (!title) return new Set();
  const collapsed = title.replace(/([a-z])\1{2,}/gi, "$1"); // "Raiiiiiders" -> "Raiders"
  const lower = ` ${collapsed.toLowerCase().replace(/[^a-z0-9 ]/g, " ")} `;
  const words = new Set(collapsed.split(/[^A-Za-z0-9]+/).filter(Boolean));
  const found = new Set();
  for (const [abbr, t] of Object.entries(TEAMS)) {
    const nick = t.name.toLowerCase();
    if (lower.includes(` ${nick} `) || lower.includes(` ${nick.replace(/s$/, "")} `)) found.add(abbr);
    for (const c of CITY[abbr] || []) if (lower.includes(` ${c} `)) found.add(abbr);
    // Abbreviations only when typed in capitals ("SF vs MIA"), so "no" or "ne" in a sentence don't count.
    if (words.has(abbr)) found.add(abbr);
  }
  if (words.has("WAS")) found.add("WSH");
  return found;
}

function memberNames(m) {
  return [m.discord_username, m.avatar_name, ...(Array.isArray(m.aliases) ? m.aliases : []),
    looksLikeEmail(m.username) ? null : m.username]
    .map(norm).filter((n) => n.length >= 4);
}

function matchMember(login, members) {
  if (!login) return null;
  const explicit = members.find((m) => norm(m.twitch_username) === norm(login));
  if (explicit) return { member: explicit, by: "twitch_username" };
  const core = norm(login).replace(/\d+$/, "");
  if (core.length < 4) return null;
  let best = null;
  let bestLen = 0;
  let tie = false;
  for (const m of members) {
    for (const n of memberNames(m)) {
      const hit = core === n || core.startsWith(n) || core.endsWith(n) || n.startsWith(core);
      if (!hit) continue;
      if (n.length > bestLen) { best = m; bestLen = n.length; tie = false; }
      else if (n.length === bestLen && best && best.id !== m.id) tie = true;
    }
  }
  return best && !tie ? { member: best, by: "identity" } : null;
}

function gameForTeam(teamName, weekGames) {
  const nick = nickOf(teamName);
  return weekGames.find((g) => nickOf(g.homeTeam) === nick || nickOf(g.awayTeam) === nick) || null;
}

function gameFromTitle(abbrs, weekGames) {
  if (!abbrs.size) return null;
  const hits = weekGames.filter((g) => abbrs.has(abbrFromName(g.homeTeam)) || abbrs.has(abbrFromName(g.awayTeam)));
  if (abbrs.size >= 2) {
    const both = hits.filter((g) => abbrs.has(abbrFromName(g.homeTeam)) && abbrs.has(abbrFromName(g.awayTeam)));
    if (both.length === 1) return both[0];
  }
  return hits.length === 1 ? hits[0] : null;
}

// True if the OTHER team in this game already has its own confident
// (non-title-only) GameStream row for it. Two different owners both going
// live for the same real matchup is strong corroboration on its own -- used
// to relax the title/kickoff heuristics below, which exist precisely to
// catch the opposite case (a recognized member streaming something else
// entirely, not their XCFL game).
async function opponentConfirmed(game, team) {
  if (!game || !team) return false;
  const opponent = [game.homeTeam, game.awayTeam].find((t) => nickOf(t) !== nickOf(team));
  if (!opponent) return false;
  const rows = await list("GameStream", {}, { limit: 500 }).catch(() => []);
  return rows.some((s) => s.game_id === game.id && s.matched_by !== "title" && nickOf(s.team_name) === nickOf(opponent));
}

// ── Handler ──
const inFlight = new Set();

async function handleStreamMessage(message) {
  if (message.channelId !== CHANNEL_ID) return;
  if (message.partial) {
    try { message = await message.fetch(); } catch { return; }
  }
  const createdAt = message.createdTimestamp || Date.now();
  if (Date.now() - createdAt > MAX_POST_AGE_MS) return;

  const post = parsePost(message);
  if (!post) return;
  const titleLower = post.title.toLowerCase();
  if (!TRUSTED_LOGINS.has(post.login) && SKIP_WORDS.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(titleLower))) {
    console.log(`[STREAMS] skip ${post.login}: title "${post.title}" looks like another game/league`);
    return;
  }

  const key = `${message.id}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const ctx = await loadContext();
    if (!ctx.week || !ctx.weekGames.length) return;

    const titleTeams = teamsInTitle(post.title);
    const who = matchMember(post.login, ctx.members);
    let game = null;
    let team = null;
    let by = null;

    if (who) {
      game = gameForTeam(who.member.team_name, ctx.weekGames);
      team = who.member.team_name;
      by = who.by;
      if (game && titleTeams.size &&
          ![game.homeTeam, game.awayTeam].some((t) => titleTeams.has(abbrFromName(t)))) {
        // The title explicitly names OTHER teams -- real evidence this post
        // is about a different game, not just an absence of evidence for
        // this one. Not something opponentConfirmed below should override:
        // the opponent being live elsewhere doesn't make this contradiction
        // go away.
        console.log(`[STREAMS] skip ${post.login}: "${post.title}" names teams outside ${team}'s game`);
        return;
      }
      // Matched by name only and the title says nothing either way -- this is
      // the genuinely ambiguous case the opponent check below is for: no
      // positive or negative signal from the title itself, so fall back to
      // either the opponent already being confirmed live for this exact
      // game, or the kickoff-time proximity check.
      if (game && !titleTeams.size && !POSITIVE_RE.test(post.title) && post.title && !(await opponentConfirmed(game, team))) {
        const sg = ctx.scheduled.find((s) => s.game_id === game.id) ||
          ctx.scheduled.find((s) => [nickOf(s.team_a), nickOf(s.team_b)].sort().join("|") ===
            [nickOf(game.homeTeam), nickOf(game.awayTeam)].sort().join("|"));
        const k = kickoffMs(sg);
        if (k != null && (createdAt < k - 90 * 60 * 1000 || createdAt > k + 4 * 60 * 60 * 1000)) {
          console.log(`[STREAMS] skip ${post.login}: "${post.title}" isn't near ${team}'s kickoff`);
          return;
        }
      }
    }
    // Title-only match (streamer not recognized): the title must also look like
    // an XCFL/Madden stream, or name both teams of the game.
    if (!game && (POSITIVE_RE.test(post.title) || titleTeams.size >= 2)) {
      game = gameFromTitle(titleTeams, ctx.weekGames);
      if (game) {
        by = "title";
        team = [game.homeTeam, game.awayTeam].find((t) => titleTeams.has(abbrFromName(t))) || null;
        // If the streamer is a known member, keep their own team when it's in this game.
        if (who && [game.homeTeam, game.awayTeam].some((t) => nickOf(t) === nickOf(who.member.team_name))) {
          team = who.member.team_name;
        }
      }
    }
    if (!game) {
      console.log(`[STREAMS] no game for ${post.login} ("${post.title}")`);
      return;
    }

    const display = who ? memberDisplayName(who.member) : post.login || "Streamer";
    const existing = (await list("GameStream", {}, { limit: 5000 }))
      .filter((s) => s.game_id === game.id && (s.discord_message_id === message.id ||
        (s.twitch_login && s.twitch_login === post.login)));
    const sameMessage = existing.find((s) => s.discord_message_id === message.id);
    const payload = {
      game_id: game.id,
      season_number: ctx.season,
      week: ctx.week,
      team_name: team || undefined,
      url: post.url,
      platform: post.platform,
      display_name: display,
      source: "discord",
      twitch_login: post.login || undefined,
      stream_title: post.title || undefined,
      discord_message_id: message.id,
      matched_by: by,
    };

    if (sameMessage) {
      // MEE6 edits its post to update the viewer count/title: refresh the title only.
      if (sameMessage.stream_title !== payload.stream_title) {
        await updateEntity("GameStream", sameMessage.id, { stream_title: payload.stream_title });
      }
      return;
    }
    const previous = existing.sort((a, b) => Date.parse(b.live_started_at || 0) - Date.parse(a.live_started_at || 0))[0];
    const live_started_at = new Date(createdAt).toISOString();
    if (previous && createdAt - Date.parse(previous.live_started_at || 0) < NEW_SESSION_MS) {
      // Same streamer, same game, restarted the stream: keep one row, refresh it.
      await updateEntity("GameStream", previous.id, { ...payload, live_started_at: previous.live_started_at || live_started_at });
    } else if (previous) {
      await updateEntity("GameStream", previous.id, { ...payload, live_started_at });
    } else {
      await createEntity("GameStream", { ...payload, live_started_at });
    }
    console.log(`[STREAMS] ${post.login} -> ${game.awayTeam} @ ${game.homeTeam} (week ${ctx.week}, by ${by})`);
  } catch (err) {
    console.error(`[STREAMS] handler error for ${post.login}: ${err.message}`);
  } finally {
    inFlight.delete(key);
  }
}

export function startStreamWatcher(client) {
  console.log(`[STREAMS] watcher starting — channel ${CHANNEL_ID}`);
  client.on(Events.MessageCreate, (message) => {
    handleStreamMessage(message).catch((err) => console.error(`[STREAMS] ${err.message}`));
  });
  client.on(Events.MessageUpdate, (_old, message) => {
    handleStreamMessage(message).catch((err) => console.error(`[STREAMS] ${err.message}`));
  });
}

// Exported for a quick local check: node -e "import('./streamWatcher.js').then(m => ...)"
export const _test = { parsePost, teamsInTitle, matchMember, gameFromTitle, kickoffMs };
