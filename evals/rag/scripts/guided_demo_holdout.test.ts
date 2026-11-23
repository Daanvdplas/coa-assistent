import assert from "node:assert/strict";
import test from "node:test";
import { earliestComplete, passesSelector, passesSourceCoverage } from "./guided_demo_holdout.ts";

test("counts cumulative unique passages against a complete alternative", () => {
  const alternatives = [["A:S2", "A:S3"], ["B:S2", "B:S3"]];
  assert.equal(earliestComplete(alternatives, [["A:S2"], ["A:S2", "B:S3"]]), null);
  assert.equal(earliestComplete(alternatives, [["A:S2"], ["A:S2", "B:S3"], ["A:S3"]]), 3);
});

test("preserves the standalone threshold and requires five fresh first-search completions", () => {
  assert(passesSourceCoverage([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 3], "standalone"));
  assert(!passesSourceCoverage([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2], "extension"));
  assert(passesSourceCoverage([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 3, 1, 1, 1, 1, 1, 2], "extension"));
  assert(!passesSourceCoverage([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, null], "extension"));
});

test("final confirmation enforces first-search coverage in both fresh cohorts", () => {
  const firsts = (count: number) => Array<number>(count).fill(1);
  assert(passesSourceCoverage([...firsts(10), 2, 2, ...firsts(5), 2, ...firsts(4)], "final"));
  assert(!passesSourceCoverage([...firsts(12), ...firsts(4), 2, 2, ...firsts(4)], "final"));
  assert(!passesSourceCoverage([...firsts(12), ...firsts(6), ...firsts(2), 2, 2], "final"));
  assert(!passesSourceCoverage([...firsts(9), 2, 2, 2, ...firsts(5), 2, ...firsts(4)], "final"));
});

test("an interval guard requires explicit abstention and observes an emitted selector", () => {
  const abstention = { applied: false, matches: [], unknown: [], exhaustive: false };
  assert(passesSelector(abstention, abstention));
  assert(!passesSelector(abstention, null));
  assert(!passesSelector(abstention, { ...abstention, applied: true }));
});
