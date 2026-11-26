import assert from "node:assert/strict";
import test from "node:test";
import { assessDaypart } from "./guided_dayparts.ts";

const allSchedules = ["A:S2", "B:S2"];
const noMatches = { applied: true, matches: [], unknown: [], exhaustive: true };

test("a negative answer requires all schedule passages and an exhaustive empty selection", () => {
  const incomplete = assessDaypart([], allSchedules, ["A:S2"], noMatches);
  assert.deepEqual(incomplete.missingSections, ["B:S2"]);
  assert.equal(incomplete.passed, false);

  const fallback = { ...noMatches, applied: false, exhaustive: false };
  assert.equal(assessDaypart([], allSchedules, allSchedules, fallback).passed, false);
  assert.equal(assessDaypart([], allSchedules, allSchedules, noMatches).passed, true);
});

test("a positive answer requires the matching schedule, even if its activity was selected", () => {
  const selector = { ...noMatches, matches: ["A"] };
  assert.equal(assessDaypart(["A"], allSchedules, ["A:S1"], selector).passed, false);
  assert.equal(assessDaypart(["A"], allSchedules, ["A:S2"], selector).passed, true);
});
