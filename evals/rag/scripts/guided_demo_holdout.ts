import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkedFile, same, sha256 } from "../promptfoo/json.ts";
import type { Section } from "../promptfoo/types.ts";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "../../..");
const dataset = join(root, "evals/shared/datasets/guided-demo-20261123/cases.json");
const frozenSha256 = "33b05aaff1872eba8f18c9e08a7c047f25d5e9e380b6863dfddb795532b662fd";
const methods = ["dense", "bm25", "guided"] as const;
const topK = 3;
const contextLimit = 1200;

type Method = typeof methods[number];
type Classification = {
  matches: string[];
  unknown: string[];
  exhaustive: boolean;
};
type Case = {
  id: string;
  theme: string;
  question: string;
  followups: string[];
  alternatives: string[][];
  firstGuided?: Classification;
};
type Dataset = {
  schema: string;
  corpus: string;
  corpusSha256: string;
  sources: { path: string; sha256: string }[];
  cases: Case[];
};
type Fingerprint = { id: string; date: string; title: string; sha256: string };
type GuidedResult = Classification & {
  applied: boolean;
  estimated_context_tokens: number;
  omitted_sections: number;
  config: { method: string; selection: string; top_k: number; candidate_k: number; context_token_limit: number; vector_weight: number };
};
type SearchResult = {
  question: string;
  retrieval_method: Method;
  top_k: number;
  as_of: string;
  sources: Fingerprint[];
  manifest: { source_sha256: string; document_vectors_sha256: string };
  hits: { section: Section }[];
  retrieval_policy?: string;
  requested_top_k?: number;
  guided_selection?: GuidedResult;
};
type Row = {
  caseId: string;
  method: Method;
  attempt: number;
  query: string;
  result?: SearchResult;
  error?: string;
};

export function earliestComplete(alternatives: string[][], attempts: string[][]): number | null {
  const delivered = new Set<string>();
  for (const [index, ids] of attempts.entries()) {
    ids.forEach(id => delivered.add(id));
    if (alternatives.some(plan => plan.every(id => delivered.has(id)))) return index + 1;
  }
  return null;
}

function sectionKey(section: Section): string {
  return section.source_id + ":" + section.id;
}

function loadDataset() {
  const bytes = readFileSync(dataset);
  assert.equal(sha256(bytes), frozenSha256, "frozen holdout bytes");
  const definition = JSON.parse(bytes.toString("utf8")) as Dataset;
  const documents = definition.sources.map(source => {
    const path = checkedFile(join(root, source.path), root, 128 * 1024);
    const bytes = readFileSync(path);
    assert.equal(sha256(bytes), source.sha256, source.path);
    return bytes.toString("utf8");
  });
  assert.equal(sha256(documents.join("\n---document---\n")), definition.corpusSha256, "live corpus order and bytes");

  const sections = new Map<string, Section>();
  const fingerprints = documents.map((document, index) => {
    const title = /^# (.+)$/m.exec(document)?.[1];
    const id = /^ID: (.+)$/m.exec(document)?.[1];
    const date = /^Brondatum: (\d{4}-\d{2}-\d{2})$/m.exec(document)?.[1];
    assert(title && id && date, definition.sources[index].path);
    const headings = [...document.matchAll(/^## (S\d+) — (.+)$/gm)];
    for (const [offset, heading] of headings.entries()) {
      const section = {
        source_id: id,
        source_title: title,
        source_date: date,
        id: heading[1],
        heading: heading[2],
        text: document.slice(heading.index + heading[0].length, headings[offset + 1]?.index).trim(),
      };
      const key = sectionKey(section);
      assert(section.text && !sections.has(key), key);
      sections.set(key, section);
    }
    return { id, date, title, sha256: definition.sources[index].sha256 };
  });
  assert.equal(fingerprints.length, 12);
  assert.equal(sections.size, 72);
  assert.equal(definition.cases.length, 12);
  for (const scenario of definition.cases) {
    const phrases = [scenario.question, ...scenario.followups];
    assert(phrases.length <= 3 && phrases.every(phrase => phrase.length > 0 && phrase === phrase.trim()));
    assert(scenario.alternatives.length > 0 && scenario.alternatives.every(plan =>
      plan.length > 0 && plan.every(key => sections.has(key)) && new Set(plan).size === plan.length), scenario.id);
    assert(scenario.firstGuided === undefined || [
      ...scenario.firstGuided.matches, ...scenario.firstGuided.unknown,
    ].every(id => fingerprints.some(source => source.id === id)), scenario.id);
  }
  return { definition, sections, fingerprints };
}

function planRows(definition: Dataset) {
  return definition.cases.flatMap(scenario => methods.flatMap(method =>
    [scenario.question, ...scenario.followups].map((query, index) => ({
      caseId: scenario.id, method, attempt: index + 1, query,
    })),
  ));
}

function emittedTokens(result: SearchResult): number {
  return result.hits.reduce((total, hit) => total + Math.ceil([...JSON.stringify(hit.section)].length / 4), 0);
}

function assess(corpus: ReturnType<typeof loadDataset>, rows: Row[]) {
  const { definition, sections, fingerprints } = corpus;
  const planned = planRows(definition);
  assert.equal(rows.length, planned.length, "all planned rows captured");
  const technicalErrors: string[] = [];
  const corpusVectors = new Set<string>();
  const valid = new Map<string, SearchResult>();
  for (const [index, row] of rows.entries()) {
    const { caseId, method, attempt, query, result } = row;
    assert.deepEqual({ caseId, method, attempt, query }, planned[index]);
    const identification = [caseId, method, attempt].join("/");
    try {
      assert(result && !row.error, row.error ?? "missing CLI result");
      assert.equal(result.question, query);
      assert.equal(result.retrieval_method, method);
      assert.equal(result.top_k, topK);
      assert.equal(result.manifest.source_sha256, definition.corpusSha256);
      assert(same(result.sources, fingerprints), "source provenance differs");
      assert.equal(result.as_of, "2026-11-13");
      assert(/^[0-9a-f]{64}$/.test(result.manifest.document_vectors_sha256), "missing vector hash");
      corpusVectors.add(result.manifest.document_vectors_sha256);
      const seen = new Set<string>();
      for (const hit of result.hits) {
        const key = sectionKey(hit.section);
        const expected = sections.get(key);
        assert(expected && same(hit.section, expected) && !seen.has(key), "noncanonical or duplicate section " + key);
        seen.add(key);
      }
      if (method === "guided") {
        const selection = result.guided_selection;
        assert(selection && result.retrieval_policy === "guided-rag-v1");
        assert.equal(result.requested_top_k, topK);
        assert.equal(selection.estimated_context_tokens, emittedTokens(result));
        assert(selection.estimated_context_tokens <= contextLimit, "context limit exceeded");
        assert.equal(selection.config.context_token_limit, contextLimit);
        assert.equal(selection.config.method, "hybrid_weighted");
        assert.equal(selection.config.selection, "activity_expansion");
        assert.equal(selection.config.top_k, topK);
        assert.equal(selection.config.candidate_k, 30);
        assert.equal(selection.config.vector_weight, 0.7);
        assert(typeof selection.applied === "boolean" && typeof selection.exhaustive === "boolean");
        assert(Number.isInteger(selection.omitted_sections) && selection.omitted_sections >= 0);
        assert(Array.isArray(selection.matches) && Array.isArray(selection.unknown));
        const classified = [...selection.matches, ...selection.unknown];
        assert.equal(new Set(classified).size, classified.length, "duplicate or conflicting classifications");
        assert(classified.every(id => fingerprints.some(source => source.id === id)), "unknown activity identifier");
        assert(!selection.exhaustive || (selection.applied && selection.omitted_sections === 0 && selection.unknown.length === 0));
        assert(selection.matches.every(id => result.hits.some(hit => hit.section.source_id === id)), "matched activity without emitted evidence");
      } else {
        assert(result.hits.length <= topK && !result.guided_selection);
      }
      valid.set(identification, result);
    } catch (error) {
      technicalErrors.push(identification + ": " + String(error));
    }
  }
  if (corpusVectors.size !== 1) technicalErrors.push("expected one shared set of document vectors");

  const typedFailures: string[] = [];
  const cases = definition.cases.map(scenario => {
    const caseMethods = methods.map(method => {
      const results = [scenario.question, ...scenario.followups].map((_query, index) =>
        valid.get([scenario.id, method, index + 1].join("/")),
      );
      const attempts = results.map(result => result?.hits.map(hit => sectionKey(hit.section)) ?? []);
      const delivery = new Set(attempts.flat());
      if (method === "guided" && scenario.firstGuided) {
        const metadata = results[0]?.guided_selection;
        if (!metadata?.applied ||
            !same([...metadata.matches].sort(), [...scenario.firstGuided.matches].sort()) ||
            !same([...metadata.unknown].sort(), [...scenario.firstGuided.unknown].sort()) ||
            metadata.exhaustive !== scenario.firstGuided.exhaustive) typedFailures.push(scenario.id);
      }
      return {
        method,
        firstComplete: earliestComplete(scenario.alternatives, attempts),
        attempts,
        missingAlternatives: scenario.alternatives.map(plan => plan.filter(id => !delivery.has(id))),
      };
    });
    return { id: scenario.id, theme: scenario.theme, methods: caseMethods };
  });
  const summary = methods.map((method, index) => ({
    method,
    first: cases.filter(scenario => scenario.methods[index].firstComplete === 1).length,
    final: cases.filter(scenario => scenario.methods[index].firstComplete !== null).length,
  }));
  const losses = cases.filter(scenario =>
    scenario.methods[2].firstComplete === null && scenario.methods.slice(0, 2).some(method => method.firstComplete !== null),
  ).map(scenario => scenario.id);
  const [,, guided] = summary;
  return {
    verdict: guided.first >= 10 && guided.final === cases.length && !losses.length &&
        !technicalErrors.length && !typedFailures.length ? "GO" : "NO_GO",
    rows: rows.length,
    summary,
    cases,
    typedFailures,
    technicalErrors,
    losses,
  };
}

function renderReport(assessment: ReturnType<typeof assess>): string {
  return [
    "# Guided demo holdout",
    "",
    `**${assessment.verdict}** with ${assessment.rows} planned retrieval rows.`,
    "",
    "| Method | Complete on first search | Complete after planned searches |",
    "| --- | ---: | ---: |",
    ...assessment.summary.map(row => `| ${row.method} | ${row.first}/12 | ${row.final}/12 |`),
    "",
    "| Case | Dense first complete | BM25 first complete | Guided first complete |",
    "| --- | ---: | ---: | ---: |",
    ...assessment.cases.map(scenario =>
      `| ${scenario.id} | ${scenario.methods.map(method => method.firstComplete ?? "incomplete").join(" | ")} |`,
    ),
    "",
    "Typed classification misses " + (assessment.typedFailures.join(", ") || "none") + ".",
    "Prior complete-case losses " + (assessment.losses.join(", ") || "none") + ".",
    "Technical or provenance errors " + assessment.technicalErrors.length + ".",
    "",
    "These were fixed source-only searches through the demo Index. Generated answer quality was outside this comparison.",
    "",
  ].join("\n");
}

function run(binary: string, out: string) {
  const corpus = loadDataset();
  const privateRoot = join(root, "evals/rag/results/local");
  const outputPath = relative(privateRoot, out);
  assert(outputPath.length > 0 && !outputPath.startsWith("..") && !isAbsolute(outputPath), "use a fresh path under evals/rag/results/local/");
  assert(statSync(binary).isFile(), "built demo binary required");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "", "measure a clean committed workspace");
  const binarySha256 = sha256(readFileSync(binary));
  const cache = join(root, ".model-cache/models--Qdrant--paraphrase-multilingual-MiniLM-L12-v2-onnx-Q");
  const cacheRevision = readFileSync(join(cache, "refs/main"), "utf8").trim();
  for (const file of ["config.json", "model_optimized.onnx", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json"]) {
    assert(statSync(join(cache, "snapshots", cacheRevision, file)).isFile(), "complete local MiniLM cache required");
  }

  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(out, { mode: 0o700 });
  const raw = join(out, "raw.jsonl");
  const plan = planRows(corpus.definition);
  const env = { PATH: process.env.PATH, COA_DISABLE_DOTENV: "1", HF_HUB_OFFLINE: "1" };
  const batches = methods.map(method => {
    const queries = plan.filter(attempt => attempt.method === method).map(attempt => attempt.query);
    const started = performance.now();
    const result = spawnSync(binary, [
      "search", "--queries-stdin", "--corpus", "demo-twelve", "--method", method, "--top-k", String(topK),
    ], { cwd: root, env, encoding: "utf8", input: JSON.stringify(queries), timeout: 120_000, maxBuffer: 1024 * 1024 });
    const elapsedMs = Math.round(performance.now() - started);
    if (result.status !== 0) return {
      method, elapsedMs, error: result.error?.message ?? "CLI exited " + String(result.status ?? result.signal),
    };
    try {
      const results = JSON.parse(result.stdout) as SearchResult[];
      assert(Array.isArray(results) && results.length === queries.length, "batch response length");
      return { method, elapsedMs, results };
    } catch {
      return { method, elapsedMs, error: "invalid CLI result array" };
    }
  });
  const offsets = new Map<Method, number>();
  const rows: Row[] = plan.map(attempt => {
    const batch = batches[methods.indexOf(attempt.method)];
    const offset = offsets.get(attempt.method) ?? 0;
    offsets.set(attempt.method, offset + 1);
    const row = { ...attempt, result: batch.results?.[offset], error: batch.error };
    appendFileSync(raw, JSON.stringify(row) + "\n", { mode: 0o600 });
    return row;
  });
  assert.equal(sha256(readFileSync(binary)), binarySha256, "binary changed during holdout");
  const provenance = {
    revision,
    runnerSha256: sha256(readFileSync(script)),
    binarySha256,
    cacheRevision,
    datasetSha256: frozenSha256,
    corpusSha256: corpus.definition.corpusSha256,
    rawSha256: sha256(readFileSync(raw)),
    planSha256: sha256(JSON.stringify(plan)),
    batchElapsedMs: batches.map(({ method, elapsedMs }) => ({ method, elapsedMs })),
  };
  writeFileSync(join(out, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n", { mode: 0o600 });
  const assessment = assess(corpus, rows);
  writeFileSync(join(out, "assessment.json"), JSON.stringify(assessment, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(renderReport(assessment));
  writeFileSync(join(out, "report.md"), renderReport(assessment), { mode: 0o600 });
  if (assessment.verdict !== "GO") process.exitCode = 1;
}

function replay(out: string) {
  const corpus = loadDataset();
  const raw = readFileSync(join(out, "raw.jsonl"));
  const provenance = JSON.parse(readFileSync(join(out, "provenance.json"), "utf8"));
  assert.equal(provenance.datasetSha256, frozenSha256);
  assert.equal(provenance.corpusSha256, corpus.definition.corpusSha256);
  assert.equal(provenance.rawSha256, sha256(raw));
  assert.equal(provenance.planSha256, sha256(JSON.stringify(planRows(corpus.definition))));
  const rows = raw.toString("utf8").trim().split("\n").map(row => JSON.parse(row) as Row);
  process.stdout.write(renderReport(assess(corpus, rows)));
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const { values } = parseArgs({ options: {
    binary: { type: "string" },
    out: { type: "string" },
    replay: { type: "string" },
  } });
  if (values.replay && !values.binary && !values.out) replay(resolve(values.replay));
  else if (values.binary && values.out && !values.replay) run(resolve(values.binary), resolve(values.out));
  else throw new Error("Use --binary BINARY --out NEW_FOLDER or --replay EXISTING_FOLDER");
}
