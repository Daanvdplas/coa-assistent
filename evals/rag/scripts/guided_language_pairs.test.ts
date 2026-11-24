import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDataset, validateSearchResult } from "./guided_demo_holdout.ts";
import { assessLanguageCase } from "./guided_language_pairs.ts";

test("a case completes only after one entire source alternative is delivered", () => {
  const result = assessLanguageCase(
    { alternatives: [["A:S1", "A:S2"], ["B:S1", "B:S2"]] },
    [
      { passages: ["A:S1", "B:S2"], selection: null },
      { passages: ["A:S2"], selection: null },
    ],
  );

  assert.equal(result.firstComplete, 2);
  assert.deepEqual(result.missingAlternatives, [[], ["B:S1"]]);
});

test("typed match, unknown and exhaustiveness are checked on the first search", () => {
  const exact = { matches: ["A"], unknown: [], exhaustive: true };
  const result = assessLanguageCase({ alternatives: [["A:S1"]], firstGuided: exact }, [
    { passages: ["A:S1"], selection: { applied: false, matches: [], unknown: [], exhaustive: false } },
    { passages: ["A:S1"], selection: { ...exact, applied: true } },
  ]);

  assert.equal(result.firstComplete, 1);
  assert.deepEqual(result.selector, {
    expected: exact,
    observed: { applied: false, matches: [], unknown: [], exhaustive: false },
    passed: false,
  });
});

test("no evidence from another language or another case can complete a case", () => {
  const result = assessLanguageCase({ alternatives: [["A:S1", "A:S2"]] }, [
    { passages: ["A:S2", "A:S2"], selection: null },
    { passages: [], selection: null },
  ]);

  assert.equal(result.firstComplete, null);
  assert.deepEqual(result.missingAlternatives, [["A:S1"]]);
});

test("the candidate plan preserves the literal inputs and requires an explicit v5 binary identity", () => {
  const script = fileURLToPath(new URL("./guided_language_pairs.ts", import.meta.url));
  const runPlan = (...options: string[]) => spawnSync(process.execPath, [script, "--plan", ...options], {
    encoding: "utf8",
  });
  const baseline = runPlan();
  assert.equal(baseline.status, 0, baseline.stderr);
  const original = JSON.parse(baseline.stdout);
  const candidateRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const candidateHash = "b".repeat(64);

  const explicit = runPlan(
    "--candidate-v5", "--binary-revision", candidateRevision, "--binary-sha256", candidateHash,
  );
  assert.equal(explicit.status, 0, explicit.stderr);
  const candidate = JSON.parse(explicit.stdout);
  assert.deepEqual(candidate.queries, original.queries);
  assert.deepEqual(candidate.binding, {
    ...original.binding,
    guidedPolicy: "guided-rag-v5",
    binaryRevision: candidateRevision,
    binarySha256: candidateHash,
  });

  const implicit = runPlan("--candidate-v5");
  assert.equal(implicit.status, 1);
  assert.match(implicit.stderr, /binary-revision and --binary-sha256/);
  const mislabeled = runPlan("--binary-revision", candidateRevision, "--binary-sha256", candidateHash);
  assert.equal(mislabeled.status, 1);
  assert.match(mislabeled.stderr, /only with --candidate-v5/);
});

test("the shared search validator rejects a v4 response in a v5 run", () => {
  const corpus = loadDataset("fallback");
  const question = "Example question";
  const response = {
    question,
    retrieval_method: "guided" as const,
    top_k: 3,
    requested_top_k: 3,
    as_of: "2026-11-13",
    sources: corpus.fingerprints,
    manifest: { source_sha256: corpus.definition.corpusSha256, document_vectors_sha256: "a".repeat(64) },
    hits: [],
    guided_selection: {
      applied: false, exhaustive: false, matches: [], unknown: [],
      estimated_context_tokens: 0, omitted_sections: 0,
      config: {
        context_token_limit: 1200, method: "hybrid_weighted", selection: "activity_expansion",
        top_k: 3, candidate_k: 30, vector_weight: 0.7,
      },
    },
  };
  assert.doesNotThrow(() => validateSearchResult(
    { ...response, retrieval_policy: "guided-rag-v5" }, question, "guided", corpus, new Set(), "candidate-v5",
  ));
  assert.throws(() => validateSearchResult(
    { ...response, retrieval_policy: "guided-rag-v4" }, question, "guided", corpus, new Set(), "candidate-v5",
  ), /Guided policy version/);
});
