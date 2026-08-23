// index.js — the XCFL Vault Discord bot.
import "dotenv/config";
import { Client, GatewayIntentBits, Events } from "discord.js";
import { loadEmoji } from "./emoji.js";
import { registerCommands } from "./deploy-commands.js";
import { startScheduler } from "./scheduler.js";
import { startTradeFlow, handleTradeComponent, suggestTeams } from "./tradeflow.js";
import { handleTradeVote, startTradeWatcher } from "./tradeVoting.js";
import { startNewsWatcher, handleNews } from "./news.js";
import { startScorebugWatcher } from "./scorebugWatcher.js";
import { startScheduleWatcher } from "./scheduleWatcher.js";
import { startSuspensionWatcher } from "./suspensionWatcher.js";
import { handleAdminCommand, suggestForceWinGames, suggestAdminTeams, handleForceWinButton } from "./adminCommands.js";
import { startEAWatcher, stopEAWatcher } from "./eaWatcher.js";
import { handleExportComponent } from "./eaCommands.js";
import {
  handleFantasyCommand,
  handleFantasyAutocomplete,
  startDraftWatcher,
  announceWeek,
} from "./fantasyCommands.js";
import { startFantasyWatcher } from "./fantasyLeague.js";
import { warmDraftPool } from "./fantasyDraft.js";
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
  getPlayerWeeklyStats,
  getPlayerSeasonStats,
  getTeamOverview,
  getRivalry,
  getMemberByDiscordId,
  getMemberByIdOrUsername,
  memberDisplayName,
  suggestMembers,
  playerTradeValue,
  warmPlayerCache,
  botLogin,
} from "./vault.js";
import {
  standingsEmbed,
  statLeadersView,
  powerRankingsEmbed,
  tradeBlockEmbed,
  tradeBlockNoTeamEmbed,
  tradesEmbed,
  playerEmbed,
  playerChoicesEmbed,
  scoresEmbed,
  compareEmbed,
  teamEmbed,
  rivalryEmbed,
  notLinkedEmbed,
} from "./embeds.js";

if (!process.env.DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment. See README.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ XCFL Vault bot online as ${c.user.tag}`);
  // Authenticate to Base44 first (needed once the app requires login).
  await botLogin();
  // Always re-register on startup so the registered commands match this code
  // (including autocomplete and option changes). Discord replaces the full set.
  await registerCommands();
  await loadEmoji(c);
  // Warm the player cache before anyone can type — Discord gives autocomplete
  // only 3 seconds, which a cold 10k-row fetch cannot meet.
  await warmPlayerCache();
  // Keep it warm so a refresh never lands in the middle of a keystroke.
  setInterval(() => {
    warmPlayerCache().catch(() => {});
  }, 240_000);
  // Same 3-second autocomplete deadline applies to /fantasy pick and
  // /fantasy queue — warm the draft pool too (no-ops when no draft is live).
  await warmDraftPool().catch((err) => console.error('[fantasy] pool warm-up failed:', err.message));
  setInterval(() => {
    warmDraftPool().catch(() => {});
  }, 240_000);
  startScheduler(c);
  // Trade/news/scorebug/suspension each fire an immediate, unstaged
  // full-collection "seed" read the moment they start (confirmed live: a
  // 429 'App entity read traffic volume limit exceeded' hit FantasyLeague,
  // Game, TradeSubmission, Suspension, NewsArticle, LeagueMember, and
  // ScorebugPost all within the same second after a restart). Calling them
  // back-to-back with no gap means every restart re-creates that same
  // thundering herd. Staggering the START of each by a few seconds spreads
  // those seed reads out instead of piling them onto one instant — the
  // watchers themselves are unchanged, this only delays when each one's
  // first read fires. startEAWatcher/startDraftWatcher/startFantasyWatcher
  // already have their own internal first-tick delays (30s/20s/30s) and
  // don't need this.
  setTimeout(() => startTradeWatcher(c), 0);
  setTimeout(() => startNewsWatcher(c), 5_000);
  setTimeout(() => startScorebugWatcher(c), 10_000);
  startScheduleWatcher(c); // event-driven only (message listeners), no seed read
  // Posts approved 70/30 Rule suspensions to SUSPENSIONS_CHANNEL_ID once each,
  // tagging the affected owner. No-ops if that env var is unset.
  setTimeout(() => startSuspensionWatcher(c), 15_000);
  // Keeps the EA tokens alive (the refresh chain dies after ~10 days idle)
  // and, if EA_AUTO_EXPORT=true, exports when the league actually changes.
  startEAWatcher();
  // Fantasy: 60s clock pings + autopicks during the draft; 10m scoring pass
  // that finds the earliest unscored week and posts results once it is final.
  startDraftWatcher(c);
  startFantasyWatcher(c, {
    onWeekScored: (league, week, result) => announceWeek(c, league, week, result),
  });
});

// Reject instead of hanging forever if a Vault read stalls.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

// Fetch whatever extra data a /player view needs, then render it.
async function renderPlayerView(player, team, view) {
  const data = {};
  if (view === "weekly") {
    console.log(`[PLAYER] fetching weekly stats for ${player.player_fullName}`);
    data.weekly = await withTimeout(
      getPlayerWeeklyStats(player.player_fullName),
      20_000,
      "Weekly stats"
    );
    console.log(`[PLAYER] weekly rows: ${data.weekly?.weeks?.length ?? 0}`);
  } else if (view === "season") {
    console.log(`[PLAYER] fetching season stats for ${player.player_fullName}`);
    data.season = await withTimeout(
      getPlayerSeasonStats(player.player_fullName),
      20_000,
      "Season stats"
    );
    console.log(`[PLAYER] season rows: ${Array.isArray(data.season) ? data.season.length : 0}`);
  }
  const payload = playerEmbed(player, team, view, data);
  console.log(
    `[PLAYER] built "${view}" view — ${payload.content.length} chars, ` +
      `${payload.components?.length ?? 0} component row(s)`
  );
  return payload;
}

// Remembers each user's requested leaderboard size so switching categories
// keeps their "count". Bounded so it cannot grow without limit.
const leadersCount = new Map();
function rememberedCount(userId) {
  return leadersCount.get(userId) ?? 10;
}
setInterval(() => {
  if (leadersCount.size > 500) leadersCount.clear();
}, 60 * 60 * 1000);

// The category dropdown under a stat-leaders card.
async function handleLeadersViewSelect(interaction) {
  // Edit in place rather than posting a new message.
  await interaction.deferUpdate();
  try {
    const category = interaction.values?.[0] ?? "passing_yds";
    const data = await withTimeout(
      getStatLeaders(category, rememberedCount(interaction.user.id)),
      20_000,
      "Stat leaders"
    );
    await interaction.editReply(statLeadersView({ ...data, category }));
  } catch (err) {
    console.error("Leaders view error:", err);
    try {
      await interaction.followUp({
        content: `${err.message || "Could not switch categories."}`,
        ephemeral: true,
      });
    } catch {}
  }
}

// The Overview / Full Ratings / Weekly / Season dropdown under a player card.
async function handlePlayerViewSelect(interaction) {
  // Edit the existing message in place rather than posting a new one.
  await interaction.deferUpdate();
  try {
    const playerId = interaction.customId.split(":")[1];
    const view = interaction.values?.[0] ?? "overview";
    const player = await getPlayerById(playerId);
    if (!player) {
      await interaction.editReply({
        content: "That player is no longer in the current cycle.",
        embeds: [],
        components: [],
      });
      return;
    }
    const team = await getRosterFor(player.player_fullName);
    await interaction.editReply(await renderPlayerView(player, team, view));
  } catch (err) {
    console.error("Player view error:", err);
    try {
      await interaction.followUp({
        content: `${err.message || "Could not switch views."}`,
        ephemeral: true,
      });
    } catch {}
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  // Probe: fires for EVERY interaction type before any routing happens.
  // If nothing appears here when you use a command, interactions are not
  // reaching the bot at all and the problem is upstream of this code.
  console.log(
    `[INTERACTION] type=${interaction.type} ` +
      `command=${interaction.commandName ?? "-"} ` +
      `user=${interaction.user?.tag ?? "-"}`
  );

  // Autocomplete: respond with player suggestions as the user types.
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === "player") {
      const started = Date.now();
      try {
        const focused = interaction.options.getFocused();
        const choices = await suggestPlayers(focused, 25);
        console.log(
          `[AUTOCOMPLETE] "${focused}" -> ${choices.length} choices in ${Date.now() - started}ms`
        );
        if (choices.length) {
          console.log(`[AUTOCOMPLETE] sample: ${JSON.stringify(choices[0])}`);
        }
        await interaction.respond(choices);
        console.log(`[AUTOCOMPLETE] responded OK (${Date.now() - started}ms total)`);
      } catch (err) {
        // Log the whole error — Discord's validation failures carry the detail
        // in err.rawError, not err.message.
        console.error("[AUTOCOMPLETE] failed after", Date.now() - started, "ms:", err);
        if (err.rawError) {
          console.error("[AUTOCOMPLETE] rawError:", JSON.stringify(err.rawError));
        }
        try {
          await interaction.respond([]);
        } catch {}
      }
    } else if (interaction.commandName === "compare") {
      // Both player1 and player2 use the same player suggestions.
      try {
        const focused = interaction.options.getFocused();
        await interaction.respond(await suggestPlayers(focused, 25));
      } catch (err) {
        console.error("[AUTOCOMPLETE] compare failed:", err.message);
        try {
          await interaction.respond([]);
        } catch {}
      }
    } else if (interaction.commandName === "team") {
      try {
        const focused = String(interaction.options.getFocused() ?? "");
        await interaction.respond(await suggestTeams(focused, 25));
      } catch (err) {
        console.error("[AUTOCOMPLETE] team failed:", err.message);
        try {
          await interaction.respond([]);
        } catch {}
      }
    } else if (interaction.commandName === "rivalry") {
      try {
        const focused = String(interaction.options.getFocused() ?? "");
        await interaction.respond(await suggestMembers(focused, 25));
      } catch (err) {
        console.error("[AUTOCOMPLETE] rivalry failed:", err.message);
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
    } else if (interaction.commandName === "submit_trade") {
      try {
        const focused = String(interaction.options.getFocused() ?? "");
        const choices = await suggestTeams(focused, 25);
        await interaction.respond(choices);
      } catch (err) {
        console.error("Autocomplete error:", err.message);
        try {
          await interaction.respond([]);
        } catch {}
      }
    } else if (interaction.commandName === "fantasy") {
      // Serves /fantasy pick and /fantasy queue from the cached draft pool.
      // A cold pool build can take longer than Discord's 3s autocomplete
      // window; respond() on an expired interaction then throws
      // "Unknown interaction" (10062). Every other branch here already
      // guards against that — this one didn't, so that throw went unhandled
      // and took the whole process down (a crash loop, not just a failed
      // autocomplete) until warmDraftPool kept the pool from going cold.
      try {
        await handleFantasyAutocomplete(interaction);
      } catch (err) {
        console.error("[fantasy] autocomplete crashed:", err.message);
      }
    } else if (interaction.commandName === "admin") {
      // Two different autocompletes live on this command: "team" (live EA
      // roster search) on most subcommands, "game" (matchup search) on the
      // force-win/no-win ones. Route by which option is actually focused.
      try {
        const { name, value } = interaction.options.getFocused(true);
        const focused = String(value ?? "");
        const choices = name === "game" ? await suggestForceWinGames(focused) : await suggestAdminTeams(focused);
        await interaction.respond(choices);
      } catch (err) {
        console.error("[AUTOCOMPLETE] admin failed:", err.message);
        try {
          await interaction.respond([]);
        } catch {}
      }
    }
    return;
  }

  // Player card view switcher — must be checked before the trade handler.
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId.startsWith("player_view:")
  ) {
    await handlePlayerViewSelect(interaction);
    return;
  }

  // Stat-leaders category switcher — also before the trade handler.
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId.startsWith("leaders_view:")
  ) {
    await handleLeadersViewSelect(interaction);
    return;
  }

  // Committee vote buttons — checked before the trade-builder router.
  if (interaction.isButton() && interaction.customId.startsWith("tvote:")) {
    await handleTradeVote(interaction);
    return;
  }

  // /admin export's week/data picker — also before the trade catch-all.
  if (
    (interaction.isButton() || interaction.isStringSelectMenu()) &&
    interaction.customId.startsWith("export:")
  ) {
    await handleExportComponent(interaction);
    return;
  }

  // Staff confirm/dismiss buttons for a schedule-watcher-detected forced win.
  if (interaction.isButton() && interaction.customId.startsWith("fw:")) {
    await handleForceWinButton(interaction);
    return;
  }

  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await handleTradeComponent(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // The trade builder is private to the user; everything else posts publicly.
  if (interaction.commandName === "submit_trade") {
    await interaction.deferReply({ ephemeral: true });
    await startTradeFlow(interaction);
    return;
  }

  // Subcommands whose output is only useful to the person running them
  // (a team's own draft queue, commissioner config/diagnostics, bug triage)
  // reply ephemerally instead of posting into the shared channel.
  const EPHEMERAL_SUBCOMMANDS = {
    fantasy: new Set(["queue", "setup", "config", "pause", "resume", "start", "score-week", "doctor"]),
    admin: new Set(["bug-status", "resolve-bug"]),
  };
  const ephemeralSubs = EPHEMERAL_SUBCOMMANDS[interaction.commandName];
  const isEphemeral = ephemeralSubs?.has(interaction.options.getSubcommand(false));

  // Vault calls can take a moment — defer so we don't time out (3s limit).
  await interaction.deferReply(isEphemeral ? { ephemeral: true } : undefined);

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
        // Carry the category and count so the dropdown can re-query with the
        // same size the user originally asked for.
        await interaction.editReply(
          statLeadersView({ ...data, category })
        );
        leadersCount.set(interaction.user.id, Math.min(count, 25));
        break;
      }
      case "player": {
        const input = interaction.options.getString("name");
        console.log(`[PLAYER] /player invoked with: ${input}`);

        // If the value looks like a Base44 record id (picked from the
        // autocomplete dropdown), fetch that exact player.
        const byId = await withTimeout(getPlayerById(input), 25_000, "Player lookup");
        if (byId) {
          console.log(`[PLAYER] matched by id: ${byId.player_fullName}`);
          const team = await withTimeout(
            getRosterFor(byId.player_fullName),
            15_000,
            "Roster lookup"
          );
          // playerEmbed returns a full message payload (markdown + dropdown).
          await interaction.editReply(await renderPlayerView(byId, team, "overview"));
          console.log(`[PLAYER] reply sent for ${byId.player_fullName}`);
          break;
        }

        // Otherwise treat it as a free-text name search.
        const { matches, unambiguous } = await withTimeout(
          getPlayer(input),
          25_000,
          "Player search"
        );
        console.log(`[PLAYER] name search matches: ${matches.length}, unambiguous: ${unambiguous}`);
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
        const team = await withTimeout(
          getRosterFor(match.player_fullName),
          15_000,
          "Roster lookup"
        );
        await interaction.editReply(await renderPlayerView(match, team, "overview"));
        console.log(`[PLAYER] reply sent for ${match.player_fullName}`);
        break;
      }
      case "compare": {
        const in1 = interaction.options.getString("player1");
        const in2 = interaction.options.getString("player2");
        console.log(`[COMPARE] ${in1} vs ${in2}`);

        // Autocomplete sends record ids; fall back to a name search.
        const resolve = async (input) => {
          const byId = await getPlayerById(input);
          if (byId) return byId;
          const { matches } = await getPlayer(input);
          return matches[0] ?? null;
        };

        const [p1, p2] = await Promise.all([resolve(in1), resolve(in2)]);
        if (!p1 || !p2) {
          const missing = !p1 ? in1 : in2;
          await interaction.editReply(
            `Couldn't find a player matching **${missing}** — pick from the dropdown for an exact match.`
          );
          break;
        }
        if (p1.id && p1.id === p2.id) {
          await interaction.editReply("Pick two different players to compare.");
          break;
        }

        const [team1, team2] = await Promise.all([
          getRosterFor(p1.player_fullName),
          getRosterFor(p2.player_fullName),
        ]);
        const values = { a: playerTradeValue(p1), b: playerTradeValue(p2) };
        await interaction.editReply(compareEmbed(p1, p2, team1, team2, values));
        break;
      }
      case "team": {
        let query = interaction.options.getString("team");
        if (!query) {
          // No team named — fall back to the caller's own linked team.
          const member = await getMemberByDiscordId(interaction.user.id);
          if (!member) {
            console.log(`[TEAM] no LeagueMember linked to ${interaction.user.tag}`);
            await interaction.editReply(notLinkedEmbed(interaction.user.tag));
            break;
          }
          if (!member.team_name) {
            await interaction.editReply(
              `**${memberDisplayName(member)}** isn't assigned to a team right now.`
            );
            break;
          }
          query = member.team_name;
          console.log(`[TEAM] ${interaction.user.tag} -> ${query}`);
        } else {
          console.log(`[TEAM] lookup: ${query}`);
        }
        const data = await getTeamOverview(query);
        await interaction.editReply(teamEmbed(data));
        break;
      }
      case "rivalry": {
        // Autocomplete sends LeagueMember record ids, not usernames, so no
        // email ever travels through the interaction payload.
        const in1 = interaction.options.getString("member1");
        const in2 = interaction.options.getString("member2");

        const member1 = await getMemberByIdOrUsername(in1);
        if (!member1?.username) {
          await interaction.editReply(
            "Couldn't find that member — pick from the dropdown."
          );
          break;
        }

        // member2 is optional — default to the caller's linked member.
        let member2 = in2 ? await getMemberByIdOrUsername(in2) : null;
        if (!member2) {
          if (in2) {
            await interaction.editReply(
              "Couldn't find the second member — pick from the dropdown."
            );
            break;
          }
          member2 = await getMemberByDiscordId(interaction.user.id);
          if (!member2?.username) {
            await interaction.editReply(
              "Name a second member — your Discord isn't linked to a league member yet."
            );
            break;
          }
        }

        if (member1.username.toLowerCase() === member2.username.toLowerCase()) {
          await interaction.editReply("Pick two different members.");
          break;
        }

        // Log display names only — usernames may be emails.
        console.log(
          `[RIVALRY] ${memberDisplayName(member1)} vs ${memberDisplayName(member2)}`
        );
        // Pass the member records themselves so getRivalry can match on any
        // known identity (gamertag, discord name, alias), not just username.
        const r = await getRivalry(member1, member2);
        await interaction.editReply(rivalryEmbed(r));
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
        // tradeBlockEmbed returns a full message payload (markdown content).
        await interaction.editReply(tradeBlockEmbed(data));
        break;
      }
      case "trades": {
        const status = interaction.options.getString("status") ?? undefined;
        const data = await getTrades(status);
        await interaction.editReply({ embeds: [tradesEmbed(data)] });
        break;
      }
      case "news": {
        await handleNews(interaction);
        break;
      }
      case "admin": {
        await handleAdminCommand(interaction);
        break;
      }
      case "fantasy": {
        // Already deferred above — handleFantasyCommand only uses editReply.
        await handleFantasyCommand(interaction);
        break;
      }
      default:
        await interaction.editReply("Unknown command.");
    }
  } catch (err) {
    console.error(`[ERROR] /${interaction.commandName} failed:`, err);
    const msg = `${err.message || "Something went wrong reaching the Vault."}`;
    // editReply can itself fail (e.g. an invalid payload) — fall back to a
    // follow-up so the user never sees an endless "thinking" spinner.
    try {
      await interaction.editReply({ content: msg, embeds: [], components: [] });
    } catch (replyErr) {
      console.error("[ERROR] editReply also failed:", replyErr.message);
      try {
        await interaction.followUp({ content: msg, ephemeral: true });
      } catch (followErr) {
        console.error("[ERROR] followUp also failed:", followErr.message);
      }
    }
  }
});

// Railway sends SIGTERM when replacing a container. Close the gateway session
// cleanly so Discord doesn't keep routing interactions to a dying instance.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`👋 ${signal} received — shutting down cleanly.`);
    stopEAWatcher();
    client.destroy();
    process.exit(0);
  });
}

client.login(process.env.DISCORD_TOKEN);
