// scheduleParser.js — turns a free-text #schedule channel post into a
// structured guess at day/time/forfeit status. Regex/keyword only, no AI
// call and no Discord/Base44 dependency, so it's trivial to unit test.
//
// Handles the shapes seen in the schedule channel:
//   "9 pm est"              -> scheduled, 9:00 PM EST
//   "11pm  est Friday"      -> scheduled, 11:00 PM EST Friday
//   "930pm EST"             -> scheduled, 9:30 PM EST
//   "10a est Sunday"        -> scheduled, 10:00 AM EST Sunday
//   "FW"                    -> forfeit
//   "Sat afternoon ish or FW" -> needs_review (conflicting signals: a
//                                 vague time AND a forfeit mention)
//   "Sat afternoon ish"     -> needs_review (day known, no exact time)
//   anything unrecognized   -> needs_review
//
// When no day name is found in the text, `day` defaults to the day the
// message was posted (league default timezone, since that's the timezone
// everyone in the channel is implicitly working in) — a bare "9pm est"
// with no day means "tonight" by the same convention the league already
// uses when people post without a date.

const DAY_PATTERNS = [
  [/\bmonday\b/i, "Monday"], [/\bmon\b/i, "Monday"],
  [/\btuesday\b/i, "Tuesday"], [/\btues?\b/i, "Tuesday"],
  [/\bwednesday\b/i, "Wednesday"], [/\bwed\b/i, "Wednesday"],
  [/\bthursday\b/i, "Thursday"], [/\bthurs?\b/i, "Thursday"],
  [/\bfriday\b/i, "Friday"], [/\bfri\b/i, "Friday"],
  [/\bsaturday\b/i, "Saturday"], [/\bsat\b/i, "Saturday"],
  [/\bsunday\b/i, "Sunday"], [/\bsun\b/i, "Sunday"],
];

const TZ_MAP = {
  est: "EST", edt: "EST", et: "EST",
  cst: "CST", cdt: "CST", ct: "CST",
  mst: "MST", mdt: "MST", mt: "MST",
  pst: "PST", pdt: "PST", pt: "PST",
};

const VAGUE_RE = /\b(ish|tbd|tba|whenever|sometime|morning|afternoon|evening|tonight)\b/i;
const FW_RE = /\bFW\b/; // case-sensitive on purpose — league shorthand is always caps
const FORFEIT_WORD_RE = /\bforfeit\b/i;
const WEEK_RE = /\bweek\s*#?\s*(\d{1,2})\b/i;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// League's implicit timezone for "today" — matches the TZ_MAP default used
// elsewhere when a time is given with no zone.
const LEAGUE_TZ = "America/New_York";

function currentWeekdayName(postedAt) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: LEAGUE_TZ, weekday: "long" }).format(postedAt);
  return WEEKDAY_NAMES.includes(weekday) ? weekday : null;
}

// "930pm", "1030pm" — 3-4 digits directly against am/pm, no separator.
const COMPACT_TIME_RE = /\b(\d{3,4})\s*(am|pm)\b/i;
// "9 pm", "11pm", "9:30 pm" — 1-2 digit hour, optional :mm, optional space.
const SPACED_TIME_RE = /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/i;
// "10a", "7p", "10:30a" — single-letter shorthand for am/pm. Requires the
// letter directly attached to the digits (no space) — that's how the
// shorthand is actually written, and it rules out a stray standalone "a"
// elsewhere in the sentence (e.g. "need a bit more time") from being
// mis-read as AM just because a number appeared earlier in the message.
const SHORT_TIME_RE = /\b(\d{1,2})(?::([0-5]\d))?([ap])\b/i;

function to24Hour(h12, ampmToken) {
  let h = h12 % 12;
  if (/^p/i.test(ampmToken)) h += 12; // matches "pm" or the "p" shorthand
  return h;
}

function formatClock(hour24, minute) {
  const period = hour24 >= 12 ? "PM" : "AM";
  let h12 = hour24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
}

function extractClockTime(content) {
  const compact = content.match(COMPACT_TIME_RE);
  if (compact) {
    const digits = compact[1];
    const ampm = compact[2];
    let h, m;
    if (digits.length === 3) {
      h = parseInt(digits[0], 10);
      m = parseInt(digits.slice(1), 10);
    } else {
      h = parseInt(digits.slice(0, 2), 10);
      m = parseInt(digits.slice(2), 10);
    }
    if (h >= 1 && h <= 12 && m >= 0 && m <= 59) {
      return { hour24: to24Hour(h, ampm), minute: m };
    }
  }

  const spaced = content.match(SPACED_TIME_RE);
  if (spaced) {
    const h = parseInt(spaced[1], 10);
    const m = spaced[2] ? parseInt(spaced[2], 10) : 0;
    const ampm = spaced[3];
    if (h >= 1 && h <= 12) {
      return { hour24: to24Hour(h, ampm), minute: m };
    }
  }

  // Fallback: single-letter shorthand ("10a", "7p"). Only reached if
  // neither full am/pm pattern above matched, so "10am" is never
  // mis-parsed as this branch — the "\b" after the single letter also
  // rules out accidentally matching the start of an unrelated word (e.g.
  // "4 away" doesn't match, since "a" there isn't followed by a boundary).
  const short = content.match(SHORT_TIME_RE);
  if (short) {
    const h = parseInt(short[1], 10);
    const m = short[2] ? parseInt(short[2], 10) : 0;
    const ampm = short[3];
    if (h >= 1 && h <= 12) {
      return { hour24: to24Hour(h, ampm), minute: m };
    }
  }

  return { hour24: null, minute: null };
}

/**
 * @param {string} rawContent - the Discord message content
 * @param {Date} [postedAt] - when the message was posted; used only to
 *   default `day` when the text doesn't name one. Defaults to now.
 * @returns {{
 *   weekNumber: number|null,
 *   status: 'scheduled'|'forfeit'|'needs_review',
 *   timeText: string|null,
 *   day: string|null,
 *   hour24: number|null,
 *   minute: number|null,
 *   timezone: string|null,
 *   fwIndex: number|null   // char offset of the FW/forfeit match, for the
 *                           // caller to scan for a winner-team emoji after it
 * }}
 */
export function parseScheduleMessage(rawContent, postedAt = new Date()) {
  const content = rawContent || "";

  const weekMatch = content.match(WEEK_RE);
  const weekNumber = weekMatch ? parseInt(weekMatch[1], 10) : null;

  const fwMatch = content.match(FW_RE) || content.match(FORFEIT_WORD_RE);
  const hasFW = Boolean(fwMatch);
  const fwIndex = fwMatch ? fwMatch.index : null;

  const { hour24, minute } = extractClockTime(content);

  const tzMatch = content.match(/\b(est|edt|et|cst|cdt|ct|mst|mdt|mt|pst|pdt|pt)\b/i);
  let timezone = tzMatch ? TZ_MAP[tzMatch[1].toLowerCase()] : null;

  let day = null;
  for (const [re, label] of DAY_PATTERNS) {
    if (re.test(content)) {
      day = label;
      break;
    }
  }
  const explicitDay = day; // keep the raw text match separate from the default below

  const vagueMatch = content.match(VAGUE_RE);

  let status;
  let timeText;

  if (hasFW && hour24 == null) {
    status = "forfeit";
    timeText = "FW (forfeit win)";
  } else if (hasFW && hour24 != null) {
    // Conflicting signals in one message (e.g. "Sat afternoon ish or FW") —
    // don't guess which one is meant, flag for a human.
    status = "needs_review";
    timeText = `Ambiguous — mentions both a time (${formatClock(hour24, minute)} ${timezone || "EST"}) and FW`;
  } else if (hour24 != null) {
    // A time was found but no day named — default to the day this was
    // posted (league timezone), same convention as "9pm est" meaning
    // "tonight" when someone says it out loud with no date attached.
    day = explicitDay || currentWeekdayName(postedAt);
    status = "scheduled";
    timezone = timezone || "EST";
    timeText = `${formatClock(hour24, minute)} ${timezone}${day ? ` ${day}` : ""}`;
  } else if (explicitDay || vagueMatch) {
    // Some schedule-related signal (a day name or a vague qualifier like
    // "afternoon") but no exact time — still default a missing day here,
    // since "afternoon ish" with no day also implicitly means today.
    day = explicitDay || currentWeekdayName(postedAt);
    status = "needs_review";
    const parts = [];
    if (day) parts.push(day);
    if (vagueMatch) parts.push(vagueMatch[1]);
    timeText = parts.join(" ") || null;
  } else {
    status = "needs_review";
    timeText = null;
  }

  return { weekNumber, status, timeText, day, hour24, minute, timezone, fwIndex };
}
