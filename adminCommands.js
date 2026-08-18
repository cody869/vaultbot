// adminCommands.js — Discord slash commands for franchise commissioner
// actions (boot/admin/cap-penalty/autopilot/force-result).
//
// index.js already calls interaction.deferReply() before the command
// switch — everything here uses editReply(), matching eaCommands.js.

import { SlashCommandBuilder } from "discord.js";
import { getConnectedClient } from "./eaTokenStore.js";
import { getMemberByDiscordId, memberDisplayName } from "./vault.js";

// Reuses the same allowlist /export and /ea-status already gate on — these
// are all "can touch the live EA league" actions, so one list covers all of
// them. Not gated with setDefaultMemberPermissions(ManageGuild) for the same
// reason as eaCommands.js: that hides the command outright from a
// commissioner who isn't a server admin.
function isAuthorized(interaction) {
  const allowed = (process.env.EA_ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length) return false;
  return allowed.includes(interaction.user.id);
}

async function denied(interaction) {
  const configured = Boolean((process.env.EA_ADMIN_IDS || "").trim());
  console.log(`[ADMIN] denied ${interaction.commandName} for ${interaction.user.tag} (${interaction.user.id})`);
  await interaction.editReply(
    configured
      ? "That command is limited to the league's export admins."
      : "Admin commands aren't enabled yet — set EA_ADMIN_IDS to your Discord user id."
  );
}

export const adminCommandBuilder = new SlashCommandBuilder()
  .setName("admin")
  .setDescription("League commissioner actions (restricted)")
  .addSubcommand((sub) =>
    sub
      .setName("boot-user")
      .setDescription("Remove a member from the league")
      .addUserOption((o) => o.setName("member").setDescription("Discord user to boot").setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName("add-admin")
      .setDescription("Grant in-game commissioner rights")
      .addUserOption((o) => o.setName("member").setDescription("Discord user to promote").setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove-admin")
      .setDescription("Revoke in-game commissioner rights")
      .addUserOption((o) => o.setName("member").setDescription("Discord user to demote").setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName("clear-cap-penalties")
      .setDescription("Clear a team's salary cap penalties")
      .addUserOption((o) => o.setName("member").setDescription("Team owner").setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName("toggle-autopilot")
      .setDescription("Toggle a member's autopilot status")
      .addUserOption((o) => o.setName("member").setDescription("Discord user").setRequired(true))
      .addIntegerOption((o) => o.setName("timeout").setDescription("Action timeout in seconds (0 = default)"))
  )
  .addSubcommand((sub) =>
    sub
      .setName("force-home-win")
      .setDescription("Force the home team to win a scheduled game")
      .addIntegerOption((o) => o.setName("season_game_key").setDescription("Game's seasonGameKey").setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName("force-away-win")
      .setDescription("Force the away team to win a scheduled game")
      .addIntegerOption((o) => o.setName("season_game_key").setDescription("Game's seasonGameKey").setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName("force-no-win")
      .setDescription("Clear a forced result back to normal")
      .addIntegerOption((o) => o.setName("season_game_key").setDescription("Game's seasonGameKey").setRequired(true))
  );

// Resolve a Discord user -> Blaze userId via the league's own admin data
// (userAdminHubInfo.userInfoMap, keyed by Blaze userId). Matches on
// team_name first (most reliable), falling back to username.
function findBlazeUserId(userInfoMap, member) {
  for (const [userId, info] of Object.entries(userInfoMap)) {
    if (info.teamName === member.team_name) return Number(userId);
  }
  for (const [userId, info] of Object.entries(userInfoMap)) {
    if (info.userName === member.username) return Number(userId);
  }
  return null;
}

async function resolveTarget(interaction) {
  const discordUser = interaction.options.getUser("member");
  const member = await getMemberByDiscordId(discordUser.id);
  if (!member) {
    throw new Error(`<@${discordUser.id}> isn't linked to a league member.`);
  }
  const { client, leagueId } = await getConnectedClient();
  const leagueInfo = await client.getLeagueInfo(leagueId);
  const blazeUserId = findBlazeUserId(leagueInfo.userAdminHubInfo.userInfoMap, member);
  if (blazeUserId == null) {
    throw new Error(`Couldn't match ${memberDisplayName(member)} to a Blaze user id in this league.`);
  }
  return { client, leagueId, member, blazeUserId };
}

export async function handleAdminCommand(interaction) {
  if (!isAuthorized(interaction)) return denied(interaction);

  const sub = interaction.options.getSubcommand();
  console.log(`[ADMIN] /admin ${sub} by ${interaction.user.tag}`);

  try {
    switch (sub) {
      case "boot-user": {
        const { client, leagueId, member, blazeUserId } = await resolveTarget(interaction);
        await client.bootUser(leagueId, blazeUserId);
        await interaction.editReply(`Booted **${memberDisplayName(member)}** from the league.`);
        break;
      }
      case "add-admin": {
        const { client, leagueId, member, blazeUserId } = await resolveTarget(interaction);
        await client.addAdmin(leagueId, blazeUserId);
        await interaction.editReply(`Granted commissioner rights to **${memberDisplayName(member)}**.`);
        break;
      }
      case "remove-admin": {
        const { client, leagueId, member, blazeUserId } = await resolveTarget(interaction);
        await client.removeAdmin(leagueId, blazeUserId);
        await interaction.editReply(`Revoked commissioner rights from **${memberDisplayName(member)}**.`);
        break;
      }
      case "clear-cap-penalties": {
        const { client, leagueId, member, blazeUserId } = await resolveTarget(interaction);
        await client.clearCapPenalties(leagueId, blazeUserId);
        await interaction.editReply(`Cleared cap penalties for **${memberDisplayName(member)}**'s team.`);
        break;
      }
      case "toggle-autopilot": {
        const { client, leagueId, member, blazeUserId } = await resolveTarget(interaction);
        const timeout = interaction.options.getInteger("timeout") ?? 0;
        await client.toggleAutoPilot(leagueId, blazeUserId, timeout);
        await interaction.editReply(`Toggled autopilot for **${memberDisplayName(member)}**.`);
        break;
      }
      case "force-home-win":
      case "force-away-win":
      case "force-no-win": {
        const { client, leagueId } = await getConnectedClient();
        const seasonGameKey = interaction.options.getInteger("season_game_key");
        if (sub === "force-home-win") await client.forceHomeWin(leagueId, seasonGameKey);
        if (sub === "force-away-win") await client.forceAwayWin(leagueId, seasonGameKey);
        if (sub === "force-no-win") await client.forceNoWin(leagueId, seasonGameKey);
        await interaction.editReply(`Updated result for game ${seasonGameKey}.`);
        break;
      }
    }
  } catch (err) {
    console.error(`[ADMIN] ${sub} failed:`, err);
    const hint = err.troubleshoot ? `\n> ${err.troubleshoot}` : "";
    await interaction.editReply(`${err.message || "That didn't work."}${hint}`);
  }
}
