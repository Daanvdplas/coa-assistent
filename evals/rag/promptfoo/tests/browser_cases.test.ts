import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  browserEmbeddingModel,
  requestKey,
  DEFAULTS,
  ROOT,
} from "../provider.ts";
import type { Variables } from "../types.ts";
const require = createRequire(import.meta.url);
const canonical = require("../cases.cjs") as {
  buildConfig: (env: Record<string, string>) => {
    tests: { vars: Variables }[];
  };
  questions: (dataset: string) => Variables[];
};
const selected = () =>
  JSON.parse(
    readFileSync(
      join(ROOT, "evals/shared/selections/rag-quality-12-20261120.json"),
      "utf8",
    ),
  );
const build = (id: string, extra: Record<string, string> = {}) =>
  canonical.buildConfig({
    COA_PROMPTFOO_SUITE: "browser",
    COA_PROMPTFOO_EVAL_ID: id,
    COA_PROMPTFOO_METHODS: "dense",
    COA_PROMPTFOO_EMBEDDING_MODEL: "e5-small-multilingual",
    ...extra,
  }).tests[0].vars;

test("public quality browser IDs resolve to their exact frozen question and corpus", () => {
  for (const row of selected().cases) {
    const vars = build(row.id);
    const expected = canonical
      .questions(row.dataset_id)
      .find((item) => item.case_id === row.case_id)!;
    assert.equal(vars.dataset, row.dataset_id);
    assert.equal(vars.case_id, row.case_id);
    assert.equal(vars.question, expected.question);
    assert.equal(vars.corpus_sha256, selected().corpus_sha256);
    assert.equal(browserEmbeddingModel(vars), "e5-small-multilingual");
    for (const key of ["facts", "evidence_alternatives", "relevant_sections"])
      assert.equal(key in vars, false);
  }
});
test("typed browser IDs support every one of the eighteen active canonical cases", () => {
  const inputs = ["demo-12-20261118", "regression-12-20261118"].flatMap(
    (dataset) => canonical.questions(dataset),
  );
  assert.equal(inputs.length, 18);
  for (const row of inputs) {
    const vars = build(`case:${row.dataset}:${row.case_id}`, {
      COA_PROMPTFOO_DATASET: row.dataset,
    });
    assert.equal(vars.question, row.question);
    assert.equal(vars.case_id, row.case_id);
    assert.equal(vars.dataset, row.dataset);
    assert.equal(browserEmbeddingModel(vars), "e5-small-multilingual");
  }
});
test("resolver exposes twelve visible choices while retaining old aliases separately", () => {
  const resolver = require("../browser_cases.cjs") as any;
  const visible = resolver.publicBrowserCases();
  assert.equal(visible.length, selected().cases.length + 1);
  assert.deepEqual(
    resolver.activeBrowserCases().map((row: any) => row.id),
    ["demo-12-20261118", "regression-12-20261118"].flatMap((dataset) =>
      canonical
        .questions(dataset)
        .map((row) => `case:${dataset}:${row.case_id}`),
    ),
  );
  for (const [id, caseId] of [
    ["garden-time-location", "P01"],
    ["indoor-tuesday", "T02"],
    ["two-activities", "T05"],
  ])
    assert.equal(resolver.resolveBrowserCase(id).case_id, caseId);
});
test("browser requests reject changed question, dataset, case, corpus, model, preset and execution mode", () => {
  const vars = build("case:demo-12-20261118:RAG26-02");
  for (const changed of [
    { question: vars.question + " extra" },
    { dataset: "regression-12-20261118" },
    { case_id: "RAG26-01" },
    { corpus_sha256: "0".repeat(64) },
    { embedding_model: "fake-model" },
    { model: "fake-model" },
    { mode: "codex" },
    { browser_eval_id: "case:legacy:P01" },
    { browser_preset: "invented" },
  ])
    assert.throws(() => requestKey({ ...vars, ...changed } as Variables));
  assert.equal(
    browserEmbeddingModel({ ...vars, question: undefined }),
    "e5-small-multilingual",
  );
});
test("two E5-only dense presets match the fixed k3 section and activity-expansion configurations", () => {
  for (const [preset, selection] of [
    ["dense-k3-sections", "sections"],
    ["dense-k3-activity-expansion", "activity_expansion"],
  ]) {
    const vars = build("case:regression-12-20261118:IND26-01", {
      COA_PROMPTFOO_BROWSER_PRESET: preset,
    });
    assert.equal(vars.top_k, 3);
    assert.equal(vars.selection, selection);
    assert.equal(vars.profile, "documents_sections");
    assert.equal(vars.candidate_k, 30);
    assert.equal(vars.context_token_limit, 1200);
    assert.equal(browserEmbeddingModel(vars), "e5-small-multilingual");
    assert.throws(() =>
      browserEmbeddingModel({
        ...vars,
        embedding_model: "minilm-multilingual",
      }),
    );
    assert.throws(() => browserEmbeddingModel({ ...vars, method: "bm25" }));
    assert.throws(() => browserEmbeddingModel({ ...vars, top_k: 6 }));
  }
});
