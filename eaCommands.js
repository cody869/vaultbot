// eaCommands.js — handlers for /export and /ea-status.
//
// index.js already calls interaction.deferReply() before the command switch,
// so nothing here defers again — that double-defer is what crashed /bug-status.
// Everything below uses editReply().

import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { runExport } from "./eaExport.js";
import { getConnection } from "./eaTokenStore.js";
import { getWatcherStatus } from "./eaWatcher.js";

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

// ---------------------------------------------------------------------------
// /admin export — 2-step guided flow: pick a week, then what to pull.
// Session state mirrors tradeflow.js's per-user Map + TTL pattern.
// customId scheme: "export:week" (select) / "export:data:stats|rosters" (buttons).
// ---------------------------------------------------------------------------

const exportSessions = new Map(); // userId -> { mode, week, createdAt }
const EXPORT_SESSION_TTL_MS = 15 * 60 * 1000;

function newExportSession(userId) {
  const s = { createdAt: Date.now() };
  exportSessions.set(userId, s);
  return s;
}
function getExportSession(userId) {
  const s = exportSessions.get(userId);
  if (!s) return null;
  if (Date.now() - s.createdAt > EXPORT_SESSION_TTL_MS) {
    exportSessions.delete(userId);
    return null;
  }
  return s;
}
function endExportSession(userId) {
  exportSessions.delete(userId);
}
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of exportSessions) {
    if (now - s.createdAt > EXPORT_SESSION_TTL_MS) exportSessions.delete(id);
  }
}, 60_000);

function weekStepRow() {
  const options = [
    { label: "Current week", value: "current" },
    ...Array.from({ length: 23 }, (_, i) => ({ label: `Week ${i + 1}`, value: String(i + 1) })),
    { label: "All weeks (slow)", value: "all" },
  ];
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("export:week")
      .setPlaceholder("Select a week")
      .addOptions(options)
  );
}

function dataStepPayload(session) {
  const label = session.mode === "current" ? "Current week" : session.mode === "all" ? "All weeks" : `Week ${session.week}`;
  return {
    content: `# Madden Export\n**Step 2 of 2 — ${label}.** What should this pull?`,
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("export:data:stats").setLabel("Stats only").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("export:data:rosters").setLabel("Rosters + stats").setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

export async function startExportFlow(interaction) {
  if (!isAuthorized(interaction)) return denied(interaction);
  if (inFlight) {
    await interaction.editReply("An export is already running. Give it a minute.");
    return;
  }
  newExportSession(interaction.user.id);
  await interaction.editReply({
    content: "# Madden Export\n**Step 1 of 2 — pick a week.**",
    embeds: [],
    components: [weekStepRow()],
  });
}

/** Routes "export:*" component interactions. Returns true once handled. */
export async function handleExportComponent(interaction) {
  const id = interaction.customId;
  if (!id.startsWith("export:")) return false;

  if (!isAuthorized(interaction)) {
    await interaction.reply({ content: "That control is limited to the league's export admins.", ephemeral: true });
    return true;
  }

  const session = getExportSession(interaction.user.id);
  if (!session) {
    await interaction.reply({ content: "This export session expired. Run `/admin export` again.", ephemeral: true });
    return true;
  }

  const parts = id.split(":");

  if (parts[1] === "week") {
    const value = interaction.values[0]; // "current" | "1".."23" | "all"
    if (value === "current" || value === "all") {
      session.mode = value;
      session.week = undefined;
    } else {
      session.mode = "week";
      session.week = Number(value);
    }
    await interaction.update(dataStepPayload(session));
    return true;
  }

  if (parts[1] === "data") {
    const rosters = parts[2] === "rosters";
    const { mode, week } = session;
    endExportSession(interaction.user.id);
    await interaction.update({ content: "# Madden Export\nStarting…", embeds: [], components: [] });
    await runExportFlow(interaction, mode, week, rosters);
    return true;
  }

  return true;
}

async function runExportFlow(interaction, mode, week, rosters) {
  if (inFlight) {
    await interaction.editReply({ content: "An export is already running. Give it a minute.", components: [] });
    return;
  }

  const started = Date.now();
  console.log(`[EA] /admin export mode=${mode}${mode === "week" ? ` week=${week}` : ""} rosters=${rosters} by ${interaction.user.tag}`);

  // Discord only lets an interaction be edited for 15 minutes, and a full
  // roster pull can approach that. Throttle progress edits, and never let a
  // failed edit abort the export itself.
  let lastEdit = 0;
  const onProgress = async (text) => {
    if (Date.now() - lastEdit < 3000) return;
    lastEdit = Date.now();
    try {
      await interaction.editReply({ content: `# Madden Export\n${text}`, components: [] });
    } catch {
      /* interaction expired — keep exporting */
    }
  };

  inFlight = runExport({ mode, week, rosters, datasets: undefined, leagueInfo: true, onProgress });
  try {
    const summary = await inFlight;
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`[EA] export complete in ${secs}s`, summary);
    await interaction.editReply({
      content: [
        "# Madden Export complete",
        `> Weeks: ${summary.weeks}${mode === "week" ? ` (week ${week})` : ""}`,
        "> Per week: all 8 datasets",
        `> League info: ${summary.leagueInfo ? "teams + standings" : "skipped"}`,
        `> Rosters: ${summary.rosters ? `${summary.rosters} teams + free agents` : "skipped"}`,
        `> Took ${secs}s`,
      ].join("\n"),
      components: [],
    });
  } catch (err) {
    console.error("[EA] export failed:", err);
    const hint = err.troubleshoot ? `\n> ${err.troubleshoot}` : "";
    await interaction.editReply({
      content: `# Madden Export failed\n> ${err.message || "Unknown error"}${hint}`,
      components: [],
    });
  } finally {
    inFlight = null;
  }
}

function fmtAgo(ts) {
  if (!ts) return "never";
  return `<t:${Math.floor(ts / 1000)}:R>`;
}

export async function handleEaStatus(interaction) {
  if (!isAuthorized(interaction)) return denied(interaction);
  const watcher = await getWatcherStatus();
  const autoExportLines = [
    `> Stats auto-export: ${
      watcher.autoExport
        ? `**on** — current week, checked every ${watcher.statsHours}h`
        : "**off** (set EA_AUTO_EXPORT=true)"
    }`,
    watcher.autoExport
      ? `> Last stats check: ${fmtAgo(watcher.lastStatsCheckAt)} — ${watcher.lastStatsCheckResult ?? "pending first check"}`
      : null,
    `> Roster auto-export: every ${watcher.rosterHours}h — last ran ${fmtAgo(watcher.lastRosterExportAt)}`,
  ].filter(Boolean);

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
        "",
        "# Auto-export",
        ...autoExportLines,
      ].join("\n")
    );
  } catch (err) {
    await interaction.editReply(
      ["# EA Connection", `> Not linked — ${err.message}`, "", "# Auto-export", ...autoExportLines].join("\n")
    );
  }
}
