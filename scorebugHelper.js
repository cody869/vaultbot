// scorebugHelper.js
//
// Turns a getScores() result into a set of Discord attachments -- one
// scorebug card per completed game. Reuses abbrFromName (emoji.js) so team
// name resolution stays in the one place the rest of the bot already trusts,
// rather than re-guessing it here.

import { AttachmentBuilder } from "discord.js";
import { renderScorebugCard } from "./scorebugCard.js";
import { abbrFromName } from "./emoji.js";
import { list } from "./vault.js";

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

// Game.scheduleId links to WeeklyStats.schedule_id -- confirmed against the
// live entity schemas, not guessed. team_abbrName lives directly on each
// WeeklyStats row (no roster join needed).
//
// Server-side filters aren't always honored (same caveat vault.js's other
// readers work around), so this tries a narrow request first and re-checks
// every row in memory regardless -- a false-positive from an ignored filter
// never slips through. Shared by getGameContributors() and
// getGameStatsCompleteness() so a caller checking both only fetches once.
async function fetchGameStatsRows(scheduleId, cycle) {
  if (scheduleId == null) return [];

  let rows;
  try {
    rows = await list("WeeklyStats", { schedule_id: scheduleId });
    rows = rows.filter((r) => r.schedule_id === scheduleId);
  } catch (err) {
    console.error(`[SCOREBUG] WeeklyStats fetch failed: ${err.message}`);
    return [];
  }

  if (!rows.length) {
    // Narrow filter came back empty -- Base44 filters aren't always
    // honored, so fall back to a cycle-scoped broad fetch and filter here.
    try {
      const broad = await list("WeeklyStats", { cycle }, { limit: 5000 });
      rows = broad.filter((r) => r.schedule_id === scheduleId);
    } catch (err) {
      console.error(`[SCOREBUG] WeeklyStats broad fetch failed: ${err.message}`);
      return [];
    }
  }
  return rows;
}

// The four categories a game's stat sync needs before a scorebug is safe to
// post, and the field that proves each one actually landed. One qualifying
// row is enough per category -- a real NFL game always has SOME player with
// a pass attempt, a rush attempt, a catch, and a tackle, so an empty
// category here means the export sync hasn't finished, not that the
// category was legitimately empty. Field names match fantasyConfig.js's
// STAT_FIELDS primary keys (verified against the live WeeklyStats schema).
const COMPLETENESS_FIELDS = {
  passing: "pass_att",
  rushing: "rush_att",
  receiving: "rec_catches",
  defense: "def_total_tackles",
};

/**
 * Whether every one of passing/rushing/receiving/defense has synced into
 * WeeklyStats for this game yet. Used to hold a scorebug post back rather
 * than send it with an incomplete stat strip -- confirmed live: cards were
 * going out before all four categories had landed.
 */
export async function getGameStatsCompleteness(scheduleId, cycle) {
  const rows = await fetchGameStatsRows(scheduleId, cycle);
  const missing = Object.entries(COMPLETENESS_FIELDS)
    .filter(([, field]) => !rows.some((r) => (r[field] ?? 0) > 0))
    .map(([name]) => name);
  return { complete: missing.length === 0, missing };
}

// Top passer/rusher/receiver for one game, read from WeeklyStats.
export async function getGameContributors(scheduleId, cycle) {
  const rows = await fetchGameStatsRows(scheduleId, cycle);
  if (!rows.length) return [];

  const topBy = (field, qualifyField) => {
    const qualifying = rows.filter((r) => (r[qualifyField] ?? 0) > 0);
    if (!qualifying.length) return null;
    return qualifying.reduce((best, r) =>
      (r[field] ?? 0) > (best[field] ?? 0) ? r : best
    );
  };

  const contributors = [];

  const passer = topBy("pass_yds", "pass_att");
  if (passer) {
    contributors.push({
      name: passer.player_full_name,
      team: passer.team_abbrName,
      line: `${passer.pass_yds ?? 0} yds · ${passer.pass_tds ?? 0} TD · ${passer.pass_ints ?? 0} INT`,
    });
  }

  const rusher = topBy("rush_yds", "rush_att");
  if (rusher) {
    contributors.push({
      name: rusher.player_full_name,
      team: rusher.team_abbrName,
      line: `${rusher.rush_yds ?? 0} yds · ${rusher.rush_tds ?? 0} TD · ${rusher.rush_att ?? 0} car`,
    });
  }

  const receiver = topBy("rec_yds", "rec_catches");
  if (receiver) {
    contributors.push({
      name: receiver.player_full_name,
      team: receiver.team_abbrName,
      line: `${receiver.rec_catches ?? 0} rec · ${receiver.rec_yds ?? 0} yds · ${receiver.rec_tds ?? 0} TD`,
    });
  }

  return contributors;
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
      const contributors = await getGameContributors(g.scheduleId, g.cycle);
      const png = await renderScorebugCard({ week, teamA, teamB, contributors });
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
