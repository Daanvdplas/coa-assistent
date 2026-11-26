import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sha256 } from "../promptfoo/json.ts";
import { loadDataset, passesSelector, sectionKey, validateSearchResult } from "./guided_demo_holdout.ts";
import type { SearchResult } from "./guided_demo_holdout.ts";

type Case = { id: string; question: string; expectedActivities: string[] };
type Selection = NonNullable<SearchResult["guided_selection"]>;

export function assessDaypart(
  expectedActivities: string[],
  schedules: string[],
  passages: string[],
  selector: Pick<Selection, "applied" | "matches" | "unknown" | "exhaustive">,
) {
  const expectedSections = expectedActivities.length > 0
    ? expectedActivities.map(id => id + ":S2")
    : schedules;
  const foundSections = expectedSections.filter(section => passages.includes(section));
  const missingSections = expectedSections.filter(section => !passages.includes(section));
  const selectorPassed = passesSelector({ matches: expectedActivities, unknown: [], exhaustive: true }, selector);
  return { expectedSections, foundSections, missingSections, selectorPassed, passed: selectorPassed && missingSections.length === 0 };
}

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "../../..");

function run(binary: string, out: string) {
  const fixture = join(root, "evals/shared/datasets/guided-dayparts-20261126/cases.json");
  const bytes = readFileSync(fixture);
  const dataset = JSON.parse(bytes.toString("utf8")) as { schema: string; corpusSha256: string; cases: Case[] };
  const corpus = loadDataset("fallback");
  assert.equal(dataset.schema, "guided-dayparts-v1");
  assert.equal(dataset.corpusSha256, corpus.definition.corpusSha256, "dataset corpus");
  const schedules = corpus.fingerprints.map(source => source.id + ":S2");
  assert(schedules.every(key => corpus.sections.has(key)), "all activities need a canonical schedule");
  for (const scenario of dataset.cases) {
    assert(scenario.expectedActivities.every(id => schedules.includes(id + ":S2")), scenario.id);
  }

  const output = execFileSync(binary, [
    "search", "--queries-stdin", "--corpus", "demo-twelve", "--method", "guided", "--top-k", "3",
  ], {
    cwd: root,
    env: { PATH: process.env.PATH, COA_DISABLE_DOTENV: "1", HF_HUB_OFFLINE: "1" },
    input: JSON.stringify(dataset.cases.map(scenario => scenario.question)),
    encoding: "utf8",
    timeout: 120_000,
  });
  const results = JSON.parse(output) as SearchResult[];
  assert(Array.isArray(results) && results.length === dataset.cases.length, "complete CLI response");

  const corpusVectors = new Set<string>();
  const assessment = dataset.cases.map((scenario, index) => {
    const result = results[index];
    validateSearchResult(result, scenario.question, "guided", corpus, corpusVectors, "candidate-v5");
    const selector = result.guided_selection!;
    return {
      ...scenario,
      ...assessDaypart(scenario.expectedActivities, schedules, result.hits.map(hit => sectionKey(hit.section)), selector),
    };
  });
  assert.equal(corpusVectors.size, 1, "all searches use the same document vectors");

  const local = join(root, "evals/rag/results/local");
  assert.equal(dirname(out), local, "use a new file directly under evals/rag/results/local");
  mkdirSync(local, { recursive: true });
  const provenance = {
    checkoutRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    binarySha256: sha256(readFileSync(binary)),
    datasetSha256: sha256(bytes),
    corpusSha256: dataset.corpusSha256,
  };
  writeFileSync(out, JSON.stringify({ provenance, assessment, results }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  for (const item of assessment) {
    process.stdout.write(`${item.question} ${item.foundSections.length}/${item.expectedSections.length} sources · ${item.passed ? "PASS" : "FAIL"}\n`);
  }
  if (assessment.some(item => !item.passed)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const { values } = parseArgs({ options: { binary: { type: "string" }, out: { type: "string" } } });
  assert(values.binary && values.out, "Use --binary BINARY --out NEW_JSON_FILE");
  run(resolve(values.binary), resolve(values.out));
}
