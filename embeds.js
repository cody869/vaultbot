// embeds.js — turns Vault data into pretty Discord embeds.
import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { teamEmoji, teamEmojiByName, devEmoji } from "./emoji.js";

const VAULT_COLOR = 0x1d4ed8; // XCFL blue
const VAULT_URL = process.env.VAULT_PUBLIC_URL || "https://xcfl-companion.com";

function fmtMoney(m) {
  if (m == null) return "—";
  const n = Number(m);
  // Values arrive in raw dollars (e.g. 1130000) — show as $1.13M.
  // If a value is already small (< 1000) assume it's already in millions.
  const millions = n >= 1000 ? n / 1_000_000 : n;
  return `$${millions.toFixed(2)}M`;
}

// Usernames in some entities are email addresses. Never render one.
function looksLikeEmail(v) {
  return /\S+@\S+\.\S+/.test(String(v ?? ""));
}

// Pick the first safe, non-email name from the candidates given.
function safeName(...candidates) {
  for (const c of candidates) {
    if (c && !looksLikeEmail(c)) return String(c);
  }
  return "Unknown member";
}

function base(title) {
  return new EmbedBuilder()
    .setColor(VAULT_COLOR)
    .setTitle(title)
    .setURL(VAULT_URL)
    .setFooter({ text: "XCFL Vault" })
    .setTimestamp();
}

export function standingsEmbed({ season, rows }) {
  const e = base(`Standings — Season ${season ?? "?"}`);
  if (!rows.length) return e.setDescription("No standings data found.");

  const lines = rows.slice(0, 32).map((r, i) => {
    const rec = `${r.wins ?? 0}-${r.losses ?? 0}${r.ties ? "-" + r.ties : ""}`;
    const team = r.team_name ?? "";
    const logo = teamEmojiByName(team);
    return `\`${String(i + 1).padStart(2)}\` ${logo} **${rec}**  ${team}`;
  });
  return e.setDescription(lines.join("\n"));
}

export function statLeadersEmbed({ label, field, season, leaders }) {
  const e = base(`${label} Leaders — Season ${season ?? "?"}`);
  if (!leaders.length) return e.setDescription("No stats found.");

  const lines = leaders.map((p, i) => {
    const raw = p[field] ?? 0;
    // Sacks come as decimals (e.g. 0.5); show one decimal only when needed.
    const val = Number.isInteger(raw) ? raw.toLocaleString() : raw.toFixed(1);
    const team = p.team_abbrName ?? "";
    const logo = teamEmoji(team);
    return `\`${String(i + 1).padStart(2)}\` ${logo} **${val}**  ${p.player_fullName} *(${team})*`;
  });
  return e.setDescription(lines.join("\n"));
}

export function powerRankingsEmbed({ week, rows }) {
  const e = base(`Power Rankings — ${week ?? "Latest"}`);
  if (!rows.length) return e.setDescription("No power rankings posted yet.");

  const lines = rows.slice(0, 32).map((r) => {
    let move = "";
    if (r.previous_rank && r.previous_rank !== r.rank) {
      const diff = r.previous_rank - r.rank;
      move = diff > 0 ? ` +${diff}` : ` -${Math.abs(diff)}`;
    }
    const logo = r.team_name ? `${teamEmojiByName(r.team_name)} ` : "";
    // PowerRanking carries a denormalized display_name; username may be an email.
    const who = safeName(r.display_name, r.username, r.team_name && `${r.team_name} owner`);
    return `\`${String(r.rank).padStart(2)}\` ${logo}**${who}**${move}`;
  });
  return e.setDescription(lines.join("\n"));
}

// Trade block — plain markdown message matching the /player card style.
// Returns a message payload; pass it straight to editReply.
export function tradeBlockEmbed({ team, entries }) {
  const out = [];

  if (team) {
    out.push(`# ${teamEmojiByName(team)} ${team}`);
    out.push(`### Trade Block`);
  } else {
    out.push(`# Trade Block`);
  }

  if (!entries.length) {
    out.push("");
    out.push(
      team
        ? `**${team}** has nothing on the block right now.`
        : "Nothing on the block right now."
    );
    out.push("");
    out.push(`-# [View on XCFL Vault](<${VAULT_URL}/trade-block>)`);
    return { content: out.join("\n"), embeds: [], components: [] };
  }

  // Group by team so each franchise gets its own headed section.
  const byTeam = new Map();
  for (const t of entries) {
    const key = t.team_name ?? "—";
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(t);
  }

  const totalPlayers = entries.filter((t) => t.entry_type !== "pick").length;
  const totalPicks = entries.filter((t) => t.entry_type === "pick").length;
  const summary = [
    totalPlayers ? `${totalPlayers} player${totalPlayers === 1 ? "" : "s"}` : null,
    totalPicks ? `${totalPicks} pick${totalPicks === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (summary) out.push(`**${summary}** across ${byTeam.size} team${byTeam.size === 1 ? "" : "s"}`);

  let shown = 0;
  let truncated = false;

  for (const [teamName, items] of [...byTeam.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    // Players first (highest OVR first), then picks.
    const players = items
      .filter((t) => t.entry_type !== "pick")
      .sort((a, b) => (b.player_ovr ?? 0) - (a.player_ovr ?? 0));
    const picks = items.filter((t) => t.entry_type === "pick");

    const lines = [];

    for (const t of players) {
      const url = `${VAULT_URL}/players/${encodeURIComponent(t.player_fullName)}`;
      const meta = [
        t.player_position ?? "?",
        t.player_ovr != null ? `${t.player_ovr} OVR` : null,
        t.trade_value != null ? `TV ${t.trade_value}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      // Angle brackets stop Discord unfurling a preview for each link.
      lines.push(`> [**${t.player_fullName}**](<${url}>) — ${meta}`);
      shown++;
    }

    for (const t of picks) {
      const notes = t.pick_notes ? ` *(${t.pick_notes})*` : "";
      lines.push(`> **${t.pick_label ?? "Pick"}**${notes}`);
      shown++;
    }

    if (!lines.length) continue;

    const block = [``, `**${teamEmojiByName(teamName)} ${teamName}**`, ...lines];
    // Keep room for the footer line before Discord's 2000-char ceiling.
    if (out.join("\n").length + block.join("\n").length > 1850) {
      truncated = true;
      break;
    }
    out.push(...block);
  }

  if (truncated) {
    out.push("");
    out.push(`-# …and more — ${entries.length - shown} entries not shown.`);
  }

  out.push("");
  out.push(`-# [View the full trade block](<${VAULT_URL}/trade-block>)`);

  let content = out.join("\n");
  if (content.length > 2000) content = content.slice(0, 1997) + "…";

  return { content, embeds: [], components: [] };
}

// Shown when a team filter matches nothing — lists teams that do have entries.
export function tradeBlockNoTeamEmbed(query, teams) {
  const e = base(`No trade block for "${query}"`);
  return e.setDescription(
    teams.length
      ? "Teams with entries on the block:\n" +
          teams.map((t) => `${teamEmojiByName(t)} ${t}`).join("\n")
      : "No teams have anything on the block right now."
  );
}

export function tradesEmbed(trades) {
  const e = base("Recent Trades");
  if (!trades.length) return e.setDescription("No trades found.");

  for (const t of trades.slice(0, 8)) {
    const t1 = [...(t.team1_players ?? []), ...(t.team1_picks ?? [])].join(", ") || "—";
    const t2 = [...(t.team2_players ?? []), ...(t.team2_picks ?? [])].join(", ") || "—";
    const badge =
      { approved: "✅", rejected: "❌", vetoed: "[vetoed]", pending: "[pending]" }[t.status] ?? "";
    e.addFields({
      name: `${badge} ${teamEmojiByName(t.team1)} ${t.team1} ↔ ${teamEmojiByName(t.team2)} ${t.team2}`,
      value: `**${t.team1} send:** ${t1}\n**${t.team2} send:** ${t2}`,
    });
  }
  return e;
}

// ===== /player card =====================================================
// Rendered as a plain markdown message (not an embed) so it can use a large
// `#` heading and block-quoted sections, matching the snallabot look.

// Every rating we know how to show: [label, data key].
const ALL_RATINGS = [
  ["Speed", "spd"], ["Accel", "acc"], ["Agility", "agi"], ["Awareness", "awa"],
  ["Injury", "inj"], ["Break Tackle", "breakTackle"], ["Carrying", "carry"],
  ["BC Vision", "ballCarryVision"], ["Truck", "trucking"], ["Stiff Arm", "stiffArm"],
  ["Juke Move", "jukeMove"], ["Spin Move", "spinMove"], ["COD", "changeOfDir"],
  ["Strength", "str"], ["Throw Power", "throwPower"], ["Short Acc", "shortAcc"],
  ["Mid Acc", "midAcc"], ["Deep Acc", "deepAcc"], ["Catch", "catch"],
  ["Spec Catch", "specCatch"], ["Release", "release"], ["Short Route", "shortRouteRun"],
  ["Tackle", "tackle"], ["Hit Power", "hitPower"], ["Pursuit", "pursuit"],
  ["Man Cov", "manCoverage"], ["Zone Cov", "zoneCoverage"], ["Press", "press"],
  ["Block Shed", "blockShed"], ["Power Moves", "powerMoves"], ["Finesse Moves", "finesseMoves"],
  ["Pass Block", "passBlock"], ["Run Block", "runBlock"], ["Kick Power", "kickPower"],
  ["Kick Acc", "kickAcc"], ["Play Recog", "playRecog"], ["Jump", "jmp"],
];

// Which rating keys matter for each position group, in display order.
const POSITION_RATINGS = {
  QB: ["throwPower", "shortAcc", "midAcc", "deepAcc", "awa", "playRecog", "spd", "acc", "agi", "breakTackle", "str", "inj"],
  RB: ["spd", "acc", "agi", "changeOfDir", "carry", "ballCarryVision", "breakTackle", "trucking", "stiffArm", "jukeMove", "spinMove", "catch", "str", "awa", "inj"],
  WR: ["spd", "acc", "agi", "changeOfDir", "catch", "specCatch", "release", "shortRouteRun", "jukeMove", "carry", "jmp", "breakTackle", "awa", "inj"],
  TE: ["spd", "acc", "agi", "catch", "specCatch", "release", "shortRouteRun", "runBlock", "passBlock", "str", "breakTackle", "jmp", "awa", "inj"],
  OL: ["passBlock", "runBlock", "str", "awa", "playRecog", "acc", "agi", "spd", "inj"],
  DL: ["blockShed", "powerMoves", "finesseMoves", "tackle", "pursuit", "hitPower", "str", "spd", "acc", "agi", "playRecog", "awa", "inj"],
  LB: ["tackle", "hitPower", "pursuit", "blockShed", "powerMoves", "finesseMoves", "manCoverage", "zoneCoverage", "playRecog", "spd", "acc", "agi", "str", "awa", "inj"],
  CB: ["manCoverage", "zoneCoverage", "press", "spd", "acc", "agi", "changeOfDir", "catch", "jmp", "tackle", "playRecog", "awa", "inj"],
  S:  ["zoneCoverage", "manCoverage", "tackle", "hitPower", "pursuit", "spd", "acc", "agi", "catch", "jmp", "playRecog", "awa", "inj"],
  K:  ["kickPower", "kickAcc", "awa", "inj"],
};

// Map a Madden position string to one of the groups above.
function positionGroup(posRaw) {
  const pos = String(posRaw ?? "").toUpperCase();
  if (pos === "QB") return "QB";
  if (["HB", "RB", "FB"].includes(pos)) return "RB";
  if (pos === "WR") return "WR";
  if (pos === "TE") return "TE";
  if (["LT", "LG", "C", "RG", "RT", "OL", "OT", "OG"].includes(pos)) return "OL";
  if (["LE", "RE", "DT", "DE", "EDGE", "LEDGE", "REDGE", "DL"].includes(pos)) return "DL";
  if (["MLB", "LOLB", "ROLB", "OLB", "ILB", "LB"].includes(pos)) return "LB";
  if (pos === "CB") return "CB";
  if (["FS", "SS", "S"].includes(pos)) return "S";
  if (["K", "P"].includes(pos)) return "K";
  return null;
}

// Ratings to show on the Overview tab: position-relevant only, and only the
// ones this player actually has. Falls back to the first 14 present.
function relevantRatings(p) {
  const group = positionGroup(p.player_position);
  const keys = group ? POSITION_RATINGS[group] : null;
  if (keys) {
    const labelOf = Object.fromEntries(ALL_RATINGS.map(([l, k]) => [k, l]));
    const picked = keys
      .filter((k) => p[k] != null)
      .map((k) => [labelOf[k] ?? k, k]);
    if (picked.length) return picked;
  }
  return ALL_RATINGS.filter(([, k]) => p[k] != null).slice(0, 14);
}

// Render [label, key] pairs two per line, block-quoted.
function ratingLines(p, pairs) {
  const out = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pairs[i];
    const b = pairs[i + 1];
    let line = `> **${a[0]}:** ${p[a[1]]}`;
    if (b) line += ` | **${b[0]}:** ${p[b[1]]}`;
    out.push(line);
  }
  return out;
}

const VIEW_LABELS = {
  overview: "Overview",
  ratings: "Full Ratings",
  weekly: "Weekly Stats",
  season: "Season Stats",
};

// The Overview / Full Ratings / Weekly / Season picker under the card.
function playerViewRow(playerId, view) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`player_view:${playerId}`)
    .setPlaceholder(VIEW_LABELS[view] ?? "Overview")
    .addOptions(
      Object.entries(VIEW_LABELS).map(([value, label]) => ({
        label,
        value,
        default: value === view,
      }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

// Header shared by every view: big title, OVR, bio line.
function playerHeader(p, teamName) {
  const pos = p.player_position ?? "?";
  const gem = devEmoji(p.player_devTrait);
  const out = [];
  out.push(`# ${teamEmojiByName(teamName)} ${pos} ${p.player_fullName}`);
  out.push(`### ${gem} ${p.player_ovr ?? "?"} OVR`);

  const bits = [];
  if (p.player_age != null) bits.push(`${p.player_age} yrs`);
  if (p.player_yrsPro != null) {
    const s = p.player_yrsPro + 1;
    const suffix = s === 1 ? "st" : s === 2 ? "nd" : s === 3 ? "rd" : "th";
    bits.push(`${s}${suffix} Season`);
  }
  let heightStr = p.player_height;
  if (heightStr != null && /^\d+$/.test(String(heightStr).trim())) {
    const inches = parseInt(heightStr, 10);
    heightStr = `${Math.floor(inches / 12)}'${inches % 12}"`;
  }
  const hw = [heightStr, p.player_weight ? `${p.player_weight} lbs` : null]
    .filter(Boolean)
    .join(", ");
  if (hw) bits.push(hw);
  if (bits.length) out.push(`**${bits.join(" | ")}**`);
  return out;
}

// One stat line from a WeeklyStats row — only the categories with activity.
function weeklyStatLine(w) {
  const parts = [];
  if (w.pass_att || w.pass_yds || w.pass_tds) {
    parts.push(
      `${w.pass_comp ?? 0}/${w.pass_att ?? 0}, ${w.pass_yds ?? 0} yds, ${w.pass_tds ?? 0} TD, ${w.pass_ints ?? 0} INT`
    );
  }
  if (w.rush_att || w.rush_yds || w.rush_tds) {
    parts.push(`${w.rush_att ?? 0} car, ${w.rush_yds ?? 0} yds, ${w.rush_tds ?? 0} TD`);
  }
  if (w.rec_catches || w.rec_yds || w.rec_tds) {
    parts.push(`${w.rec_catches ?? 0} rec, ${w.rec_yds ?? 0} yds, ${w.rec_tds ?? 0} TD`);
  }
  if (w.def_total_tackles || w.def_sacks || w.def_ints) {
    parts.push(
      `${w.def_total_tackles ?? 0} tkl, ${w.def_sacks ?? 0} sk, ${w.def_ints ?? 0} INT`
    );
  }
  return parts.join(" • ");
}

// Season-total lines for one merged season row:
// { season, gamesPlayed, passing?, rushing?, receiving?, defense? }
function seasonStatLines(row) {
  const parts = [];
  const pass = row.passing;
  const rush = row.rushing;
  const rec = row.receiving;
  const def = row.defense;
  if (pass) {
    parts.push(
      `Pass: ${pass.passTotalComp ?? 0}/${pass.passTotalAtt ?? 0}, ${pass.passTotalYds ?? 0} yds, ${pass.passTotalTDs ?? 0} TD, ${pass.passTotalInts ?? 0} INT`
    );
  }
  if (rush) {
    parts.push(
      `Rush: ${rush.rushTotalAtt ?? 0} car, ${rush.rushTotalYds ?? 0} yds, ${rush.rushTotalTDs ?? 0} TD`
    );
  }
  if (rec) {
    parts.push(
      `Rec: ${rec.recTotalCatches ?? 0} rec, ${rec.recTotalYds ?? 0} yds, ${rec.recTotalTDs ?? 0} TD`
    );
  }
  if (def) {
    parts.push(
      `Def: ${def.defTotalTackles ?? 0} tkl, ${def.defTotalSacks ?? 0} sk, ${def.defTotalInts ?? 0} INT`
    );
  }
  return parts;
}

// Build the /player message for a given view.
//   view  — "overview" | "ratings" | "weekly" | "season"
//   data  — { weekly, season } as needed by the weekly/season views
// Returns a message payload; pass it straight to editReply/update.
export function playerEmbed(p, team = null, view = "overview", data = {}) {
  const teamName = team?.team_name ?? p.team_name ?? "";
  const playerUrl = `${VAULT_URL}/players/${encodeURIComponent(p.player_fullName)}`;
  const out = playerHeader(p, teamName);

  if (view === "overview") {
    const cl = p.player_contractLength;
    const yl = p.player_contractYrsLeft;
    const lengthStr =
      cl != null && yl != null ? `${yl}/${cl} yrs` : cl != null ? `${cl} yrs` : "—";
    out.push("");
    out.push("**Contract**");
    out.push(`> **Length**: ${lengthStr} | **Salary**: ${fmtMoney(p.player_contractSalary)}`);
    out.push(`> **Cap Hit**: ${fmtMoney(p.player_capHit)} | **Bonus**: ${fmtMoney(p.player_contractBonus)}`);
    out.push(`> **Savings**: ${fmtMoney(p.player_capSavings)} | **Penalty**: ${fmtMoney(p.player_capPenalty)}`);

    const pairs = relevantRatings(p);
    if (pairs.length) {
      out.push("");
      out.push("**Key Ratings**");
      out.push(...ratingLines(p, pairs));
    }

    if (Array.isArray(p.abilities) && p.abilities.length) {
      const names = p.abilities.map((a) => a.title).filter(Boolean).join(", ");
      if (names) {
        out.push("");
        out.push(`**Abilities:** ${names}`);
      }
    }
  }

  if (view === "ratings") {
    const pairs = ALL_RATINGS.filter(([, k]) => p[k] != null);
    out.push("");
    out.push("**Full Ratings**");
    if (pairs.length) out.push(...ratingLines(p, pairs));
    else out.push("> No ratings on file.");
  }

  if (view === "weekly") {
    const { season = null, weeks: allWeeks = [] } = data.weekly ?? {};
    // Newest weeks first; cap so we stay under Discord's 2000-char limit.
    const weeks = allWeeks.slice(0, 12);
    out.push("");
    out.push(`**Weekly Stats${season != null ? ` — Season ${season}` : ""}**`);
    if (!weeks.length) {
      out.push("> No weekly stats on file for this player.");
    } else {
      let any = false;
      for (const w of weeks) {
        const line = weeklyStatLine(w);
        if (!line) continue;
        any = true;
        out.push(`> **Wk ${w.week_index ?? "?"}** — ${line}`);
      }
      if (!any) out.push("> No recorded stats in these weeks.");
    }
  }

  if (view === "season") {
    // getPlayerSeasonStats returns rows sorted newest season first.
    const rows = Array.isArray(data.season) ? data.season : [];
    out.push("");
    out.push("**Season Stats**");
    if (!rows.length) {
      out.push("> No season stats on file for this player.");
    } else {
      let any = false;
      for (const row of rows.slice(0, 8)) {
        const parts = seasonStatLines(row);
        if (!parts.length) continue;
        any = true;
        const gp = row.gamesPlayed ? ` (${row.gamesPlayed} GP)` : "";
        out.push(`> **Season ${row.season}**${gp} — ${parts.join(" • ")}`);
      }
      if (!any) out.push("> No recorded stats in these seasons.");
    }
  }

  // Angle brackets around the URL stop Discord from unfurling a link preview.
  out.push("");
  out.push(`-# [View on XCFL Vault](<${playerUrl}>)`);

  let content = out.join("\n");
  if (content.length > 2000) content = content.slice(0, 1997) + "…";

  return {
    content,
    embeds: [],
    components: [playerViewRow(p.id, view)],
  };
}

// When a name is ambiguous, list the alternatives.
export function playerChoicesEmbed(name, matches) {
  if (!matches.length) {
    return base(`No player found for "${name}"`).setDescription(
      "No players matched. Check the spelling or try a first name."
    );
  }
  const e = base(`Multiple players match "${name}"`);
  const lines = matches.slice(0, 15).map((p) => {
    const gem = devEmoji(p.player_devTrait);
    const team = p.team_abbrName ? ` — ${p.team_abbrName}` : "";
    return `${gem} **${p.player_fullName}** (${p.player_position ?? "?"}, ${p.player_ovr ?? "?"} OVR${team})`;
  });
  const more = matches.length > 15 ? `\n…and ${matches.length - 15} more.` : "";
  return e.setDescription(
    "Did you mean one of these? Search the full name:\n" + lines.join("\n") + more
  );
}

// Scores for a week — each game as "Team SCORE vs SCORE Team" with helmets and
// the winner bolded. No home/away or status distinction.
export function scoresEmbed({ season, week, games }) {
  const e = base(`Scores — Season ${season ?? "?"}, Week ${week ?? "?"}`);
  if (!games.length) return e.setDescription("No games found for that week.");

  const lines = games.map((g) => {
    const e1 = teamEmojiByName(g.home);
    const e2 = teamEmojiByName(g.away);
    const oneWon = g.homeScore > g.awayScore;
    const twoWon = g.awayScore > g.homeScore;
    const t1 = oneWon ? `**${g.home} ${g.homeScore}**` : `${g.home} ${g.homeScore}`;
    const t2 = twoWon ? `**${g.awayScore} ${g.away}**` : `${g.awayScore} ${g.away}`;
    return `${e1} ${t1}  vs  ${t2} ${e2}`;
  });
  return e.setDescription(lines.join("\n"));
}

// ===== /compare, /team, /rivalry, /myteam ================================

// Ratings worth comparing, by position group — reuses the /player mapping.
function comparableRatings(a, b) {
  const groupA = positionGroup(a.player_position);
  const groupB = positionGroup(b.player_position);
  // Same position group -> that group's keys. Mixed -> shared athletic core.
  const keys =
    groupA && groupA === groupB
      ? POSITION_RATINGS[groupA]
      : ["spd", "acc", "agi", "str", "awa", "inj", "playRecog"];
  const labelOf = Object.fromEntries(ALL_RATINGS.map(([l, k]) => [k, l]));
  return keys
    .filter((k) => a[k] != null || b[k] != null)
    .slice(0, 12)
    .map((k) => [labelOf[k] ?? k, k]);
}

// Side-by-side player comparison. Rendered inside a fenced code block so
// Discord uses a monospace font — the only way to get true column alignment,
// since Discord markdown has no table support.
const CMP_LABEL_W = 13; // stat label column
const CMP_VAL_W = 9;    // each player's value column
const CMP_MARK_W = 3;   // the center column holding < or >

// Generational suffixes are not surnames — "Patrick Surtain II" should
// shorten to "Surtain", not "II".
const NAME_SUFFIXES = new Set([
  "jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v", "vi",
]);

// Short, column-friendly name: surname, clipped to the column width.
function shortName(fullName) {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  let i = parts.length - 1;
  while (i > 0 && NAME_SUFFIXES.has(parts[i].toLowerCase())) i--;
  return parts[i].slice(0, CMP_VAL_W);
}

// One aligned row. The left value is right-aligned and the right value is
// left-aligned, so both hug the centre marker and each value clearly belongs
// to the player named above its column.
function cmpRow(label, a, b, { compare = true } = {}) {
  const left = a == null || a === "" ? "—" : String(a);
  const right = b == null || b === "" ? "—" : String(b);

  let mark = "   ";
  if (compare && typeof a === "number" && typeof b === "number") {
    if (a > b) mark = " < ";
    else if (b > a) mark = " > ";
  }

  return (
    String(label).slice(0, CMP_LABEL_W).padEnd(CMP_LABEL_W) +
    left.slice(0, CMP_VAL_W).padStart(CMP_VAL_W) +
    mark +
    right.slice(0, CMP_VAL_W).padEnd(CMP_VAL_W)
  ).trimEnd();
}

// Placeholder — real width is computed once every row is built, so the rule
// matches the widest line instead of overrunning it.
const CMP_DIV = "\u0000DIV\u0000";
function cmpDivider() {
  return CMP_DIV;
}

export function compareEmbed(a, b, teamA = null, teamB = null, values = {}) {
  const nameA = a.player_fullName;
  const nameB = b.player_fullName;
  const logoA = teamEmojiByName(teamA?.team_name ?? a.team_name ?? "");
  const logoB = teamEmojiByName(teamB?.team_name ?? b.team_name ?? "");
  const samePos = a.player_position === b.player_position;

  const out = [];
  out.push(`# ${nameA} vs ${nameB}`);
  out.push(
    `### ${logoA} ${devEmoji(a.player_devTrait)} ${a.player_ovr ?? "?"} OVR ` +
      `**vs** ${logoB} ${devEmoji(b.player_devTrait)} ${b.player_ovr ?? "?"} OVR`
  );
  if (!samePos) {
    out.push(
      `*${a.player_position ?? "?"} vs ${b.player_position ?? "?"} — different positions, comparing athletic traits*`
    );
  }

  // Everything below lives in one monospace block so the columns line up.
  const rows = [];

  // Header: player names over their own columns.
  rows.push(
    (
      "".padEnd(CMP_LABEL_W) +
      shortName(nameA).padStart(CMP_VAL_W) +
      "".padEnd(CMP_MARK_W) +
      shortName(nameB).padEnd(CMP_VAL_W)
    ).trimEnd()
  );
  rows.push(cmpDivider());

  // Core profile
  rows.push(cmpRow("Overall", a.player_ovr, b.player_ovr));
  rows.push(cmpRow("Position", a.player_position, b.player_position, { compare: false }));
  rows.push(cmpRow("Age", a.player_age, b.player_age, { compare: false }));
  if (a.player_yrsPro != null || b.player_yrsPro != null) {
    rows.push(
      cmpRow(
        "Season",
        a.player_yrsPro != null ? a.player_yrsPro + 1 : null,
        b.player_yrsPro != null ? b.player_yrsPro + 1 : null,
        { compare: false }
      )
    );
  }
  rows.push(
    cmpRow("Dev Trait", a.player_devTrait, b.player_devTrait, { compare: false })
  );

  // Contract
  rows.push(cmpDivider());
  rows.push(
    cmpRow(
      "Yrs Left",
      a.player_contractYrsLeft,
      b.player_contractYrsLeft,
      { compare: false }
    )
  );
  rows.push(
    cmpRow("Cap Hit", fmtMoney(a.player_capHit), fmtMoney(b.player_capHit), {
      compare: false,
    })
  );
  rows.push(
    cmpRow("Salary", fmtMoney(a.player_contractSalary), fmtMoney(b.player_contractSalary), {
      compare: false,
    })
  );

  // Trade value, when the engine is available.
  if (values.a != null || values.b != null) {
    rows.push(cmpDivider());
    rows.push(cmpRow("Trade Value", values.a, values.b));
  }

  // Ratings
  const pairs = comparableRatings(a, b);
  if (pairs.length) {
    rows.push(cmpDivider());
    for (const [label, key] of pairs) {
      rows.push(cmpRow(label, a[key], b[key]));
    }
  }

  // Size the dividers to the widest actual row.
  const width = Math.max(
    ...rows.filter((r) => r !== CMP_DIV).map((r) => r.length)
  );
  const ruled = rows.map((r) => (r === CMP_DIV ? "-".repeat(width) : r));

  out.push("```");
  out.push(ruled.join("\n"));
  out.push("```");
  out.push(`-# \`<\` favors ${shortName(nameA)} · \`>\` favors ${shortName(nameB)}`);

  out.push(
    `-# [${nameA}](<${VAULT_URL}/players/${encodeURIComponent(nameA)}>) · ` +
      `[${nameB}](<${VAULT_URL}/players/${encodeURIComponent(nameB)}>)`
  );

  let content = out.join("\n");
  if (content.length > 2000) content = content.slice(0, 1994) + "…\n```";
  return { content, embeds: [], components: [] };
}

// Team card — record, owner, cap, top roster, trade block.
export function teamEmbed(data) {
  if (!data.found) {
    const out = [`# No team matching "${data.query}"`, ""];
    if (data.teams?.length) {
      out.push("**Try one of these:**");
      out.push(data.teams.map((t) => `${teamEmojiByName(t)} ${t}`).join("\n").slice(0, 1500));
    }
    return { content: out.join("\n"), embeds: [], components: [] };
  }

  const { teamName, owner, record, roster, block, cap } = data;
  const out = [];
  out.push(`# ${teamEmojiByName(teamName)} ${teamName}`);

  if (record) {
    const rec = `${record.wins ?? 0}-${record.losses ?? 0}${record.ties ? `-${record.ties}` : ""}`;
    const seed = record.seed ? ` · #${record.seed} seed` : "";
    out.push(`### ${rec}${seed}${record.season != null ? ` · Season ${record.season}` : ""}`);
  }
  if (owner) out.push(`**Owner:** ${owner}`);

  if (cap) {
    const bits = [];
    if (cap.grade != null) bits.push(`Grade **${cap.grade}**`);
    if (cap.cap_ecs2026 != null) bits.push(`Cap space **$${cap.cap_ecs2026}M**`);
    if (cap.draft_score != null) bits.push(`Draft **${cap.draft_score}**`);
    if (bits.length) {
      out.push("");
      out.push("**Outlook**");
      out.push(`> ${bits.join(" · ")}`);
    }
  }

  const top = roster.filter((r) => r.player_ovr != null).slice(0, 8);
  if (top.length) {
    out.push("");
    out.push(`**Top Players** *(${roster.length} on roster)*`);
    for (const r of top) {
      const url = `${VAULT_URL}/players/${encodeURIComponent(r.player_fullName)}`;
      out.push(
        `> [**${r.player_fullName}**](<${url}>) — ${r.player_position ?? "?"} · ${r.player_ovr} OVR`
      );
    }
  }

  if (block?.length) {
    const players = block.filter((e) => e.entry_type !== "pick");
    const picks = block.filter((e) => e.entry_type === "pick");
    out.push("");
    out.push("**On the Trade Block**");
    for (const e of players.slice(0, 5)) {
      out.push(`> ${e.player_fullName} — ${e.player_position ?? "?"} · ${e.player_ovr ?? "?"} OVR`);
    }
    for (const e of picks.slice(0, 3)) out.push(`> ${e.pick_label ?? "Pick"}`);
    const extra = block.length - Math.min(players.length, 5) - Math.min(picks.length, 3);
    if (extra > 0) out.push(`-# …and ${extra} more`);
  }

  out.push("");
  out.push(`-# [View on XCFL Vault](<${VAULT_URL}/trade-block>)`);

  let content = out.join("\n");
  if (content.length > 2000) content = content.slice(0, 1997) + "…";
  return { content, embeds: [], components: [] };
}

// Head-to-head record between two league members.
export function rivalryEmbed(r) {
  if (!r) {
    return {
      content: "Could not build that rivalry — check both usernames.",
      embeds: [],
      components: [],
    };
  }

  // Usernames can be email addresses — always render the safe display name.
  const n1 = r.display1 ?? r.user1;
  const n2 = r.display2 ?? r.user2;

  const total = (r.user1_wins ?? 0) + (r.user2_wins ?? 0) + (r.ties ?? 0);
  const out = [];
  out.push(`# ${n1} vs ${n2}`);

  if (!total) {
    out.push("");
    out.push("These two have never played each other.");
    return { content: out.join("\n"), embeds: [], components: [] };
  }

  out.push(`### ${r.user1_wins}–${r.user2_wins}${r.ties ? `–${r.ties}` : ""}`);

  const leader =
    r.user1_wins > r.user2_wins
      ? `**${n1}** leads the all-time series`
      : r.user2_wins > r.user1_wins
        ? `**${n2}** leads the all-time series`
        : "All square";
  out.push(`${leader} · ${total} meeting${total === 1 ? "" : "s"}`);

  if (r.games?.length) {
    out.push("");
    out.push("**Recent Meetings**");
    for (const g of r.games) {
      const label = [
        g.season != null ? `S${g.season}` : null,
        g.week != null ? `W${g.week}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const aWon = g.aScore > g.bScore;
      const bWon = g.bScore > g.aScore;
      const left = aWon ? `**${g.aScore}**` : `${g.aScore}`;
      const right = bWon ? `**${g.bScore}**` : `${g.bScore}`;
      out.push(`> ${label} — ${n1} ${left} – ${right} ${n2}`);
    }
  }

  if (r.source === "games") {
    out.push("");
    out.push("-# Tallied live from game history.");
  }

  let content = out.join("\n");
  if (content.length > 2000) content = content.slice(0, 1997) + "…";
  return { content, embeds: [], components: [] };
}

// Shown when a Discord account isn't linked to a league member.
export function notLinkedEmbed(discordTag) {
  const out = [
    "# Account not linked",
    "",
    `Your Discord account (**${discordTag}**) isn't linked to a league member yet.`,
    "",
    "An admin can link it by setting **discord_user_id** on your LeagueMember record in the Vault.",
    "",
    `-# [Open XCFL Vault](<${VAULT_URL}>)`,
  ];
  return { content: out.join("\n"), embeds: [], components: [] };
}
