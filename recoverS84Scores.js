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
//   2. Fetches each Discord message via the bot REST API.
//   3. Downloads its scorebug-card attachment to ./s84-recovery/<game_key>.png.
//   4. Writes a manifest.json mapping game_key -> {week, away_team, home_team,
//      discord_message_id, file}.
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

async function fetchDiscordMessage(channelId, messageId) {
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    { headers: { Authorization: `Bot ${DISCORD_TOKEN}` } }
  );
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const waitMs = Math.ceil((body.retry_after || 1) * 1000) + 200;
    console.warn(`  rate limited, waiting ${waitMs}ms...`);
    await new Promise((r) => setTimeout(r, waitMs));
    return fetchDiscordMessage(channelId, messageId);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

async function main() {
  await botLogin();

  console.log("Fetching ScorebugPost rows for season 84...");
  const rows = await list("ScorebugPost", { season_number: 84 }, { limit: 1000 });
  const posted = rows.filter((r) => r.discord_message_id);
  console.log(`Found ${posted.length} posted season-84 scorebug cards (of ${rows.length} total rows).`);

  const manifest = [];
  let ok = 0;
  let failed = 0;

  for (const [i, row] of posted.entries()) {
    const label = `wk${row.week} ${row.away_team} @ ${row.home_team}`;
    process.stdout.write(`[${i + 1}/${posted.length}] ${label} ... `);
    try {
      const msg = await fetchDiscordMessage(row.discord_channel_id, row.discord_message_id);
      const attachment = (msg.attachments || [])[0];
      if (!attachment) {
        console.log("no attachment, skipping");
        failed++;
        continue;
      }
      const imgRes = await fetch(attachment.url);
      if (!imgRes.ok) throw new Error(`image HTTP ${imgRes.status}`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const filename = `${safeName(row.game_key)}.png`;
      fs.writeFileSync(path.join(OUT_DIR, filename), buf);
      manifest.push({
        game_key: row.game_key,
        week: row.week,
        away_team: row.away_team,
        home_team: row.home_team,
        discord_message_id: row.discord_message_id,
        file: filename,
      });
      console.log("ok");
      ok++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed++;
    }
    // Discord REST is generously rate-limited per-route but let's be polite.
    await new Promise((r) => setTimeout(r, 150));
  }

  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nDone. ${ok} images saved to ${OUT_DIR}, ${failed} failed.`);
  console.log(`Manifest: ${path.join(OUT_DIR, "manifest.json")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
