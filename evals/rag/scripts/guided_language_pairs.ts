import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sha256 } from "../promptfoo/json.ts";
import { earliestComplete, loadDataset, passesSelector, sectionKey, validateSearchResult } from "./guided_demo_holdout.ts";
import type { Case, SearchResult } from "./guided_demo_holdout.ts";

type ExpectedSelector = { applied?: boolean; matches: string[]; unknown: string[]; exhaustive: boolean };
type Selection = ExpectedSelector & { applied: boolean };
type Attempt = { passages: string[]; selection: Selection | null };

export function assessLanguageCase(
  scenario: { alternatives: string[][]; firstGuided?: ExpectedSelector },
  attempts: Attempt[],
) {
  const delivered = new Set(attempts.flatMap(attempt => attempt.passages));
  const observed = attempts[0]?.selection ?? null;
  return {
    firstComplete: earliestComplete(scenario.alternatives, attempts.map(attempt => attempt.passages)),
    missingAlternatives: scenario.alternatives.map(plan => plan.filter(id => !delivered.has(id))),
    selector: scenario.firstGuided ? {
      expected: scenario.firstGuided,
      observed,
      passed: passesSelector(scenario.firstGuided, observed),
    } : null,
  };
}

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "../../..");
const validator = join(dirname(script), "guided_demo_holdout.ts");
const fixture = join(root, "evals/shared/datasets/guided-demo-20261123/language-pairs.json");
const translationSha256 = "432d51be9a548da0b9dcdc85809103cb0e3a00208b11b2477b417ea5703d3c0c";
const baselineBinary = {
  guidedPolicy: "guided-rag-v4",
  binaryRevision: "9381cec7c89705f4339eade749ed7ea98cd826b8",
  binarySha256: "6d0aff2aee00005de72cc69f7dba3cdee6f8fbf49a98c3d231631573432a6c8b",
} as const;
const baselineCaptureTools = {
  runnerSha256: "1da1665ed1d4fcf0fd77209212e98c2edd221ee31a71c1c21c6ebf8af7684805",
  validatorSha256: "e6097f3b564959010787162711cb9b81ca1be27083d80071a84181b09e9c3721",
};
const model = "Qdrant/paraphrase-multilingual-MiniLM-L12-v2-onnx-Q";
const cacheRevision = "faf4aa4225822f3bc6376869cb1164e8e3feedd0";
const vectorSha256 = "12d9d025926131d834919d15a4a80bd15783246d86787c9830aa52477ac93e3b";
const embeddingInputsSha256 = "ad7574ea8c878b7db5f9e1465f411f3f2cfd7be40b3b8eb4470faa3f475f1581";
const embeddingSettingsSha256 = "3d9e7a996bc51af7255687b8b541ad78c4bc7dd0aaddbb2d7fb6866862e36a1f";
const languages = ["nl", "en"] as const;
const topK = 3;
const batchLength = 54;

type Language = typeof languages[number];
type Translation = Pick<Case, "id" | "question" | "followups"> & { language: Language };
type Query = { language: Language; caseId: string; attempt: number; query: string };
type Row = Query & { result?: SearchResult; error?: string };

type Binary = {
  guidedPolicy: "guided-rag-v4" | "guided-rag-v5";
  binaryRevision: string;
  binarySha256: string;
};

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trimEnd();
}

function loadPlan(binary: Binary) {
  const corpus = loadDataset("fallback");
  const bytes = readFileSync(fixture);
  assert.equal(sha256(bytes), translationSha256, "frozen translations");
  const translations = JSON.parse(bytes.toString("utf8")) as { schema: string; cases: Translation[] };
  assert.equal(translations.schema, "guided-demo-language-pairs-v1");
  assert.equal(translations.cases.length, corpus.definition.cases.length);
  const plan = languages.flatMap(language => corpus.definition.cases.flatMap((scenario, index) => {
    const translation = translations.cases[index];
    assert.equal(translation.id, scenario.id, "case order");
    assert(languages.includes(translation.language), scenario.id);
    assert.equal(translation.followups.length, scenario.followups.length, scenario.id);
    const selected = translation.language === language ? translation : scenario;
    const queries = [selected.question, ...selected.followups];
    assert(queries.every(query => query.length > 0 && query === query.trim()), scenario.id);
    return queries.map((query, offset) => ({ language, caseId: scenario.id, attempt: offset + 1, query }));
  }));
  for (const language of languages) {
    assert.equal(plan.filter(row => row.language === language).length, batchLength);
    assert.equal(translations.cases.filter(row => row.language === language).length, 11);
  }
  return { corpus, plan, binary };
}

function binding(input: ReturnType<typeof loadPlan>) {
  return {
    schema: "guided-demo-language-pairs-v1",
    translationSha256,
    planSha256: sha256(JSON.stringify(input.plan)),
    expectedCasesSha256: sha256(JSON.stringify(input.corpus.definition.cases)),
    corpusSha256: input.corpus.definition.corpusSha256,
    guidedPolicy: input.binary.guidedPolicy,
    model,
    cacheRevision,
    documentVectorsSha256: vectorSha256,
    embeddingInputsSha256,
    embeddingSettingsSha256,
    binaryRevision: input.binary.binaryRevision,
    binarySha256: input.binary.binarySha256,
  };
}

function assess(input: ReturnType<typeof loadPlan>, rows: Row[]) {
  assert.equal(rows.length, input.plan.length, "all planned rows captured");
  const technicalErrors: string[] = [];
  const valid = new Map<string, Attempt>();
  const corpusVectors = new Set<string>();

  const candidateMode = input.binary.guidedPolicy === "guided-rag-v5" ? "candidate-v5" : undefined;

  for (const [index, row] of rows.entries()) {
    const { result, error, ...query } = row;
    assert.deepEqual(query, input.plan[index], "ordered literal query");
    const id = [query.language, query.caseId, query.attempt].join("/");
    try {
      assert(result && !error, error ?? "missing retrieval result");
      validateSearchResult(result, query.query, "guided", input.corpus, corpusVectors, candidateMode);
      const manifest = result.manifest as Record<string, unknown>;
      assert.equal(manifest.model, model, "embedding model");
      assert.equal(manifest.dimensions, 384, "embedding dimensions");
      assert.equal(manifest.embedding_inputs_sha256, embeddingInputsSha256, "prepared embedding inputs");
      assert.equal(manifest.settings_sha256, embeddingSettingsSha256, "embedding settings");
      assert.equal(manifest.document_vectors_sha256, vectorSha256, "prepared corpus vectors");
      assert(result.guided_selection, "missing Guided selection");
      const { applied, matches, unknown, exhaustive } = result.guided_selection;
      valid.set(id, {
        passages: result.hits.map(hit => sectionKey(hit.section)),
        selection: { applied, matches, unknown, exhaustive },
      });
    } catch (failure) {
      technicalErrors.push(id + ": " + String(failure));
    }
  }
  if (corpusVectors.size !== 1) technicalErrors.push("expected one shared set of document vectors");

  const cases = input.corpus.definition.cases.map(scenario => ({
    id: scenario.id,
    theme: scenario.theme,
    alternatives: scenario.alternatives,
    languages: languages.map(language => {
      const attempts = [scenario.question, ...scenario.followups].map((_, index) =>
        valid.get([language, scenario.id, index + 1].join("/")) ?? { passages: [], selection: null },
      );
      return { language, ...assessLanguageCase(scenario, attempts), attempts };
    }),
  }));
  const summary = languages.map((language, index) => {
    const outcomes = cases.map(scenario => scenario.languages[index]);
    const checks = outcomes.flatMap(outcome => outcome.selector ? [outcome.selector] : []);
    return {
      language,
      first: outcomes.filter(outcome => outcome.firstComplete === 1).length,
      second: outcomes.filter(outcome => outcome.firstComplete === 2).length,
      third: outcomes.filter(outcome => outcome.firstComplete === 3).length,
      final: outcomes.filter(outcome => outcome.firstComplete !== null).length,
      typedChecksPassed: checks.filter(check => check.passed).length,
      typedChecksTotal: checks.length,
    };
  });
  return { rows: rows.length, summary, cases, technicalErrors };
}

function renderReport(assessment: ReturnType<typeof assess>, policy: Binary["guidedPolicy"]) {
  const count = assessment.cases.length;
  return [
    policy === "guided-rag-v5" ? "# Guided v5 candidate paired language evaluation" : "# Guided demo paired language evaluation",
    "",
    `${count} cases and ${assessment.rows} literal searches on the same indexed Dutch corpus.`,
    "",
    "| Question language | First complete on search 1 | First complete on search 2 | First complete on search 3 | Complete by end | Typed checks passed |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...assessment.summary.map(row =>
      `| ${row.language} | ${row.first}/${count} | ${row.second} | ${row.third} | ${row.final}/${count} | ${row.typedChecksPassed}/${row.typedChecksTotal} |`,
    ),
    "",
    "| Case | Theme | NL first complete | EN first complete |",
    "| --- | --- | ---: | ---: |",
    ...assessment.cases.map(scenario =>
      `| ${scenario.id} | ${scenario.theme} | ${scenario.languages.map(row => row.firstComplete ?? "incomplete").join(" | ")} |`,
    ),
    "",
    "Typed classification misses",
    "",
    ...assessment.cases.flatMap(scenario => scenario.languages.flatMap(row =>
      row.selector && !row.selector.passed ? [
        `- ${scenario.id} (${row.language}) expected ${JSON.stringify(row.selector.expected)}, observed ${JSON.stringify(row.selector.observed)}.`,
      ] : [],
    )),
    "",
    `Technical or provenance errors ${assessment.technicalErrors.length}.`,
    ...assessment.technicalErrors.map(error => "- " + error),
    "",
  ].join("\n");
}

function requireCandidateSource(binary: Binary, revision: string) {
  if (binary.guidedPolicy === "guided-rag-v5") {
    assert.equal(revision, binary.binaryRevision, "v5 source commit");
    assert.equal(git("status", "--porcelain"), "", "measure v5 from a clean committed worktree");
  }
}

function run(binary: string, out: string, input: ReturnType<typeof loadPlan>) {
  const privateRoot = join(root, "evals/rag/results/local");
  assert.equal(dirname(out), privateRoot, "use a fresh direct child of evals/rag/results/local");
  assert.equal(sha256(readFileSync(binary)), input.binary.binarySha256, "reviewed macOS CLI binary");
  const cache = join(root, ".model-cache/models--Qdrant--paraphrase-multilingual-MiniLM-L12-v2-onnx-Q");
  assert.equal(readFileSync(join(cache, "refs/main"), "utf8").trim(), cacheRevision, "MiniLM cache revision");
  for (const file of ["config.json", "model_optimized.onnx", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json"]) {
    assert(statSync(join(cache, "snapshots", cacheRevision, file)).isFile(), "complete local MiniLM cache required");
  }
  const revision = git("rev-parse", "HEAD");
  requireCandidateSource(input.binary, revision);
  const runnerSha256 = sha256(readFileSync(script));
  const validatorSha256 = sha256(readFileSync(validator));
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(out, { mode: 0o700 });
  const batchElapsedMs: { language: Language; elapsedMs: number }[] = [];
  const env = { PATH: process.env.PATH, COA_DISABLE_DOTENV: "1", HF_HUB_OFFLINE: "1" };
  const rows = languages.flatMap<Row>(language => {
    const entries = input.plan.filter(row => row.language === language);
    const start = performance.now();
    const output = spawnSync(binary, [
      "search", "--queries-stdin", "--corpus", input.corpus.definition.corpus, "--method", "guided", "--top-k", String(topK),
    ], {
      cwd: root, env, encoding: "utf8", input: JSON.stringify(entries.map(row => row.query)),
      timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    });
    batchElapsedMs.push({ language, elapsedMs: Math.round(performance.now() - start) });
    if (output.status !== 0) {
      const error = output.error?.message ?? "CLI exited " + String(output.status ?? output.signal);
      return entries.map(entry => ({ ...entry, error }));
    }
    const results = JSON.parse(output.stdout) as SearchResult[];
    assert(Array.isArray(results) && results.length === entries.length, "batch response length");
    return entries.map((entry, index) => ({ ...entry, result: results[index] }));
  });
  requireCandidateSource(input.binary, git("rev-parse", "HEAD"));
  assert.equal(sha256(readFileSync(binary)), input.binary.binarySha256, "binary changed during run");
  assert.equal(sha256(readFileSync(script)), runnerSha256, "runner changed during run");
  assert.equal(sha256(readFileSync(validator)), validatorSha256, "validator changed during run");
  assert.deepEqual(binding(loadPlan(input.binary)), binding(input), "plan changed during run");

  const raw = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(join(out, "raw.jsonl"), raw, { mode: 0o600 });
  writeFileSync(join(out, "provenance.json"), JSON.stringify({
    ...binding(input), revision, runnerSha256, validatorSha256,
    rawSha256: sha256(raw), batchElapsedMs,
  }, null, 2) + "\n", { mode: 0o600 });
  const assessment = assess(input, rows);
  const report = renderReport(assessment, input.binary.guidedPolicy);
  writeFileSync(join(out, "assessment.json"), JSON.stringify(assessment, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(out, "report.md"), report, { mode: 0o600 });
  process.stdout.write(report);
  if (assessment.technicalErrors.length) process.exitCode = 1;
}

function replay(out: string, input: ReturnType<typeof loadPlan>) {
  const provenance = JSON.parse(readFileSync(join(out, "provenance.json"), "utf8"));
  for (const [key, value] of Object.entries(binding(input))) assert.equal(provenance[key], value, key);
  const baselineCapture = input.binary.guidedPolicy === "guided-rag-v4" &&
    provenance.runnerSha256 === baselineCaptureTools.runnerSha256 &&
    provenance.validatorSha256 === baselineCaptureTools.validatorSha256;
  if (!baselineCapture) {
    assert.equal(provenance.runnerSha256, sha256(readFileSync(script)), "captured runner");
    assert.equal(provenance.validatorSha256, sha256(readFileSync(validator)), "captured validator");
  }
  if (input.binary.guidedPolicy === "guided-rag-v5") {
    assert.equal(provenance.revision, input.binary.binaryRevision, "captured v5 source commit");
  }
  const raw = readFileSync(join(out, "raw.jsonl"), "utf8");
  assert.equal(sha256(raw), provenance.rawSha256, "raw rows");
  const rows = raw.trimEnd().split("\n").map(line => JSON.parse(line) as Row);
  const assessment = assess(input, rows);
  process.stdout.write(renderReport(assessment, input.binary.guidedPolicy));
  if (assessment.technicalErrors.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const { values } = parseArgs({ options: {
    binary: { type: "string" },
    out: { type: "string" },
    replay: { type: "string" },
    plan: { type: "boolean" },
    "candidate-v5": { type: "boolean" },
    "binary-revision": { type: "string" },
    "binary-sha256": { type: "string" },
  } });
  const revision = values["binary-revision"];
  const digest = values["binary-sha256"];
  let binary: Binary = baselineBinary;
  if (values["candidate-v5"]) {
    assert(revision && /^[a-f0-9]{40}$/.test(revision) && digest && /^[a-f0-9]{64}$/.test(digest),
      "--candidate-v5 requires --binary-revision and --binary-sha256");
    assert.notEqual(digest, baselineBinary.binarySha256, "v5 requires a distinct binary");
    assert.equal(git("cat-file", "-t", revision), "commit", "v5 source commit");
    binary = { guidedPolicy: "guided-rag-v5", binaryRevision: revision, binarySha256: digest };
  } else {
    assert(!revision && !digest, "specify binary identity only with --candidate-v5");
  }
  const input = loadPlan(binary);
  if (values.plan && !values.binary && !values.out && !values.replay) {
    process.stdout.write(JSON.stringify({ binding: binding(input), queries: input.plan }, null, 2) + "\n");
  } else if (values.replay && !values.binary && !values.out && !values.plan) {
    replay(resolve(values.replay), input);
  } else if (values.binary && values.out && !values.replay && !values.plan) {
    run(resolve(values.binary), resolve(values.out), input);
  } else {
    throw new Error("Use --plan, --binary BINARY --out NEW_FOLDER, or --replay EXISTING_FOLDER");
  }
}
