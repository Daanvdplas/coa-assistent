import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { getAssert, canonicalSources, loadCase, orderedSection } from "../assertions.ts";
import { DEFAULTS, ROOT } from "../provider.ts";
import { canonicalJson, readJson, sha256 } from "../json.ts";
import type {
  Embedding,
  EmbeddingSpec,
  Envelope,
  NativeRecord,
} from "../types.ts";
import { localRecord } from "./fixtures.ts";
import { isolateEnvironment } from "./environment.ts";
function setup(t: test.TestContext) {
  t.after(isolateEnvironment());
  const root = mkdtempSync(join(tmpdir(), "coa-browser-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spec = readJson<EmbeddingSpec[]>(
    join(ROOT, "evals/rag/embedding-models.json"),
  ).find((row) => row.id === "e5-small-multilingual")!;
  const identity: Embedding = {
    provider: "local-fastembed",
    model: spec.repository + "@" + "a".repeat(40),
    sdk: spec.sdk,
    dimensions: 384,
    encoding: spec.encoding + "; model_files_sha256=" + "b".repeat(64),
    document_prefix: "passage: ",
    query_prefix: "query: ",
  };
  const envelope = localRecord(),
    record = envelope.record as NativeRecord;
  record.config.retrieval.top_k = 5;
  record.outcome.config.top_k = 5;
  const corpus = record.outcome.corpus_identity,
    inputs = [...canonicalSources().values()].map(
      (section) =>
        "passage: " +
        section.source_title +
        "\n" +
        section.heading +
        "\n" +
        section.text,
    );
  corpus.embedding_inputs_sha256 = sha256(canonicalJson(inputs));
  corpus.embedding = structuredClone(identity);
  record.preparation.corpus_identity = structuredClone(corpus);
  const vars = {
    ...DEFAULTS,
    mode: "local",
    method: "dense",
    top_k: 5,
    filters: {},
    dataset: "legacy",
    case_id: "P01",
    question: envelope.question,
    browser_eval_id: "garden-time-location",
    embedding_model: "e5-small-multilingual",
  };
  const manifest = join(root, "embedding.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      schema_version: 1,
      execution_id: "browser-test",
      models: { "e5-small-multilingual": identity },
    }),
  );
  Object.assign(process.env, {
    COA_PROMPTFOO_ARTIFACT_DIR: root,
    COA_PROMPTFOO_EXECUTION_ID: "browser-test",
    COA_PROMPTFOO_EMBEDDING_MANIFEST: manifest,
    COA_PROMPTFOO_EMBEDDING_MANIFEST_SHA256: sha256(readFileSync(manifest)),
  });
  return {
    spec,
    identity,
    envelope,
    vars,
    grade: (value: Envelope = envelope) => getAssert(value, { vars }),
  };
}
test("true E5 identity and prefixed corpus have source goal details", (t) => {
  const { identity, grade } = setup(t),
    result = grade();
  assert.equal(result.pass, true, result.reason);
  const metrics = result.metadata!.source_metrics;
  assert.deepEqual(metrics.embedding_identity, identity);
  assert.equal(metrics.goals!.length, 2);
  assert.ok(metrics.goals!.every((goal) => goal.covered));
  assert.ok(
    metrics.goals!.every((goal) =>
      goal.alternatives.every((option) => option.every((ref) => ref.found)),
    ),
  );
});
test("model revision artifact prefix SDK or dimensions cannot be substituted", (t) => {
  const { spec, envelope, grade } = setup(t);
  const changes = {
    model: spec.repository + "@" + "c".repeat(40),
    encoding: spec.encoding + "; model_files_sha256=" + "c".repeat(64),
    document_prefix: "",
    query_prefix: "",
    sdk: "other",
    dimensions: 768,
  };
  for (const [field, value] of Object.entries(changes)) {
    const row = structuredClone(envelope),
      record = row.record as NativeRecord;
    Object.assign(record.outcome.corpus_identity.embedding!, {
      [field]: value,
    });
    Object.assign(record.preparation.corpus_identity.embedding!, {
      [field]: value,
    });
    const result = grade(row);
    assert.equal(result.pass, false, field);
    assert.equal(result.namedScores.execution_integrity, 0, field);
  }
});
test("unprefixed inputs or changed independent model pin fail", (t) => {
  const { envelope, grade } = setup(t),
    row = structuredClone(envelope),
    record = row.record as NativeRecord;
  record.outcome.corpus_identity.embedding_inputs_sha256 = "0".repeat(64);
  record.preparation.corpus_identity.embedding_inputs_sha256 = "0".repeat(64);
  assert.equal(grade(row).pass, false);
  process.env.COA_PROMPTFOO_EMBEDDING_MANIFEST_SHA256 = "0".repeat(64);
  const result = grade();
  assert.equal(result.pass, false);
  assert.equal(result.namedScores.execution_integrity, 0);
});
test("word-only run has no actual embedding and cannot relabel vectors as unused", (t) => {
  const { vars, envelope, identity, grade } = setup(t);
  vars.method = "bm25";
  const record = envelope.record as NativeRecord;
  record.config.retrieval.method = "bm25";
  record.outcome.config.method = "bm25";
  const corpus = record.outcome.corpus_identity;
  corpus.embedding = null;
  corpus.vectors_sha256 = null;
  corpus.embedding_inputs_sha256 = sha256(
    canonicalJson(
      [...canonicalSources().values()].map(
        (section) =>
          section.source_title + "\n" + section.heading + "\n" + section.text,
      ),
    ),
  );
  record.preparation.corpus_identity = structuredClone(corpus);
  for (const candidate of record.outcome.candidates) {
    const scores = candidate.scores;
    scores.bm25_score = scores.dense_similarity;
    scores.keyword_rank = scores.dense_rank;
    scores.dense_similarity = null;
    scores.dense_rank = null;
  }
  for (const [index, hit] of record.outcome.hits.entries())
    hit.scores = structuredClone(record.outcome.candidates[index].scores);
  const valid = grade();
  assert.equal(valid.pass, true, valid.reason);
  assert.equal(valid.metadata!.source_metrics.embedding_identity, null);
  corpus.embedding = identity;
  record.preparation.corpus_identity.embedding = identity;
  const invalid = grade();
  assert.equal(invalid.pass, false);
  assert.equal(invalid.namedScores.execution_integrity, 0);
});

function currentBrowserFixture(
  t: test.TestContext,
  id: string,
  preset?: string,
) {
  const original = setup(t);
  const require = createRequire(import.meta.url);
  const config = require("../cases.cjs").buildConfig({
    COA_PROMPTFOO_SUITE: "browser",
    COA_PROMPTFOO_EVAL_ID: id,
    COA_PROMPTFOO_METHODS: "dense",
    COA_PROMPTFOO_EMBEDDING_MODEL: "e5-small-multilingual",
    ...(preset ? { COA_PROMPTFOO_BROWSER_PRESET: preset } : {}),
  });
  const vars = config.tests[0].vars;
  const envelope = localRecord([]),
    record = envelope.record as NativeRecord;
  Object.assign(envelope, {
    dataset_id: vars.dataset,
    case_id: vars.case_id,
    question: vars.question,
  });
  Object.assign(record, {
    case_id: vars.case_id,
    question: vars.question,
    dataset: { corpus_sha256: vars.corpus_sha256, as_of: "2026-11-13" },
  });
  const retrieval = Object.fromEntries(
    Object.keys(DEFAULTS)
      .filter((key) => key in record.config.retrieval)
      .map((key) => [key, vars[key]]),
  );
  record.config = {
    profile: vars.profile,
    retrieval: retrieval as NativeRecord["config"]["retrieval"],
  };
  record.outcome.config = structuredClone(record.config.retrieval);
  record.outcome.query = vars.question;
  const sources = [...canonicalSources(false, true).values()];
  const corpus = record.outcome.corpus_identity;
  corpus.source_sha256 = sha256(canonicalJson(sources.map(orderedSection)));
  corpus.embedding_inputs_sha256 = sha256(
    canonicalJson(
      sources.map(
        (section) =>
          "passage: " +
          section.source_title +
          "\n" +
          section.heading +
          "\n" +
          section.text,
      ),
    ),
  );
  corpus.embedding = structuredClone(original.identity);
  record.preparation.corpus_identity = structuredClone(corpus);
  record.preparation.actual_profile = vars.profile;
  record.preparation.layout = {
    canonical_sections: 72,
    activity_records: 0,
    activity_section_links: 0,
  };
  return {
    ...original,
    vars,
    envelope,
    record,
    grade: () => getAssert(envelope, { vars }),
  };
}
test("every public quality case and typed active case reaches its own frozen source criteria", (t) => {
  const resolver = createRequire(import.meta.url)("../browser_cases.cjs");
  const ids = [
    ...resolver.publicBrowserCases().map((row: { id: string }) => row.id),
    ...resolver.activeBrowserCases().map((row: { id: string }) => row.id),
  ];
  for (const id of ids) {
    const fixture = currentBrowserFixture(t, id);
    const grade = fixture.grade();
    assert.equal(
      grade.namedScores.execution_integrity,
      1,
      `${id}: ${grade.reason}`,
    );
    const criteria = loadCase(fixture.vars.dataset, fixture.vars.case_id);
    assert.equal(
      grade.metadata!.source_metrics.reference_sha256,
      criteria.reference_sha256,
    );
    assert.equal(
      grade.metadata!.source_metrics.question_sha256,
      criteria.question_sha256,
    );
    if (grade.metadata!.source_metrics.target_goals) {
      assert.equal(grade.pass, false);
      assert.equal(grade.metadata!.source_metrics.covered_goals, 0);
    }
  }
});
test("both E5 k3 presets retain integrity while missing sources remain real quality failures", (t) => {
  for (const preset of ["dense-k3-sections", "dense-k3-activity-expansion"]) {
    const fixture = currentBrowserFixture(
      t,
      "case:regression-12-20261118:IND26-01",
      preset,
    );
    const grade = fixture.grade();
    assert.equal(grade.namedScores.execution_integrity, 1, grade.reason);
    assert.equal(grade.pass, false);
    assert.equal(grade.metadata!.source_metrics.target_goals, 10);
    assert.equal(grade.metadata!.source_metrics.covered_goals, 0);
  }
});
test("generic browser grading rejects wrong query dataset case corpus and preset bindings", (t) => {
  for (const change of [
    "question",
    "case",
    "dataset",
    "native-corpus",
    "declared-corpus",
    "preset",
  ]) {
    const fixture = currentBrowserFixture(t, "quality-music");
    if (change === "question") {
      fixture.vars.question += " changed";
      fixture.envelope.question = fixture.vars.question;
      fixture.record.question = fixture.vars.question;
      fixture.record.outcome.query = fixture.vars.question;
    }
    if (change === "case")
      fixture.vars.browser_eval_id = "case:demo-12-20261118:RAG26-05";
    if (change === "dataset")
      fixture.vars.browser_eval_id = "case:regression-12-20261118:IND26-01";
    if (change === "native-corpus")
      fixture.record.dataset.corpus_sha256 = "0".repeat(64);
    if (change === "declared-corpus")
      fixture.vars.corpus_sha256 = "0".repeat(64);
    if (change === "preset") fixture.vars.browser_preset = "dense-k3-sections";
    assert.equal(fixture.grade().namedScores.execution_integrity, 0, change);
  }
});
test("export-redacted redundant corpus metadata never replaces native and frozen corpus proof", (t) => {
  const fixture = currentBrowserFixture(t, "quality-music");
  fixture.vars.corpus_sha256 = "[REDACTED]";
  assert.equal(
    fixture.grade().namedScores.execution_integrity,
    1,
    fixture.grade().reason,
  );
  fixture.record.dataset.corpus_sha256 = "0".repeat(64);
  assert.equal(fixture.grade().namedScores.execution_integrity, 0);
});
