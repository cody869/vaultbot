// Run: node --test liveScoreLogic.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeReading, quarterRank } from "./liveScoreLogic.js";

const r = (away, home, quarter = "2nd", visible = true) => ({ scorebug_visible: visible, away_score: away, home_score: home, quarter });

test("first readable frame is accepted", () => {
  assert.equal(judgeReading(null, null, r(0, 0, "1st")).accept, true);
});

test("normal scoring is accepted at once", () => {
  assert.equal(judgeReading(r(17, 7), null, r(17, 14)).accept, true); // TD + XP
  assert.equal(judgeReading(r(17, 14), null, r(25, 14)).accept, true); // TD + 2pt
  assert.equal(judgeReading(r(17, 14, "2nd"), null, r(17, 14, "Half")).accept, true);
  assert.equal(judgeReading(r(17, 14, "Half"), null, r(17, 14, "3rd")).accept, true);
});

test("no scorebug keeps the last score (not accepted, not an error)", () => {
  const out = judgeReading(r(17, 7), null, { scorebug_visible: false, away_score: null, home_score: null, quarter: null });
  assert.equal(out.accept, false);
  assert.equal(out.state, "no_scorebug");
});

test("stat graphic in place of scores counts as no scorebug", () => {
  // e.g. "24 RUSHING YDS 62": the model reports scores as null.
  assert.equal(judgeReading(r(17, 7), null, { scorebug_visible: true, away_score: null, home_score: null, quarter: "1st" }).state, "no_scorebug");
});

test("score going down is held until a second frame agrees", () => {
  const first = judgeReading(r(17, 14), null, r(17, 4));
  assert.equal(first.accept, false);
  assert.deepEqual(first.pending, r(17, 4));
  const again = judgeReading(r(17, 14), first.pending, r(17, 4));
  assert.equal(again.accept, true);
  assert.equal(again.pending, null);
});

test("a one-frame misread is dropped when the next frame disagrees", () => {
  const first = judgeReading(r(17, 14), null, r(71, 14)); // misread 17 -> 71
  assert.equal(first.accept, false);
  const next = judgeReading(r(17, 14), first.pending, r(17, 14));
  assert.equal(next.accept, true);
  assert.equal(next.pending, null);
});

test("quarter going backwards is held", () => {
  assert.equal(judgeReading(r(10, 10, "4th"), null, r(10, 10, "2nd")).accept, false);
});

test("quarter labels rank in game order", () => {
  assert.ok(quarterRank("1st") < quarterRank("Half"));
  assert.ok(quarterRank("4th") < quarterRank("OT"));
  assert.equal(quarterRank("weird"), null);
});
