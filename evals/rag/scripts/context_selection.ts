/** Model-free, frozen source-selection comparison. Assessment stays outside Rust inputs. */
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, fsyncSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { canonicalJson, checkedFile, readJson, same, sha256 } from "../promptfoo/json.ts";
import { goalMetrics, key, orderedSection, rawJsonField, validateLocal } from "../promptfoo/assertions.ts";
import type { Config, Criteria, Goal, NativeRecord, Reference, Section, Variables } from "../promptfoo/types.ts";
const DATASET = "evals/shared/datasets/context-selection-controls-20261123";
const FREEZE_SHA256 = "e9d3c65c1874e6ce0eb9dca42071d60e5a44290337cca46e362669e7154eeede";
const POLICIES = ["baseline", "activity_balanced"] as const;
type Policy = typeof POLICIES[number];
interface Document {
    path: string;
    sha256: string;
}
interface Corpus {
    corpus_sha256: string;
    documents: Document[];
}
interface InputCase {
    id: string;
    question: string;
    corpus_id: string;
}
interface NativeInput {
    schema_version: number;
    execution_id: string;
    reference_date: string;
    corpora: Record<string, Corpus>;
    cases: InputCase[];
}
interface Assessment {
    plans: Reference[][];
    goals: Goal[];
}
export interface Experiment {
    input: NativeInput;
    inputBytes: string;
    inputSha256: string;
    freezeSha256: string;
    sections: Map<string, Map<string, Section>>;
    assessments: Map<string, Assessment>;
}
interface ManifestCase extends InputCase {
    assessment_ref: {
        path?: string;
        case_id: string;
        questions_path?: string;
        expectations_path?: string;
        reference_details_path?: string;
    };
}
interface Manifest {
    id: string;
    reference_date: string;
    corpora: Record<string, Corpus>;
    cases: ManifestCase[];
}
interface LabelCase {
    case_id: string;
    expected_source_plans: Reference[][];
}
interface Envelope {
    policy_id: Policy;
    input_sha256: string;
    record: NativeRecord & {
        batch_id: string;
        config_id: string;
        error: string | null;
        dataset: NativeRecord["dataset"] & {
            questions_sha256: string;
            dataset_versions: string[];
        };
    };
}
interface Coverage {
    complete: boolean;
    found: number;
    required: number;
    fraction: number;
    found_keys: string[];
    missing_keys: string[];
}
interface Row {
    case_id: string;
    policy_id: Policy;
    run_id: string;
    record_sha256: string;
    status: string;
    complete: boolean | null;
    coverage: Coverage | null;
    fact_goals: ReturnType<typeof goalMetrics> | null;
    precision: null;
    stages: {
        candidate_keys: string[];
        candidate_activities: string[];
        seed_keys: string[];
        seed_activities: string[];
        context_keys: string[];
        context_activities: string[];
    } | null;
    missing_evidence: {
        key: string;
        candidate: boolean;
        activity_candidate: boolean;
        activity_selected: boolean;
        omitted_reason: string | null;
    }[];
    query_total_ms: number | null;
    query_embedding_cache_hit: boolean | null;
    error: string | null;
}
export interface AssessmentReport {
    schema_version: number;
    execution_id: string;
    input_sha256: string;
    native_sha256: string;
    freeze_sha256: string;
    rows: Row[];
    policies: Record<Policy, {
        complete: number;
        technical_failures: number;
        cases: number;
    }>;
    gate: {
        decision: "GO" | "NO_GO";
        no_regressions: boolean;
        all_twelve_complete: boolean;
        enumeration_complete: boolean;
        all_eight_controls_complete: boolean;
        technical_failures: number;
    };
    answer_quality: "not_assessed";
    activity_classification: "not_assessed";
    ai_judge_calls: 0;
}
function requireValue(condition: unknown, message: string): asserts condition { if (!condition)
    throw new Error(message); }
function readBound(root: string, path: string, expected: string): string {
    const bytes = readFileSync(checkedFile(resolve(root, path), root, 2 * 1024 * 1024));
    requireValue(sha256(bytes) === expected, "Frozen file hash changed: " + path);
    return bytes.toString();
}
function parseSections(text: string): Section[] {
    const source_id = /^ID: (.+)$/m.exec(text)?.[1], source_date = /^Brondatum: (.+)$/m.exec(text)?.[1], source_title = /^# (.+)$/m.exec(text)?.[1];
    requireValue(source_id && source_date && source_title, "Missing canonical source metadata");
    const pieces = text.split(/^## (S\d+) — (.+)\n/m), sections: Section[] = [];
    for (let i = 1; i < pieces.length; i += 3)
        sections.push(orderedSection({ source_id, source_date, source_title, id: pieces[i], heading: pieces[i + 1], text: pieces[i + 2].trim() }));
    requireValue(sections.length === 6 && sections.every(s => s.text), "Invalid canonical source sections");
    return sections;
}
export function loadExperiment(root: string, executionId: string): Experiment {
    requireValue(/^[a-zA-Z0-9_-]{1,100}$/.test(executionId), "Invalid execution ID");
    const freezeBytes = readBound(root, DATASET + "/FROZEN.json", FREEZE_SHA256);
    const freeze = JSON.parse(freezeBytes) as {
        review: {
            approved: boolean;
            before_candidate_implementation: boolean;
        };
        integrity: {
            artifacts: {
                path: string;
                sha256_bytes: string;
            }[];
            referenced_original_artifacts: {
                path: string;
                sha256_bytes: string;
            }[];
        };
    };
    requireValue(freeze.review.approved && freeze.review.before_candidate_implementation, "Dataset lacks independent preimplementation review");
    for (const file of [...freeze.integrity.artifacts, ...freeze.integrity.referenced_original_artifacts])
        readBound(root, file.path, file.sha256_bytes);
    const manifest = readJson<Manifest>(resolve(root, DATASET, "manifest.json"));
    const corpora: Record<string, Corpus> = {}, sections = new Map<string, Map<string, Section>>(), assessments = new Map<string, Assessment>();
    for (const [id, corpus] of Object.entries(manifest.corpora)) {
        requireValue(corpus.documents.length === 12, "Incomplete twelve-source corpus");
        const texts = corpus.documents.map(d => readBound(root, d.path, d.sha256));
        requireValue(sha256(texts.join("\n---document---\n")) === corpus.corpus_sha256, "Corpus byte binding differs");
        const all = texts.flatMap(parseSections), canonical = new Map(all.map(s => [key(s), s]));
        requireValue(canonical.size === 72, "Duplicate or missing canonical sections");
        corpora[id] = { corpus_sha256: corpus.corpus_sha256, documents: corpus.documents.map(d => ({ path: d.path, sha256: d.sha256 })) };
        sections.set(id, canonical);
    }
    const cases = manifest.cases.map(c => {
        requireValue(corpora[c.corpus_id], "Unknown case corpus");
        const ref = c.assessment_ref;
        let plans: Reference[][], goals: Goal[];
        if (ref.path) {
            const label = readJson<{
                cases: LabelCase[];
            }>(resolve(root, ref.path)).cases.find(x => x.case_id === c.id);
            requireValue(label, "Missing control source plan");
            plans = label.expected_source_plans;
            goals = [{ id: "required-evidence-plan", evidence_alternatives: plans }];
        }
        else {
            const question = readJson<{
                cases: {
                    id: string;
                    question: string;
                }[];
            }>(resolve(root, ref.questions_path!)).cases.find(x => x.id === c.id);
            requireValue(question?.question === c.question, "Existing question changed");
            const label = readJson<{
                cases: LabelCase[];
            }>(resolve(root, ref.reference_details_path!)).cases.find(x => x.case_id === c.id);
            const criteria = readJson<{
                cases: ({
                    case_id: string;
                } & Criteria)[];
            }>(resolve(root, ref.expectations_path!)).cases.find(x => x.case_id === c.id);
            requireValue(label && criteria?.facts?.length, "Missing existing protected criteria");
            plans = label.expected_source_plans;
            goals = criteria.facts;
        }
        requireValue(plans.length && plans.every(p => p.length && p.every(r => sections.get(c.corpus_id)!.has(key(r)))), "Unknown required canonical source");
        assessments.set(c.id, { plans, goals });
        return { id: c.id, question: c.question, corpus_id: c.corpus_id };
    });
    requireValue(cases.length === 20 && new Set(cases.map(c => c.id)).size === 20, "Expected twenty unique frozen cases");
    const input: NativeInput = { schema_version: 1, execution_id: executionId, reference_date: manifest.reference_date, corpora, cases };
    const inputBytes = JSON.stringify(input) + "\n";
    return { input, inputBytes, inputSha256: sha256(inputBytes), freezeSha256: FREEZE_SHA256, sections, assessments };
}
function policyConfig(policy: Policy): Config {
    return { method: "hybrid_weighted", selection: policy === "baseline" ? "activity_expansion" : "activity_balanced", top_k: policy === "baseline" ? 3 : 6, candidate_k: 30, context_token_limit: 1200, apply_filters: false, mmr: false, rrf_k: 60, vector_weight: 0.7, mmr_lambda: 0.7 };
}
function coverage(plans: Reference[][], offered: Set<string>): Coverage {
    const options = plans.map(p => { const required = [...new Set(p.map(key))], found = required.filter(k => offered.has(k)); return { complete: found.length === required.length, found: found.length, required: required.length, fraction: found.length / required.length, found_keys: found, missing_keys: required.filter(k => !offered.has(k)) }; });
    options.sort((a, b) => b.fraction - a.fraction || a.required - b.required);
    requireValue(goalMetrics([{ evidence_alternatives: plans }], offered).source_complete === options[0].complete, "Source plan and unchanged goal scorer disagree");
    return options[0];
}
export function assessExperiment(experiment: Experiment, nativeBytes: string): AssessmentReport {
    requireValue(nativeBytes.endsWith("\n"), "Native capture lacks final durable newline");
    const lines = nativeBytes.slice(0, -1).split("\n"), seen = new Set<string>(), ids = new Set<string>(), rows: Row[] = [];
    requireValue(lines.length === 40 && lines.every(Boolean), "Expected forty distinct measurements");
    const modelSpec = readJson<{
        repository: string;
        sdk: string;
        dimensions: number;
        encoding: string;
    }[]>(fileURLToPath(new URL("../embedding-models.json", import.meta.url)))[0];
    let firstEmbedding: unknown, nativeBatchId: string | undefined;
    const paired = new Map<string, NativeRecord["outcome"]>();
    for (const line of lines) {
        const envelope = JSON.parse(line) as Envelope, record = envelope.record;
        const caseInput = experiment.input.cases.find(c => c.id === record.case_id);
        requireValue(caseInput && POLICIES.includes(envelope.policy_id), "Unknown native case or policy");
        const comparison = record.case_id + ":" + envelope.policy_id;
        requireValue(!seen.has(comparison) && record.run_id && !ids.has(record.run_id), "Duplicate native execution or comparison identity");
        seen.add(comparison);
        ids.add(record.run_id);
        requireValue(envelope.input_sha256 === experiment.inputSha256 && record.dataset.questions_sha256 === experiment.inputSha256, "Native input hash binding differs");
        requireValue(record.schema_version === 1 && record.execution_kind === "local_measured" && record.batch_id.startsWith(experiment.input.execution_id + "-native-") && /^\d+-\d+$/.test(record.batch_id.slice((experiment.input.execution_id + "-native-").length)) && record.run_id === record.batch_id + "--" + record.case_id + "--" + envelope.policy_id && record.question === caseInput.question, "Native execution identity/question differs");
        if (nativeBatchId === undefined)
            nativeBatchId = record.batch_id;
        else
            requireValue(record.batch_id === nativeBatchId, "Native measurements span different batches");
        requireValue(record.dataset.corpus_sha256 === experiment.input.corpora[caseInput.corpus_id].corpus_sha256 && record.dataset.as_of === experiment.input.reference_date && same(record.dataset.dataset_versions, ["context-selection-controls-20261123"]), "Native corpus binding differs");
        const expected = { profile: "documents_sections", retrieval: policyConfig(envelope.policy_id) };
        requireValue(same(record.config, expected), "Native policy configuration differs");
        requireValue(record.config_id === "documents_sections__hybrid_weighted__" + sha256(canonicalJson(expected)).slice(0, 12), "Native configuration hash differs");
        const row: Row = { case_id: record.case_id, policy_id: envelope.policy_id, run_id: record.run_id, record_sha256: sha256(rawJsonField(line, "record")), status: record.execution_status, complete: null, coverage: null, fact_goals: null, precision: null, stages: null, missing_evidence: [], query_total_ms: record.timings?.query_total_ms ?? null, query_embedding_cache_hit: record.timings?.query_embedding_cache_hit ?? null, error: record.error ?? null };
        if (record.execution_status !== "completed") {
            requireValue(record.execution_status === "failed" && record.error && !record.outcome, "Invalid failed measurement");
            rows.push(row);
            continue;
        }
        requireValue(record.outcome && !record.error, "Completed measurement lacks genuine evidence");
        const canonical = experiment.sections.get(caseInput.corpus_id)!;
        const criteria = { corpus_sha256: record.dataset.corpus_sha256, as_of: experiment.input.reference_date } as Criteria;
        const variables = { ...expected.retrieval, profile: expected.profile, mode: "local", model: "minilm", dataset: "context-selection-controls-20261123", case_id: record.case_id, question: caseInput.question, filters: {} } as Variables;
        validateLocal(record, variables, criteria, canonical);
        requireValue(record.outcome.query === caseInput.question, "Native search query differs from literal question");
        const identity = record.outcome.corpus_identity.embedding;
        requireValue(identity && identity.provider === "local-fastembed" && identity.sdk === modelSpec.sdk && identity.dimensions === modelSpec.dimensions && identity.model.startsWith(modelSpec.repository + "@") && /^[a-f0-9]{40}$/.test(identity.model.slice(modelSpec.repository.length + 1)) && identity.encoding.startsWith(modelSpec.encoding + "; model_files_sha256=") && /^[a-f0-9]{64}$/.test(identity.encoding.slice((modelSpec.encoding + "; model_files_sha256=").length)) && !(identity.document_prefix ?? "") && !(identity.query_prefix ?? "") && /^[a-f0-9]{64}$/.test(record.outcome.corpus_identity.vectors_sha256 ?? ""), "Native MiniLM embedding identity differs");
        if (firstEmbedding === undefined)
            firstEmbedding = identity;
        else
            requireValue(same(identity, firstEmbedding), "Encoder changed during comparison");
        const pair = paired.get(record.case_id);
        if (pair)
            requireValue(same(pair.candidates, record.outcome.candidates) && same(pair.corpus_identity, record.outcome.corpus_identity), "Paired policies changed candidates or corpus vectors/preparation");
        else
            paired.set(record.case_id, record.outcome);
        const hits = record.outcome.hits;
        for (const hit of hits)
            requireValue(same(canonical.get(key(hit.section)), hit.section), "Delivered source text is not canonical");
        const offered = new Set(hits.map(h => key(h.section))), candidates = record.outcome.candidates.map(c => key(c.key)), seeds = record.outcome.seeds.map(key);
        const activities = (keys: string[]) => [...new Set(keys.map(k => k.split(":")[0]))];
        row.stages = { candidate_keys: candidates, candidate_activities: activities(candidates), seed_keys: seeds, seed_activities: activities(seeds), context_keys: [...offered], context_activities: activities([...offered]) };
        const labels = experiment.assessments.get(record.case_id)!;
        row.coverage = coverage(labels.plans, offered);
        row.complete = row.coverage.complete;
        row.fact_goals = goalMetrics(labels.goals, offered);
        row.missing_evidence = row.coverage.missing_keys.map(k => ({ key: k, candidate: candidates.includes(k), activity_candidate: row.stages!.candidate_activities.includes(k.split(":")[0]), activity_selected: row.stages!.seed_activities.includes(k.split(":")[0]), omitted_reason: record.outcome.omitted.find(o => key(o.key) === k)?.reason ?? null }));
        for (const value of [row.query_total_ms, record.timings?.query_embedding_ms, record.timings?.retrieval_ms])
            requireValue(value === null || value === undefined || Number.isFinite(value) && value >= 0, "Invalid measured timing");
        rows.push(row);
    }
    const policies = Object.fromEntries(POLICIES.map(p => { const r = rows.filter(r => r.policy_id === p); requireValue(r.length === 20, "Incomplete policy measurements"); return [p, { complete: r.filter(r => r.complete === true).length, technical_failures: r.filter(r => r.status !== "completed").length, cases: r.length }]; })) as AssessmentReport["policies"];
    const candidate = rows.filter(r => r.policy_id === "activity_balanced"), oldIds = experiment.input.cases.slice(0, 12).map(c => c.id);
    const no_regressions = oldIds.every(id => { const baseline = rows.find(r => r.case_id === id && r.policy_id === "baseline")!, changed = rows.find(r => r.case_id === id && r.policy_id === "activity_balanced")!; return baseline.status === "completed" && changed.status === "completed" && !(baseline.complete && !changed.complete) && changed.coverage!.fraction >= baseline.coverage!.fraction; });
    const all_twelve_complete = candidate.filter(r => oldIds.includes(r.case_id)).every(r => r.complete === true);
    const enumeration_complete = candidate.find(r => r.case_id === "IND26-01")?.complete === true;
    const all_eight_controls_complete = candidate.filter(r => !oldIds.includes(r.case_id)).every(r => r.complete === true);
    const technical_failures = rows.filter(r => r.status !== "completed").length;
    return { schema_version: 1, execution_id: experiment.input.execution_id, input_sha256: experiment.inputSha256, native_sha256: sha256(nativeBytes), freeze_sha256: experiment.freezeSha256, rows, policies, gate: { decision: !technical_failures && no_regressions && all_twelve_complete && enumeration_complete && all_eight_controls_complete ? "GO" : "NO_GO", no_regressions, all_twelve_complete, enumeration_complete, all_eight_controls_complete, technical_failures }, answer_quality: "not_assessed", activity_classification: "not_assessed", ai_judge_calls: 0 };
}
export function renderReport(experiment: Experiment, report: AssessmentReport): string {
    const text = ["# Context-selection comparison", "", `Decision: **${report.gate.decision}**. The existing default is retained; this experiment does not change website retrieval.`, "", "Twenty frozen cases × two policies × one execution = forty measurements. Source coverage only; answer quality is not assessed. Activity classification is not assessed. No AI judge or answer-model calls.", "", "| Case | Current complete evidence | Activity-balanced evidence | Change |", "| --- | --- | --- | --- |"];
    for (const c of experiment.input.cases) {
        const before = report.rows.find(r => r.case_id === c.id && r.policy_id === "baseline")!, after = report.rows.find(r => r.case_id === c.id && r.policy_id === "activity_balanced")!;
        const score = (r: Row) => r.coverage ? `${r.coverage.found}/${r.coverage.required}${r.complete ? " complete" : ""}` : "unknown: execution failed";
        const change = before.coverage && after.coverage ? after.coverage.fraction - before.coverage.fraction : null;
        text.push(`| ${c.id} | ${score(before)} | ${score(after)} | ${change === null ? "unknown" : (change > 0 ? "+" : "") + (change * 100).toFixed(1) + " pp"} |`);
    }
    text.push("", "## Evidence paths", "", "Candidate and seed section keys are diagnostic ranking references. Only actual canonical context text counts as retrieved evidence. Expansion may add sections that were absent from the candidate list.", "");
    for (const c of experiment.input.cases) {
        text.push(`### ${c.id}`, "", c.question, "");
        for (const p of POLICIES) {
            const row = report.rows.find(r => r.case_id === c.id && r.policy_id === p)!;
            text.push(`- ${p}: ${row.coverage ? row.coverage.found + "/" + row.coverage.required : "unknown"}; candidate → seed → context activities: ${row.stages ? [row.stages.candidate_activities.length, row.stages.seed_activities.length, row.stages.context_activities.length].join(" → ") : "unknown"}.`);
            for (const missing of row.missing_evidence)
                text.push(`  - Missing ${missing.key}: candidate section ${missing.candidate ? "yes" : "no"}; activity candidate ${missing.activity_candidate ? "yes" : "no"}; activity selected ${missing.activity_selected ? "yes" : "no"}; omission ${missing.omitted_reason ?? "not recorded"}.`);
            if (row.error)
                text.push("  - Execution error: " + row.error.replace(/[\r\n]+/g, " "));
        }
        text.push("");
    }
    text.push("## Limits", "", "The eight controls are agent-reviewed fictional controls, not human validation. Unknown-condition evidence is required where specified; coverage does not prove that an assistant preserves unknowns. Precision remains unknown because relevance labels are incomplete. The baseline query may be cold while the candidate lookup is warm; their cache states are not a speed comparison. A single execution per cell does not establish speed superiority. Query clocks exclude shared preparation; overlapping preparation clocks must not be summed.", "", `Input SHA-256: ${report.input_sha256}`, `Native capture SHA-256: ${report.native_sha256}`, `Frozen dataset SHA-256: ${report.freeze_sha256}`, "");
    return text.join("\n");
}
interface RunOptions {
    binary: string;
    modelCache: string;
    output: string;
    executionId?: string;
}
interface ChildOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
    encoding: "utf8";
    maxBuffer: number;
    timeout: number;
}
type Executor = (binary: string, args: string[], options: ChildOptions) => {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
};
function writeDurableNew(path: string, bytes: string): void {
    const fd = openSync(path, "wx", 0o600);
    try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
export function runExperiment(root: string, options: RunOptions, execute: Executor = spawnSync): AssessmentReport {
    const output = resolve(options.output), delta = relative(resolve(root, "evals/rag/results/local"), output);
    requireValue(delta !== "" && delta !== ".." && !delta.startsWith("../") && !isAbsolute(delta), "Output must be a new private evals/rag/results/local directory");
    const experiment = loadExperiment(root, options.executionId ?? "context-" + randomUUID());
    mkdirSync(resolve(output, ".."), { recursive: true, mode: 0o700 });
    mkdirSync(output, { mode: 0o700 });
    writeDurableNew(join(output, "input.json"), experiment.inputBytes);
    const provenance = { schema_version: 1, execution_id: experiment.input.execution_id, input_sha256: experiment.inputSha256, freeze_sha256: experiment.freezeSha256, binary_sha256: sha256(readFileSync(options.binary)), runner_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))), scorer_sha256: sha256(readFileSync(fileURLToPath(new URL("../promptfoo/assertions.ts", import.meta.url)))), source_revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(), retrieval_measurement_limit: 40, answer_model_calls: 0, ai_judge_calls: 0 };
    writeDurableNew(join(output, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
    const env: NodeJS.ProcessEnv = { COA_DISABLE_DOTENV: "1", RAYON_NUM_THREADS: "2", TOKENIZERS_PARALLELISM: "false", COA_BENCHMARK_SEARCH_WORKERS: "2" };
    for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "ORT_DYLIB_PATH"])
        if (process.env[name] !== undefined)
            env[name] = process.env[name];
    const child = execute(resolve(options.binary), ["lab", "context-selection", "--input", join(output, "input.json"), "--output", join(output, "native.jsonl"), "--model-cache", resolve(options.modelCache), "--source-root", resolve(root)], { cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300000 });
    writeDurableNew(join(output, "native-summary.stdout.json"), child.stdout ?? "");
    writeDurableNew(join(output, "native.stderr.log"), child.stderr ?? "");
    writeDurableNew(join(output, "exit.json"), JSON.stringify({ status: child.status, error: child.error?.message ?? null }) + "\n");
    requireValue(child.status === 0 && !child.error, "Native comparison failed; saved captures retained without retry");
    const summary = JSON.parse(child.stdout) as Record<string, unknown>;
    const nativeBytes = readFileSync(join(output, "native.jsonl"), "utf8");
    const report = assessExperiment(experiment, nativeBytes);
    const envelopes = nativeBytes.trimEnd().split("\n").map(line => JSON.parse(line) as Envelope);
    const completed = report.rows.filter(r => r.status === "completed").length;
    requireValue(summary.schema_version === 1 && summary.input_sha256 === experiment.inputSha256 && summary.batch_id === envelopes[0].record.batch_id && summary.planned_rows === 40 && summary.completed === completed && summary.failed === 40 - completed && summary.codex_calls === 0 && summary.ai_judge_calls === 0 && summary.document_embedding_chunk_size === 8 && summary.max_concurrent_searches === 2 && Number(summary.observed_peak_rankings) >= 1 && Number(summary.observed_peak_rankings) <= 2 && typeof summary.native_batch_elapsed_ms === "number" && Number.isFinite(summary.native_batch_elapsed_ms) && summary.native_batch_elapsed_ms >= 0, "Native batch summary differs from captured execution");
    const completedEnvelope = envelopes.find(e => e.record.execution_status === "completed");
    requireValue(!completedEnvelope || same(summary.embedding_identity, completedEnvelope.record.outcome.corpus_identity.embedding), "Native summary encoder identity differs");
    writeDurableNew(join(output, "assessment.json"), JSON.stringify(report, null, 2) + "\n");
    writeDurableNew(join(output, "report.md"), renderReport(experiment, report));
    return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const { values, positionals } = parseArgs({ allowPositionals: true, options: { binary: { type: "string" }, "model-cache": { type: "string" }, output: { type: "string" }, "execution-id": { type: "string" } } });
        requireValue(positionals.length === 1 && positionals[0] === "run" && values.binary && values["model-cache"] && values.output, "Usage: node evals/rag/scripts/context_selection.ts run --binary PATH --model-cache EXISTING_CACHE --output NEW_PRIVATE_DIRECTORY [--execution-id ID]");
        const root = fileURLToPath(new URL("../../../", import.meta.url));
        const report = runExperiment(root, { binary: values.binary, modelCache: values["model-cache"], output: values.output, executionId: values["execution-id"] });
        process.stdout.write(JSON.stringify({ output: resolve(values.output), decision: report.gate.decision, policies: report.policies }) + "\n");
    }
    catch (error) {
        process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
        process.exitCode = 1;
    }
}
