import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAssert, canonicalSources } from "../assertions.ts";
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
