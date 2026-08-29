// weeklyDigestWatcher.js — posts a WeeklyDigest recap card to the scorebug
// channel once an admin publishes it in the app.
//
// Mirrors news.js's poll/claim pattern: the RECORD is the lock (stamp
// discord_message_id with a claim token, re-read to confirm ownership before
// sending), not an in-memory Set -- an in-memory guard empties on every
// Railway restart, which is exactly the bug that pattern exists to avoid.
// No bulk-reimport risk here (unlike Game/ScorebugPost) since WeeklyDigest
// is only ever written by an admin publishing one, so writing
// discord_message_id/posted_to_discord directly onto the record is safe.
//
// Environment:
//   SCOREBUG_CHANNEL_ID         same channel scorebugWatcher.js posts to (shared)
//   WEEKLYDIGEST_POLL_SECONDS   optional — default 300 (5 min; published rarely,
//                                by a human, no need to poll fast)
//   WEEKLYDIGEST_SEED_HOURS     optional — default 24 (first-boot backlog grace window)
//
// Two card sections read fields that don't exist on the WeeklyDigest schema
// yet -- both read defensively (empty/absent = section just doesn't render),
// so no code change is needed here once the app adds them, only a schema
// update on the Base44 side matching these exact names:
//   player_dev_upgrades  array of {player_fullName, team_name, from_trait, to_trait}
//   next_game_of_week    {home_team, away_team, blurb}

import { AttachmentBuilder } from "discord.js";
import { list, updateEntity, pollCached } from "./vault.js";
import { isRateLimited } from "./base44Pacer.js";
import { renderWeeklyDigestCard } from "./weeklyDigestCard.js";

const ENTITY = "WeeklyDigest";
const CHANNEL_ID = process.env.SCOREBUG_CHANNEL_ID || "478919775163252736";
const POLL_MS = Number(process.env.WEEKLYDIGEST_POLL_SECONDS || 300) * 1000;
const SEED_HOURS = Number(process.env.WEEKLYDIGEST_SEED_HOURS || 24);

// Articles we've already handled this process, so a slow post can't be
// picked up twice by the next tick.
const handled = new Set();

// --- posting -----------------------------------------------------------

// Same "record is the lock" pattern as news.js's claim().
async function claim(d) {
  const token = `posting:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  await updateEntity(ENTITY, d.id, { discord_message_id: token });

  const [fresh] = (await list(ENTITY, { id: d.id }, { limit: 1 })) || [];
  const current = fresh?.discord_message_id;
  if (current !== token) {
    console.log(`[DIGEST] claim lost for ${d.id} (now ${current}) — another instance has it`);
    return null;
  }
  return token;
}

async function postDigest(client, d) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel?.isTextBased?.()) {
    throw new Error(`SCOREBUG_CHANNEL_ID ${CHANNEL_ID} is not a text channel`);
  }

  // Take the lock BEFORE rendering/sending. If we don't win it, do nothing.
  const token = await claim(d);
  if (!token) return;

  let msg;
  try {
    const png = await renderWeeklyDigestCard({
      week: d.week,
      seasonNumber: d.season_number,
      headline: d.headline,
      summary: d.summary,
      topGame: d.top_game && {
        homeTeam: d.top_game.home_team,
        awayTeam: d.top_game.away_team,
        homeScore: d.top_game.home_score,
        awayScore: d.top_game.away_score,
        homeOwner: d.top_game.home_owner,
        awayOwner: d.top_game.away_owner,
      },
      statLeaders: (d.stat_leaders || []).map((s) => ({
        category: s.category,
        playerFullName: s.player_fullName,
        teamName: s.team_name,
        statLine: s.stat_line,
      })),
      storylines: d.storylines || [],
      // Neither field exists on the schema yet -- read defensively (||  [])
      // so these sections just don't render until the app adds them, no
      // further code change needed here when it does.
      devUpgrades: (d.player_dev_upgrades || []).map((u) => ({
        playerFullName: u.player_fullName,
        teamName: u.team_name,
        fromTrait: u.from_trait,
        toTrait: u.to_trait,
      })),
      nextGame: d.next_game_of_week && {
        homeTeam: d.next_game_of_week.home_team,
        awayTeam: d.next_game_of_week.away_team,
        blurb: d.next_game_of_week.blurb,
      },
    });
    const filename = `weekly-digest-${d.season_number ?? "x"}-wk${d.week ?? "x"}.png`;
    const file = new AttachmentBuilder(png, { name: filename });

    // Card only, no accompanying text -- narrative/dev_upgrades/speed_upgrades/
    // trades_count/suspensions_count are not shown anywhere in this post.
    msg = await channel.send({ files: [file] });
  } catch (err) {
    // Send failed after we claimed — release the claim so a later tick retries.
    await updateEntity(ENTITY, d.id, { discord_message_id: "" }).catch(() => {});
    throw err;
  }

  const finalUpdate = {
    discord_message_id: msg.id,
    posted_to_discord: true,
  };
  let saved = false;
  for (let attempt = 1; attempt <= 3 && !saved; attempt++) {
    try {
      await updateEntity(ENTITY, d.id, finalUpdate);
      saved = true;
    } catch (err) {
      console.warn(`[DIGEST] stamp attempt ${attempt} failed for ${d.id}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  if (!saved) {
    // The message is live but the flags couldn't persist. Leave the claim
    // token in place (NOT empty) so the watcher treats it as handled and
    // never reposts.
    console.error(`[DIGEST] could not persist post flags for ${d.id}; left claim token to prevent a repost`);
  }

  console.log(`[DIGEST] posted "${d.headline}" (week ${d.week}, ${d.id}) → ${msg.id}`);
}

// --- watcher -------------------------------------------------------------

async function fetchDigests(limit = 50) {
  return pollCached(`weeklydigest:${limit}`, POLL_MS - 5_000, () =>
    list(ENTITY, {}, { sort: "-generated_at", limit })
  );
}

function generatedTime(d) {
  return new Date(d.generated_at || d.created_date || 0).getTime();
}

async function tick(client, { seed = false } = {}) {
  // An app-wide Base44 pause is in effect (see base44Pacer.js) -- sit this
  // tick out rather than piling onto it. The next tick checks again.
  if (isRateLimited()) return;

  let rows;
  try {
    rows = await fetchDigests();
  } catch (err) {
    console.error(`[DIGEST] fetch failed: ${err.message}`);
    return;
  }

  const cutoff = Date.now() - SEED_HOURS * 3600 * 1000;

  for (const d of rows) {
    if (!d?.id || handled.has(d.id)) continue;
    if (d.discord_message_id) continue; // posted, or currently being claimed

    handled.add(d.id); // fast in-process guard; the record claim is the real lock

    // First boot on an app that already has an unposted digest sitting
    // around: mark it handled rather than posting a stale recap.
    if (seed && generatedTime(d) < cutoff) {
      try {
        await updateEntity(ENTITY, d.id, {
          discord_message_id: "skipped-backfill",
          posted_to_discord: true,
        });
        console.log(`[DIGEST] seeded (not posted): week ${d.week}`);
      } catch (err) {
        console.warn(`[DIGEST] seed stamp failed for ${d.id}: ${err.message}`);
        handled.delete(d.id);
      }
      continue;
    }

    try {
      await postDigest(client, d);
    } catch (err) {
      console.error(`[DIGEST] post failed for ${d.id}: ${err.message}`);
      handled.delete(d.id); // let a later tick retry
    }
  }
}

export function startWeeklyDigestWatcher(client) {
  if (!CHANNEL_ID) {
    console.log("[DIGEST] watcher disabled — no CHANNEL_ID set.");
    return;
  }
  console.log(`[DIGEST] watcher starting — channel ${CHANNEL_ID}, every ${POLL_MS / 1000}s`);

  tick(client, { seed: true })
    .catch((err) => console.error(`[DIGEST] seed pass failed: ${err.message}`))
    .finally(() => {
      setInterval(() => {
        tick(client).catch((err) => console.error(`[DIGEST] poll failed: ${err.message}`));
      }, POLL_MS);
    });
}
