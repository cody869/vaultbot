// survivorCommands.js — /survivor pick|mine for the XCFL Weekly Survivor Pool.
//
// Picks live in the Vault (SurvivorPick). Every path here ends in
// invokeFunction("survivorPick", {...}), which checks every rule server-side
// (used teams, your opponent, known force wins, the lock at the advance) --
// the same function the Survivor page on the Vault uses, so a pick made here
// shows up there and vice versa.
//
// The bot logs in as a normal Vault user, so it proves it's the bot with
// INTERNAL_FUNCTION_SECRET (same value as the Base44 secret of that name) and
// names the Discord user; the Vault maps them to their LeagueMember by
// discord_user_id.
//
// Picks are hidden until the week locks, so the pick itself is confirmed
// privately (ephemeral) and the channel only sees "X has a Week N pick in".
//
// Weekly results/eliminations are posted to #survivor-pool by the Vault
// itself (survivorEngine.ts), not by this bot.

import { SlashCommandBuilder } from "discord.js";
import { invokeFunction } from "./vault.js";

const TEAMS = [
  "Arizona Cardinals", "Atlanta Falcons", "Baltimore Ravens", "Buffalo Bills", "Carolina Panthers",
  "Chicago Bears", "Cincinnati Bengals", "Cleveland Browns", "Dallas Cowboys", "Denver Broncos",
  "Detroit Lions", "Green Bay Packers", "Houston Texans", "Indianapolis Colts", "Jacksonville Jaguars",
  "Kansas City Chiefs", "Las Vegas Raiders", "Los Angeles Chargers", "Los Angeles Rams", "Miami Dolphins",
  "Minnesota Vikings", "New England Patriots", "New Orleans Saints", "New York Giants", "New York Jets",
  "Philadelphia Eagles", "Pittsburgh Steelers", "San Francisco 49ers", "Seattle Seahawks",
  "Tampa Bay Buccaneers", "Tennessee Titans", "Washington Commanders",
];
const SITE = "https://xcfl-companion.com/survivor";
const last = (t) => String(t || "").trim().split(/\s+/).pop() || "";

export const survivorCommand = [
  new SlashCommandBuilder()
    .setName("survivor")
    .setDescription("XCFL Weekly Survivor Pool")
    .addSubcommand((sub) =>
      sub
        .setName("pick")
        .setDescription("Make or change this week's Survivor pick")
        .addStringOption((o) =>
          o.setName("team").setDescription("The team you think wins this week").setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand((sub) => sub.setName("mine").setDescription("Your pick, your used teams and what's still open")),
];

// Static list, filtered locally: autocomplete has 3 seconds and every Vault
// call costs credits, so nothing is fetched per keystroke. The Vault rejects
// anything that isn't allowed when the pick is submitted.
export function suggestSurvivorTeams(focused) {
  const q = String(focused || "").toLowerCase();
  return TEAMS.filter((t) => !q || t.toLowerCase().includes(q))
    .slice(0, 25)
    .map((t) => ({ name: t, value: t }));
}

async function call(interaction, payload) {
  const secret = process.env.INTERNAL_FUNCTION_SECRET;
  if (!secret) return { error: "Survivor isn't set up on the bot yet (INTERNAL_FUNCTION_SECRET missing)." };
  return invokeFunction("survivorPick", {
    ...payload,
    discord_user_id: interaction.user.id,
    internal_secret: secret,
  });
}

export async function handleSurvivorCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand();

  try {
    if (sub === "pick") {
      const team = interaction.options.getString("team", true);
      const res = await call(interaction, { action: "pick", team });
      if (res?.error) {
        await interaction.editReply(`Pick not saved: ${res.error}`);
        return;
      }
      await interaction.editReply(
        `${res.message}\nYou can change it until the week locks — run \`/survivor pick\` again or use <${SITE}>.`
      );
      // Public, but without the team: picks stay hidden until the lock.
      await interaction.followUp({
        content: `**${interaction.member?.displayName || interaction.user.username}** ${res.repick ? "made a re-pick" : `has a Week ${res.week} pick in`}.`,
        allowed_mentions: { parse: [] },
      }).catch(() => null);
      return;
    }

    if (sub === "mine") {
      const o = await call(interaction, { action: "options" });
      if (o?.error) {
        await interaction.editReply(o.error);
        return;
      }
      const lines = [];
      const e = o.entry || {};
      if (e.status === "eliminated") lines.push(`You were eliminated in Week ${e.eliminated_week}.`);
      else if (e.status === "ineligible") lines.push("You're sitting out this season (new owner).");
      else if (e.status === "winner") lines.push("You won the Survivor Pool.");
      if (o.week && e.status === "alive") {
        const lock = o.lock_at ? `<t:${Math.floor(Date.parse(o.lock_at) / 1000)}:F>` : `the Week ${o.week - 1} advance`;
        lines.push(
          o.mode === "repick"
            ? `**Week ${o.week} re-pick open** — a force win hit your game. Pick any game that hasn't been played.`
            : `**Week ${o.week}** · locks ${lock}`
        );
        lines.push(o.pick?.team ? `Your pick: **${last(o.pick.team)}** vs ${last(o.pick.opponent)}` : "Your pick: **none yet** — no pick by the lock means you're out.");
        const open = [];
        const blocked = [];
        for (const g of o.slate || []) {
          for (const [team, why] of [[g.away, g.away_blocked], [g.home, g.home_blocked]]) {
            if (why) {
              const short = /used/i.test(why) ? "used" : /opponent/i.test(why) ? "your opponent"
                : /force win/i.test(why) ? "force win" : /played/i.test(why) ? "played" : "n/a";
              blocked.push(`${last(team)} (${short})`);
            }
            else open.push(last(team));
          }
        }
        lines.push(`Available: ${open.join(", ") || "—"}`);
        if (blocked.length) lines.push(`-# Not available: ${blocked.join(", ")}`);
      }
      if (o.used?.length) lines.push(`Used: ${o.used.map(last).join(", ")}`);
      lines.push(`Full board: <${SITE}>`);
      await interaction.editReply(lines.join("\n").slice(0, 1990));
    }
  } catch (err) {
    console.error("[survivor] command failed:", err.message);
    await interaction.editReply(`Something went wrong: ${err.message}`).catch(() => null);
  }
}
