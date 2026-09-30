// vegasWatcher.js — posts newly-opened Vegas lines to Discord, and settles
// them automatically once their linked Game goes final.
//
// Mirrors scorebugWatcher.js's poll/claim/withFileLock pattern exactly: a
// VegasLine posts itself once (discord_message_id is the claim token, same
// idea as ScorebugPost/Suspension), and settlement is triggered once per
// line the moment its real score lands, guarded by the same per-key
// withFileLock cross-process mutex scorebugWatcher.js/suspensionWatcher.js
// already use for this exact class of race.
//
// Environment:
//   VEGAS_CHANNEL_ID     channel to post odds cards and results into
//   VEGAS_POLL_SECONDS   optional — default 60

import { AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { list, updateEntity, invokeFunction, pollCached } from "./vault.js";
import { isRateLimited } from "./base44Pacer.js";
import { withFileLock } from "./fileLock.js";
import { renderOddsCard } from "./vegasCard.js";
import { abbrFromName } from "./emoji.js";
import { isGameFinal } from "./scorebugHelper.js";

const CHANNEL_ID = process.env.VEGAS_CHANNEL_ID;
const POLL_MS = Number(process.env.VEGAS_POLL_SECONDS || 60) * 1000;

function formatCutoff(cutoffAt) {
  if (!cutoffAt) return null;
  const d = new Date(cutoffAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function marketButtons(lineId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vegas:mkt:${lineId}:moneyline`).setLabel("Moneyline").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vegas:mkt:${lineId}:spread`).setLabel("Point Spread").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vegas:mkt:${lineId}:total`).setLabel("Total").setStyle(ButtonStyle.Primary)
  );
}

async function postLine(client, line) {
  const homeAbbr = abbrFromName(line.home_team);
  const awayAbbr = abbrFromName(line.away_team);
  if (!homeAbbr || !awayAbbr) {
    console.warn(`[VEGAS] could not resolve teams for "${line.away_team}" @ "${line.home_team}", skipping.`);
    return;
  }

  const png = await renderOddsCard({
    matchNumber: line.match_number,
    week: line.week,
    homeAbbr,
    awayAbbr,
    moneylineHome: line.moneyline_home,
    moneylineAway: line.moneyline_away,
    spreadHome: line.spread_home,
    spreadHomeOdds: line.spread_home_odds,
    spreadAwayOdds: line.spread_away_odds,
    totalLine: line.total_line,
    totalOverOdds: line.total_over_odds,
    totalUnderOdds: line.total_under_odds,
    minBet: line.min_bet ?? 100,
    maxBet: line.max_bet ?? 1000,
    cutoffLabel: formatCutoff(line.cutoff_at),
  });
  const filename = `vegas-${awayAbbr}-${homeAbbr}-wk${line.week ?? "x"}.png`;
  const file = new AttachmentBuilder(png, { name: filename });

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    throw new Error("channel not found or not text-based");
  }
  const message = await channel.send({ files: [file], components: [marketButtons(line.id)] });
  await updateEntity("VegasLine", line.id, {
    discord_channel_id: CHANNEL_ID,
    discord_message_id: message.id,
  });
  console.log(`[VEGAS] posted line ${line.id}: ${line.away_team} @ ${line.home_team} -> ${message.id}`);
}

async function postSettlementSummary(client, line, game, result) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const won = result.graded.filter((g) => g.status === "won").length;
  const lost = result.graded.filter((g) => g.status === "lost").length;
  const push = result.graded.filter((g) => g.status === "push").length;

  const embed = new EmbedBuilder()
    .setTitle(`${line.away_team} @ ${line.home_team} — Settled`)
    .setDescription(`Final: ${line.away_team} ${game.user2_score} @ ${line.home_team} ${game.user1_score}`)
    .addFields(
      { name: "Won", value: String(won), inline: true },
      { name: "Lost", value: String(lost), inline: true },
      { name: "Push", value: String(push), inline: true }
    )
    .setColor(0xd4a843);

  await channel.send({ embeds: [embed] });
  console.log(`[VEGAS] settled line ${line.id}: ${won} won, ${lost} lost, ${push} push`);
}

async function postNewLines(client, openLines) {
  const toPost = openLines.filter((l) => !l.discord_message_id);
  for (const line of toPost) {
    try {
      await withFileLock(`vegas-post:${line.id}`, async () => {
        const fresh = await list("VegasLine", { id: line.id }, { limit: 1 });
        if (fresh[0]?.discord_message_id) {
          console.log(`[VEGAS] ${line.id} already posted by another container, skipping`);
          return;
        }
        await postLine(client, line);
      });
    } catch (err) {
      console.error(`[VEGAS] post failed for ${line.id}: ${err.message}`);
    }
  }
}

async function triggerSettlements(client, openLines, games) {
  const gamesById = new Map(games.map((g) => [g.id, g]));
  const postedOpen = openLines.filter((l) => l.discord_message_id);

  for (const line of postedOpen) {
    const game = gamesById.get(line.game_id);
    if (!game || !isGameFinal(game.user1_score, game.user2_score)) continue;

    try {
      await withFileLock(`vegas-settle:${line.id}`, async () => {
        const fresh = await list("VegasLine", { id: line.id }, { limit: 1 });
        if (fresh[0]?.status !== "open") {
          console.log(`[VEGAS] ${line.id} already settled by another container, skipping`);
          return;
        }
        const result = await invokeFunction("settleVegasLine", { line_id: line.id });
        if (result?.error) {
          console.error(`[VEGAS] settle rejected for ${line.id}: ${result.error}`);
          return;
        }
        if (result?.skipped) return;
        await postSettlementSummary(client, line, game, result);
      });
    } catch (err) {
      console.error(`[VEGAS] settlement failed for ${line.id}: ${err.message}`);
    }
  }
}

async function tick(client) {
  if (isRateLimited()) return;

  let openLines, games;
  try {
    [openLines, games] = await Promise.all([
      pollCached("vegas:lines", 55_000, () => list("VegasLine", { status: "open" }, { limit: 100 })),
      pollCached("vegas:games", 55_000, () => list("Game")),
    ]);
  } catch (err) {
    console.error(`[VEGAS] fetch failed: ${err.message}`);
    return;
  }
  if (!openLines.length) return;

  await postNewLines(client, openLines);
  await triggerSettlements(client, openLines, games);
}

export function startVegasWatcher(client) {
  if (!CHANNEL_ID) {
    console.log("[VEGAS] watcher disabled — no VEGAS_CHANNEL_ID set.");
    return;
  }
  console.log(`[VEGAS] watcher starting — channel ${CHANNEL_ID}, every ${POLL_MS / 1000}s`);

  tick(client)
    .catch((err) => console.error(`[VEGAS] initial tick failed: ${err.message}`))
    .finally(() => {
      setInterval(() => {
        tick(client).catch((err) => console.error(`[VEGAS] poll failed: ${err.message}`));
      }, POLL_MS);
    });
}
