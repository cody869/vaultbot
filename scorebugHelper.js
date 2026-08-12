// scorebugHelper.js
//
// Turns a getScores() result into a set of Discord attachments -- one
// scorebug card per completed game. Reuses abbrFromName (emoji.js) so team
// name resolution stays in the one place the rest of the bot already trusts,
// rather than re-guessing it here.

import { AttachmentBuilder } from "discord.js";
import { renderScorebugCard } from "./scorebugCard.js";
import { abbrFromName } from "./emoji.js";

// Discord allows up to 10 file attachments per message. A full week's slate
// can run past that, so cards are capped and the rest still show up in the
// text embed as usual -- nothing is silently dropped, just not imaged.
const MAX_CARDS_PER_MESSAGE = 10;

// A game is "final" once it has real scores -- but this league's export
// uses 0-0 as the not-yet-played placeholder, not null, so a null check
// alone isn't enough. A genuine 0-0 final is effectively impossible in
// football, so treating 0-0 as "not played" is a safe, simple signal given
// there's no separate played/unplayed flag in the data.
export function isGameFinal(scoreA, scoreB) {
  if (scoreA == null || scoreB == null) return false;
  if (scoreA === 0 && scoreB === 0) return false;
  return true;
}

function recordFor(standingsRows, teamAbbr) {
  const row = standingsRows.find(
    (r) => (r.team_abbrName || "").toUpperCase() === teamAbbr
  );
  if (!row) return undefined;
  const { wins = 0, losses = 0, ties = 0 } = row;
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

/**
 * @param {{season: number, week: number, games: Array}} scoresData - from getScores()
 * @param {Array} standingsRows - from (await getStandings(scoresData.season)).rows
 * @returns {Promise<import('discord.js').AttachmentBuilder[]>}
 */
export async function buildScorebugAttachments(scoresData, standingsRows) {
  const { week, games } = scoresData;
  const attachments = [];

  for (const g of games) {
    if (attachments.length >= MAX_CARDS_PER_MESSAGE) break;
    // Only completed games have a real final score to show.
    if (!isGameFinal(g.homeScore, g.awayScore)) continue;

    const homeAbbr = abbrFromName(g.home);
    const awayAbbr = abbrFromName(g.away);
    if (!homeAbbr || !awayAbbr) {
      console.warn(`[SCOREBUG] could not resolve abbreviation for "${g.home}" / "${g.away}", skipping card`);
      continue;
    }

    // Winner goes on the left (teamA), matching the design's winner/loser
    // color and layout convention. Ties fall back to home-left.
    const homeWon = g.homeScore >= g.awayScore;
    const teamA = homeWon
      ? { abbr: homeAbbr, score: g.homeScore, record: recordFor(standingsRows, homeAbbr) }
      : { abbr: awayAbbr, score: g.awayScore, record: recordFor(standingsRows, awayAbbr) };
    const teamB = homeWon
      ? { abbr: awayAbbr, score: g.awayScore, record: recordFor(standingsRows, awayAbbr) }
      : { abbr: homeAbbr, score: g.homeScore, record: recordFor(standingsRows, homeAbbr) };

    try {
      const png = await renderScorebugCard({ week, teamA, teamB });
      attachments.push(
        new AttachmentBuilder(png, {
          name: `scorebug-${awayAbbr}-${homeAbbr}-wk${week ?? "x"}.png`,
        })
      );
    } catch (err) {
      // One bad logo fetch or render shouldn't take down the whole /scores
      // reply -- log it and just skip that game's card.
      console.error(`[SCOREBUG] render failed for ${g.away} @ ${g.home}:`, err.message);
    }
  }

  return attachments;
}
