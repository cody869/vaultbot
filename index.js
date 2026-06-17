// index.js — the XCFL Vault Discord bot.
import "dotenv/config";
import { Client, GatewayIntentBits, Events } from "discord.js";
import { loadEmoji } from "./emoji.js";
import { registerCommands } from "./deploy-commands.js";
import { startScheduler } from "./scheduler.js";
import {
  getStandings,
  getStatLeaders,
  getPowerRankings,
  getTradeBlock,
  getTradeBlockTeams,
  getTrades,
  getPlayer,
  getPlayerById,
  suggestPlayers,
  getScores,
  getScoreWeeks,
  getRosterFor,
} from "./vault.js";
import {
  standingsEmbed,
  statLeadersEmbed,
  powerRankingsEmbed,
  tradeBlockEmbed,
  tradeBlockNoTeamEmbed,
  tradesEmbed,
  playerEmbed,
  playerChoicesEmbed,
  scoresEmbed,
} from "./embeds.js";

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment. See README.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ XCFL Vault bot online as ${c.user.tag}`);
  // Always re-register on startup so the registered commands match this code
  // (including autocomplete and option changes). Discord replaces the full set.
  await registerCommands();
  await loadEmoji(c);
  startScheduler(c);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Autocomplete: respond with player suggestions as the user types.
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === "player") {
      try {
        const focused = interaction.options.getFocused();
        const choices = await suggestPlayers(focused, 25);
        await interaction.respond(choices);
      } catch (err) {
        console.error("Autocomplete error:", err.message);
        try {
          await interaction.respond([]);
        } catch {}
      }
    } else if (interaction.commandName === "scores") {
      try {
        const focused = String(interaction.options.getFocused() ?? "");
        const { weeks } = await getScoreWeeks();
        const choices = weeks
          .filter((w) => !focused || String(w).startsWith(focused))
          .slice(-25) // most recent 25 weeks
          .reverse()
          .map((w) => ({ name: `Week ${w}`, value: w }));
        await interaction.respond(choices);
      } catch (err) {
        console.error("Autocomplete error:", err.message);
        try {
          await interaction.respond([]);
        } catch {}
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // Vault calls can take a moment — defer so we don't time out (3s limit).
  await interaction.deferReply();

  try {
    switch (interaction.commandName) {
      case "standings": {
        const season = interaction.options.getInteger("season") ?? undefined;
        const data = await getStandings(season);
        await interaction.editReply({ embeds: [standingsEmbed(data)] });
        break;
      }
      case "leaders": {
        const category = interaction.options.getString("category");
        const count = interaction.options.getInteger("count") ?? 10;
        const data = await getStatLeaders(category, Math.min(count, 25));
        await interaction.editReply({ embeds: [statLeadersEmbed(data)] });
        break;
      }
      case "player": {
        const input = interaction.options.getString("name");

        // If the value looks like a Base44 record id (picked from the
        // autocomplete dropdown), fetch that exact player.
        const byId = await getPlayerById(input);
        if (byId) {
          const team = await getRosterFor(byId.player_fullName);
          await interaction.editReply({ embeds: [playerEmbed(byId, team)] });
          break;
        }

        // Otherwise treat it as a free-text name search.
        const { matches, unambiguous } = await getPlayer(input);
        if (!matches.length) {
          await interaction.editReply({
            embeds: [playerChoicesEmbed(input, [])],
          });
          break;
        }
        if (!unambiguous) {
          await interaction.editReply({
            embeds: [playerChoicesEmbed(input, matches)],
          });
          break;
        }
        const match = matches[0];
        const team = await getRosterFor(match.player_fullName);
        await interaction.editReply({ embeds: [playerEmbed(match, team)] });
        break;
      }
      case "scores": {
        const week = interaction.options.getInteger("week") ?? undefined;
        const season = interaction.options.getInteger("season") ?? undefined;
        const data = await getScores(week, season);
        await interaction.editReply({ embeds: [scoresEmbed(data)] });
        break;
      }
      case "power": {
        const data = await getPowerRankings();
        await interaction.editReply({ embeds: [powerRankingsEmbed(data)] });
        break;
      }
      case "tradeblock": {
        const team = interaction.options.getString("team") ?? undefined;
        const data = await getTradeBlock(team);
        // If a team was requested but nothing matched, show available teams.
        if (team && !data.entries.length) {
          const teams = await getTradeBlockTeams();
          await interaction.editReply({
            embeds: [tradeBlockNoTeamEmbed(team, teams)],
          });
          break;
        }
        await interaction.editReply({ embeds: [tradeBlockEmbed(data)] });
        break;
      }
      case "trades": {
        const status = interaction.options.getString("status") ?? undefined;
        const data = await getTrades(status);
        await interaction.editReply({ embeds: [tradesEmbed(data)] });
        break;
      }
      default:
        await interaction.editReply("Unknown command.");
    }
  } catch (err) {
    console.error(err);
    await interaction.editReply(
      `⚠️ ${err.message || "Something went wrong reaching the Vault."}`
    );
  }
});

client.login(process.env.DISCORD_TOKEN);
