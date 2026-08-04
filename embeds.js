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

function base(title) {
  return new EmbedBuilder()
    .setColor(VAULT_COLOR)
    .setTitle(title)
    .setURL(VAULT_URL)
    .setFooter({ text: "XCFL Vault" })
    .setTimestamp();
}

export function standingsEmbed({ season, rows }) {
  const e = base(`📊 Standings — Season ${season ?? "?"}`);
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
  const e = base(`🏈 ${label} Leaders — Season ${season ?? "?"}`);
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
  const e = base(`🔥 Power Rankings — ${week ?? "Latest"}`);
  if (!rows.length) return e.setDescription("No power rankings posted yet.");

  const lines = rows.slice(0, 32).map((r) => {
    let move = "";
    if (r.previous_rank && r.previous_rank !== r.rank) {
      const diff = r.previous_rank - r.rank;
      move = diff > 0 ? ` 🔺${diff}` : ` 🔻${Math.abs(diff)}`;
    }
    const logo = r.team_name ? `${teamEmojiByName(r.team_name)} ` : "";
    return `\`${String(r.rank).padStart(2)}\` ${logo}**${r.username}**${move}`;
  });
  return e.setDescription(lines.join("\n"));
}

export function tradeBlockEmbed({ team, entries }) {
  // Team-specific title with helmet; otherwise the league-wide block.
  const title = team
    ? `${teamEmojiByName(team)} ${team} — Trade Block`
    : "🔁 Trade Block";
  const e = base(title);

  // Set URL to the trade-block page
  e.setURL(`${VAULT_URL}/trade-block`);

  if (!entries.length) {
    return e.setDescription(
      team
        ? `**${team}** has nothing on the block right now.`
        : "Nothing on the block right now."
    );
  }

  // Group entries by team for cleaner display
  const byTeam = {};
  entries.slice(0, 25).forEach((t) => {
    if (!byTeam[t.team_name]) byTeam[t.team_name] = [];
    byTeam[t.team_name].push(t);
  });

  // Add fields for each team's entries
  for (const teamName of Object.keys(byTeam).sort()) {
    const teamEntries = byTeam[teamName];
    const lines = teamEntries.map((t) => {
      if (t.entry_type === "pick") {
        return `**${t.pick_label ?? "Pick"}**${t.pick_notes ? ` *(${t.pick_notes})*` : ""}`;
      }

      const ovr = t.player_ovr ? ` ${t.player_ovr} OVR` : "";
      const tradeValue = t.trade_value ? ` • TV: ${t.trade_value}` : "";
      return `**${t.player_fullName}** (${t.player_position ?? "?"}${ovr}${tradeValue})`;
    });

    const logo = teamEmojiByName(teamName);
    e.addFields({
      name: `${logo} ${teamName}`,
      value: lines.join("\n"),
      inline: false,
    });
  }

  return e;
}

// Shown when a team filter matches nothing — lists teams that do have entries.
export function tradeBlockNoTeamEmbed(query, teams) {
  const e = base(`🔍 No trade block for "${query}"`);
  return e.setDescription(
    teams.length
      ? "Teams with entries on the block:\n" +
          teams.map((t) => `${teamEmojiByName(t)} ${t}`).join("\n")
      : "No teams have anything on the block right now."
  );
}

export function tradesEmbed(trades) {
  const e = base("📑 Recent Trades");
  if (!trades.length) return e.setDescription("No trades found.");

  for (const t of trades.slice(0, 8)) {
    const t1 = [...(t.team1_players ?? []), ...(t.team1_picks ?? [])].join(", ") || "—";
    const t2 = [...(t.team2_players ?? []), ...(t.team2_picks ?? [])].join(", ") || "—";
    const badge =
      { approved: "✅", rejected: "❌", vetoed: "🚫", pending: "⏳" }[t.status] ?? "•";
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

// Season-total lines for one season across the four stat entities.
function seasonStatLines(season, stats) {
  const parts = [];
  const pass = stats.passing.find((r) => r.season_number === season);
  const rush = stats.rushing.find((r) => r.season_number === season);
  const rec = stats.receiving.find((r) => r.season_number === season);
  const def = stats.defense.find((r) => r.season_number === season);
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
    const { season = null, weeks = [] } = data.weekly ?? {};
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
    const stats = data.season ?? { passing: [], rushing: [], receiving: [], defense: [] };
    const seasons = [
      ...new Set(
        [...stats.passing, ...stats.rushing, ...stats.receiving, ...stats.defense]
          .map((r) => r.season_number)
          .filter((s) => s != null)
      ),
    ].sort((a, b) => b - a);

    out.push("");
    out.push("**Season Stats**");
    if (!seasons.length) {
      out.push("> No season stats on file for this player.");
    } else {
      for (const s of seasons.slice(0, 8)) {
        const parts = seasonStatLines(s, stats);
        if (!parts.length) continue;
        out.push(`> **Season ${s}** — ${parts.join(" • ")}`);
      }
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
    return base(`🔍 No player found for "${name}"`).setDescription(
      "No players matched. Check the spelling or try a first name."
    );
  }
  const e = base(`🔍 Multiple players match "${name}"`);
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
  const e = base(`🏟️ Scores — Season ${season ?? "?"}, Week ${week ?? "?"}`);
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
