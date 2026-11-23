import assert from "node:assert/strict";
import test from "node:test";
import { earliestComplete } from "./guided_demo_holdout.ts";

test("counts cumulative unique passages against a complete alternative", () => {
  const alternatives = [["A:S2", "A:S3"], ["B:S2", "B:S3"]];
  assert.equal(earliestComplete(alternatives, [["A:S2"], ["A:S2", "B:S3"]]), null);
  assert.equal(earliestComplete(alternatives, [["A:S2"], ["A:S2", "B:S3"], ["A:S3"]]), 3);
});
