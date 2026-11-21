// scorebugReader.js — read Madden's in-game scorebug from one stream frame
// with Claude vision (Anthropic API), as strict JSON.
//
// The standard Madden scorebug is a single bar along the bottom of the game
// picture: MADDEN logo, AWAY team logo, the score row "(rec) AWY 17 x 7 • HOM
// (rec)", HOME team logo, then quarter + clock, play clock, down & distance.
// Away is always the LEFT side, home the RIGHT. Team abbreviations are NOT
// trusted (franchise relocations rename teams), the caller maps sides to the
// Vault game it already knows.
//
// Env:
//   ANTHROPIC_API_KEY   required
//   LIVE_SCORE_MODEL    optional, default claude-opus-5-5
//
// Test on a screenshot:  node scorebugReader.js path/to/frame.jpg

import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-5-5";

let _client = null;
const client = () => (_client ||= new Anthropic());

const SYSTEM = `You read the score of an American football video game (EA Sports Madden NFL) from one frame of a Twitch stream.

Find Madden's in-game SCOREBUG: one horizontal bar along the bottom of the game picture. Reading left to right it has the MADDEN logo, the AWAY team logo, then the score section "<away abbr> <away score> × <home score> • <home abbr>" (team records like "(1-2)" may sit beside the abbreviations), the HOME team logo, then the quarter and game clock (e.g. "2nd 5:44"), the play clock (":28" or "--"), down & distance ("1st & 10", "4th & Goal"), and sometimes a ball-spot number.

Rules:
- The away score is the number on the LEFT of the score section, the home score the number on the RIGHT. Never swap them, whatever the abbreviations say.
- The stream may be scaled, cropped or framed: the game picture can sit inside borders with a webcam, chat or other overlays around it. Find the scorebug wherever the game picture is.
- Ignore everything that is not Madden's scorebug: the streamer's own overlays (gamertag bars, decibel meters, alerts), and Madden's SECOND ticker row underneath the scorebug that lists other games or players (e.g. "WEEK 4 ... SHVXL_ ... User Game").
- Sometimes the score section is replaced by a stat graphic (e.g. "24 RUSHING YDS 62") or the scorebug is in transition. Then scores are not visible: set away_score and home_score to null.
- If there is no scorebug at all (menus, loading screens, replays without the bar, halftime show, a different game, the stream's starting soon screen), set scorebug_visible to false, possession to "none" and every other field to null.
- possession: "away" or "home" if the scorebug marks which side has the ball (a dot or highlight next to one team), else "none".
- Copy quarter, clock and down & distance exactly as shown ("1st", "2nd", "3rd", "4th", "OT", "Half", "Final"; "5:44"; "1st & 10").
- Never guess a digit you cannot read: use null instead.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scorebug_visible", "away_score", "home_score", "quarter", "clock", "down_distance", "possession"],
  properties: {
    scorebug_visible: { type: "boolean" },
    away_score: { type: ["integer", "null"] },
    home_score: { type: ["integer", "null"] },
    quarter: { type: ["string", "null"] },
    clock: { type: ["string", "null"] },
    down_distance: { type: ["string", "null"] },
    possession: { type: "string", enum: ["away", "home", "none"] },
  },
};

// Models with server-side refusal fallbacks (see the Anthropic API docs).
const SUPPORTS_FALLBACKS = /^claude-(opus-5|fable-5|mythos-5|sonnet-5-5)/;

/**
 * Read one frame (a JPEG from twitchFrame.js, or any PNG/WebP/GIF screenshot
 * with mediaType set). Resolves to the reading object, or null when the model
 * declined / ran out of room (treated like "no scorebug" by the caller).
 */
export async function readScorebug(image, { model = process.env.LIVE_SCORE_MODEL || DEFAULT_MODEL, mediaType = "image/jpeg" } = {}) {
  const request = {
    model,
    max_tokens: 4000,
    system: SYSTEM,
    // Simple extraction: low effort keeps each read quick and cheap.
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: image.toString("base64") } },
        { type: "text", text: "Read the Madden scorebug in this frame." },
      ],
    }],
  };
  const response = SUPPORTS_FALLBACKS.test(model)
    ? await client().beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
    : await client().messages.create(request);

  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null;
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) return null;
  const reading = JSON.parse(text);
  return { ...reading, usage: response.usage };
}

// CLI: node scorebugReader.js frame.jpg [more.jpg ...]
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("Usage: node scorebugReader.js frame.jpg [more.jpg ...]");
    process.exit(1);
  }
  for (const f of files) {
    try {
      const ext = f.toLowerCase().split(".").pop();
      const mediaType = { png: "image/png", webp: "image/webp", gif: "image/gif" }[ext] || "image/jpeg";
      const out = await readScorebug(fs.readFileSync(f), { mediaType });
      console.log(f, JSON.stringify(out));
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) console.error("Set ANTHROPIC_API_KEY first.");
      else if (err instanceof Anthropic.APIError) console.error(f, `API error ${err.status}:`, err.message);
      else console.error(f, err.message);
    }
  }
}
