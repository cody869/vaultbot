// vegasCommands.js — /bet, /wallet, and the button->button->modal wizard
// that places a bet, for the in-house "Vegas" sportsbook.
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
    .setDescription("Place a bet on an open Vegas line")
    .addStringOption((o) =>
      o
        .setName("line")
        .setDescription("Start typing a matchup, then pick from the list")
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName("wallet")
    .setDescription("Show your current-season Vegas balance"),
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

// Step 1 -> 2: market chosen (from the odds card or /bet), show side buttons.
async function replyWithSideButtons(interaction, lineId, market) {
  const line = await getLine(lineId);
  if (!line) {
    await interaction.reply({ content: "That line no longer exists.", ephemeral: true });
    return;
  }
  if (line.status !== "open") {
    await interaction.reply({ content: `This line is ${line.status}, not open for betting.`, ephemeral: true });
    return;
  }

  const buttons =
    market === "total"
      ? [
          new ButtonBuilder().setCustomId(`vegas:side:${lineId}:total:over`).setLabel(`Over ${line.total_line ?? ""}`).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`vegas:side:${lineId}:total:under`).setLabel(`Under ${line.total_line ?? ""}`).setStyle(ButtonStyle.Secondary),
        ]
      : [
          new ButtonBuilder().setCustomId(`vegas:side:${lineId}:${market}:away`).setLabel(`Bet on ${line.away_team}`).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`vegas:side:${lineId}:${market}:home`).setLabel(`Bet on ${line.home_team}`).setStyle(ButtonStyle.Secondary),
        ];

  await interaction.reply({
    content: `**${line.away_team} @ ${line.home_team}** — ${market === "moneyline" ? "Moneyline" : market === "spread" ? "Point Spread" : "Total"}. Pick a side:`,
    components: [new ActionRowBuilder().addComponents(buttons)],
    ephemeral: true,
  });
}

export async function handleVegasMarketButton(interaction) {
  const [, , lineId, market] = interaction.customId.split(":");
  await replyWithSideButtons(interaction, lineId, market);
}

// Step 2 -> 3: side chosen, open the stake modal directly (showModal() must
// be the immediate response to the interaction -- no reply/defer first).
export async function handleVegasSideButton(interaction) {
  const [, , lineId, market, selection] = interaction.customId.split(":");
  const line = await getLine(lineId);
  const minBet = line?.min_bet ?? 100;
  const maxBet = line?.max_bet ?? 1000;

  const modal = new ModalBuilder()
    .setCustomId(`vegas:stake:${lineId}:${market}:${selection}`)
    .setTitle("Place your bet");

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

  await interaction.deferReply({ ephemeral: true });

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

// /bet replies for itself (a fresh interaction.reply with buttons) and must
// NOT be routed through index.js's generic deferReply -- called as its own
// early-return special case, same shape as submit_trade's. /wallet goes
// through the normal deferred switch (handleVegasCommand below), same as
// every other read-only command.
export async function handleBetCommand(interaction) {
  const lineId = interaction.options.getString("line");
  await replyWithMarketButtons(interaction, lineId);
}

export async function handleVegasCommand(interaction) {
  if (interaction.commandName === "wallet") {
    await handleWalletCommand(interaction);
  }
}

// /bet skips straight to market choice (same first step the odds card's
// buttons start with) rather than duplicating the whole wizard inline.
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
  await interaction.reply({
    content: `**${line.away_team} @ ${line.home_team}** — pick a market:`,
    components: [new ActionRowBuilder().addComponents(buttons)],
    ephemeral: true,
  });
}

async function handleWalletCommand(interaction) {
  const member = await getMemberByDiscordId(interaction.user.id);
  if (!member?.username) {
    await interaction.editReply("Couldn't find your linked league account — ask a commissioner to link your Discord to a team.");
    return;
  }
  const wallets = await list("VegasWallet", { username: member.username }, { limit: 1, sort: "-season_number" });
  const wallet = wallets[0];
  if (!wallet) {
    await interaction.editReply(`No Vegas wallet found for ${memberDisplayName(member)} yet.`);
    return;
  }
  const eligible = (wallet.bets_placed ?? 0) >= 20;
  const embed = new EmbedBuilder()
    .setTitle(`${memberDisplayName(member)}'s Wallet`)
    .setColor(0xd4a843)
    .addFields(
      { name: "Balance", value: `$${wallet.balance}`, inline: true },
      { name: "Bets this season", value: `${wallet.bets_placed ?? 0}${eligible ? " ✅ eligible" : " / 20 for prizes"}`, inline: true }
    );
  await interaction.editReply({ embeds: [embed] });
}
