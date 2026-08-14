// deploy-commands.js — registers slash commands with Discord.
// Run this once (and again whenever you change commands): npm run deploy
import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("standings")
    .setDescription("Show the current XCFL standings")
    .addIntegerOption((o) =>
      o.setName("season").setDescription("Season number (defaults to latest)")
    ),

  new SlashCommandBuilder()
    .setName("leaders")
    .setDescription("Show stat leaders")
    .addStringOption((o) =>
      o
        .setName("category")
        .setDescription("Which stat category")
        .setRequired(true)
        .addChoices(
          { name: "Passing YDs", value: "passing_yds" },
          { name: "Passing TDs", value: "passing_tds" },
          { name: "Passing INTs", value: "passing_ints" },
          { name: "Rushing YDs", value: "rushing_yds" },
          { name: "Rushing TDs", value: "rushing_tds" },
          { name: "Fumbles", value: "fumbles" },
          { name: "Receptions", value: "receptions" },
          { name: "Receiving YDs", value: "receiving_yds" },
          { name: "Receiving TDs", value: "receiving_tds" },
          { name: "Sacks", value: "sacks" },
          { name: "Defensive INTs", value: "def_ints" },
          { name: "Forced Fumbles", value: "forced_fumbles" }
        )
    )
    .addIntegerOption((o) =>
      o.setName("count").setDescription("How many to show (default 10)")
    ),

  new SlashCommandBuilder()
    .setName("player")
    .setDescription("Look up a player's card (ratings, contract, abilities)")
    .addStringOption((o) =>
      o
        .setName("name")
        .setDescription("Start typing a player name, then pick from the list")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("compare")
    .setDescription("Compare two players side by side")
    .addStringOption((o) =>
      o
        .setName("player1")
        .setDescription("First player — pick from the list")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((o) =>
      o
        .setName("player2")
        .setDescription("Second player — pick from the list")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("team")
    .setDescription("Show a team's record, roster, cap outlook, and trade block")
    .addStringOption((o) =>
      o
        .setName("team")
        .setDescription("Team name or abbreviation")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("myteam")
    .setDescription("Show your own team (requires your Discord to be linked)"),

  new SlashCommandBuilder()
    .setName("rivalry")
    .setDescription("All-time head-to-head record between two league members")
    .addStringOption((o) =>
      o
        .setName("member1")
        .setDescription("First league member")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((o) =>
      o
        .setName("member2")
        .setDescription("Second member (defaults to you)")
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("scores")
    .setDescription("Show game scores for a week")
    .addIntegerOption((o) =>
      o
        .setName("week")
        .setDescription("Week number (defaults to the latest week)")
        .setAutocomplete(true)
    )
    .addIntegerOption((o) =>
      o.setName("season").setDescription("Season number (defaults to latest)")
    ),

  new SlashCommandBuilder()
    .setName("submit_trade")
    .setDescription("Build and submit a trade step by step")
    .addStringOption((o) =>
      o
        .setName("team1")
        .setDescription("First team in the trade")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((o) =>
      o
        .setName("team2")
        .setDescription("Second team in the trade")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("power")
    .setDescription("Show the latest power rankings"),

  new SlashCommandBuilder()
    .setName("tradeblock")
    .setDescription("Show players and picks on the trade block")
    .addStringOption((o) =>
      o
        .setName("team")
        .setDescription("Filter to one team (name or abbreviation)")
    ),

  new SlashCommandBuilder()
    .setName("trades")
    .setDescription("Show recent trade submissions")
    .addStringOption((o) =>
      o
        .setName("status")
        .setDescription("Filter by status")
        .addChoices(
          { name: "Approved", value: "approved" },
          { name: "Pending", value: "pending" },
          { name: "Rejected", value: "rejected" }
        )
    ),

  new SlashCommandBuilder()
    .setName("news")
    .setDescription("Latest articles from the Vault newsroom")
    .addStringOption((o) =>
      o
        .setName("category")
        .setDescription("Filter by category")
        .addChoices(
          { name: "League News", value: "League News" },
          { name: "Team Report", value: "Team Report" },
          { name: "Analysis", value: "Analysis" },
          { name: "Recap", value: "Recap" },
          { name: "Draft", value: "Draft" },
          { name: "Trade Talk", value: "Trade Talk" },
          { name: "Interview", value: "Interview" },
          { name: "Op-Ed", value: "Op-Ed" },
          { name: "Rumor Mill", value: "Rumor Mill" },
          { name: "Announcement", value: "Announcement" },
          { name: "History", value: "History" }
        )
    )
    .addIntegerOption((o) =>
      o
        .setName("count")
        .setDescription("How many to show (1-10)")
        .setMinValue(1)
        .setMaxValue(10)
    ),

  new SlashCommandBuilder()
    .setName('bug-status')
    .setDescription('View all bug reports and their status'),

  new SlashCommandBuilder()
    .setName('resolve-bug')
    .setDescription('Resolve a bug report')
    .addStringOption(option =>
      option
        .setName('bug_id')
        .setDescription('Bug report ID (from /bug-status)')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('resolution')
        .setDescription('How was this bug fixed?')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("export")
    .setDescription("Pull a fresh Madden export from EA into the Vault")
    .addStringOption((o) =>
      o
        .setName("scope")
        .setDescription("Which weeks to pull (defaults to the current week)")
        .addChoices(
          { name: "Current week", value: "current" },
          { name: "Surrounding weeks (prev / current / next)", value: "surrounding" },
          { name: "All weeks (slow)", value: "all" }
        )
    )
    .addBooleanOption((o) =>
      o
        .setName("rosters")
        .setDescription("Also pull all 32 rosters and free agents (slow)")
    ),

  new SlashCommandBuilder()
    .setName("ea-status")
    .setDescription("Show the EA connection status"),
].map((c) => c.toJSON());

// Registers the current command set with Discord. Safe to call on every
// startup — Discord does a full replace, so it always reflects this code
// (including option changes like autocomplete). Returns true on success.
export async function registerCommands() {
  const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
    console.error("Cannot register commands: missing DISCORD_TOKEN or DISCORD_CLIENT_ID");
    return false;
  }
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const route = DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID);
  try {
    await rest.put(route, { body: commands });
    console.log(
      DISCORD_GUILD_ID
        ? "✅ Guild commands registered (instant)."
        : "✅ Global commands registered (can take up to 1 hour)."
    );
    return true;
  } catch (err) {
    console.error("Command registration failed:", err.message);
    return false;
  }
}

// Only run registration directly when invoked as `node deploy-commands.js`.
if (process.argv[1] && process.argv[1].endsWith("deploy-commands.js")) {
  registerCommands();
}
