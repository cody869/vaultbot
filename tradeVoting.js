// tradeVoting.js — committee voting on trades, handled entirely by the bot.
//
// Replaces the reaction-based flow: the bot posts a readable trade card with
// Approve / Reject buttons, writes each vote straight into the
// TradeSubmission.votes array, and edits the message in place so the tally is
// always live. No polling of reaction counts, no ambiguity about who voted.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import { teamEmojiByName, devEmoji } from "./emoji.js";
import {
  getPendingTrades,
  getAllTrades,
  getTradeById,
  getPlayersByNames,
  getMemberByDiscordId,
  memberDisplayName,
  updateEntity,
} from "./vault.js";

const VAULT_URL = process.env.VAULT_PUBLIC_URL || "https://xcfl-companion.com";
const TRADE_CHANNEL_ID = process.env.TRADE_CHANNEL_ID || null;
// Approved trades are announced here. Rejections are resolved silently —
// the review card updates in place and nothing else is posted.
const TRADE_ANNOUNCE_CHANNEL_ID = process.env.TRADE_ANNOUNCE_CHANNEL_ID || null;

// How often to look for newly submitted trades to post.
const WATCH_INTERVAL_MS = 60_000;

// customId: tvote:<action>:<tradeId>
const ID = (action, tradeId) => `tvote:${action}:${tradeId}`;

// ---- rendering -----------------------------------------------------------

// The attributes worth showing per position on a trade card — enough to judge
// the player without opening the app.
const CARD_ATTRS = {
  QB: [["THP", "throwPower"], ["SAC", "shortAcc"], ["MAC", "midAcc"], ["DAC", "deepAcc"], ["AWR", "awa"]],
  RB: [["SPD", "spd"], ["ACC", "acc"], ["AGI", "agi"], ["BTK", "breakTackle"], ["CAR", "carry"]],
  WR: [["SPD", "spd"], ["CTH", "catch"], ["RLS", "release"], ["CIT", "catchInTraffic"], ["SRR", "shortRouteRun"]],
  TE: [["SPD", "spd"], ["CTH", "catch"], ["CIT", "catchInTraffic"], ["RBK", "runBlock"], ["SRR", "shortRouteRun"]],
  OL: [["PBK", "passBlock"], ["RBK", "runBlock"], ["STR", "str"], ["AWR", "awa"], ["PRC", "playRecog"]],
  DL: [["BSH", "blockShed"], ["PMV", "powerMoves"], ["FMV", "finesseMoves"], ["TAK", "tackle"], ["PUR", "pursuit"]],
  LB: [["TAK", "tackle"], ["PUR", "pursuit"], ["HIT", "hitPower"], ["ZCV", "zoneCoverage"], ["PRC", "playRecog"]],
  CB: [["SPD", "spd"], ["MCV", "manCoverage"], ["ZCV", "zoneCoverage"], ["PRS", "press"], ["AGI", "agi"]],
  S: [["SPD", "spd"], ["ZCV", "zoneCoverage"], ["TAK", "tackle"], ["HIT", "hitPower"], ["PRC", "playRecog"]],
  K: [["KPW", "kickPower"], ["KAC", "kickAcc"], ["AWR", "awa"]],
};

function attrGroup(pos) {
  const p = String(pos ?? "").toUpperCase();
  if (p === "QB") return "QB";
  if (["HB", "RB", "FB"].includes(p)) return "RB";
  if (p === "WR") return "WR";
  if (p === "TE") return "TE";
  if (["LT", "LG", "C", "RG", "RT", "OL", "OT", "OG"].includes(p)) return "OL";
  if (["LE", "RE", "DT", "DE", "EDGE", "LEDGE", "REDGE", "DL"].includes(p)) return "DL";
  if (["MLB", "LOLB", "ROLB", "OLB", "ILB", "LB", "MIKE", "WILL", "SAM"].includes(p)) return "LB";
  if (p === "CB") return "CB";
  if (["FS", "SS", "S"].includes(p)) return "S";
  if (["K", "P"].includes(p)) return "K";
  return null;
}

// One player line: name, position, OVR, age, dev, then key attributes.
function playerLine(name, player) {
  if (!player) return `> **${name}**`;

  const url = `${VAULT_URL}/players/${encodeURIComponent(name)}`;
  const bits = [
    player.player_position ?? "?",
    player.player_ovr != null ? `${player.player_ovr} OVR` : null,
    player.player_age != null ? `${player.player_age}y` : null,
  ].filter(Boolean);

  const head = `> [**${name}**](<${url}>) — ${bits.join(" · ")} ${devEmoji(player.player_devTrait)}`;

  const group = attrGroup(player.player_position);
  const attrs = group ? CARD_ATTRS[group] : null;
  if (!attrs) return head;

  const shown = attrs
    .filter(([, k]) => player[k] != null)
    .map(([label, k]) => `${label} ${player[k]}`);
  if (!shown.length) return head;

  return `${head}\n> -# ${shown.join(" · ")}`;
}

// How lopsided is this trade? Percentage gap between the two sides.
function fairness(v1, v2) {
  const a = Number(v1 ?? 0);
  const b = Number(v2 ?? 0);
  if (!a && !b) return { label: "No value data", diff: 0 };
  const diff = Math.abs(a - b);
  const bigger = Math.max(a, b) || 1;
  const pct = (diff / bigger) * 100;
  const favors = a > b ? "team1" : b > a ? "team2" : null;

  if (pct <= 8) return { label: "Even", diff, pct, favors };
  if (pct <= 20) return { label: "Slight edge", diff, pct, favors };
  if (pct <= 35) return { label: "Notable gap", diff, pct, favors };
  return { label: "Lopsided", diff, pct, favors };
}

// Build the full trade message. `players` is a Map of lowercased name -> Player.
export function tradeMessage(trade, players = new Map(), { decided = false } = {}) {
  const t1 = trade.team1 ?? "Team 1";
  const t2 = trade.team2 ?? "Team 2";
  const votes = Array.isArray(trade.votes) ? trade.votes : [];
  const approve = votes.filter((v) => v.vote === "approve");
  const reject = votes.filter((v) => v.vote === "reject");
  const needed = trade.votes_needed ?? 3;

  const out = [];

  // Heading reflects the outcome once decided.
  const status = trade.status ?? "pending";
  if (status === "approved") out.push(`# ✅ Trade Approved`);
  else if (status === "rejected" || status === "vetoed") out.push(`# ❌ Trade ${status === "vetoed" ? "Vetoed" : "Rejected"}`);
  else out.push(`# Trade Under Review`);

  out.push(`### ${teamEmojiByName(t1)} ${t1}  ↔  ${teamEmojiByName(t2)} ${t2}`);
  if (trade.submitted_by) out.push(`-# Submitted by ${trade.submitted_by}`);

  // Each side's assets.
  const sideBlock = (teamName, playerNames = [], picks = []) => {
    const lines = [``, `**${teamEmojiByName(teamName)} ${teamName} sends**`];
    if (!playerNames.length && !picks.length) {
      lines.push("> *nothing*");
      return lines;
    }
    for (const n of playerNames) {
      lines.push(playerLine(n, players.get(String(n).toLowerCase())));
    }
    for (const p of picks) lines.push(`> Pick: **${p}**`);
    return lines;
  };

  out.push(...sideBlock(t1, trade.team1_players, trade.team1_picks));
  out.push(...sideBlock(t2, trade.team2_players, trade.team2_picks));

  // Value and fairness.
  const f = fairness(trade.team1_value, trade.team2_value);
  out.push("");
  out.push("**Value**");
  out.push(
    `> ${t1} **${Math.round(trade.team1_value ?? 0)}** · ${t2} **${Math.round(trade.team2_value ?? 0)}**`
  );
  const favorsName = f.favors === "team1" ? t1 : f.favors === "team2" ? t2 : null;
  out.push(
    `> ${f.label}${f.diff ? ` — ${Math.round(f.diff)} pt gap` : ""}` +
      (favorsName && f.pct > 8 ? `, favors **${favorsName}**` : "")
  );

  // Vote tally with names, so it's clear who has weighed in.
  out.push("");
  out.push(`**Committee Vote** — ${needed} needed to decide`);
  out.push(
    `> ✅ **${approve.length}**${approve.length ? ` — ${approve.map((v) => v.voter_name).join(", ")}` : ""}`
  );
  out.push(
    `> ❌ **${reject.length}**${reject.length ? ` — ${reject.map((v) => v.voter_name).join(", ")}` : ""}`
  );

  // Any comments left with votes.
  const comments = votes.filter((v) => v.comment);
  if (comments.length) {
    out.push("");
    out.push("**Notes**");
    for (const c of comments.slice(0, 5)) {
      out.push(`> **${c.voter_name}:** ${String(c.comment).slice(0, 200)}`);
    }
  }

  out.push("");
  out.push(`-# [Open in XCFL Vault](<${VAULT_URL}/trade-voting>)`);

  let content = out.join("\n");
  if (content.length > 2000) content = content.slice(0, 1997) + "…";

  return { content, embeds: [], components: voteRows(trade, decided) };
}

function voteRows(trade, decided) {
  const status = trade.status ?? "pending";
  const done = decided || status !== "pending";

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ID("approve", trade.id))
      .setLabel("Approve")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(done),
    new ButtonBuilder()
      .setCustomId(ID("reject", trade.id))
      .setLabel("Reject")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(done),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("Vote in App")
      .setURL(`${VAULT_URL}/trade-voting`)
  );
  return [row];
}

// ---- posting -------------------------------------------------------------

// Fetch the Player records for every player named in a trade.
async function playersForTrade(trade) {
  const names = [
    ...(trade.team1_players ?? []),
    ...(trade.team2_players ?? []),
  ];
  try {
    return await getPlayersByNames(names);
  } catch (err) {
    console.error("[TRADE VOTE] player lookup failed:", err.message);
    return new Map();
  }
}

// Post a trade to the committee channel and record the message id so the
// tally can be edited in place later.
export async function postTrade(client, trade) {
  if (!TRADE_CHANNEL_ID) {
    console.error("[TRADE VOTE] TRADE_CHANNEL_ID not set — cannot post trades.");
    return null;
  }
  const channel = await client.channels.fetch(TRADE_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error(`[TRADE VOTE] channel ${TRADE_CHANNEL_ID} not found.`);
    return null;
  }

  const players = await playersForTrade(trade);
  const payload = tradeMessage(trade, players);
  const msg = await channel.send(payload);

  try {
    await updateEntity("TradeSubmission", trade.id, {
      discord_message_id: msg.id,
      discord_channel_id: channel.id,
    });
  } catch (err) {
    console.error("[TRADE VOTE] could not save message id:", err.message);
  }
  console.log(`[TRADE VOTE] posted trade ${trade.id} as message ${msg.id}`);
  return msg;
}

// ---- voting --------------------------------------------------------------

export async function handleTradeVote(interaction) {
  const [, action, tradeId] = interaction.customId.split(":");
  await interaction.deferUpdate();

  try {
    // Only committee members may vote.
    const member = await getMemberByDiscordId(interaction.user.id);
    if (!member) {
      await interaction.followUp({
        content:
          "Your Discord account isn't linked to a league member, so I can't record your vote. An admin can link it in the Vault.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!member.is_committee) {
      await interaction.followUp({
        content: "Only trade committee members can vote on trades.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const trade = await getTradeById(tradeId);
    if (!trade) {
      await interaction.followUp({
        content: "That trade no longer exists.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if ((trade.status ?? "pending") !== "pending") {
      await interaction.followUp({
        content: `This trade is already **${trade.status}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const voterName = memberDisplayName(member);
    const votes = Array.isArray(trade.votes) ? [...trade.votes] : [];
    const existing = votes.findIndex(
      (v) => String(v.voter_discord_id ?? "") === String(interaction.user.id)
    );

    const entry = {
      voter_email: member.username ?? "",
      voter_name: voterName,
      voter_discord_id: interaction.user.id,
      vote: action, // "approve" | "reject"
      comment: existing >= 0 ? votes[existing].comment ?? "" : "",
      voted_at: new Date().toISOString(),
    };

    let notice;
    if (existing >= 0) {
      const previous = votes[existing].vote;
      if (previous === action) {
        await interaction.followUp({
          content: `You already voted **${action}** on this trade.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      votes[existing] = entry;
      notice = `Vote changed from **${previous}** to **${action}**.`;
    } else {
      votes.push(entry);
      notice = `Vote recorded: **${action}**.`;
    }

    const votes_approve = votes.filter((v) => v.vote === "approve").length;
    const votes_reject = votes.filter((v) => v.vote === "reject").length;
    const needed = trade.votes_needed ?? 3;

    // Decide as soon as either side reaches the threshold.
    let status = trade.status ?? "pending";
    if (votes_approve >= needed) status = "approved";
    else if (votes_reject >= needed) status = "rejected";

    const patch = { votes, votes_approve, votes_reject, status };
    await updateEntity("TradeSubmission", tradeId, patch);

    const updated = { ...trade, ...patch };
    const players = await playersForTrade(updated);
    await interaction.editReply(tradeMessage(updated, players));

    // Approvals get announced publicly; rejections resolve silently.
    if (status === "approved") {
      await announceApproval(interaction.client, updated);
    } else if (status === "rejected") {
      announced.add(tradeId); // decided — the watcher should not revisit it
    }

    if (status !== "pending" && status !== (trade.status ?? "pending")) {
      await interaction.followUp({
        content: `${notice} That decides it — the trade is **${status}**.`,
        flags: MessageFlags.Ephemeral,
      });
      console.log(`[TRADE VOTE] trade ${tradeId} decided: ${status}`);
    } else {
      await interaction.followUp({
        content: `${notice} (${votes_approve} approve · ${votes_reject} reject · ${needed} needed)`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    console.error("[TRADE VOTE] failed:", err);
    try {
      await interaction.followUp({
        content: `Couldn't record that vote: ${err.message}`,
        flags: MessageFlags.Ephemeral,
      });
    } catch {}
  }
}

// ---- approval announcements ---------------------------------------------

// Trades we've already announced, so a restart or a second vote can't double
// post. Seeded at startup with everything already decided.
const announced = new Set();

// The public "this trade went through" post. Deliberately lighter than the
// review card: what moved, who won the vote, and a link.
export function approvalMessage(trade, players = new Map()) {
  const t1 = trade.team1 ?? "Team 1";
  const t2 = trade.team2 ?? "Team 2";
  const votes = Array.isArray(trade.votes) ? trade.votes : [];
  const approve = votes.filter((v) => v.vote === "approve");
  const reject = votes.filter((v) => v.vote === "reject");

  const out = [];
  out.push(`# ✅ Trade Approved`);
  out.push(`### ${teamEmojiByName(t1)} ${t1}  ↔  ${teamEmojiByName(t2)} ${t2}`);

  const sideBlock = (teamName, playerNames = [], picks = []) => {
    const lines = [``, `**${teamEmojiByName(teamName)} ${teamName} receives**`];
    if (!playerNames.length && !picks.length) {
      lines.push("> *nothing*");
      return lines;
    }
    for (const n of playerNames) {
      lines.push(playerLine(n, players.get(String(n).toLowerCase())));
    }
    for (const p of picks) lines.push(`> Pick: **${p}**`);
    return lines;
  };

  // Each team receives what the OTHER side sent.
  out.push(...sideBlock(t1, trade.team2_players, trade.team2_picks));
  out.push(...sideBlock(t2, trade.team1_players, trade.team1_picks));

  out.push("");
  out.push(
    `-# Approved ${approve.length}\u2013${reject.length}` +
      (approve.length ? ` — ${approve.map((v) => v.voter_name).join(", ")}` : "")
  );
  out.push(`-# [View in XCFL Vault](<${VAULT_URL}/trades>)`);

  let content = out.join("\n");
  if (content.length > 2000) content = content.slice(0, 1997) + "\u2026";
  return { content, embeds: [], components: [] };
}

// Post the approval announcement, once per trade.
export async function announceApproval(client, trade) {
  if (announced.has(trade.id)) return null;
  announced.add(trade.id); // claim it up front so a race can't double-post

  if (!TRADE_ANNOUNCE_CHANNEL_ID) {
    console.log("[TRADE VOTE] TRADE_ANNOUNCE_CHANNEL_ID not set — skipping announcement.");
    return null;
  }
  const channel = await client.channels
    .fetch(TRADE_ANNOUNCE_CHANNEL_ID)
    .catch(() => null);
  if (!channel) {
    console.error(`[TRADE VOTE] announce channel ${TRADE_ANNOUNCE_CHANNEL_ID} not found.`);
    announced.delete(trade.id); // let a later tick retry
    return null;
  }

  try {
    const players = await playersForTrade(trade);
    const msg = await channel.send(approvalMessage(trade, players));
    console.log(`[TRADE VOTE] announced approved trade ${trade.id}`);
    return msg;
  } catch (err) {
    console.error("[TRADE VOTE] announcement failed:", err.message);
    announced.delete(trade.id);
    return null;
  }
}

// ---- watcher -------------------------------------------------------------

// Poll for pending trades that haven't been posted yet and post them.
export function startTradeWatcher(client) {
  if (!TRADE_CHANNEL_ID) {
    console.log("ℹ️  TRADE_CHANNEL_ID not set — trade voting posts disabled.");
    return;
  }

  // On startup, treat everything already decided as announced so a restart
  // never replays old approvals into the channel.
  const seed = async () => {
    try {
      const all = await getAllTrades();
      let n = 0;
      for (const t of all) {
        if ((t.status ?? "pending") !== "pending") {
          announced.add(t.id);
          n++;
        }
      }
      console.log(`[TRADE VOTE] seeded ${n} already-decided trade(s).`);
    } catch (err) {
      console.error("[TRADE VOTE] seed failed:", err.message);
    }
  };

  const tick = async () => {
    try {
      // 1) Post newly submitted trades for review.
      const pending = await getPendingTrades();
      const unposted = pending.filter((t) => !t.discord_message_id);
      if (unposted.length) {
        console.log(`[TRADE VOTE] ${unposted.length} trade(s) to post.`);
        // Oldest first so the channel reads in submission order.
        for (const trade of unposted.reverse()) {
          await postTrade(client, trade);
        }
      }

      // 2) Announce approvals — including ones decided in the app rather than
      //    through the Discord buttons. Rejections stay silent.
      const all = await getAllTrades();
      for (const t of all) {
        if (t.status === "approved" && !announced.has(t.id)) {
          await announceApproval(client, t);
        } else if (t.status === "rejected" || t.status === "vetoed") {
          announced.add(t.id);
        }
      }
    } catch (err) {
      console.error("[TRADE VOTE] watcher error:", err.message);
    }
  };

  // Seed first, then sweep shortly after startup and on an interval.
  seed().then(() => {
    setTimeout(tick, 10_000);
    setInterval(tick, WATCH_INTERVAL_MS);
  });
  console.log(
    `Trade voting watcher started (review: ${TRADE_CHANNEL_ID}` +
      `, announce: ${TRADE_ANNOUNCE_CHANNEL_ID ?? "not set"}).`
  );
}
