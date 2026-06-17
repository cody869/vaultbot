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
          { name: "Passing", value: "passing" },
          { name: "Rushing", value: "rushing" },
          { name: "Receiving", value: "receiving" },
          { name: "Defense (sacks)", value: "defense" }
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
