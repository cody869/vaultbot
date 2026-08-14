// eaCommands.js — handlers for /export and /ea-status.
//
// index.js already calls interaction.deferReply() before the command switch,
// so nothing here defers again — that double-defer is what crashed /bug-status.
// Everything below uses editReply().

import { runExport } from "./eaExport.js";
import { getConnection } from "./eaTokenStore.js";

// Exports are heavy and EA rate-limits, so only one runs at a time no matter
// who fires the command.
let inFlight = null;

/*
 * Who may run these.
 *
 * Deliberately NOT gated with setDefaultMemberPermissions(ManageGuild):
 * Discord hides such commands outright from anyone lacking the permission,
 * which locks out a commissioner who isn't a server admin. An allowlist of
 * Discord user ids keeps control in this repo instead of in server roles.
 *
 * EA_ADMIN_IDS: comma-separated Discord user ids.
 */
function isAuthorized(interaction) {
  const allowed = (process.env.EA_ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Fail closed. An unset allowlist must not mean "everyone" — an export
  // overwrites league data.
  if (!allowed.length) return false;
  return allowed.includes(interaction.user.id);
}

async function denied(interaction) {
  const configured = Boolean((process.env.EA_ADMIN_IDS || "").trim());
  console.log(`[EA] denied ${interaction.commandName} for ${interaction.user.tag} (${interaction.user.id})`);
  await interaction.editReply(
    configured
      ? "That command is limited to the league's export admins."
      : "EA commands aren't enabled yet — set EA_ADMIN_IDS to your Discord user id."
  );
}

export async function handleExport(interaction) {
  if (!isAuthorized(interaction)) return denied(interaction);
  if (inFlight) {
    await interaction.editReply("An export is already running. Give it a minute.");
    return;
  }

  const mode = interaction.options.getString("scope") ?? "current";
  const dataOpt = interaction.options.getString("data") ?? "all";
  const rosters = interaction.options.getBoolean("rosters") ?? false;

  // "Schedules only" means exactly that — no stat categories, and no
  // teams/standings either, so a schedule backfill can't overwrite current
  // league info with a stale snapshot.
  const datasets = dataOpt === "schedules" ? ["schedules"] : undefined;
  const wantLeagueInfo = dataOpt !== "schedules";

  const started = Date.now();
  console.log(
    `[EA] /export scope=${mode} data=${dataOpt} rosters=${rosters} by ${interaction.user.tag}`
  );

  // Discord only lets an interaction be edited for 15 minutes, and a full
  // roster pull can approach that. Throttle progress edits, and never let a
  // failed edit abort the export itself.
  let lastEdit = 0;
  const onProgress = async (text) => {
    if (Date.now() - lastEdit < 3000) return;
    lastEdit = Date.now();
    try {
      await interaction.editReply(`# Madden Export\n${text}`);
    } catch {
      /* interaction expired — keep exporting */
    }
  };

  inFlight = runExport({
    mode,
    rosters,
    datasets,
    leagueInfo: wantLeagueInfo,
    onProgress,
  });
  try {
    const summary = await inFlight;
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`[EA] export complete in ${secs}s`, summary);
    await interaction.editReply(
      [
        "# Madden Export complete",
        `> Weeks: ${summary.weeks}`,
        `> Per week: ${dataOpt === "schedules" ? "schedules only" : "all 8 datasets"}`,
        `> League info: ${summary.leagueInfo ? "teams + standings" : "skipped"}`,
        `> Rosters: ${summary.rosters ? `${summary.rosters} teams + free agents` : "skipped"}`,
        `> Took ${secs}s`,
      ].join("\n")
    );
  } catch (err) {
    console.error("[EA] export failed:", err);
    const hint = err.troubleshoot ? `\n> ${err.troubleshoot}` : "";
    await interaction.editReply(
      `# Madden Export failed\n> ${err.message || "Unknown error"}${hint}`
    );
  } finally {
    inFlight = null;
  }
}

export async function handleEaStatus(interaction) {
  if (!isAuthorized(interaction)) return denied(interaction);
  try {
    const conn = await getConnection();
    const expiry = new Date(conn.token.expiry);
    const expired = expiry < new Date();
    const linked = Math.floor(new Date(conn.linkedAt).getTime() / 1000);
    await interaction.editReply(
      [
        "# EA Connection",
        `> League: **${conn.leagueName ?? "unknown"}** (id ${conn.leagueId})`,
        `> Platform: ${conn.token.console}`,
        `> Linked: <t:${linked}:R>`,
        `> Access token: ${
          expired
            ? "expired — refreshes on next use"
            : `valid until <t:${Math.floor(expiry.getTime() / 1000)}:t>`
        }`,
        `> Export target: ${process.env.MADDEN_EXPORT_URL ? "configured" : "**MADDEN_EXPORT_URL not set**"}`,
      ].join("\n")
    );
  } catch (err) {
    await interaction.editReply(`# EA Connection\n> Not linked — ${err.message}`);
  }
}
