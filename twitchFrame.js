// twitchFrame.js — grab one still frame from a live Twitch channel.
//
// Same route the Twitch web player (and tools like streamlink) take:
//   1. a playback access token for the channel from Twitch's public GraphQL
//      endpoint (the web player's public client id, no login)
//   2. the channel's HLS playlist from usher, pick the 720p variant
//   3. download the newest ~2s media segment labelled "live" with fetch
//      (ad segments are skipped, see SESSIONS below)
//   4. ffmpeg decodes the first frame of that segment from STDIN to a JPEG.
//      ffmpeg never touches the network itself: static ffmpeg builds crash
//      (SIGSEGV) doing their own DNS lookups, and this keeps timeouts in Node.
//
// This is not an official Twitch API. If Twitch changes the web player's
// endpoints this returns { offline: true, why } instead of throwing, and the
// live score reader simply shows no score for that game.
//
// Env: FFMPEG_PATH overrides the bundled ffmpeg-static binary.

import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic;
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"; // Twitch web player's public client id
const TIMEOUT_MS = 15_000;
const SESSION_MAX_MS = 30 * 60_000;

// One playback session per channel, reused across reads like a viewer who
// keeps the stream open. A fresh session starts with Twitch's pre-roll ads
// (~30s); reusing it means we sit through that once instead of every minute.
// While ads run the playlist's segments are titled "Amazon|..." instead of
// "live": we never read those, the read is just skipped until the game is back.
const SESSIONS = new Map(); // login -> { url, height, expires }

const TOKEN_QUERY =
  "query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {" +
  " streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isLive) { value signature __typename }" +
  " videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }";

async function fetchWithTimeout(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** twitch.tv/<login> -> login, or null for anything else. */
export function twitchLogin(url) {
  try {
    const u = new URL(String(url).startsWith("http") ? url : `https://${url}`);
    if (!/(^|\.)twitch\.tv$/i.test(u.hostname)) return null;
    const seg = u.pathname.split("/").filter(Boolean)[0];
    return seg && /^[a-z0-9_]{2,25}$/i.test(seg) ? seg.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The channel's variant playlists, or { offline } when it isn't live. */
async function variants(login) {
  const res = await fetchWithTimeout("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: { "Client-ID": CLIENT_ID, "Content-Type": "text/plain" },
    body: JSON.stringify({
      operationName: "PlaybackAccessToken_Template",
      query: TOKEN_QUERY,
      variables: { isLive: true, login, isVod: false, vodID: "", playerType: "site", platform: "web" },
    }),
  });
  const token = (await res.json().catch(() => null))?.data?.streamPlaybackAccessToken;
  if (!token) return { offline: true, why: `no playback token (HTTP ${res.status})` };
  let expires = Date.now() + SESSION_MAX_MS;
  try {
    const e = Number(JSON.parse(token.value).expires) * 1000;
    if (e) expires = Math.min(expires, e - 60_000);
  } catch { /* keep the default */ }

  const u = new URL(`https://usher.ttvnw.net/api/channel/hls/${login}.m3u8`);
  u.searchParams.set("sig", token.signature);
  u.searchParams.set("token", token.value);
  u.searchParams.set("allow_source", "true");
  u.searchParams.set("player", "twitchweb");
  u.searchParams.set("p", String(Math.floor(Math.random() * 1e6)));
  const m = await fetchWithTimeout(u);
  if (m.status !== 200) return { offline: true, why: m.status === 404 ? "not live" : `usher HTTP ${m.status}` };

  const lines = (await m.text()).split("\n");
  const list = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const res2 = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
    if (lines[i + 1]) list.push({ height: res2 ? Number(res2[2]) : 0, url: lines[i + 1].trim() });
  }
  return list.length ? { list, expires } : { offline: true, why: "empty playlist" };
}

/** Decode the first frame of a media segment to a JPEG no wider than 1280px. */
function firstFrameJpeg(segment) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, [
      "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1",
      "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", "-f", "image2", "-vcodec", "mjpeg", "pipe:1",
    ]);
    const out = [];
    let err = "";
    const timer = setTimeout(() => ff.kill("SIGKILL"), TIMEOUT_MS);
    ff.stdout.on("data", (d) => out.push(d));
    ff.stderr.on("data", (d) => { err += d; });
    ff.on("error", (e) => { clearTimeout(timer); reject(e); });
    ff.on("close", (code) => {
      clearTimeout(timer);
      const jpg = Buffer.concat(out);
      if (code === 0 && jpg.length) resolve(jpg);
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 200)}`));
    });
    ff.stdin.on("error", () => { /* ffmpeg may close stdin once it has its frame */ });
    ff.stdin.end(segment);
  });
}

/** The channel's held session (720p variant playlist), opening one if needed. */
async function session(login) {
  const held = SESSIONS.get(login);
  if (held && held.expires > Date.now()) return held;
  const v = await variants(login);
  if (v.offline) { SESSIONS.delete(login); return v; }
  // 720p is plenty to read the scorebug and keeps the image small.
  const pick = v.list.filter((x) => x.height >= 720).sort((a, b) => a.height - b.height)[0]
    || v.list.sort((a, b) => b.height - a.height)[0];
  const s = { url: pick.url, height: pick.height, expires: v.expires };
  SESSIONS.set(login, s);
  return s;
}

/** The newest segment if it is titled "live" (null during ads), with the init map in force for it. */
export function newestLiveSegment(media) {
  let title = "";
  let map = null;
  let found = null;
  for (const raw of media.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("#EXT-X-MAP:")) map = /URI="([^"]+)"/.exec(l)?.[1] || null;
    else if (l.startsWith("#EXTINF:")) title = l.slice(l.indexOf(",") + 1);
    else if (!l.startsWith("#")) {
      // An ad after a live chunk means an ad break started: that live chunk
      // is stale, so only a live chunk at the very end of the playlist counts.
      found = /\blive\b/i.test(title) ? { uri: l, map } : null;
      title = "";
    }
  }
  return found;
}

/**
 * One JPEG frame from a live channel: { jpeg }, { ad: true, why } while an
 * ad break plays, or { offline: true, why }.
 * Throws only on unexpected failures (ffmpeg missing, network down).
 */
export async function grabTwitchFrame(login, retried = false) {
  const s = await session(login);
  if (s.offline) return s;
  const res = await fetchWithTimeout(s.url);
  if (res.status !== 200) {
    // Expired or ended session: open a new one once, else report offline.
    SESSIONS.delete(login);
    return retried ? { offline: true, why: `playlist HTTP ${res.status}` } : grabTwitchFrame(login, true);
  }
  const media = await res.text();
  if (/#EXT-X-ENDLIST/.test(media)) { SESSIONS.delete(login); return { offline: true, why: "stream ended" }; }
  const seg = newestLiveSegment(media);
  if (!seg) return { ad: true, why: "ad break" };
  const bytes = async (u) => Buffer.from(await (await fetchWithTimeout(new URL(u, s.url))).arrayBuffer());
  let segment = await bytes(seg.uri);
  // Some channels send fragmented MP4 (CMAF) instead of MPEG-TS: each chunk
  // then needs the playlist's init segment (#EXT-X-MAP) in front of it.
  if (seg.map) segment = Buffer.concat([await bytes(seg.map), segment]);
  return { jpeg: await firstFrameJpeg(segment), height: s.height };
}
