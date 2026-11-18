import test from "node:test";
import assert from "node:assert/strict";
import * as model from "../../../static/site/benchmark-model.js";
import {
  outcome,
  summarize,
  matrixCases,
  metricText,
  configurationLabel,
  executionStatus,
} from "../../../static/site/benchmark-model.js";

const row = (config, status, covered, extra = {}) => ({
  case_id: "P01",
  question: "Waar en wanneer?",
  configuration_id: config,
  repeat: 1,
  status,
  source_complete: covered === 2,
  metrics: {
    covered_goals: covered,
    target_goals: 2,
    source_quality_applicable: true,
  },
  ...extra,
});

test("failed runs are execution errors rather than source-quality misses", () => {
  assert.equal(executionStatus("failed"), "Uitvoeringsfout");
  assert.equal(executionStatus("cancelling"), "Stoppen…");
});

test("execution errors, missing results and non-applicable checks never become a source pass", () => {
  assert.equal(outcome(row("a", "error", 2)), "error");
  assert.equal(outcome(null), "not_run");
  assert.equal(
    outcome(
      row("a", "passed", 2, {
        source_complete: null,
        metrics: { source_quality_applicable: false },
      }),
    ),
    "not_applicable",
  );
  assert.equal(
    outcome(row("a", "passed", 2, { source_complete: null })),
    "unknown",
  );
  assert.equal(outcome(row("a", "failed", 1)), "failed");
  assert.equal(outcome(row("a", "passed", 2)), "passed");
});

test("summaries retain all repetitions and separate failures from execution errors", () => {
  const result = summarize([
    row("a", "passed", 2),
    row("a", "failed", 1, { repeat: 2 }),
    row("a", "error", 0, { repeat: 3 }),
  ]);
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.error, 1);
  assert.equal(result.total, 3);
  assert.equal(metricText(row("a", "failed", 1)), "1/2");
  assert.equal(metricText(row("a", "error", 2)), "Uitvoeringsfout");
});

test("difference filters compare every repeat, including an absent variant", () => {
  const same = [row("a", "passed", 2), row("b", "passed", 2)];
  assert.equal(matrixCases(same, ["a", "b"], "differences").length, 0);
  assert.equal(matrixCases([same[0]], ["a", "b"], "differences").length, 1);
  assert.equal(
    matrixCases(
      [...same, row("b", "failed", 1, { repeat: 2 })],
      ["a", "b"],
      "differences",
    ).length,
    1,
  );
  assert.equal(
    matrixCases([row("a", "error", 0)], ["a"], "failures").length,
    0,
  );
  assert.equal(matrixCases([row("a", "error", 0)], ["a"], "errors").length, 1);
});

test("BM25 never acquires a fictional embedding label", () => {
  assert.equal(
    configurationLabel(
      {
        method: "bm25",
        embedding_model: "minilm",
        profile: "documents_sections",
      },
      {
        methods: [{ id: "bm25", label: "Op woorden" }],
        profiles: [{ id: "documents_sections", label: "Secties · bestanden" }],
        embedding_models: [{ id: "minilm", label: "MiniLM" }],
      },
    ),
    "Op woorden · Secties · bestanden",
  );
});

test("equal scores still expose changed answers and retrieved sources, ignoring timing and run ids", () => {
  const a = row("a", "passed", 2, {
    answer: "Antwoord A",
    calls: [{ query: "tuinieren", hits: ["bron-1"] }],
  });
  const b = row("b", "passed", 2, {
    answer: "Antwoord B",
    calls: [{ query: "tuinieren", hits: ["bron-1"] }],
  });
  assert.equal(matrixCases([a, b], ["a", "b"], "differences").length, 1);
  b.answer = a.answer;
  b.calls = [{ query: "tuinieren", hits: ["bron-2"] }];
  assert.equal(matrixCases([a, b], ["a", "b"], "differences").length, 1);
  b.calls = a.calls;
  b.id = "another-run";
  b.retrieval_ms = 1000;
  assert.equal(matrixCases([a, b], ["a", "b"], "differences").length, 0);
});

test("assistant full-context coverage cannot override failed execution and provenance checks", () => {
  const assistant = row("all-context", "failed", 2, {
    suite: "assistant",
    assertions: [{ pass: true }, { pass: false }],
    answer_quality: "not_assessed",
  });
  assert.equal(outcome(assistant), "failed");
  assert.equal(metricText(assistant), "1/2 controles");
});
test("the current corpus choice includes its extra regression set", () => {
  assert.equal(typeof model.selectedDatasets, "function");
  const catalog = {datasets:[{id:"basis"},{id:"regression"},{id:"historical"}],default_selection:{datasets:["basis","regression"]}};
  assert.deepEqual(model.selectedDatasets(catalog,"__current__"),["basis","regression"]);
  assert.deepEqual(model.selectedDatasets(catalog,"historical"),["historical"]);
});
test("speed averages require the whole selected set to be correct and complete", () => {
  assert.equal(typeof model.eligibleMean, "function");
  const correct = {status:"passed",source_complete:true,retrieval_ms:20};
  assert.equal(model.eligibleMean([correct,{...correct,retrieval_ms:40}],"retrieval_ms",2),30);
  assert.equal(model.eligibleMean([correct,{...correct,status:"failed",source_complete:false,retrieval_ms:1}],"retrieval_ms",2),null);
  assert.equal(model.eligibleMean([correct],"retrieval_ms",2),null);
  assert.equal(model.eligibleMean([{...correct,suite:"assistant",answer_quality:"not_assessed"}],"retrieval_ms",1),null);
});
