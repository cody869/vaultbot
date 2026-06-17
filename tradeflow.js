// tradeflow.js — multi-step interactive /submit_trade flow.
//
// Flow: pick Team 1 & Team 2 -> select players from each -> add picks
// (generic R1-R7, pick 1-32) -> review -> hand off to the app to submit.
//
// State is per-user, in memory, with a TTL. The final step does NOT write to
// Base44; it posts a summary with a deep link to the app's trade page so the
// app stays authoritative (no write credential needed).

import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { teamEmojiByName } from "./emoji.js";

const PUBLIC_URL = process.env.VAULT_PUBLIC_URL || "https://xcfl-companion.com";
const CYCLE = process.env.XCFL_CYCLE || "M26";
const APP_ID = process.env.BASE44_APP_ID;
const SERVER = process.env.BASE44_SERVER_URL || "https://base44.app";

// ---- session state ------------------------------------------------------

const sessions = new Map(); // userId -> session
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

function newSession(userId) {
  const s = {
    userId,
    step: "team1",
    team1: null,
    team2: null,
    team1Players: [],
    team2Players: [],
    team1Picks: [],
    team2Picks: [],
    pickSide: null, // which team we're currently adding picks for
    createdAt: Date.now(),
  };
  sessions.set(userId, s);
  return s;
}
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(userId);
    return null;
  }
  return s;
}
function endSession(userId) {
  sessions.delete(userId);
}

// Periodically sweep expired sessions.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 60_000);

// ---- Base44 reads (anonymous, same as vault.js) -------------------------

async function readEntity(entity, filter = {}) {
  const url = new URL(`${SERVER}/api/apps/${APP_ID}/entities/${entity}`);
  for (const [k, v] of Object.entries(filter)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", "X-App-Id": APP_ID },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} reading ${entity}`);
  const data = await res.json().catch(() => null);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.entities)) return data.entities;
  return [];
}

// Distinct team names from Roster, sorted.
async function getTeams() {
  const rows = await readEntity("Roster", { cycle: CYCLE });
  return [...new Set(rows.map((r) => r.team_name).filter(Boolean))].sort();
}

// Players on a team, joined with Player for OVR/position, sorted by OVR.
async function getTeamPlayers(teamName) {
  const roster = await readEntity("Roster", { cycle: CYCLE, team_name: teamName });
  // Pull OVR/pos from Player by full name (Roster has names but not OVR).
  const players = await readEntity("Player", { cycle: CYCLE });
  const byName = new Map(players.map((p) => [p.player_fullName, p]));
  return roster
    .map((r) => {
      const p = byName.get(r.player_fullName) || {};
      return {
        name: r.player_fullName,
        position: r.player_position || p.player_position || "?",
        ovr: p.player_ovr ?? 0,
      };
    })
    .filter((x) => x.name)
    .sort((a, b) => b.ovr - a.ovr);
}

// ---- UI builders ---------------------------------------------------------

// customId scheme: "trade:<action>:<arg>"
const ID = (action, arg = "") => `trade:${action}:${arg}`;

function teamSelectRow(teams, action, placeholder) {
  // Discord select menus cap at 25 options. If more teams exist, this would
  // need pagination; XCFL has 32, so we page into two menus.
  const opts = teams.slice(0, 25).map((t) => ({
    label: t.slice(0, 100),
    value: t.slice(0, 100),
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(action)
      .setPlaceholder(placeholder)
      .addOptions(opts)
  );
}

// Two-menu team picker to cover >25 teams.
function teamSelectRows(teams, action, placeholder) {
  const rows = [];
  for (let i = 0; i < teams.length && rows.length < 4; i += 25) {
    const chunk = teams.slice(i, i + 25);
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${action}:${i}`)
          .setPlaceholder(
            teams.length > 25
              ? `${placeholder} (${chunk[0]}–${chunk[chunk.length - 1]})`
              : placeholder
          )
          .addOptions(chunk.map((t) => ({ label: t.slice(0, 100), value: t.slice(0, 100) })))
      )
    );
  }
  return rows;
}

function playerSelectRow(players, action, placeholder, selected = []) {
  const opts = players.slice(0, 25).map((p) => ({
    label: `${p.name} (${p.position}, ${p.ovr} OVR)`.slice(0, 100),
    value: p.name.slice(0, 100),
    default: selected.includes(p.name),
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(action)
      .setPlaceholder(placeholder)
      .setMinValues(0)
      .setMaxValues(Math.min(opts.length, 25))
      .addOptions(opts)
  );
}

// Pick selectors: round (1-7) then pick-in-round (1-32). We add picks one at a
// time, appending to the current side.
function roundSelectRow(action) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(action)
      .setPlaceholder("Add a draft pick — choose round")
      .addOptions(
        Array.from({ length: 7 }, (_, i) => ({
          label: `Round ${i + 1}`,
          value: String(i + 1),
        }))
      )
  );
}
function pickNumberRows(round, action) {
  // 32 pick numbers need two menus (25 cap each).
  const rows = [];
  for (let start = 1; start <= 32; start += 25) {
    const end = Math.min(start + 24, 32);
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${action}:${round}:${start}`)
          .setPlaceholder(`Round ${round} — pick ${start}–${end}`)
          .addOptions(
            Array.from({ length: end - start + 1 }, (_, i) => {
              const n = start + i;
              return { label: `R${round}.${String(n).padStart(2, "0")}`, value: String(n) };
            })
          )
      )
    );
  }
  return rows;
}

function navButtons(session) {
  const row = new ActionRowBuilder();
  if (session.step === "players") {
    row.addComponents(
      new ButtonBuilder().setCustomId(ID("toPicks")).setLabel("Next: Add Picks ▶").setStyle(ButtonStyle.Primary)
    );
  }
  if (session.step === "picks") {
    row.addComponents(
      new ButtonBuilder().setCustomId(ID("pickSide", "1")).setLabel("Add pick for Team 1").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(ID("pickSide", "2")).setLabel("Add pick for Team 2").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(ID("review")).setLabel("Review ▶").setStyle(ButtonStyle.Primary)
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId(ID("cancel")).setLabel("Cancel").setStyle(ButtonStyle.Danger)
  );
  return row;
}

function summaryEmbed(session, { final = false } = {}) {
  const e = new EmbedBuilder()
    .setColor(0x1d4ed8)
    .setTitle(final ? "📦 Trade Ready to Submit" : "📦 Trade Builder")
    .setURL(PUBLIC_URL);

  const side = (team, players, picks) => {
    const logo = team ? teamEmojiByName(team) + " " : "";
    const lines = [];
    if (players.length) lines.push(players.map((p) => `• ${p}`).join("\n"));
    if (picks.length) lines.push(picks.map((p) => `• ${p}`).join("\n"));
    return `${logo}**${team || "—"}**\n${lines.join("\n") || "_nothing yet_"}`;
  };

  e.addFields(
    { name: "Team 1 sends", value: side(session.team1, session.team1Players, session.team1Picks).slice(0, 1024) },
    { name: "Team 2 sends", value: side(session.team2, session.team2Players, session.team2Picks).slice(0, 1024) }
  );
  if (!final) e.setFooter({ text: "This stays private until you submit." });
  return e;
}

// Builds the deep link to the app's trade submission page with prefilled data.
function submitUrl(session) {
  const u = new URL("/trade", PUBLIC_URL);
  u.searchParams.set("team1", session.team1 || "");
  u.searchParams.set("team2", session.team2 || "");
  if (session.team1Players.length) u.searchParams.set("team1_players", session.team1Players.join(","));
  if (session.team2Players.length) u.searchParams.set("team2_players", session.team2Players.join(","));
  if (session.team1Picks.length) u.searchParams.set("team1_picks", session.team1Picks.join(","));
  if (session.team2Picks.length) u.searchParams.set("team2_picks", session.team2Picks.join(","));
  return u.toString();
}

// ---- entry point: /submit_trade -----------------------------------------

export async function startTradeFlow(interaction) {
  const session = newSession(interaction.user.id);
  let teams;
  try {
    teams = await getTeams();
  } catch (err) {
    await interaction.editReply("⚠️ Couldn't load teams from the Vault. Try again shortly.");
    endSession(interaction.user.id);
    return;
  }
  session.teamsCache = teams;

  await interaction.editReply({
    content: "**Step 1 of 4 — Select Team 1** (the first team in the trade).",
    components: [...teamSelectRows(teams, "trade:team1"), navButtons(session)],
  });
}

// ---- component router -----------------------------------------------------
// Returns true if it handled the interaction.

export async function handleTradeComponent(interaction) {
  const id = interaction.customId;
  if (!id.startsWith("trade:")) return false;

  const session = getSession(interaction.user.id);
  if (!session) {
    await interaction.reply({
      content: "This trade builder session expired. Run `/submit_trade` again.",
      ephemeral: true,
    });
    return true;
  }

  const [, action] = id.split(":");

  try {
    // --- team selection ---
    if (action === "team1") {
      session.team1 = interaction.values[0];
      session.step = "team2";
      const teams = session.teamsCache.filter((t) => t !== session.team1);
      await interaction.update({
        content: `Team 1: **${session.team1}** ${teamEmojiByName(session.team1)}\n\n**Step 2 of 4 — Select Team 2.**`,
        components: [...teamSelectRows(teams, "trade:team2"), navButtons(session)],
      });
      return true;
    }
    if (action === "team2") {
      session.team2 = interaction.values[0];
      session.step = "players";
      await showPlayerStep(interaction, session);
      return true;
    }

    // --- player selection ---
    if (action === "p1") {
      session.team1Players = interaction.values;
      await interaction.update({ embeds: [summaryEmbed(session)] });
      return true;
    }
    if (action === "p2") {
      session.team2Players = interaction.values;
      await interaction.update({ embeds: [summaryEmbed(session)] });
      return true;
    }

    // --- navigation: go to picks ---
    if (action === "toPicks") {
      session.step = "picks";
      await interaction.update({
        content: "**Step 3 of 4 — Add draft picks** (optional). Choose which team's pick to add, or go to Review.",
        embeds: [summaryEmbed(session)],
        components: [navButtons(session)],
      });
      return true;
    }

    // --- picks: choose side ---
    if (action === "pickSide") {
      session.pickSide = id.split(":")[2];
      await interaction.update({
        content: `Adding a pick for **${session.pickSide === "1" ? session.team1 : session.team2}**. Choose a round:`,
        embeds: [summaryEmbed(session)],
        components: [roundSelectRow("trade:pickRound"), navButtons(session)],
      });
      return true;
    }
    if (action === "pickRound") {
      const round = interaction.values[0];
      await interaction.update({
        content: `Round ${round}: choose the pick number.`,
        embeds: [summaryEmbed(session)],
        components: [...pickNumberRows(round, "trade:pickNum"), navButtons(session)],
      });
      return true;
    }
    if (action === "pickNum") {
      const [, , round] = id.split(":");
      const num = interaction.values[0];
      const label = `R${round}.${String(num).padStart(2, "0")}`;
      if (session.pickSide === "1") session.team1Picks.push(label);
      else session.team2Picks.push(label);
      await interaction.update({
        content: `Added **${label}** to ${session.pickSide === "1" ? session.team1 : session.team2}. Add another pick or Review.`,
        embeds: [summaryEmbed(session)],
        components: [navButtons(session)],
      });
      return true;
    }

    // --- review / submit ---
    if (action === "review") {
      if (!session.team1Players.length && !session.team2Players.length &&
          !session.team1Picks.length && !session.team2Picks.length) {
        await interaction.reply({ content: "Add at least one player or pick first.", ephemeral: true });
        return true;
      }
      session.step = "review";
      const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Submit in App ▶").setURL(submitUrl(session)),
        new ButtonBuilder().setCustomId(ID("cancel")).setLabel("Discard").setStyle(ButtonStyle.Danger)
      );
      await interaction.update({
        content: "**Step 4 of 4 — Review.** Click **Submit in App** to open the prefilled trade form on the site and finalize it there.",
        embeds: [summaryEmbed(session, { final: true })],
        components: [linkRow],
      });
      return true;
    }

    // --- cancel ---
    if (action === "cancel") {
      endSession(interaction.user.id);
      await interaction.update({
        content: "Trade builder cancelled.",
        embeds: [],
        components: [],
      });
      return true;
    }
  } catch (err) {
    console.error("Trade flow error:", err);
    try {
      await interaction.reply({ content: `⚠️ ${err.message}`, ephemeral: true });
    } catch {}
    return true;
  }

  return false;
}

async function showPlayerStep(interaction, session) {
  let t1Players, t2Players;
  try {
    [t1Players, t2Players] = await Promise.all([
      getTeamPlayers(session.team1),
      getTeamPlayers(session.team2),
    ]);
  } catch (err) {
    await interaction.update({ content: `⚠️ ${err.message}`, components: [] });
    return;
  }
  session._t1 = t1Players;
  session._t2 = t2Players;

  await interaction.update({
    content:
      `Team 1: **${session.team1}**  •  Team 2: **${session.team2}**\n\n` +
      "**Step 3 of 4 — Select players** from each team (optional — you can also trade only picks). Pick from both menus, then continue.",
    embeds: [summaryEmbed(session)],
    components: [
      playerSelectRow(t1Players, "trade:p1", `Players from ${session.team1}`.slice(0, 100), session.team1Players),
      playerSelectRow(t2Players, "trade:p2", `Players from ${session.team2}`.slice(0, 100), session.team2Players),
      navButtons(session),
    ],
  });
}
