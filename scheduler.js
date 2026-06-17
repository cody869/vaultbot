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

import { getStandings, getScores, getPowerRankings } from "./vault.js";
import {
  standingsEmbed,
  scoresEmbed,
  powerRankingsEmbed,
} from "./embeds.js";

function cfg() {
  return {
    channelId: process.env.AUTOPOST_CHANNEL_ID,
    day: Number.isFinite(+process.env.AUTOPOST_DAY) ? +process.env.AUTOPOST_DAY : 1,
    hour: Number.isFinite(+process.env.AUTOPOST_HOUR) ? +process.env.AUTOPOST_HOUR : 12,
    content: (process.env.AUTOPOST_CONTENT || "standings,scores")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
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
  const { channelId } = cfg();
  if (!channelId) return;
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
    const { day, hour, content } = cfg();
    const now = new Date();
    if (now.getDay() === day && now.getHours() === hour) {
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
  const { day, hour } = cfg();
  console.log(
    `⏰ Auto-posting enabled: day ${day}, hour ${hour}, content "${cfg().content.join(",")}".`
  );
}

// Exposed so a manual command could trigger a post too, if desired later.
export async function postNow(client) {
  await post(client, cfg().content);
}
