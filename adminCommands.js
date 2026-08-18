// adminCommands.js
// Discord slash commands for the Blaze admin actions (adminActions.js).
//
// INTEGRATION (matches how bugReport.js was wired in):
// 1. Copy this file + adminActions.js into the vaultbot repo root.
// 2. In deploy-commands.js: import the builders below and push them into
//    the commands array that gets registered.
// 3. In index.js: import { handleAdminCommand } from './adminCommands.js',
//    and add a case in the interaction.commandName switch:
//        case 'admin': return handleAdminCommand(interaction);
//    (index.js already deferReply()s before the switch — don't defer again here.)
// 4. Set ADMIN_DISCORD_IDS in your env — comma-separated Discord user ids
//    allowed to run these. Gated in code since you're not a Manage Guild
//    admin in the XCFL server, so Discord-native permission gating won't
//    even show you the command.
// 5. Adjust the three TODOs below to match your actual helpers:
//    - getCurrentMember.js for resolving a Discord user to a LeagueMember
//    - wherever your EA export code stores/refreshes the Blaze session
//      (sessionKey, blazeId, deviceId, blazeIdHeader) per league

import { SlashCommandBuilder } from 'discord.js';
import * as admin from './adminActions.js';
// TODO: adjust these two imports to your actual modules
// import { getCurrentMember } from './getCurrentMember.js';
// import { getBlazeSession } from './ea_client.js'; // or wherever session refresh lives

const ADMIN_DISCORD_IDS = (process.env.ADMIN_DISCORD_IDS || '').split(',').filter(Boolean);

function isAuthorized(interaction) {
  return ADMIN_DISCORD_IDS.includes(interaction.user.id);
}

// ── Command builders ────────────────────────────────────────────────────

export const adminCommandBuilder = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('League commissioner actions (restricted)')
  .addSubcommand(sub =>
    sub.setName('boot-user')
      .setDescription('Remove a member from the league')
      .addUserOption(opt => opt.setName('member').setDescription('Discord user to boot').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('add-admin')
      .setDescription('Grant in-game commissioner rights')
      .addUserOption(opt => opt.setName('member').setDescription('Discord user to promote').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('remove-admin')
      .setDescription('Revoke in-game commissioner rights')
      .addUserOption(opt => opt.setName('member').setDescription('Discord user to demote').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('clear-cap-penalties')
      .setDescription("Clear a team's salary cap penalties")
      .addUserOption(opt => opt.setName('member').setDescription('Team owner').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('toggle-autopilot')
      .setDescription("Toggle a member's autopilot status")
      .addUserOption(opt => opt.setName('member').setDescription('Discord user').setRequired(true))
      .addIntegerOption(opt => opt.setName('timeout').setDescription('Action timeout in seconds (0 = default)').setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('force-home-win')
      .setDescription('Force the home team to win a scheduled game')
      .addStringOption(opt => opt.setName('team').setDescription('Home team name').setRequired(true).setAutocomplete(true))
      .addIntegerOption(opt => opt.setName('week').setDescription('Week number').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('force-away-win')
      .setDescription('Force the away team to win a scheduled game')
      .addStringOption(opt => opt.setName('team').setDescription('Away team name').setRequired(true).setAutocomplete(true))
      .addIntegerOption(opt => opt.setName('week').setDescription('Week number').setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('force-no-win')
      .setDescription('Clear a forced result back to normal')
      .addStringOption(opt => opt.setName('team').setDescription('Either team in the game').setRequired(true).setAutocomplete(true))
      .addIntegerOption(opt => opt.setName('week').setDescription('Week number').setRequired(true)));

// ── Helpers ─────────────────────────────────────────────────────────────

// Resolve a Discord user -> Blaze userId via the already-working GetLeagueHub
// data. userAdminHubInfo.userInfoMap is keyed by Blaze userId; match by
// teamName/userName against the LeagueMember record, same identity-matching
// approach the rest of the bot already uses (username vs discord_username
// vs avatar_name — see xcfl-vault notes on identity matching).
async function resolveBlazeUserId(leagueHubData, leagueMember) {
  const { userInfoMap } = leagueHubData.userAdminHubInfo;
  for (const [userId, info] of Object.entries(userInfoMap)) {
    if (info.teamName === leagueMember.team_name || info.userName === leagueMember.username) {
      return Number(userId);
    }
  }
  return null;
}

// Look up seasonGameKey for a team+week from the already-working GetLeagueHub
// data (gameScheduleHubInfo.leagueSchedule).
function findSeasonGameKey(leagueHubData, teamName, week) {
  const { leagueSchedule } = leagueHubData.gameScheduleHubInfo;
  // TODO: leagueSchedule entries carry team info nested under seasonGameInfo —
  // adjust this filter to match the real field names once you're reading
  // real GetLeagueHub responses (the sample in docs/madden/api_data/get_league.json
  // is a good reference for the exact shape).
  const entry = leagueSchedule.find(g =>
    g.seasonGameInfo?.weekIndex === week - 1 &&
    (g.seasonGameInfo?.homeTeamName === teamName || g.seasonGameInfo?.awayTeamName === teamName)
  );
  if (!entry) return null;
  if (!entry.canForceWin) throw new Error(`Force-win isn't available for that game (canForceWin: false).`);
  return entry.seasonGameKey;
}

// ── Handler ─────────────────────────────────────────────────────────────

export async function handleAdminCommand(interaction) {
  if (!isAuthorized(interaction)) {
    return interaction.editReply({ content: "You're not authorized to run commissioner commands." });
  }

  const sub = interaction.options.getSubcommand();

  // TODO: replace with your real session + league lookups
  // const session = await getBlazeSession(leagueId);
  // const leagueHubData = await admin.getLeagueHub(session, leagueId); // your existing working call
  // const leagueId = <resolve from guild/server config, same as other commands>

  try {
    switch (sub) {
      case 'boot-user': {
        const target = interaction.options.getUser('member');
        // const member = await getCurrentMember(target, allMembers);
        // const blazeUserId = await resolveBlazeUserId(leagueHubData, member);
        // await admin.bootUser(session, leagueId, blazeUserId);
        return interaction.editReply({ content: `Booted <@${target.id}> from the league.` });
      }
      case 'add-admin': {
        const target = interaction.options.getUser('member');
        // await admin.addAdmin(session, leagueId, blazeUserId);
        return interaction.editReply({ content: `Granted commissioner rights to <@${target.id}>.` });
      }
      case 'remove-admin': {
        const target = interaction.options.getUser('member');
        // await admin.removeAdmin(session, leagueId, blazeUserId);
        return interaction.editReply({ content: `Revoked commissioner rights from <@${target.id}>.` });
      }
      case 'clear-cap-penalties': {
        const target = interaction.options.getUser('member');
        // await admin.clearCapPenalties(session, leagueId, blazeUserId);
        return interaction.editReply({ content: `Cleared cap penalties for <@${target.id}>'s team.` });
      }
      case 'toggle-autopilot': {
        const target = interaction.options.getUser('member');
        const timeout = interaction.options.getInteger('timeout') ?? 0;
        // await admin.toggleAutoPilot(session, leagueId, blazeUserId, timeout);
        return interaction.editReply({ content: `Toggled autopilot for <@${target.id}>.` });
      }
      case 'force-home-win':
      case 'force-away-win':
      case 'force-no-win': {
        const team = interaction.options.getString('team');
        const week = interaction.options.getInteger('week');
        // const seasonGameKey = findSeasonGameKey(leagueHubData, team, week);
        // if (sub === 'force-home-win') await admin.forceHomeWin(session, leagueId, seasonGameKey);
        // if (sub === 'force-away-win') await admin.forceAwayWin(session, leagueId, seasonGameKey);
        // if (sub === 'force-no-win') await admin.forceNoWin(session, leagueId, seasonGameKey);
        return interaction.editReply({ content: `Updated result for ${team}, week ${week}.` });
      }
    }
  } catch (err) {
    console.error(`[admin] ${sub} failed:`, err);
    return interaction.editReply({ content: `That didn't work: ${err.message}` });
  }
}
