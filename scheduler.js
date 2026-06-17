// scheduler.js — optional automatic posting of standings / scores / power
// rankings to a channel on a weekly schedule. Entirely env-configured:
//
//   AUTOPOST_CHANNEL_ID   Discord channel id to post into (required to enable)
//   AUTOPOST_DAY          day of week 0-6 (0=Sun) to post on        (default 1 = Mon)
//   AUTOPOST_HOUR         hour 0-23 in the bot's timezone            (default 12)
//   AUTOPOST_CONTENT      comma list of: standings,scores,power      (default "standings,scores")
//   TZ                    standard env var to set timezone (e.g. America/Los_Angeles)
//
// If AUTOPOST_CHANNEL_ID is unset, the scheduler does nothing.

import { getStandings, getScores, getPowerRankings, getScoresSignature } from "./vault.js";
import {
  standingsEmbed,
  scoresEmbed,
  powerRankingsEmbed,
} from "./embeds.js";
import { readFileSync, writeFileSync } from "node:fs";

// Where we remember the last-posted score signature. Railway's filesystem is
// ephemeral (resets on redeploy), which is fine: after a redeploy the bot will
// post once to catch up, then track changes from there.
const STATE_FILE = process.env.AUTOPOST_STATE_FILE || "/tmp/xcfl-autopost.json";

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (err) {
    console.error("Autopost: could not persist state:", err.message);
  }
}

function cfg() {
  // AUTOPOST_DAY may be a single day ("1") or a comma list ("0,1,2,3,4,5,6").
  // Empty/unset defaults to Monday. "*" or "all" means every day.
  const rawDay = (process.env.AUTOPOST_DAY ?? "1").trim();
  let days;
  if (rawDay === "*" || rawDay.toLowerCase() === "all") {
    days = [0, 1, 2, 3, 4, 5, 6];
  } else {
    days = rawDay
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    if (!days.length) days = [1];
  }

  return {
    channelId: process.env.AUTOPOST_CHANNEL_ID,
    days,
    hour: Number.isFinite(+process.env.AUTOPOST_HOUR) ? +process.env.AUTOPOST_HOUR : 12,
    content: (process.env.AUTOPOST_CONTENT || "standings,scores")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    // When true (default), skip posting if there are no new game results since
    // the last post. Set AUTOPOST_ONLY_ON_CHANGE=false to always post.
    onlyOnChange:
      (process.env.AUTOPOST_ONLY_ON_CHANGE ?? "true").toLowerCase() !== "false",
  };
}

// Build the embeds for the configured content list.
async function buildEmbeds(content) {
  const embeds = [];
  for (const item of content) {
    try {
      if (item === "standings") embeds.push(standingsEmbed(await getStandings()));
      else if (item === "scores") embeds.push(scoresEmbed(await getScores()));
      else if (item === "power") embeds.push(powerRankingsEmbed(await getPowerRankings()));
    } catch (err) {
      console.error(`Autopost: failed to build ${item}:`, err.message);
    }
  }
  return embeds;
}

async function post(client, content) {
  const { channelId, onlyOnChange } = cfg();
  if (!channelId) return;

  // If gating on change, compare the current score signature to last posted.
  let currentSig = null;
  if (onlyOnChange) {
    try {
      currentSig = await getScoresSignature();
      const state = loadState();
      if (currentSig && state.lastSignature === currentSig) {
        console.log("⏰ Autopost skipped: no new scores since last post.");
        return;
      }
    } catch (err) {
      console.error("Autopost: signature check failed, posting anyway:", err.message);
    }
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error("Autopost: channel not found or not text-based.");
      return;
    }
    const embeds = await buildEmbeds(content);
    if (embeds.length) {
      // Discord allows up to 10 embeds per message.
      await channel.send({ embeds: embeds.slice(0, 10) });
      console.log(`📤 Autoposted: ${content.join(", ")}`);
      // Persist the signature only after a successful send.
      if (onlyOnChange && currentSig) {
        const state = loadState();
        saveState({
          ...state,
          lastSignature: currentSig,
          lastPostedAt: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    console.error("Autopost: send failed:", err.message);
  }
}

// Start the scheduler. Checks once a minute; fires when the configured day+hour
// is hit, and guards against double-posting within the same hour.
export function startScheduler(client) {
  const { channelId } = cfg();
  if (!channelId) {
    console.log("⏰ Auto-posting disabled (set AUTOPOST_CHANNEL_ID to enable).");
    return;
  }

  let lastFiredKey = null;
  const tick = () => {
    const { days, hour, content } = cfg();
    const now = new Date();
    if (days.includes(now.getDay()) && now.getHours() === hour) {
      // Only fire once per scheduled hour.
      const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${hour}`;
      if (key !== lastFiredKey) {
        lastFiredKey = key;
        post(client, content);
      }
    }
  };

  // Check every minute.
  setInterval(tick, 60_000);
  const { days, hour, content } = cfg();
  console.log(
    `⏰ Auto-posting enabled: days [${days.join(",")}], hour ${hour}, content "${content.join(",")}".`
  );
}

// Exposed so a manual command could trigger a post too, if desired later.
export async function postNow(client) {
  await post(client, cfg().content);
}
