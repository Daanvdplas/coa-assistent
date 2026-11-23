import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256 } from "../promptfoo/json.ts";
import { loadExperiment, assessExperiment } from "./context_selection.ts";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SPEC = JSON.parse(readFileSync(resolve(ROOT, "evals/rag/embedding-models.json"), "utf8"))[0];
test("native input contains only twenty literal questions and byte-bound document paths", () => {
    const experiment = loadExperiment(ROOT, "test-control-run");
    assert.ok(experiment?.input, "Missing source-only experiment projection");
    assert.equal(experiment.input.cases.length, 20);
    assert.deepEqual(Object.keys(experiment.input).sort(), ["cases", "corpora", "execution_id", "reference_date", "schema_version"]);
    for (const row of experiment.input.cases)
        assert.deepEqual(Object.keys(row).sort(), ["corpus_id", "id", "question"]);
    for (const corpus of Object.values(experiment.input.corpora))
        for (const doc of corpus.documents)
            assert.deepEqual(Object.keys(doc).sort(), ["path", "sha256"]);
    for (const word of ["assessment", "expected_source", "evidence_alternatives", "human_labels", "canary"])
        assert.ok(!experiment.inputBytes.includes(word));
    assert.equal(experiment.inputSha256, sha256(experiment.inputBytes));
});
test("source changes fail closed against frozen byte hashes", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "coa-context-freeze-"));
    try {
        for (const part of ["evals/shared", "fixtures"])
            cpSync(resolve(ROOT, part), resolve(dir, part), { recursive: true });
        writeFileSync(resolve(dir, "fixtures/language-cafe.md"), readFileSync(resolve(dir, "fixtures/language-cafe.md"), "utf8") + "\nChanged.\n");
        assert.throws(() => loadExperiment(dir, "test-control-run"), /hash|changed|binding/i);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
function captures(experiment: ReturnType<typeof loadExperiment>, overrides: Record<string, string[]> = {}) {
    assert.ok(experiment?.input, "Missing source-only experiment projection");
    const embedding = { provider: "local-fastembed", model: SPEC.repository + "@" + "a".repeat(40), sdk: SPEC.sdk, dimensions: SPEC.dimensions, encoding: SPEC.encoding + "; model_files_sha256=" + "b".repeat(64) };
    const rows = experiment.input.cases.flatMap(c => ["baseline", "activity_balanced"].map(policy_id => {
        const config = { profile: "documents_sections", retrieval: { method: "hybrid_weighted", selection: policy_id === "baseline" ? "activity_expansion" : "activity_balanced", top_k: policy_id === "baseline" ? 3 : 6, candidate_k: 30, context_token_limit: 1200, apply_filters: false, mmr: false, rrf_k: 60, vector_weight: 0.7, mmr_lambda: 0.7 } };
        const sections = [...experiment.sections.get(c.corpus_id)!.values()];
        const identity = { source_sha256: sha256(canonicalJson(sections)), embedding_inputs_sha256: sha256(canonicalJson(sections.map(s => s.source_title + "\n" + s.heading + "\n" + s.text))), embedding, vectors_sha256: "c".repeat(64) };
        const offered = overrides[c.id + ":" + policy_id] ?? [];
        const distinct = [...new Set(offered.map(k => k.split(":")[0]))];
        const seeds = distinct.map(id => offered.find(k => k.startsWith(id + ":"))!).slice(0, config.retrieval.top_k);
        const keys = [...seeds, ...offered.filter(k => !seeds.includes(k))];
        const candidateKeys = [...new Set([...(overrides[c.id + ":baseline"] ?? []), ...(overrides[c.id + ":activity_balanced"] ?? [])])];
        const candidates = candidateKeys.sort().map((k, i) => ({ key: { source_id: k.split(":")[0], section_id: k.split(":")[1] }, scores: { rank_score: 1 - i / 100, dense_similarity: 0.8, bm25_score: 1, dense_rank: i + 1, keyword_rank: i + 1 } }));
        const hits = keys.map(k => ({ section: experiment.sections.get(c.corpus_id)!.get(k)!, inclusion: seeds.includes(k) ? "seed" : "activity_expansion", scores: candidates.find(x => x.key.source_id + ":" + x.key.section_id === k)!.scores }));
        const record = { schema_version: 1, run_id: experiment.input.execution_id + "-native-123-456--" + c.id + "--" + policy_id, batch_id: experiment.input.execution_id + "-native-123-456", case_id: c.id, question: c.question, config_id: "documents_sections__hybrid_weighted__" + sha256(canonicalJson(config)).slice(0, 12), config, request_filters: { weekdays: [], environment: null, time: null }, execution_kind: "local_measured", execution_status: "completed", dataset: { corpus_sha256: experiment.input.corpora[c.corpus_id].corpus_sha256, as_of: experiment.input.reference_date, questions_sha256: experiment.inputSha256, dataset_versions: ["context-selection-controls-20261123"] }, preparation: { actual_profile: "documents_sections", corpus_identity: identity, layout: { canonical_sections: 72, activity_records: 0, activity_section_links: 0 } }, outcome: { version: "retrieval-v1", query: c.question, config: config.retrieval, corpus_identity: identity, candidates, seeds: seeds.map(k => ({ source_id: k.split(":")[0], section_id: k.split(":")[1] })), hits, omitted: [], token_estimator: "unicode-scalar-ceil-div4-json-section-v1", estimated_context_tokens: hits.reduce((n, h) => n + Math.ceil(Array.from(canonicalJson(h.section)).length / 4), 0), filters: { requested: false, applied: false, matched_activity_ids: distinct }, work: { union_candidates: candidates.length } }, timings: { query_total_ms: 1, query_embedding_cache_hit: false, retrieval_ms: 1 }, error: null };
        return { policy_id, input_sha256: experiment.inputSha256, record };
    }));
    return rows;
}
const refs = (id: string) => ["S1", "S2", "S3", "S5"].map(s => id + ":" + s);
test("a complete coherent option passes, mixed halves fail, and all-options needs both", () => {
    const experiment = loadExperiment(ROOT, "test-control-run");
    const rows = captures(experiment, {
        "CTX26-07:baseline": [...refs("ACT-FIETS-002").slice(0, 2), ...refs("ACT-TAAL-003").slice(2)],
        "CTX26-07:activity_balanced": refs("ACT-TAAL-003"),
        "CTX26-08:baseline": refs("ACT-TAAL-003"),
        "CTX26-08:activity_balanced": [...refs("ACT-FIETS-002"), ...refs("ACT-TAAL-003")],
    });
    const report = assessExperiment(experiment, rows.map(x => JSON.stringify(x)).join("\n") + "\n");
    assert.ok(report?.rows, "Missing source-evidence grading");
    assert.equal(report.rows.find(r => r.case_id === "CTX26-07" && r.policy_id === "baseline")!.complete, false);
    assert.equal(report.rows.find(r => r.case_id === "CTX26-07" && r.policy_id === "activity_balanced")!.complete, true);
    assert.equal(report.rows.find(r => r.case_id === "CTX26-08" && r.policy_id === "baseline")!.complete, false);
    assert.equal(report.rows.find(r => r.case_id === "CTX26-08" && r.policy_id === "activity_balanced")!.complete, true);
    assert.equal(report.answer_quality, "not_assessed");
    assert.equal(report.rows[0].precision, null);
});
test("canonical IDs cannot turn altered source text into found evidence", () => {
    const experiment = loadExperiment(ROOT, "test-control-run");
    const rows = captures(experiment, { "CTX26-07:baseline": refs("ACT-FIETS-002") });
    rows.find(x => x.policy_id === "baseline" && x.record.case_id === "CTX26-07")!.record.outcome.hits[0].section = { ...rows.find(x => x.policy_id === "baseline" && x.record.case_id === "CTX26-07")!.record.outcome.hits[0].section, text: "Expected IDs are not delivered evidence." };
    assert.throws(() => assessExperiment(experiment, rows.map(x => JSON.stringify(x)).join("\n") + "\n"), /canonical|text|source/i);
});
test("changed input binding, reused native execution ID or missing measurement fails closed", () => {
    const experiment = loadExperiment(ROOT, "test-control-run");
    for (const mutate of [
        (rows: ReturnType<typeof captures>) => { rows[0].input_sha256 = "d".repeat(64); },
        (rows: ReturnType<typeof captures>) => { rows[1].record.run_id = rows[0].record.run_id; },
        (rows: ReturnType<typeof captures>) => { rows.pop(); },
        (rows: ReturnType<typeof captures>) => { rows[0].record.question = "Different question"; },
        (rows: ReturnType<typeof captures>) => { rows[0].record.dataset.corpus_sha256 = "d".repeat(64); },
    ]) {
        const rows = captures(experiment);
        mutate(rows);
        assert.throws(() => assessExperiment(experiment, rows.map(x => JSON.stringify(x)).join("\n") + "\n"));
    }
});
test("real native batch suffix binds one batch without inventing an exact request ID", () => {
    const experiment = loadExperiment(ROOT, "test-control-run"), rows = captures(experiment);
    for (const row of rows) {
        row.record.batch_id = "test-control-run-native-123-456";
        row.record.run_id = row.record.batch_id + "--" + row.record.case_id + "--" + row.policy_id;
    }
    assert.doesNotThrow(() => assessExperiment(experiment, rows.map(x => JSON.stringify(x)).join("\n") + "\n"));
});
test("a policy comparison rejects changed candidate rankings or document vectors", () => {
    const experiment = loadExperiment(ROOT, "test-control-run");
    for (const mutate of [
        (row: ReturnType<typeof captures>[number]) => { row.record.outcome.candidates[0].scores.dense_similarity = 0.7; },
        (row: ReturnType<typeof captures>[number]) => { row.record.outcome.corpus_identity.vectors_sha256 = "e".repeat(64); },
    ]) {
        const rows = captures(experiment, { "CTX26-07:baseline": refs("ACT-FIETS-002"), "CTX26-07:activity_balanced": refs("ACT-FIETS-002") });
        mutate(rows.find(r => r.policy_id === "activity_balanced" && r.record.case_id === "CTX26-07")!);
        assert.throws(() => assessExperiment(experiment, rows.map(x => JSON.stringify(x)).join("\n") + "\n"), /pair|candidate|vectors|preparation/i);
    }
});
test("comparison report shows source counts and explicitly leaves answer quality unassessed", async () => {
    const { renderReport } = await import("./context_selection.ts");
    const experiment = loadExperiment(ROOT, "test-control-run"), rows = captures(experiment, { "CTX26-07:baseline": refs("ACT-FIETS-002") });
    const report = assessExperiment(experiment, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    const markdown = renderReport(experiment, report);
    assert.match(markdown, /NO_GO/);
    assert.match(markdown, /CTX26-07/);
    assert.match(markdown, /4\/4/);
    assert.match(markdown, /answer quality.*not assessed/i);
    assert.match(markdown, /candidate.*seed.*context/i);
    assert.match(markdown, /baseline.*cold.*candidate.*warm/i);
});
test("runner persists source-only input then calls exactly one credential-free native batch", async () => {
    const { runExperiment } = await import("./context_selection.ts");
    const parent = resolve(ROOT, "evals/rag/results/local");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(resolve(parent, "context-runner-test-"));
    const binary = resolve(dir, "test-native");
    writeFileSync(binary, "synthetic controlled runner fixture");
    const output = resolve(dir, "measurement");
    const experiment = loadExperiment(ROOT, "test-control-run");
    const native = captures(experiment).map(r => JSON.stringify(r)).join("\n") + "\n";
    let calls = 0;
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "FAKE_TEST_CREDENTIAL";
    try {
        const report = runExperiment(ROOT, { binary, modelCache: resolve(dir, "cache"), output, executionId: "test-control-run" }, (_binary, args, options) => {
            calls++;
            assert.equal(options.env.OPENAI_API_KEY, undefined);
            assert.equal(options.env.COA_DISABLE_DOTENV, "1");
            assert.equal(readFileSync(resolve(output, "input.json"), "utf8"), experiment.inputBytes);
            assert.equal(args[0], "lab");
            assert.equal(args[1], "context-selection");
            writeFileSync(resolve(output, "native.jsonl"), native, { flag: "wx" });
            return { status: 0, stdout: JSON.stringify({ schema_version: 1, input_sha256: experiment.inputSha256, batch_id: "test-control-run-native-123-456", embedding_identity: JSON.parse(native.split("\n")[0]).record.outcome.corpus_identity.embedding, planned_rows: 40, completed: 40, failed: 0, codex_calls: 0, ai_judge_calls: 0, document_embedding_chunk_size: 8, max_concurrent_searches: 2, observed_peak_rankings: 2, native_batch_elapsed_ms: 10 }), stderr: "" };
        });
        assert.equal(calls, 1);
        assert.equal(report.rows.length, 40);
        assert.equal(JSON.parse(readFileSync(resolve(output, "assessment.json"), "utf8")).input_sha256, experiment.inputSha256);
        assert.match(readFileSync(resolve(output, "report.md"), "utf8"), /NO_GO/);
        assert.throws(() => runExperiment(ROOT, { binary, modelCache: resolve(dir, "cache"), output, executionId: "test-control-run" }, () => { throw Error("must not retry"); }), /exist|new/i);
    }
    finally {
        if (saved === undefined)
            delete process.env.OPENAI_API_KEY;
        else
            process.env.OPENAI_API_KEY = saved;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a technical failure remains unknown evidence and blocks the quality gate", () => {
    const experiment = loadExperiment(ROOT, "test-control-run");
    const rows = captures(experiment);
    const failed = rows.find(row => row.record.case_id === "CTX26-03" && row.policy_id === "activity_balanced")!;
    failed.record.execution_status = "failed";
    Reflect.set(failed.record, "outcome", null);
    Reflect.set(failed.record, "error", "Controlled preparation failure");
    const capture = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
    const report = assessExperiment(experiment, capture);
    const result = report.rows.find(row => row.run_id === failed.record.run_id)!;
    assert.equal(result.complete, null);
    assert.equal(result.coverage, null);
    assert.equal(result.fact_goals, null);
    assert.equal(result.stages, null);
    assert.equal(report.gate.technical_failures, 1);
    assert.equal(report.gate.decision, "NO_GO");
    assert.equal(report.policies.activity_balanced.technical_failures, 1);
    assert.equal(report.native_sha256, sha256(capture));
});
