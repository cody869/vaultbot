// adminCommands.js — Discord slash commands for franchise commissioner
// actions (boot/admin/cap-penalty/autopilot/force-result).
//
// index.js already calls interaction.deferReply() before the command
// switch — everything here uses editReply(), matching eaCommands.js.
//
// Deliberately EA-only, not Vault-backed: every picker here (team, game)
// reads straight from the league's live Blaze data (getLeagueInfo), not
// Vault's LeagueMember table. That table is a snapshot that only updates on
// import, so a team that changed hands or a player who just joined could be
// stale or missing there. EA's own data can't be stale — it's the save file.

import { SlashCommandBuilder } from "discord.js";
import { getConnectedClient } from "./eaTokenStore.js";
import { startExportFlow, handleEaStatus } from "./eaCommands.js";
import bugReportCommands from "./bugReport.js";

// Reuses the same allowlist /export and /ea-status already gate on — these
// are all "can touch the live EA league" actions, so one list covers all of
// them. Not gated with setDefaultMemberPermissions(ManageGuild) for the same
// reason as eaCommands.js: that hides the command outright from a
// commissioner who isn't a server admin. True hiding from the command
// picker needs Discord's own per-guild command permissions, set by whoever
// has Manage Server — this allowlist only controls what happens if someone
// runs it, not whether they can see it.
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
      .setDescription("Remove a team's owner from the league")
      .addIntegerOption((o) =>
        o.setName("team").setDescription("Start typing a team name, then pick from the list").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("add-admin")
      .setDescription("Grant in-game commissioner rights")
      .addIntegerOption((o) =>
        o.setName("team").setDescription("Start typing a team name, then pick from the list").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove-admin")
      .setDescription("Revoke in-game commissioner rights")
      .addIntegerOption((o) =>
        o.setName("team").setDescription("Start typing a team name, then pick from the list").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("clear-cap-penalties")
      .setDescription("Clear a team's salary cap penalties")
      .addIntegerOption((o) =>
        o.setName("team").setDescription("Start typing a team name, then pick from the list").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("toggle-autopilot")
      .setDescription("Toggle a team's autopilot status")
      .addIntegerOption((o) =>
        o.setName("team").setDescription("Start typing a team name, then pick from the list").setRequired(true).setAutocomplete(true)
      )
      .addIntegerOption((o) => o.setName("timeout").setDescription("Action timeout in seconds (0 = default)"))
  )
  .addSubcommand((sub) =>
    sub
      .setName("force-home-win")
      .setDescription("Force the home team to win a scheduled game")
      .addIntegerOption((o) =>
        o.setName("game").setDescription("Start typing a matchup, then pick from the list").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("force-away-win")
      .setDescription("Force the away team to win a scheduled game")
      .addIntegerOption((o) =>
        o.setName("game").setDescription("Start typing a matchup, then pick from the list").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("force-no-win")
      .setDescription("Clear a forced result back to normal")
      .addIntegerOption((o) =>
        o.setName("game").setDescription("Start typing a matchup, then pick from the list").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("export")
      .setDescription("Pull a fresh Madden export from EA into the Vault — walks you through week, then what to pull")
  )
  .addSubcommand((sub) =>
    sub
      .setName("ea-status")
      .setDescription("Show the EA connection status")
  )
  .addSubcommand((sub) =>
    sub
      .setName("bug-status")
      .setDescription("View all bug reports and their status")
  )
  .addSubcommand((sub) =>
    sub
      .setName("resolve-bug")
      .setDescription("Resolve a bug report")
      .addStringOption((o) =>
        o
          .setName("bug_id")
          .setDescription("Bug report ID (from /admin bug-status)")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("resolution")
          .setDescription("How was this bug fixed?")
          .setRequired(true)
      )
  );

// Both pickers (team, game) come off the same live getLeagueInfo() call —
// one shared cache instead of two, so picking a team then a game in the
// same session doesn't double the EA calls. 60s matches the game picker's
// prior cache window; Discord's 3s autocomplete budget is why this exists
// at all rather than calling EA on every keystroke.
let _leagueInfoCache = null;
async function getCachedLeagueInfo() {
  if (_leagueInfoCache && Date.now() - _leagueInfoCache.at < 60_000) {
    return { leagueInfo: _leagueInfoCache.leagueInfo, leagueId: _leagueInfoCache.leagueId, client: _leagueInfoCache.client };
  }
  const { client, leagueId } = await getConnectedClient();
  const leagueInfo = await client.getLeagueInfo(leagueId);
  _leagueInfoCache = { at: Date.now(), leagueInfo, leagueId, client };
  return { leagueInfo, leagueId, client };
}

// Autocomplete for the "team" option. userAdminHubInfo.userInfoMap is keyed
// by Blaze userId and only contains human-controlled teams (CPU teams never
// appear — correct, since there's no user to boot/toggle/etc.). The value
// sent back IS the real Blaze userId, so resolveTarget below needs no
// further lookup or matching step.
export async function suggestAdminTeams(focused) {
  try {
    const { leagueInfo } = await getCachedLeagueInfo();
    const q = String(focused ?? "").trim().toLowerCase();
    return Object.entries(leagueInfo.userAdminHubInfo.userInfoMap)
      .filter(([, info]) => !q || info.teamName?.toLowerCase().includes(q) || info.userName?.toLowerCase().includes(q))
      .slice(0, 25)
      .map(([userId, info]) => ({
        name: `${info.teamName} — ${info.userName}${info.isAdmin ? " (admin)" : ""}${info.autoPilot ? " (autopilot)" : ""}`,
        value: Number(userId),
      }));
  } catch (err) {
    console.error("[ADMIN] team autocomplete failed:", err.message);
    return [];
  }
}

// Autocomplete for the force-win/no-win "game" option. Matches on the
// matchup text ("Bengals @ Ravens") and shows the week + whether EA
// currently allows forcing a result for that game.
export async function suggestForceWinGames(focused) {
  try {
    const { leagueInfo } = await getCachedLeagueInfo();
    const games = leagueInfo.gameScheduleHubInfo.leagueSchedule;
    const q = String(focused ?? "").trim().toLowerCase();
    return games
      .filter((g) => !g.seasonGameInfo.isGamePlayed)
      .filter((g) => !q || g.seasonGameInfo.matchup.toLowerCase().includes(q))
      .slice(0, 25)
      .map((g) => ({
        name: `${g.seasonGameInfo.matchup} — ${g.seasonGameInfo.displayedWeek}${
          g.canForceWin ? "" : " (not forceable right now)"
        }`,
        value: g.seasonGameKey,
      }));
  } catch (err) {
    console.error("[ADMIN] game autocomplete failed:", err.message);
    return [];
  }
}

async function resolveTarget(interaction) {
  const blazeUserId = interaction.options.getInteger("team");
  const { leagueInfo, leagueId, client } = await getCachedLeagueInfo();
  const info = leagueInfo.userAdminHubInfo.userInfoMap[String(blazeUserId)];
  const label = info ? `${info.teamName} (${info.userName})` : `user ${blazeUserId}`;
  return { client, leagueId, blazeUserId, label };
}

/**
 * Given two team nicknames (e.g. "Bengals", "Ravens" — the same format
 * seasonGameInfo.matchup uses), find the single unplayed, forceable live EA
 * game between them. Used by scheduleWatcher.js to cross-reference a
 * forfeit detected in #schedule against a real seasonGameKey, without a
 * human typing into the /admin force-* autocomplete.
 */
export async function resolveLiveGameByNicknames(nickA, nickB) {
  const a = String(nickA || "").toLowerCase().trim();
  const b = String(nickB || "").toLowerCase().trim();
  if (!a || !b) return { ok: false, reason: "missing_team" };

  try {
    const { leagueInfo } = await getCachedLeagueInfo();
    const games = leagueInfo.gameScheduleHubInfo.leagueSchedule;
    const matches = games.filter((g) => {
      const m = (g.seasonGameInfo.matchup || "").toLowerCase();
      return m.includes(a) && m.includes(b);
    });

    if (matches.length !== 1) {
      return { ok: false, reason: matches.length === 0 ? "no_match" : "ambiguous" };
    }
    const game = matches[0];
    if (game.seasonGameInfo.isGamePlayed) return { ok: false, reason: "already_played", game };
    if (!game.canForceWin) return { ok: false, reason: "cannot_force", game };
    return { ok: true, game };
  } catch (err) {
    console.error("[ADMIN] resolveLiveGameByNicknames failed:", err.message);
    return { ok: false, reason: "lookup_failed" };
  }
}

/**
 * Shared force-win execution, used by both the /admin slash command and the
 * staff-channel confirm buttons (handleForceWinButton below) — one place
 * that actually talks to EA, instead of duplicating the Blaze calls.
 */
export async function applyForceWin(sub, seasonGameKey) {
  try {
    const { client, leagueId } = await getConnectedClient();
    const { leagueInfo } = await getCachedLeagueInfo();
    const game = leagueInfo.gameScheduleHubInfo.leagueSchedule.find((g) => g.seasonGameKey === seasonGameKey);
    const label = game ? game.seasonGameInfo.matchup : `game ${seasonGameKey}`;
    if (game && !game.canForceWin && sub !== "force-no-win") {
      return { ok: false, label, reason: `Force-win isn't available for **${label}** right now.` };
    }

    if (sub === "force-home-win") await client.forceHomeWin(leagueId, seasonGameKey);
    if (sub === "force-away-win") await client.forceAwayWin(leagueId, seasonGameKey);
    if (sub === "force-no-win") await client.forceNoWin(leagueId, seasonGameKey);

    return { ok: true, label };
  } catch (err) {
    return { ok: false, reason: err.message || "That didn't work." };
  }
}

/**
 * Staff-channel confirm buttons posted by scheduleWatcher.js when it detects
 * a forfeit it could confidently match to a live EA game. customId scheme:
 * "fw:home:<seasonGameKey>" / "fw:away:<seasonGameKey>" / "fw:dismiss:<seasonGameKey>".
 * Re-checks isAuthorized() itself — a button click doesn't inherit whatever
 * authorization the original poster had.
 */
export async function handleForceWinButton(interaction) {
  const [, action, keyStr] = interaction.customId.split(":");
  const seasonGameKey = Number(keyStr);

  if (!isAuthorized(interaction)) {
    await interaction.reply({ content: "That control is limited to the league's export admins.", ephemeral: true });
    return;
  }

  const original = interaction.message.content || "";

  if (action === "dismiss") {
    await interaction.update({
      content: `${original}\n\n_Dismissed by <@${interaction.user.id}> — no action taken._`,
      components: [],
    });
    return;
  }

  await interaction.deferUpdate();
  const sub = action === "home" ? "force-home-win" : "force-away-win";
  const result = await applyForceWin(sub, seasonGameKey);
  const resultLine = result.ok
    ? `✅ Confirmed by <@${interaction.user.id}> — **${result.label}**: ${action} win applied.`
    : `❌ <@${interaction.user.id}> tried to confirm — failed: ${result.reason}`;

  await interaction.editReply({
    content: `${original}\n\n${resultLine}`,
    components: [],
  });
}

export async function handleAdminCommand(interaction) {
  if (!isAuthorized(interaction)) return denied(interaction);

  const sub = interaction.options.getSubcommand();
  console.log(`[ADMIN] /admin ${sub} by ${interaction.user.tag}`);

  try {
    switch (sub) {
      case "boot-user": {
        const { client, leagueId, blazeUserId, label } = await resolveTarget(interaction);
        await client.bootUser(leagueId, blazeUserId);
        await interaction.editReply(`Booted **${label}** from the league.`);
        break;
      }
      case "add-admin": {
        const { client, leagueId, blazeUserId, label } = await resolveTarget(interaction);
        await client.addAdmin(leagueId, blazeUserId);
        await interaction.editReply(`Granted commissioner rights to **${label}**.`);
        break;
      }
      case "remove-admin": {
        const { client, leagueId, blazeUserId, label } = await resolveTarget(interaction);
        await client.removeAdmin(leagueId, blazeUserId);
        await interaction.editReply(`Revoked commissioner rights from **${label}**.`);
        break;
      }
      case "clear-cap-penalties": {
        const { client, leagueId, blazeUserId, label } = await resolveTarget(interaction);
        await client.clearCapPenalties(leagueId, blazeUserId);
        await interaction.editReply(`Cleared cap penalties for **${label}**.`);
        break;
      }
      case "toggle-autopilot": {
        const { client, leagueId, blazeUserId, label } = await resolveTarget(interaction);
        const timeout = interaction.options.getInteger("timeout") ?? 0;
        await client.toggleAutoPilot(leagueId, blazeUserId, timeout);
        await interaction.editReply(`Toggled autopilot for **${label}**.`);
        break;
      }
      case "force-home-win":
      case "force-away-win":
      case "force-no-win": {
        const seasonGameKey = interaction.options.getInteger("game");
        const result = await applyForceWin(sub, seasonGameKey);
        await interaction.editReply(result.ok ? `Updated result for **${result.label}**.` : result.reason);
        break;
      }
      case "export": {
        await startExportFlow(interaction);
        break;
      }
      case "ea-status": {
        await handleEaStatus(interaction);
        break;
      }
      case "bug-status": {
        await bugReportCommands.bugStatus.execute(interaction);
        break;
      }
      case "resolve-bug": {
        await bugReportCommands.resolveBug.execute(interaction);
        break;
      }
    }
  } catch (err) {
    console.error(`[ADMIN] ${sub} failed:`, err);
    const hint = err.troubleshoot ? `\n> ${err.troubleshoot}` : "";
    await interaction.editReply(`${err.message || "That didn't work."}${hint}`);
  }
}
