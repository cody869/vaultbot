// index.js — the XCFL Vault Discord bot.
import "dotenv/config";
import { Client, GatewayIntentBits, Events } from "discord.js";
import { loadEmoji } from "./emoji.js";
import {
  getStandings,
  getStatLeaders,
  getPowerRankings,
  getTradeBlock,
  getTradeBlockTeams,
  getTrades,
  getPlayer,
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
} from "./embeds.js";

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment. See README.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`✅ XCFL Vault bot online as ${c.user.tag}`);
  loadEmoji(c);
});

client.on(Events.InteractionCreate, async (interaction) => {
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
        const name = interaction.options.getString("name");
        const { match, others } = await getPlayer(name);
        if (!match) {
          await interaction.editReply({
            embeds: [playerChoicesEmbed(name, others)],
          });
          break;
        }
        const team = await getRosterFor(match.player_fullName);
        await interaction.editReply({ embeds: [playerEmbed(match, team)] });
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
