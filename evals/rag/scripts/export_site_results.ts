/** Export only public observables from the frozen model comparison. No model calls. */
import { readFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { fileHash, load } from "./model_trials.ts";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DATASET = join(ROOT, "evals/shared/datasets/strengthened-10-20261106");
const SOURCE_FILES = [
  "document.md",
  "bicycle-workshop.md",
  "language-cafe.md",
  "community-cooking.md",
  "walking.md",
  ...Array.from(
    { length: 5 },
    (_, i) =>
      `expanded-10-20261105/activity-${String(i + 6).padStart(3, "0")}.md`,
  ),
];
const MODELS: Record<string, string> = {
  "gpt-6.1-sol": "Sol",
  "gpt-6-luna": "Luna",
};
const EXPECTED_MANIFEST_SHA256 =
  "c1385fc9aac9d6c59671971cc8a09e14d9628bc131dc75e26ca20800579e1157";
interface Ref {
  source_id: string;
  section_id: string;
}
interface Section {
  source_id: string;
  id: string;
  source_title: string;
  source_date: string;
  heading: string;
  text: string;
}
interface Native {
  tool_calls: {
    query: string;
    status: string;
    result: { hits: { section: Section }[] };
  }[];
  model?: string;
  status?: string;
}
interface Assessment {
  actual_search_calls: number;
  source_coverage: {
    expected_source_options: Ref[][];
    complete: boolean;
    first_complete_call_index: number | null;
  };
  calls: {
    index: number;
    query: string;
    status: string;
    offered_sections: Ref[];
    complete_expected_sources: boolean;
  }[];
  status?: string;
  run_id?: string;
}
interface Projection {
  complete: boolean;
  actions: number;
  first_complete: number | null;
  calls: { index: number; query: string; hits: string[]; complete: boolean }[];
}
interface Run extends Projection {
  model: string;
  trial: number;
}
interface Case {
  id: string;
  question: string;
  purpose: string;
  alternatives: string[][];
  runs: Run[];
}
function refKey(ref: Ref): string {
  return ref.source_id + ":" + ref.section_id;
}
export function isComplete(
  offered: Set<string>,
  alternatives: string[][],
): boolean {
  return alternatives.some((option) => option.every((key) => offered.has(key)));
}
export function readSources(): [
  {
    id: string;
    title: string;
    date: string;
    preamble: string;
    sections: string[];
  }[],
  Record<string, Section>,
] {
  const documents = [],
    sections: Record<string, Section> = {};
  for (const name of SOURCE_FILES) {
    const text = readFileSync(join(ROOT, "fixtures", name), "utf8");
    const title = text.match(/^# (.+)$/m)![1],
      id = text.match(/^ID: (.+)$/m)![1],
      date = text.match(/^Brondatum: (.+)$/m)![1];
    const pieces = text.split(/^## (S\d+) — (.+)\n/m);
    const document = {
      id,
      title,
      date,
      preamble: pieces[0].slice(pieces[0].indexOf(date) + date.length).trim(),
      sections: [] as string[],
    };
    for (let i = 1; i < pieces.length; i += 3) {
      const section = {
          source_id: id,
          source_title: title,
          source_date: date,
          id: pieces[i],
          heading: pieces[i + 1],
          text: pieces[i + 2].trim(),
        },
        key = id + ":" + section.id;
      if (key in sections) throw new Error("Duplicate source identity");
      sections[key] = section;
      document.sections.push(key);
    }
    documents.push(document);
  }
  return [documents, sections];
}
export function projectRun(
  native: Native,
  assessment: Assessment,
  sources: Record<string, Section>,
): Projection {
  const alternatives = assessment.source_coverage.expected_source_options.map(
    (option) => option.map(refKey),
  );
  if (
    native.tool_calls.length !== assessment.actual_search_calls ||
    assessment.calls.length !== assessment.actual_search_calls
  )
    throw new Error("Tool call count differs from assessment");
  const calls: Projection["calls"] = [],
    cumulative = new Set<string>();
  let firstComplete: number | null = null;
  for (let i = 0; i < native.tool_calls.length; i++) {
    const raw = native.tool_calls[i],
      grade = assessment.calls[i];
    if (raw.query !== grade.query || raw.status !== grade.status)
      throw new Error("Observable call differs from assessment");
    const offered = grade.offered_sections.map(refKey),
      hits = raw.result.hits.map((hit) => {
        const actual = hit.section,
          key = actual.source_id + ":" + actual.id;
        if (!(key in sources) || !isDeepStrictEqual(actual, sources[key]))
          throw new Error("Offered source text is not canonical");
        return key;
      });
    if (!isDeepStrictEqual(hits, offered))
      throw new Error("Candidate or unoffered source was included");
    hits.forEach((key) => cumulative.add(key));
    const complete = isComplete(cumulative, alternatives);
    if (complete !== grade.complete_expected_sources)
      throw new Error("Cumulative source coverage differs");
    if (complete && firstComplete === null) firstComplete = grade.index;
    calls.push({ index: grade.index, query: raw.query, hits, complete });
  }
  const complete = isComplete(cumulative, alternatives);
  if (
    complete !== assessment.source_coverage.complete ||
    firstComplete !== assessment.source_coverage.first_complete_call_index
  )
    throw new Error("Session source coverage differs");
  return {
    complete,
    actions: calls.length,
    first_complete: firstComplete,
    calls,
  };
}
function within(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return (
    rel !== ".." &&
    !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) &&
    !isAbsolute(rel)
  );
}
export function exportResults(experimentDirectory: string) {
  const directory = realpathSync(experimentDirectory);
  if (
    fileHash(join(directory, "EXECUTION_MANIFEST.json")) !==
    EXPECTED_MANIFEST_SHA256
  )
    throw new Error("This is not the reviewed execution manifest");
  const manifest = load<{
    new_attempts: number;
    old_aborted_attempts: number;
    files: { path: string; sha256: string }[];
  }>(join(directory, "EXECUTION_MANIFEST.json"));
  if (manifest.new_attempts !== 60 || manifest.old_aborted_attempts !== 6)
    throw new Error("Expected the distinct 60-session replacement cohort");
  for (const item of manifest.files) {
    const path = realpathSync(resolve(directory, item.path));
    if (!within(path, directory) || fileHash(path) !== item.sha256)
      throw new Error("Sealed evidence changed");
  }
  const index = load<{
    attempts: {
      model: string;
      case_id: string;
      trial: number;
      record_path: string;
      record_sha256: string;
      assessment_path: string;
    }[];
    ai_judge_calls: number;
  }>(join(directory, "ANALYSIS_INDEX.json"));
  if (index.attempts.length !== 60 || index.ai_judge_calls !== 0)
    throw new Error("Wrong experiment cohort");
  const [documents, sources] = readSources(),
    questions = load<{
      cases: { id: string; question: string }[];
      as_of: string;
      corpus_sha256: string;
    }>(join(DATASET, "questions.json"));
  const refs = Object.fromEntries(
    load<{ cases: { case_id: string; expected_source_plans: Ref[][] }[] }>(
      join(DATASET, "reference-details.json"),
    ).cases.map((item) => [item.case_id, item]),
  );
  const labels = Object.fromEntries(
    load<{ cases: { case_id: string; facts: { description: string }[] }[] }>(
      join(DATASET, "expectations.json"),
    ).cases.map((item) => [item.case_id, item]),
  );
  const cases: Record<string, Case> = {};
  for (const item of questions.cases)
    cases[item.id] = {
      id: item.id,
      question: item.question,
      purpose: labels[item.id].facts[0].description,
      alternatives: refs[item.id].expected_source_plans.map((option) =>
        option.map(refKey),
      ),
      runs: [],
    };
  const assessmentFiles = new Map<string, Map<string, Assessment>>(),
    seen = new Set<string>();
  for (const attempt of index.attempts) {
    const key = JSON.stringify([attempt.model, attempt.case_id, attempt.trial]);
    if (
      seen.has(key) ||
      !(attempt.model in MODELS) ||
      ![1, 2, 3].includes(attempt.trial)
    )
      throw new Error("Duplicate or unplanned model execution");
    seen.add(key);
    const recordPath = realpathSync(attempt.record_path);
    if (
      !within(recordPath, directory) ||
      fileHash(recordPath) !== attempt.record_sha256
    )
      throw new Error("Execution record binding changed");
    const wrapper = load<{
        dataset_id: string;
        question: string;
        requested_model: string;
        live: { run: Native | null; run_id: string };
      }>(recordPath),
      native = wrapper.live.run;
    if (
      wrapper.dataset_id !== "strengthened-10-20261106" ||
      wrapper.question !== cases[attempt.case_id].question ||
      wrapper.requested_model !== attempt.model ||
      native === null ||
      native.model !== attempt.model ||
      native.status !== "completed"
    )
      throw new Error("Wrong question/model or unassessed run");
    const assessmentPath = realpathSync(attempt.assessment_path);
    if (!within(assessmentPath, directory))
      throw new Error("Assessment outside experiment");
    if (!assessmentFiles.has(assessmentPath))
      assessmentFiles.set(
        assessmentPath,
        new Map(
          readFileSync(assessmentPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => {
              const row = JSON.parse(line) as Assessment;
              return [row.run_id!, row];
            }),
        ),
      );
    const assessment = assessmentFiles
      .get(assessmentPath)!
      .get(wrapper.live.run_id)!;
    if (assessment.status !== "scored")
      throw new Error("Expected a native scored run");
    const projected = projectRun(native, assessment, sources),
      options = assessment.source_coverage.expected_source_options.map(
        (option) => option.map(refKey),
      );
    const normalize = (options: string[][]) =>
      options
        .map((option) => [...option].sort())
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (
      !isDeepStrictEqual(
        normalize(options),
        normalize(cases[attempt.case_id].alternatives),
      )
    )
      throw new Error(
        "Native source alternatives differ from frozen references",
      );
    cases[attempt.case_id].runs.push({
      ...projected,
      model: attempt.model,
      trial: attempt.trial,
    });
  }
  if (seen.size !== 60 || Object.values(cases).some((c) => c.runs.length !== 6))
    throw new Error("Missing comparison cells");
  const models = Object.entries(MODELS).map(([id, label]) => {
    const runs = Object.values(cases)
      .flatMap((c) => c.runs)
      .filter((run) => run.model === id);
    return {
      id,
      label,
      attempts: runs.length,
      complete: runs.filter((run) => run.complete).length,
      actions: runs.reduce((sum, run) => sum + run.actions, 0),
      always_complete: Object.values(cases).filter((c) =>
        c.runs.filter((r) => r.model === id).every((r) => r.complete),
      ).length,
    };
  });
  for (const c of Object.values(cases))
    c.runs.sort((a, b) => a.model.localeCompare(b.model) || a.trial - b.trial);
  const payload = {
    schema_version: 1,
    evidence_manifest_sha256: EXPECTED_MANIFEST_SHA256,
    dataset: "strengthened-10-20261106",
    measured_date: "2026-11-06",
    source_date: questions.as_of,
    corpus_sha256: questions.corpus_sha256,
    method: "dense",
    method_label: "Op betekenis",
    repetitions: 3,
    answer_quality: "not_assessed",
    historical_aborted_attempts: 6,
    models,
    documents,
    sources,
    questions: Object.values(cases),
  };
  for (const forbidden of [
    "/Users/",
    "/private/tmp/",
    "access_token",
    "runtime_path",
    "reasoning",
  ])
    if (JSON.stringify(payload).includes(forbidden))
      throw new Error("Non-public content in projected observables");
  return payload;
}
function main(): void {
  const { values } = parseArgs({
    options: {
      "experiment-dir": { type: "string" },
      output: {
        type: "string",
        default: join(ROOT, "evals/rag/site/results.json"),
      },
    },
  });
  if (!values["experiment-dir"]) throw new Error("Missing --experiment-dir");
  const data = exportResults(values["experiment-dir"]);
  mkdirSync(dirname(values.output!), { recursive: true });
  writeFileSync(values.output!, JSON.stringify(data, null, 2) + "\n");
  console.log(
    `Exported ${data.questions.length} questions, 60 sessions, 10 documents.`,
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
