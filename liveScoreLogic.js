// liveScoreLogic.js — pure rules for trusting a scorebug reading.
//
// The vision read of a stream frame is usually right, but a single frame can
// be misread (a replay, a transition, a digit half-drawn). A reading is
// accepted straight away when it moves the game forward sensibly. Anything
// suspicious — a score going DOWN, the quarter going backwards, or one team
// jumping by more than one score at once — is held as "pending" and only
// accepted if the very next reading says the same thing.
//
// No I/O here so it can be unit-tested (liveScoreLogic.test.js).

// Largest single score: touchdown + two-point conversion.
export const MAX_ONE_READ_JUMP = 8;

const QUARTER_ORDER = { "1st": 1, "2nd": 2, half: 2.5, halftime: 2.5, "3rd": 3, "4th": 4, ot: 5, final: 6 };

/** Sort key for a quarter label ("1st", "2nd", "Half", "OT", "Final"...), or null if unknown. */
export function quarterRank(q) {
  if (!q) return null;
  const k = String(q).trim().toLowerCase();
  return QUARTER_ORDER[k] ?? null;
}

const sameScore = (a, b) => !!a && !!b && a.away_score === b.away_score && a.home_score === b.home_score
  && (quarterRank(a.quarter) ?? -1) === (quarterRank(b.quarter) ?? -1);

/**
 * Decide what to do with one reading.
 * @param {object|null} prev    last accepted { away_score, home_score, quarter }
 * @param {object|null} pending last suspicious reading waiting for confirmation
 * @param {object} reading      { scorebug_visible, away_score, home_score, quarter, ... }
 * @returns {{ accept: boolean, pending: object|null, state: 'live'|'no_scorebug', reason: string }}
 */
export function judgeReading(prev, pending, reading) {
  const visible = reading && reading.scorebug_visible
    && Number.isInteger(reading.away_score) && Number.isInteger(reading.home_score)
    && reading.away_score >= 0 && reading.home_score >= 0;
  if (!visible) return { accept: false, pending, state: "no_scorebug", reason: "no readable scorebug" };

  if (!prev) return { accept: true, pending: null, state: "live", reason: "first reading" };

  const dAway = reading.away_score - prev.away_score;
  const dHome = reading.home_score - prev.home_score;
  const qPrev = quarterRank(prev.quarter);
  const qNow = quarterRank(reading.quarter);
  const problems = [];
  if (dAway < 0 || dHome < 0) problems.push("score went down");
  if (dAway > MAX_ONE_READ_JUMP || dHome > MAX_ONE_READ_JUMP) problems.push("jump bigger than one score");
  if (qPrev != null && qNow != null && qNow < qPrev) problems.push("quarter went backwards");

  if (!problems.length) return { accept: true, pending: null, state: "live", reason: "consistent" };
  if (sameScore(pending, reading)) return { accept: true, pending: null, state: "live", reason: `confirmed (${problems.join(", ")})` };
  return { accept: false, pending: reading, state: "live", reason: `held for confirmation: ${problems.join(", ")}` };
}
