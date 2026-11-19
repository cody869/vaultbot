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
// /survivor pick is a two-step private picker: a dropdown of that week's
// matchups, then a button per team (teams you can't pick are disabled with
// the reason). Component ids carry the week so a stale picker can never
// land a pick in a different week than the one it showed:
//   survivor:game:<week>          matchup dropdown (value = game_id)
//   survivor:team:<week>:<team>   team button
//   survivor:back:<week>          back to the matchup list
//
// Weekly results/eliminations are posted to #survivor-pool by the Vault
// itself (survivorEngine.ts), not by this bot.

import {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { invokeFunction } from "./vault.js";

const SITE = "https://xcfl-companion.com/survivor";
const last = (t) => String(t || "").trim().split(/\s+/).pop() || "";

export const survivorCommand = [
  new SlashCommandBuilder()
    .setName("survivor")
    .setDescription("XCFL Weekly Survivor Pool")
    .addSubcommand((sub) =>
      sub
        .setName("pick")
        .setDescription("Make or change this week's Survivor pick: choose a matchup, then a team")
    )
    .addSubcommand((sub) => sub.setName("mine").setDescription("Your pick, your used teams and what's still open")),
];

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
      const o = await call(interaction, { action: "options" });
      await interaction.editReply(matchupView(o));
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

// --- the pick flow ---------------------------------------------------------

function shortReason(why) {
  return /used/i.test(why) ? "used" : /opponent/i.test(why) ? "your opponent"
    : /force win/i.test(why) ? "force win" : /played/i.test(why) ? "played"
      : /lock/i.test(why) ? "locked" : "unavailable";
}

// Week, lock and current-pick lines shared by both steps.
function headerLines(o) {
  const lock = o.lock_at ? `<t:${Math.floor(Date.parse(o.lock_at) / 1000)}:F>` : `the Week ${o.week - 1} advance`;
  return [
    o.mode === "repick"
      ? `**Week ${o.week} re-pick** — a force win hit your game. Pick any game that hasn't been played.`
      : `**Week ${o.week} Survivor pick** · locks ${lock}`,
    o.pick?.team ? `Current pick: **${last(o.pick.team)}** vs ${last(o.pick.opponent)}` : "Current pick: **none yet**",
  ];
}

// Anything that stops the picker before step 1, or null if it can run.
function cannotPick(o) {
  if (o?.error) return o.error;
  const e = o.entry || {};
  if (e.status === "eliminated") return `You were eliminated in Week ${e.eliminated_week}.`;
  if (e.status === "ineligible") return "You're sitting out this season (new owner).";
  if (e.status === "winner") return "You already won the Survivor Pool.";
  if (!o.week) return "No week is open for Survivor picks right now.";
  if (!o.slate?.length) return `No Week ${o.week} games are on the schedule yet.`;
  return null;
}

const plain = (content) => ({ content, components: [] });

/** Step 1: the week's matchups in a dropdown. */
function matchupView(o) {
  const blocked = cannotPick(o);
  if (blocked) return plain(blocked);

  const options = o.slate.slice(0, 25).map((g) => {
    const mine = o.pick?.team && (o.pick.team === g.away || o.pick.team === g.home);
    const status = mine
      ? `Your pick: ${last(o.pick.team)}`
      : g.played ? "Played"
        : [[g.away, g.away_blocked], [g.home, g.home_blocked]]
          .map(([t, why]) => `${last(t)} ${why ? `(${shortReason(why)})` : "open"}`).join(" · ");
    return {
      label: `${g.away} @ ${g.home}`.slice(0, 100),
      description: status.slice(0, 100),
      value: String(g.game_id),
      default: !!mine,
    };
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`survivor:game:${o.week}`)
    .setPlaceholder("Choose a matchup")
    .addOptions(options);
  return {
    content: [...headerLines(o), "", "**Step 1:** choose a matchup."].join("\n"),
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

/** Step 2: one button per team in the chosen game, plus Back. */
function teamView(o, gameId) {
  const blocked = cannotPick(o);
  if (blocked) return plain(blocked);
  const g = o.slate.find((x) => String(x.game_id) === String(gameId));
  if (!g) return matchupView(o); // game no longer on the slate -> start over

  const button = (team, why) => new ButtonBuilder()
    .setCustomId(`survivor:team:${o.week}:${team}`.slice(0, 100))
    .setLabel((why ? `${last(team)} (${shortReason(why)})` : last(team)).slice(0, 80))
    .setStyle(o.pick?.team === team ? ButtonStyle.Success : ButtonStyle.Primary)
    .setDisabled(!!why);
  const back = new ButtonBuilder()
    .setCustomId(`survivor:back:${o.week}`)
    .setLabel("Back to matchups")
    .setStyle(ButtonStyle.Secondary);

  const open = [g.away_blocked, g.home_blocked].some((why) => !why);
  return {
    content: [
      ...headerLines(o), "",
      `**Step 2:** ${g.away} @ ${g.home} — ${open ? "who wins?" : "neither team is available to you. Go back and choose another matchup."}`,
    ].join("\n"),
    components: [new ActionRowBuilder().addComponents(button(g.away, g.away_blocked), button(g.home, g.home_blocked), back)],
  };
}

/** Buttons and the dropdown from the picker (custom ids start "survivor:"). */
export async function handleSurvivorComponent(interaction) {
  const [, kind, weekRaw, ...rest] = interaction.customId.split(":");
  const week = Number(weekRaw);
  await interaction.deferUpdate();
  try {
    if (kind === "game") {
      const o = await call(interaction, { action: "options", week });
      await interaction.editReply(teamView(o, interaction.values?.[0]));
      return;
    }
    if (kind === "back") {
      const o = await call(interaction, { action: "options", week });
      await interaction.editReply(matchupView(o));
      return;
    }
    if (kind === "team") {
      const team = rest.join(":");
      const res = await call(interaction, { action: "pick", team, week });
      if (res?.error) {
        const back = new ButtonBuilder().setCustomId(`survivor:back:${week}`).setLabel("Back to matchups").setStyle(ButtonStyle.Secondary);
        await interaction.editReply({
          content: `Pick not saved: ${res.error}`,
          components: [new ActionRowBuilder().addComponents(back)],
        });
        return;
      }
      await interaction.editReply(plain(
        `${res.message}\nYou can change it until the week locks — run \`/survivor pick\` again or use <${SITE}>.`
      ));
      // Public, but without the team: picks stay hidden until the lock.
      await interaction.followUp({
        content: `**${interaction.member?.displayName || interaction.user.username}** ${res.repick ? "made a re-pick" : `has a Week ${res.week} pick in`}.`,
        allowed_mentions: { parse: [] },
      }).catch(() => null);
    }
  } catch (err) {
    console.error("[survivor] picker failed:", err.message);
    await interaction.editReply(plain(`Something went wrong: ${err.message}`)).catch(() => null);
  }
}
