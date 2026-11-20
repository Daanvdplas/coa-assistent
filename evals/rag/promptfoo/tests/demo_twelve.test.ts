import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadCase } from "../assertions.ts";

const matrix = createRequire(import.meta.url)("../cases.cjs");
const { buildConfig } = matrix;
const dataset = "demo-12-20261118";

test("the current twelve-document corpus has its own retrieval matrix without changing historical suites", () => {
  let plan: any;
  assert.doesNotThrow(() => {
    plan = buildConfig({ COA_PROMPTFOO_SUITE: "retrieval", COA_PROMPTFOO_DATASET: dataset });
  });
  assert.equal(plan.tests.length, 17 * 16);
  assert.equal(new Set(plan.tests.map((row: any) => row.vars.case_id)).size, 17);
  assert.ok(plan.tests.every((row: any) => row.vars.dataset === dataset));
  assert.equal(buildConfig({ COA_PROMPTFOO_SUITE: "retrieval" }).tests.length, 800);
  assert.equal(buildConfig({ COA_PROMPTFOO_SUITE: "quality" }).tests.length, 768);
  for (const row of plan.tests) {
    assert.equal("facts" in row.vars, false);
    assert.equal("required_unknowns" in row.vars, false);
  }
});

test("twelve-document protected expectations include both new activities and retain uncertainty", () => {
  let chess: any, sewing: any, unknown: any;
  assert.doesNotThrow(() => {
    chess = loadCase(dataset, "DEMO12-11");
    sewing = loadCase(dataset, "DEMO12-12");
    unknown = loadCase(dataset, "DEMO12-14");
  });
  assert.equal(chess.as_of, "2026-11-13");
  assert.ok(chess.facts.flatMap((fact: any) => fact.evidence_alternatives.flat()).some((ref: any) => ref.source_id === "ACT-SCHAAK-011"));
  assert.ok(sewing.facts.flatMap((fact: any) => fact.evidence_alternatives.flat()).some((ref: any) => ref.source_id === "ACT-NAAI-012"));
  assert.ok(unknown.required_unknowns.length > 0);
  assert.equal(unknown.relevance_labels_complete, false);
  assert.notEqual(chess.corpus_sha256, loadCase("strengthened-10-20261106", "RAG26-01").corpus_sha256);
});

test("all-local selects only applicable twelve-document suites and fixed studies cannot be relabelled", () => {
  assert.equal(typeof matrix.suitesFor, "function");
  assert.deepEqual(matrix.suitesFor("all-local", dataset), ["retrieval", "quality"]);
  assert.deepEqual(matrix.suitesFor("all-local"), ["garden", "retrieval", "quality", "compact"]);
  for (const suite of ["garden", "models", "compact", "compact-live"]) {
    assert.throws(() => matrix.suitesFor(suite, dataset), /fixed|historical|protocol/i);
  }
  const quality = buildConfig({ COA_PROMPTFOO_SUITE: "quality", COA_PROMPTFOO_DATASET: dataset });
  assert.equal(quality.tests.length, 17 * 24);
  assert.ok(quality.tests.every((row: any) => !row.vars.apply_filters));
  const agentic = buildConfig({ COA_PROMPTFOO_SUITE: "agentic", COA_PROMPTFOO_DATASET: dataset });
  assert.equal(agentic.tests.length, 17 * 4);
});
