import { test } from "node:test";
import assert from "node:assert/strict";
import { newestLiveSegment, twitchLogin } from "./twitchFrame.js";

test("picks the newest live segment", () => {
  const m = "#EXTM3U\n#EXTINF:2.000,live\na.ts\n#EXTINF:2.000,live\nb.ts\n";
  assert.deepEqual(newestLiveSegment(m), { uri: "b.ts", map: null });
});

test("ad segments are never read", () => {
  assert.equal(newestLiveSegment("#EXTINF:2.000,Amazon|123\nx.ts\n"), null);
});

test("a live segment followed by ads is stale (ad break started)", () => {
  assert.equal(newestLiveSegment("#EXTINF:2.000,live\na.ts\n#EXTINF:2.000,Amazon|1\nb.ts\n"), null);
});

test("back to live after an ad break, with the init map in force", () => {
  const m = '#EXT-X-MAP:URI="ad-init.mp4"\n#EXTINF:2,Amazon\nx.mp4\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,live\ny.mp4\n';
  assert.deepEqual(newestLiveSegment(m), { uri: "y.mp4", map: "init.mp4" });
});

test("twitchLogin parses channel urls", () => {
  assert.equal(twitchLogin("https://www.twitch.tv/Brack3tt"), "brack3tt");
  assert.equal(twitchLogin("twitch.tv/some_user/videos"), "some_user");
  assert.equal(twitchLogin("https://youtube.com/@x"), null);
});
