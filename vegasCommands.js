// vegasCommands.js — /bet place|mine, and the button->button->modal wizard
// that places a bet, for the in-house "Vegas" sportsbook.
//
// Odds cards and settlement results still post publicly to VEGAS_CHANNEL_ID
// (vegasWatcher.js) for everyone to see, but they're display-only now --
// no buttons on the public card. All interaction (placing a bet, checking
// your own open bets and balance) happens through this one /bet command,
// meant to be used in its own channel (restrict which channel via Discord's
// own per-command channel permissions in Server Settings -> Integrations;
// nothing here hardcodes a channel).
//
// Money math never happens here -- every path below ends in
// invokeFunction("placeBetOnLine", {...}), which runs server-side
// (asServiceRole) exactly like processApprovedTrade already does for trade
// execution. This file only resolves who's clicking, renders the
// confirmation, and reports errors back to them.

import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { list, invokeFunction, getMemberByDiscordId, memberDisplayName } from "./vault.js";
import { abbrFromName } from "./emoji.js";
import { renderBetReceiptCard } from "./vegasCard.js";

export const vegasCommand = [
  new SlashCommandBuilder()
    .setName("bet")
    .setDescription("XCFL Sportsbook")
    .addSubcommand((sub) =>
      sub
        .setName("place")
        .setDescription("Place a bet on an open line")
        .addStringOption((o) =>
          o
            .setName("line")
            .setDescription("Start typing a matchup, then pick from the list")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("mine").setDescription("Your balance and open bets")
    ),
];

async function openLines() {
  return list("VegasLine", { status: "open" }, { limit: 100, sort: "-created_date" });
}

export async function suggestVegasLines(focused) {
  try {
    const lines = await openLines();
    const q = String(focused ?? "").toLowerCase();
    return lines
      .filter((l) => !q || `${l.away_team} ${l.home_team}`.toLowerCase().includes(q))
      .slice(0, 25)
      .map((l) => ({
        name: `${l.away_team} @ ${l.home_team}${l.match_number != null ? ` (#${l.match_number})` : ""}`,
        value: l.id,
      }));
  } catch (err) {
    console.error("[VEGAS] autocomplete failed:", err.message);
    return [];
  }
}

async function getLine(lineId) {
  const rows = await list("VegasLine", { id: lineId }, { limit: 1 });
  return rows[0] || null;
}

function fmtOdds(n) {
  if (n == null) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

// Step 1 -> 2: market chosen (from /bet place's own market buttons), show
// side buttons. interaction.update() edits the SAME ephemeral message the
// market buttons were on, rather than interaction.reply()'s default of
// posting a brand new one -- that's what was piling up a fresh "only you
// can see this" ghost message per click. Every step of this wizard follows
// the same rule: update the one message in place, never reply() again
// after the first.
async function replyWithSideButtons(interaction, lineId, market) {
  const line = await getLine(lineId);
  if (!line) {
    await interaction.update({ content: "That line no longer exists.", components: [] });
    return;
  }
  if (line.status !== "open") {
    await interaction.update({ content: `This line is ${line.status}, not open for betting.`, components: [] });
    return;
  }

  const spreadAway = line.spread_home != null ? -line.spread_home : null;
  const buttons =
    market === "total"
      ? [
          new ButtonBuilder().setCustomId(`vegas:side:${lineId}:total:over`).setLabel(`Over ${line.total_line ?? ""} (${fmtOdds(line.total_over_odds)})`).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`vegas:side:${lineId}:total:under`).setLabel(`Under ${line.total_line ?? ""} (${fmtOdds(line.total_under_odds)})`).setStyle(ButtonStyle.Secondary),
        ]
      : market === "spread"
        ? [
            new ButtonBuilder().setCustomId(`vegas:side:${lineId}:spread:away`).setLabel(`${line.away_team} ${spreadAway > 0 ? "+" : ""}${spreadAway ?? "—"} (${fmtOdds(line.spread_away_odds)})`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`vegas:side:${lineId}:spread:home`).setLabel(`${line.home_team} ${line.spread_home > 0 ? "+" : ""}${line.spread_home ?? "—"} (${fmtOdds(line.spread_home_odds)})`).setStyle(ButtonStyle.Secondary),
          ]
        : [
            new ButtonBuilder().setCustomId(`vegas:side:${lineId}:moneyline:away`).setLabel(`${line.away_team} (${fmtOdds(line.moneyline_away)})`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`vegas:side:${lineId}:moneyline:home`).setLabel(`${line.home_team} (${fmtOdds(line.moneyline_home)})`).setStyle(ButtonStyle.Secondary),
          ];

  await interaction.update({
    content: `**${line.away_team} @ ${line.home_team}** — ${market === "moneyline" ? "Moneyline" : market === "spread" ? "Point Spread" : "Total"}. Pick a side:`,
    components: [new ActionRowBuilder().addComponents(buttons)],
  });
}

export async function handleVegasMarketButton(interaction) {
  const [, , lineId, market] = interaction.customId.split(":");
  await replyWithSideButtons(interaction, lineId, market);
}

// What a side is actually worth right now, for the stake modal's title --
// the last thing a bettor sees before committing money, so the odds being
// locked in need to be right there, not just implied by an earlier step.
function describeSideForModal(market, selection, line) {
  if (market === "total") {
    const side = selection === "over" ? "Over" : "Under";
    return { label: `${side} ${line?.total_line ?? ""}`, odds: selection === "over" ? line?.total_over_odds : line?.total_under_odds };
  }
  const team = selection === "home" ? line?.home_team : line?.away_team;
  if (market === "spread") {
    const val = selection === "home" ? line?.spread_home : (line?.spread_home != null ? -line.spread_home : null);
    return { label: `${team} ${val > 0 ? "+" : ""}${val ?? ""}`, odds: selection === "home" ? line?.spread_home_odds : line?.spread_away_odds };
  }
  return { label: team, odds: selection === "home" ? line?.moneyline_home : line?.moneyline_away };
}

// Step 2 -> 3: side chosen, open the stake modal directly (showModal() must
// be the immediate response to the interaction -- no reply/defer first).
export async function handleVegasSideButton(interaction) {
  const [, , lineId, market, selection] = interaction.customId.split(":");
  const line = await getLine(lineId);
  const minBet = line?.min_bet ?? 100;
  const maxBet = line?.max_bet ?? 1000;
  const { label: sideLabel, odds: sideOdds } = describeSideForModal(market, selection, line);

  const modal = new ModalBuilder()
    .setCustomId(`vegas:stake:${lineId}:${market}:${selection}`)
    .setTitle(`${sideLabel} @ ${fmtOdds(sideOdds)}`.slice(0, 45));

  const stakeInput = new TextInputBuilder()
    .setCustomId("stake")
    .setLabel(`Stake ($${minBet} - $${maxBet})`)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(String(minBet))
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(stakeInput));
  await interaction.showModal(modal);
}

// Step 3: stake submitted -- resolve the caller, place the bet, show the
// result. All validation (cutoff, min/max, balance, duplicate-this-week)
// lives server-side in placeBetOnLine; this just relays whatever it says.
export async function handleVegasStakeModal(interaction) {
  const [, , lineId, market, selection] = interaction.customId.split(":");
  const stake = Number(interaction.fields.getTextInputValue("stake"));

  // This modal is always opened from the side-button step (handleVegasSideButton),
  // so it's always "from a message" -- deferUpdate() + editReply() finishes the
  // edit on that same wizard message instead of deferReply()'s default of
  // opening yet another new ephemeral message. isFromMessage() is still
  // checked rather than assumed, so a future caller that isn't button-driven
  // degrades to a normal new reply instead of throwing.
  if (interaction.isFromMessage()) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ ephemeral: true });
  }

  if (!Number.isFinite(stake) || stake <= 0) {
    await interaction.editReply("Stake has to be a positive number.");
    return;
  }

  const member = await getMemberByDiscordId(interaction.user.id);
  if (!member?.username) {
    await interaction.editReply("Couldn't find your linked league account — ask a commissioner to link your Discord to a team.");
    return;
  }

  let result;
  try {
    result = await invokeFunction("placeBetOnLine", {
      line_id: lineId,
      username: member.username,
      discord_user_id: interaction.user.id,
      market,
      selection,
      stake,
    });
  } catch (err) {
    console.error("[VEGAS] placeBetOnLine call failed:", err.message);
    await interaction.editReply("Couldn't reach the Vault to place that bet — try again in a moment.");
    return;
  }

  if (result?.error) {
    await interaction.editReply(`❌ ${result.error}`);
    return;
  }

  const bet = result.bet;
  const line = await getLine(lineId);
  const teamAbbr =
    market !== "total" ? abbrFromName(selection === "home" ? line?.home_team : line?.away_team) : null;
  const description =
    market === "moneyline"
      ? `${bet.team_name} Moneyline`
      : market === "spread"
        ? `${bet.team_name} ${bet.line_value > 0 ? "+" : ""}${bet.line_value}`
        : `${selection === "over" ? "Over" : "Under"} ${bet.line_value}`;

  try {
    const png = await renderBetReceiptCard({
      headline: "BET PLACED",
      teamAbbr,
      description,
      stake: bet.stake,
      odds: bet.odds,
      status: "pending",
    });
    await interaction.editReply({
      content: `✅ Bet placed. New balance: $${result.balance}`,
      files: [{ attachment: png, name: "bet-receipt.png" }],
    });
  } catch (err) {
    // A bad logo fetch shouldn't hide a real, successful bet.
    console.error("[VEGAS] receipt card render failed:", err.message);
    await interaction.editReply(`✅ Bet placed: ${description} for $${bet.stake} @ ${bet.odds > 0 ? "+" : ""}${bet.odds}. New balance: $${result.balance}`);
  }
}

// /bet replies for itself -- "place" opens with a fresh interaction.reply
// (buttons), "mine" defers and edits (plain read) -- and so must NOT be
// routed through index.js's generic deferReply, same shape as
// submit_trade's. Both subcommands live under this one early-return case.
export async function handleBetCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "mine") {
    await handleMyBetsCommand(interaction);
    return;
  }
  const lineId = interaction.options.getString("line");
  await replyWithMarketButtons(interaction, lineId);
}

// /bet place skips straight to market choice (same first step the old
// public odds-card buttons used to start with) rather than duplicating the
// whole wizard inline.
async function replyWithMarketButtons(interaction, lineId) {
  const line = await getLine(lineId);
  if (!line) {
    await interaction.reply({ content: "That line doesn't exist or isn't open anymore.", ephemeral: true });
    return;
  }
  const buttons = [
    new ButtonBuilder().setCustomId(`vegas:mkt:${lineId}:moneyline`).setLabel("Moneyline").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vegas:mkt:${lineId}:spread`).setLabel("Point Spread").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vegas:mkt:${lineId}:total`).setLabel("Total").setStyle(ButtonStyle.Primary),
  ];
  const spreadAway = line.spread_home != null ? -line.spread_home : null;
  const odds =
    `Moneyline: ${line.away_team} ${fmtOdds(line.moneyline_away)} · ${line.home_team} ${fmtOdds(line.moneyline_home)}\n` +
    `Spread: ${line.away_team} ${spreadAway > 0 ? "+" : ""}${spreadAway ?? "—"} (${fmtOdds(line.spread_away_odds)}) · ` +
    `${line.home_team} ${line.spread_home > 0 ? "+" : ""}${line.spread_home ?? "—"} (${fmtOdds(line.spread_home_odds)})\n` +
    `Total: O ${line.total_line ?? "—"} (${fmtOdds(line.total_over_odds)}) · U ${line.total_line ?? "—"} (${fmtOdds(line.total_under_odds)})`;
  await interaction.reply({
    content: `**${line.away_team} @ ${line.home_team}** — pick a market:\n${odds}`,
    components: [new ActionRowBuilder().addComponents(buttons)],
    ephemeral: true,
  });
}

// What a bet backed, in plain English -- same shape as vegasCard.js's own
// describeBetSelection, duplicated rather than imported since that one
// works off abbreviations/the settlement card's own line context and this
// one has the full VegasLine row on hand already.
function describeBetSelection(bet, line) {
  if (bet.market === "total") {
    const side = bet.selection === "over" ? "Over" : "Under";
    return bet.line_value != null ? `${side} ${bet.line_value}` : side;
  }
  const team = bet.selection === "home" ? line?.home_team : line?.away_team;
  if (bet.market === "spread" && bet.line_value != null) {
    return `${team} ${bet.line_value > 0 ? "+" : ""}${bet.line_value}`;
  }
  return `${team} ML`;
}

const MY_BETS_SHOWN = 20;

async function handleMyBetsCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const member = await getMemberByDiscordId(interaction.user.id);
  if (!member?.username) {
    await interaction.editReply("Couldn't find your linked league account — ask a commissioner to link your Discord to a team.");
    return;
  }

  const [wallets, bets, lines] = await Promise.all([
    list("VegasWallet", { username: member.username }, { limit: 1, sort: "-season_number" }),
    list("VegasBet", { username: member.username, status: "pending" }, { limit: 100 }),
    list("VegasLine", {}, { limit: 500 }),
  ]);
  const wallet = wallets[0];
  const linesById = new Map(lines.map((l) => [l.id, l]));

  const embed = new EmbedBuilder()
    .setTitle(`${memberDisplayName(member)}'s Sportsbook`)
    .setColor(0xd4a843);

  if (wallet) {
    const eligible = (wallet.bets_placed ?? 0) >= 20;
    embed.addFields(
      { name: "Balance", value: `$${wallet.balance}`, inline: true },
      { name: "Bets this season", value: `${wallet.bets_placed ?? 0}${eligible ? " ✅ eligible" : " / 20 for prizes"}`, inline: true }
    );
  } else {
    embed.addFields({ name: "Balance", value: "No wallet yet", inline: true });
  }

  if (!bets.length) {
    embed.addFields({ name: "Open bets", value: "None right now." });
  } else {
    const shown = bets.slice(0, MY_BETS_SHOWN);
    const rows = shown.map((bet) => {
      const line = linesById.get(bet.line_id);
      const matchup = line ? `${line.away_team} @ ${line.home_team}` : "Unknown matchup";
      const profit = (bet.potential_payout ?? bet.stake) - bet.stake;
      return `• ${matchup} — ${describeBetSelection(bet, line)}, $${bet.stake} to win $${profit.toFixed(0)}`;
    });
    if (bets.length > shown.length) rows.push(`…+${bets.length - shown.length} more`);
    embed.addFields({ name: `Open bets (${bets.length})`, value: rows.join("\n").slice(0, 1024) });
  }

  await interaction.editReply({ embeds: [embed] });
}
