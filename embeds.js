// embeds.js — turns Vault data into pretty Discord embeds.
import { EmbedBuilder } from "discord.js";
import { teamEmoji, teamEmojiByName, devEmoji } from "./emoji.js";

const VAULT_COLOR = 0x1d4ed8; // XCFL blue
const VAULT_URL = "https://app.base44.com/apps/69d09944c8636f39abaa7ef0";

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

export function statLeadersEmbed({ label, season, leaders }) {
  const e = base(`🏈 ${label} Leaders — Season ${season ?? "?"}`);
  if (!leaders.length) return e.setDescription("No stats found.");

  const field =
    label === "Sacks"
      ? "defTotalSacks"
      : label === "Pass Yds"
      ? "passTotalYds"
      : label === "Rush Yds"
      ? "rushTotalYds"
      : "recTotalYds";

  const lines = leaders.map((p, i) => {
    const val = p[field] ?? 0;
    const team = p.team_abbrName ?? "";
    const logo = teamEmoji(team);
    return `\`${String(i + 1).padStart(2)}\` ${logo} **${val.toLocaleString()}**  ${p.player_fullName} *(${team})*`;
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

  if (!entries.length) {
    return e.setDescription(
      team
        ? `**${team}** has nothing on the block right now.`
        : "Nothing on the block right now."
    );
  }

  const lines = entries.slice(0, 25).map((t) => {
    const logo = teamEmojiByName(t.team_name);
    if (t.entry_type === "pick") {
      return `${logo} 📋 **${t.pick_label ?? "Pick"}** — ${t.team_name}${t.pick_notes ? ` *(${t.pick_notes})*` : ""}`;
    }
    const ovr = t.player_ovr ? ` ${t.player_ovr} OVR` : "";
    return `${logo} **${t.player_fullName}** (${t.player_position ?? "?"}${ovr}) — ${t.team_name}`;
  });
  return e.setDescription(lines.join("\n"));
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

// Full player card — mirrors the snallabot "player get" layout.
// `team` is an optional Roster row giving team_abbrName for the helmet/header.
export function playerEmbed(p, team = null) {
  const abbr = team?.team_abbrName ?? p.team_abbrName ?? "";
  const teamName = team?.team_name ?? "";
  const pos = p.player_position ?? "?";
  const gem = devEmoji(p.player_devTrait);

  const e = base(`${teamEmoji(abbr)} ${pos} ${p.player_fullName}`).setDescription(
    `${gem} **${p.player_ovr ?? "?"} OVR**`
  );

  // Bio line: age | season | height, weight
  const bits = [];
  if (p.player_age != null) bits.push(`${p.player_age} yrs`);
  if (p.player_yrsPro != null) {
    const s = p.player_yrsPro + 1;
    const suffix = s === 1 ? "st" : s === 2 ? "nd" : s === 3 ? "rd" : "th";
    bits.push(`${s}${suffix} Season`);
  }
  // Height may be inches ("73") or already formatted ("6'1\""). Normalize.
  let heightStr = p.player_height;
  if (heightStr != null && /^\d+$/.test(String(heightStr).trim())) {
    const inches = parseInt(heightStr, 10);
    heightStr = `${Math.floor(inches / 12)}'${inches % 12}"`;
  }
  const hw = [heightStr, p.player_weight ? `${p.player_weight} lbs` : null]
    .filter(Boolean)
    .join(", ");
  if (hw) bits.push(hw);
  if (bits.length) e.addFields({ name: "\u200b", value: `**${bits.join(" | ")}**` });

  // Contract block
  const cl = p.player_contractLength;
  const yl = p.player_contractYrsLeft;
  const lengthStr = cl != null && yl != null ? `${yl}/${cl} yrs` : cl != null ? `${cl} yrs` : "—";
  e.addFields({
    name: "Contract",
    value:
      `**Length**: ${lengthStr} | **Salary**: ${fmtMoney(p.player_contractSalary)}\n` +
      `**Cap Hit**: ${fmtMoney(p.player_capHit)} | **Bonus**: ${fmtMoney(p.player_contractBonus)}\n` +
      `**Savings**: ${fmtMoney(p.player_capSavings)} | **Penalty**: ${fmtMoney(p.player_capPenalty)}`,
  });

  // Ratings — show the most relevant attributes that are present, two per line.
  const RATINGS = [
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
  const present = RATINGS.filter(([, k]) => p[k] != null);
  if (present.length) {
    const lines = [];
    for (let i = 0; i < present.length; i += 2) {
      const a = present[i];
      const b = present[i + 1];
      let line = `**${a[0]}:** ${p[a[1]]}`;
      if (b) line += ` | **${b[0]}:** ${p[b[1]]}`;
      lines.push(line);
    }
    e.addFields({ name: "Ratings", value: lines.join("\n").slice(0, 1024) });
  }

  // Abilities
  if (Array.isArray(p.abilities) && p.abilities.length) {
    const names = p.abilities.map((a) => a.title).filter(Boolean).join(", ");
    if (names) e.addFields({ name: "Abilities", value: names });
  }

  return e;
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
    "Did you mean one of these? Search the full name:\n" +
      lines.join("\n") +
      more
  );
}
