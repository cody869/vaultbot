// recoverS84Scores.js — ONE-OFF recovery script (not part of the bot's normal
// runtime, not wired into index.js). Run manually: `node recoverS84Scores.js`
//
// Background: a Sept 17-18 offseason export bug re-tagged ~279 real, played
// season-84 games as season 85 and zeroed their scores in the Game entity
// (see eaExport.js and maddenWebhook/entry.ts for the fixes that stop this
// going forward). The raw webhook payloads that carried the real scores were
// never stored anywhere, so they can't be recovered from import history.
//
// But ScorebugPost -- a separate entity vaultbot uses purely to dedupe its
// scorebug-card Discord posts, never touched by the import pipeline -- still
// holds the discord_message_id of the ORIGINAL post for every one of those
// games, made back when the game was actually played. That Discord message's
// attached PNG card still shows the real final score. (The embed itself
// carries no score text -- the score is only in the rendered image.)
//
// This script does NOT touch the database. It only:
//   1. Reads every season-84 ScorebugPost row with a discord_message_id.
//   2. Fetches each Discord message via the bot REST API (trying every
//      candidate message id for a game -- ScorebugPost can't be updated in
//      this Base44 app, so a retried post creates a SECOND row instead of
//      overwriting the first, and one of the two can point at a message
//      that no longer resolves).
//   3. Downloads its scorebug-card attachment to ./s84-recovery/<game_key>.png.
//   4. Writes a manifest.json mapping game_key -> {week, away_team, home_team,
//      discord_message_id, file}, and a failures.json for games that never
//      resolved (checked with resume support -- safe to re-run after a
//      Ctrl+C or crash, it skips games already in manifest.json).
//
// The images + manifest are then read (by a human or by Claude) to transcribe
// the real scores, and a separate step writes the corrected Game rows back.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { list, botLogin } from "./vault.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

const OUT_DIR = path.resolve("./s84-recovery");
fs.mkdirSync(OUT_DIR, { recursive: true });

function safeName(s) {
  return String(s).replace(/[^a-z0-9-]+/gi, "_");
}

// Discord per-route rate limiting: track remaining/reset-after from response
// headers and wait BEFORE the next call once we're out, instead of firing on
// a blind fixed delay and hoping -- the "Get Channel Message" route has a
// tight per-channel bucket and a flat 150ms gap tripped it on nearly every
// call.
let rlRemaining = 1;
let rlResetAt = 0;

async function throttle() {
  if (rlRemaining <= 0 && Date.now() < rlResetAt) {
    const wait = rlResetAt - Date.now() + 50;
    await new Promise((r) => setTimeout(r, wait));
  }
}

function recordRateLimitHeaders(res) {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const resetAfter = res.headers.get("x-ratelimit-reset-after");
  if (remaining != null) rlRemaining = Number(remaining);
  if (resetAfter != null) rlResetAt = Date.now() + Number(resetAfter) * 1000;
}

async function discordGet(url) {
  await throttle();
  const res = await fetch(url, { headers: { Authorization: `Bot ${DISCORD_TOKEN}` } });
  recordRateLimitHeaders(res);
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const waitMs = Math.ceil((body.retry_after || 1) * 1000) + 250;
    console.warn(`  rate limited, waiting ${waitMs}ms...`);
    await new Promise((r) => setTimeout(r, waitMs));
    return discordGet(url);
  }
  return res;
}

async function fetchDiscordMessage(channelId, messageId) {
  const res = await discordGet(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 150)}` : ""}`);
  }
  return res.json();
}

async function main() {
  await botLogin();

  console.log("Fetching ScorebugPost rows for season 84...");
  const rows = await list("ScorebugPost", { season_number: 84 }, { limit: 1000 });
  const posted = rows.filter((r) => r.discord_message_id);

  const byGameKey = new Map();
  for (const r of posted) {
    if (!byGameKey.has(r.game_key)) byGameKey.set(r.game_key, []);
    byGameKey.get(r.game_key).push(r);
  }
  console.log(
    `Found ${posted.length} posted rows across ${byGameKey.size} distinct games ` +
    `(of ${rows.length} total ScorebugPost rows).`
  );

  // Sanity check: confirm the bot can see the channel at all before doing
  // hundreds of individual lookups that would otherwise all fail the same way.
  const sampleChannelId = posted[0]?.discord_channel_id;
  if (sampleChannelId) {
    const chRes = await discordGet(`https://discord.com/api/v10/channels/${sampleChannelId}`);
    if (!chRes.ok) {
      console.error(
        `Cannot access channel ${sampleChannelId} (HTTP ${chRes.status}). ` +
        `The bot may lack access, or the channel may have been recreated. Aborting.`
      );
      process.exit(1);
    }
    const ch = await chRes.json();
    console.log(`Channel access OK: #${ch.name || sampleChannelId}`);
  }

  const manifestPath = path.join(OUT_DIR, "manifest.json");
  const failuresPath = path.join(OUT_DIR, "failures.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : [];
  const failures = fs.existsSync(failuresPath) ? JSON.parse(fs.readFileSync(failuresPath, "utf8")) : [];
  const alreadyDone = new Set(manifest.map((m) => m.game_key));

  let i = 0;
  for (const [gameKey, candidates] of byGameKey) {
    i++;
    if (alreadyDone.has(gameKey)) continue; // resume support

    const first = candidates[0];
    const label = `wk${first.week} ${first.away_team} @ ${first.home_team}`;
    process.stdout.write(`[${i}/${byGameKey.size}] ${label} ... `);

    let saved = false;
    let lastErr = null;
    for (const row of candidates) {
      try {
        const msg = await fetchDiscordMessage(row.discord_channel_id, row.discord_message_id);
        const attachment = (msg.attachments || [])[0];
        if (!attachment) {
          lastErr = "no attachment";
          continue;
        }
        const imgRes = await fetch(attachment.url);
        if (!imgRes.ok) {
          lastErr = `image HTTP ${imgRes.status}`;
          continue;
        }
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const filename = `${safeName(gameKey)}.png`;
        fs.writeFileSync(path.join(OUT_DIR, filename), buf);
        manifest.push({
          game_key: gameKey,
          week: first.week,
          away_team: first.away_team,
          home_team: first.home_team,
          discord_message_id: row.discord_message_id,
          file: filename,
        });
        console.log("ok");
        saved = true;
        break;
      } catch (err) {
        lastErr = err.message;
      }
    }

    if (!saved) {
      console.log(`FAILED (${candidates.length} candidate${candidates.length > 1 ? "s" : ""}): ${lastErr}`);
      failures.push({
        game_key: gameKey,
        week: first.week,
        away_team: first.away_team,
        home_team: first.home_team,
        reason: lastErr,
        candidates: candidates.map((c) => c.discord_message_id),
      });
    }

    // Checkpoint after every game so Ctrl+C or a crash doesn't lose progress.
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(failuresPath, JSON.stringify(failures, null, 2));
  }

  console.log(`\nDone. ${manifest.length} images saved to ${OUT_DIR}, ${failures.length} games failed.`);
  console.log(`Manifest: ${manifestPath}`);
  if (failures.length) console.log(`Failures: ${failuresPath}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
