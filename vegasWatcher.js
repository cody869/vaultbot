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
import { renderOddsCard, renderSettlementCard } from "./vegasCard.js";
import { abbrFromName } from "./emoji.js";
import { isGameFinal } from "./scorebugHelper.js";

const CHANNEL_ID = process.env.VEGAS_CHANNEL_ID;
const POLL_MS = Number(process.env.VEGAS_POLL_SECONDS || 60) * 1000;

// Staff enter the cutoff in Eastern time (VegasAdmin.jsx converts it to a
// correct UTC instant before saving) -- display has to pin the same zone
// explicitly too, or this reads in whatever timezone the Railway container
// happens to be in instead. timeZoneName: "short" picks EST/EDT correctly
// on its own depending on the date, no DST math needed here.
function formatCutoff(cutoffAt) {
  if (!cutoffAt) return null;
  const d = new Date(cutoffAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZoneName: "short",
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
  // allowedMentions must opt in explicitly or the ping is inert text --
  // same pattern tradeVoting.js uses for its own @everyone submission ping.
  const message = await channel.send({
    content: "@everyone new line is up",
    files: [file],
    components: [marketButtons(line.id)],
    allowedMentions: { parse: ["everyone"] },
  });
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

  const homeAbbr = abbrFromName(line.home_team);
  const awayAbbr = abbrFromName(line.away_team);

  try {
    const png = await renderSettlementCard({
      homeAbbr, awayAbbr,
      homeScore: game.user1_score,
      awayScore: game.user2_score,
      week: line.week,
      matchNumber: line.match_number,
      won, lost, push,
    });
    const filename = `vegas-final-${awayAbbr}-${homeAbbr}-wk${line.week ?? "x"}.png`;
    await channel.send({ files: [new AttachmentBuilder(png, { name: filename })] });
  } catch (err) {
    // A card render hiccup shouldn't hide that the line actually settled --
    // fall back to the plain-text summary so the result still posts.
    console.error(`[VEGAS] settlement card render failed for ${line.id}, falling back to embed: ${err.message}`);
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
  }

  console.log(`[VEGAS] settled line ${line.id}: ${won} won, ${lost} lost, ${push} push`);
}

// In-memory "last rendered odds" per line, so the card only gets re-edited
// and announced when a market actually moved -- not on every poll tick.
// Resets on container restart; a move that happened while the bot was down
// is picked up silently (re-seeded, not announced) on the first tick after
// restart rather than retroactively posted, the same cold-start tradeoff
// pollCached already accepts elsewhere in this file.
const lastOdds = new Map();

function oddsSnapshot(line) {
  return {
    moneyline_home: line.moneyline_home,
    moneyline_away: line.moneyline_away,
    spread_home: line.spread_home,
    total_line: line.total_line,
  };
}

function fmtOdds(n) {
  if (n == null) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

function describeMoves(prev, cur, line) {
  const moves = [];
  if (prev.moneyline_home !== cur.moneyline_home || prev.moneyline_away !== cur.moneyline_away) {
    moves.push(
      `Moneyline: ${line.away_team} ${fmtOdds(cur.moneyline_away)} (was ${fmtOdds(prev.moneyline_away)}) · ` +
      `${line.home_team} ${fmtOdds(cur.moneyline_home)} (was ${fmtOdds(prev.moneyline_home)})`
    );
  }
  if (prev.spread_home !== cur.spread_home) {
    moves.push(`Spread: ${line.home_team} ${fmtOdds(cur.spread_home)} (was ${fmtOdds(prev.spread_home)})`);
  }
  if (prev.total_line !== cur.total_line) {
    moves.push(`Total: ${cur.total_line} (was ${prev.total_line})`);
  }
  return moves;
}

// Re-renders and edits a line's posted odds card when placeBetOnLine has
// moved its moneyline/spread/total off what's currently shown, and drops a
// short follow-up explaining what moved and why (stake imbalance, not a
// staff edit). First sighting of a line in this process just seeds the
// cache -- the already-posted card already matches opening odds, so there's
// nothing to announce yet.
async function checkLineMovement(client, line) {
  if (!line.discord_message_id) return;

  const cur = oddsSnapshot(line);
  const prev = lastOdds.get(line.id);
  lastOdds.set(line.id, cur);
  if (!prev) return;

  const moves = describeMoves(prev, cur, line);
  if (!moves.length) return;

  const homeAbbr = abbrFromName(line.home_team);
  const awayAbbr = abbrFromName(line.away_team);
  if (!homeAbbr || !awayAbbr) return;

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(line.discord_message_id).catch(() => null);
    if (!message) return;

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
    await message.edit({ files: [new AttachmentBuilder(png, { name: filename })] });

    await channel.send({
      content: `📈 **Line moved** — ${line.away_team} @ ${line.home_team} (#${line.match_number})\n${moves.join("\n")}`,
      reply: { messageReference: message.id },
      allowedMentions: { parse: [] },
    });
    console.log(`[VEGAS] line ${line.id} moved: ${moves.join(" | ")}`);
  } catch (err) {
    console.error(`[VEGAS] movement update failed for ${line.id}: ${err.message}`);
  }
}

async function checkMovements(client, openLines) {
  for (const line of openLines.filter((l) => l.discord_message_id)) {
    await checkLineMovement(client, line);
  }
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
  await checkMovements(client, openLines);
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
