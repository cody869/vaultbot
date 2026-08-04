// embeds.js — turns Vault data into pretty Discord embeds.
import { EmbedBuilder } from "discord.js";
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
        return `📋 **${t.pick_label ?? "Pick"}**${t.pick_notes ? ` *(${t.pick_notes})*` : ""}`;
      }
      
      const ovr = t.player_ovr ? ` ${t.player_ovr} OVR` : "";
      const tradeValue = t.trade_value ? ` • TV: ${t.trade_value}` : "";
      return `**${t.player_fullName}** (${t.player_position ?? "?"}${ovr}${tradeValue})`;
    });
    
    const logo = teamEmojiByName(teamName);
    e.addFields({
      name: `${logo} ${teamName}`,
      value: lines.join("\n"),
      inline: false
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

// Full player card — snallabot-style plain-markdown message (NOT an embed).
// Uses a large `#` heading, block-quoted (`>`) Contract and Ratings sections,
// and no embed box, matching snallabot's look. Returns a message payload
// object: pass it directly to interaction.editReply(...).
export function playerEmbed(p, team = null) {
  const teamName = team?.team_name ?? p.team_name ?? "";
  const pos = p.player_position ?? "?";
  const gem = devEmoji(p.player_devTrait);
  const playerUrl = `${VAULT_URL}/players/${encodeURIComponent(p.player_fullName)}`;

  const out = [];

  // Big title with team logo, then OVR line
  out.push(`# ${teamEmojiByName(teamName)} ${pos} ${p.player_fullName}`);
  out.push(`### ${gem} ${p.player_ovr ?? "?"} OVR`);

  // Bio line: age | season | height, weight
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

  // Contract — bold header + block-quoted lines (the gray bar)
  const cl = p.player_contractLength;
  const yl = p.player_contractYrsLeft;
  const lengthStr = cl != null && yl != null ? `${yl}/${cl} yrs` : cl != null ? `${cl} yrs` : "—";
  out.push("");
  out.push("**Contract**");
  out.push(`> **Length**: ${lengthStr} | **Salary**: ${fmtMoney(p.player_contractSalary)}`);
  out.push(`> **Cap Hit**: ${fmtMoney(p.player_capHit)} | **Bonus**: ${fmtMoney(p.player_contractBonus)}`);
  out.push(`> **Savings**: ${fmtMoney(p.player_capSavings)} | **Penalty**: ${fmtMoney(p.player_capPenalty)}`);

  // Ratings — bold header + block-quoted, two per line
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
    out.push("");
    out.push("**Ratings**");
    for (let i = 0; i < present.length; i += 2) {
      const a = present[i];
      const b = present[i + 1];
      let line = `> **${a[0]}:** ${p[a[1]]}`;
      if (b) line += ` | **${b[0]}:** ${p[b[1]]}`;
      out.push(line);
    }
  }

  // Abilities — inline bold label, comma-separated
  if (Array.isArray(p.abilities) && p.abilities.length) {
    const names = p.abilities.map((a) => a.title).filter(Boolean).join(", ");
    if (names) {
      out.push("");
      out.push(`**Abilities:** ${names}`);
    }
  }

  // Footer link to the player's profile page
  out.push("");
  out.push(`-# [View on XCFL Vault](${playerUrl})`);

  // Message content caps at 2000 chars — trim safely if a player somehow exceeds it.
  let content = out.join("\n");
  if (content.length > 2000) content = content.slice(0, 1997) + "…";

  return { content, embeds: [] };
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
