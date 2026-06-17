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
import { teamEmojiByName, abbrFromName } from "./emoji.js";
import { list } from "./vault.js";

const PUBLIC_URL = process.env.VAULT_PUBLIC_URL || "https://xcfl-companion.com";
const CYCLE = process.env.XCFL_CYCLE || "M26";

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
    playerSide: "1", // which team's players we're currently choosing
    playerPage: 0, // which page of position buckets is showing
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

// ---- Base44 reads (via vault.js, which is the proven reader) ------------

// Roster has hundreds of rows (one per player); fetch a high limit so every
// team is represented and player lists are complete.
const ROSTER_LIMIT = 2000;

// Distinct team names from Roster, sorted.
async function getTeams() {
  const rows = await list("Roster", { cycle: CYCLE }, { limit: ROSTER_LIMIT });
  return [...new Set(rows.map((r) => r.team_name).filter(Boolean))].sort();
}

// Short-lived cache of the team list for autocomplete (fires per keystroke).
let _teamCache = { at: 0, teams: [] };
async function getTeamsCached() {
  const now = Date.now();
  if (now - _teamCache.at < 60_000 && _teamCache.teams.length) return _teamCache.teams;
  const teams = await getTeams();
  _teamCache = { at: now, teams };
  return teams;
}

// Autocomplete suggestions for a team option. Matches on name or abbreviation,
// shows "ABBR — Full Name", and returns the full name as the value.
export async function suggestTeams(partial, limit = 25) {
  let teams;
  try {
    teams = await getTeamsCached();
  } catch {
    return [];
  }
  const q = (partial ?? "").trim().toLowerCase();
  const scored = teams
    .map((name) => {
      const abbr = abbrFromName(name);
      const hay = `${name} ${abbr}`.toLowerCase();
      let tier = 0;
      if (!q) tier = 1;
      else if (abbr.toLowerCase() === q || name.toLowerCase() === q) tier = 3;
      else if (abbr.toLowerCase().startsWith(q) || name.toLowerCase().startsWith(q)) tier = 2;
      else if (hay.includes(q)) tier = 1;
      return { name, abbr, tier };
    })
    .filter((x) => x.tier > 0)
    .sort((a, b) => b.tier - a.tier || a.name.localeCompare(b.name))
    .slice(0, limit);

  return scored.map(({ name, abbr }) => ({
    name: abbr ? `${abbr} — ${name}` : name,
    value: name,
  }));
}

// Players on a team, joined with Player for OVR/position, sorted by OVR.
async function getTeamPlayers(teamName) {
  const roster = await list(
    "Roster",
    { cycle: CYCLE, team_name: teamName },
    { limit: ROSTER_LIMIT }
  );
  const players = await list("Player", { cycle: CYCLE }, { limit: ROSTER_LIMIT });
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

// Map raw Madden positions into broad buckets so each select menu stays well
// under Discord's 25-option cap and the UI is easy to scan.
const POSITION_BUCKETS = [
  { label: "QB", match: ["QB"] },
  { label: "RB", match: ["HB", "RB", "FB"] },
  { label: "WR", match: ["WR"] },
  { label: "TE", match: ["TE"] },
  { label: "OL", match: ["LT", "LG", "C", "RG", "RT", "OL", "G", "T"] },
  { label: "DL", match: ["LE", "RE", "DT", "DE", "DL", "REDGE", "LEDGE", "EDGE"] },
  { label: "LB", match: ["LOLB", "MLB", "ROLB", "LB", "OLB", "ILB"] },
  { label: "DB", match: ["CB", "FS", "SS", "S", "DB"] },
  { label: "ST", match: ["K", "P", "LS"] },
];

function bucketFor(position) {
  const pos = (position || "").toUpperCase();
  for (const b of POSITION_BUCKETS) {
    if (b.match.includes(pos)) return b.label;
  }
  return "Other";
}

// Group a team's players into position buckets (only non-empty ones), each
// already sorted by OVR. Returns [{ label, players }] in POSITION_BUCKETS order.
function groupByPosition(players) {
  const groups = new Map();
  for (const p of players) {
    const b = bucketFor(p.position);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(p);
  }
  const order = [...POSITION_BUCKETS.map((b) => b.label), "Other"];
  return order
    .filter((label) => groups.has(label))
    .map((label) => ({ label, players: groups.get(label) }));
}

// One select menu for a single position bucket on a given side.
// customId: trade:pos:<side>:<bucket>
function positionMenuRow(side, bucket, players, selected) {
  const opts = players.slice(0, 25).map((p) => ({
    label: `${p.name} (${p.position}, ${p.ovr} OVR)`.slice(0, 100),
    value: p.name.slice(0, 100),
    default: selected.includes(p.name),
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`trade:pos:${side}:${bucket}`)
      .setPlaceholder(`${bucket} — select players`)
      .setMinValues(0)
      .setMaxValues(Math.min(opts.length, 25))
      .addOptions(opts)
  );
}

// Build the message payload for the current player-selection side/page.
// Shows up to 4 position menus per page; a "More positions" button appears if
// the side has more buckets than fit, and a button to switch to the other team.
const BUCKETS_PER_PAGE = 4;

function renderPlayerStep(session) {
  const side = session.playerSide;
  const players = side === "1" ? session._t1 : session._t2;
  const selected = side === "1" ? session.team1Players : session.team2Players;
  const teamName = side === "1" ? session.team1 : session.team2;
  const abbr = abbrFromName(teamName) || teamName;

  const buckets = groupByPosition(players);
  const pageCount = Math.max(1, Math.ceil(buckets.length / BUCKETS_PER_PAGE));
  const page = Math.min(session.playerPage, pageCount - 1);
  const start = page * BUCKETS_PER_PAGE;
  const pageBuckets = buckets.slice(start, start + BUCKETS_PER_PAGE);

  const rows = pageBuckets.map((b) =>
    positionMenuRow(side, b.label, b.players, selected)
  );

  // Navigation row.
  const nav = new ActionRowBuilder();
  if (pageCount > 1) {
    nav.addComponents(
      new ButtonBuilder()
        .setCustomId(ID("pPage", String((page + 1) % pageCount)))
        .setLabel(`More positions (${page + 1}/${pageCount})`)
        .setStyle(ButtonStyle.Secondary)
    );
  }
  nav.addComponents(
    new ButtonBuilder()
      .setCustomId(ID("pSide", side === "1" ? "2" : "1"))
      .setLabel(side === "1" ? `Switch to ${abbrFromName(session.team2) || session.team2}` : `Switch to ${abbrFromName(session.team1) || session.team1}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ID("toPicks")).setLabel("Next: Picks ▶").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ID("cancel")).setLabel("Cancel").setStyle(ButtonStyle.Danger)
  );

  return {
    content:
      `Selecting players for ${teamEmojiByName(teamName)} **${abbr}**.\n` +
      "Pick from the position menus below. Use **Switch** to do the other team, then **Next: Picks**.",
    embeds: [summaryEmbed(session)],
    components: [...rows, nav],
  };
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
  const team1 = interaction.options.getString("team1");
  const team2 = interaction.options.getString("team2");

  if (team1 === team2) {
    await interaction.editReply("⚠️ Team 1 and Team 2 must be different.");
    return;
  }

  const session = newSession(interaction.user.id);
  session.team1 = team1;
  session.team2 = team2;
  session.step = "players";

  // Load both rosters and render the player step directly.
  let t1Players, t2Players;
  try {
    [t1Players, t2Players] = await Promise.all([
      getTeamPlayers(team1),
      getTeamPlayers(team2),
    ]);
  } catch (err) {
    console.error("Trade flow roster load failed:", err.message);
    await interaction.editReply(`⚠️ Couldn't load rosters (${err.message}). Try again shortly.`);
    endSession(interaction.user.id);
    return;
  }
  if (!t1Players.length && !t2Players.length) {
    await interaction.editReply("⚠️ No players found for either team. Check the team names.");
    endSession(interaction.user.id);
    return;
  }
  session._t1 = t1Players;
  session._t2 = t2Players;
  session.playerSide = "1";
  session.playerPage = 0;

  const a1 = abbrFromName(team1) || team1;
  const a2 = abbrFromName(team2) || team2;
  await interaction.editReply({
    content:
      `${teamEmojiByName(team1)} **${a1}**  ↔  ${teamEmojiByName(team2)} **${a2}**\n\n` +
      "**Step 1 of 3 — Select players.** Players are grouped by position so nothing is cut off.",
    embeds: [summaryEmbed(session)],
    components: renderPlayerStep(session).components,
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
    // --- player selection by position bucket ---
    if (action === "pos") {
      // customId: trade:pos:<side>:<bucket>
      const [, , side, bucket] = id.split(":");
      const allPlayers = side === "1" ? session._t1 : session._t2;
      const key = side === "1" ? "team1Players" : "team2Players";

      // Names belonging to this bucket (so we only replace this bucket's part).
      const bucketNames = new Set(
        allPlayers.filter((p) => bucketFor(p.position) === bucket).map((p) => p.name)
      );
      // Keep prior selections from other buckets, then add this bucket's picks.
      const kept = session[key].filter((n) => !bucketNames.has(n));
      session[key] = [...kept, ...interaction.values];

      await interaction.update(renderPlayerStep(session));
      return true;
    }
    if (action === "pPage") {
      session.playerPage = parseInt(id.split(":")[2], 10) || 0;
      await interaction.update(renderPlayerStep(session));
      return true;
    }
    if (action === "pSide") {
      session.playerSide = id.split(":")[2];
      session.playerPage = 0;
      await interaction.update(renderPlayerStep(session));
      return true;
    }

    // --- navigation: go to picks ---
    if (action === "toPicks") {
      session.step = "picks";
      await interaction.update({
        content: "**Step 2 of 3 — Add draft picks** (optional). Choose which team's pick to add, or go to Review.",
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
        content: "**Step 3 of 3 — Review.** Click **Submit in App** to open the prefilled trade form on the site and finalize it there.",
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
