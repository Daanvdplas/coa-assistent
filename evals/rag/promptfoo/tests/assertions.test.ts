import assert from "node:assert/strict";
import { test } from "node:test";
import { getAssert, goalMetrics, loadCase } from "../assertions.ts";
import {
  localRecord,
  codexRecord,
  compactResult,
  section,
  variables,
} from "./fixtures.ts";
import type {
  Envelope,
  NativeRecord,
  LiveRecord,
  Goal,
  CompactRecord,
} from "../types.ts";
import { sha256 } from "../json.ts";
const grade = (envelope: Envelope, extra = {}) =>
  getAssert(JSON.stringify(envelope), {
    vars: variables(localRecord(), extra),
  });

test("complete required sources separate completeness from coverage", () => {
  const result = grade(localRecord());
  assert.equal(result.pass, true);
  assert.equal(result.namedScores.source_complete, 1);
  assert.equal(result.namedScores.goal_coverage, 1);
});
test("completed execution with a missing source is a real quality failure", () => {
  const result = grade(localRecord(["S2"]));
  assert.equal(result.pass, false);
  assert.equal(result.namedScores.source_complete, 0);
  assert.equal(result.namedScores.goal_coverage, 0.5);
  assert.equal(result.namedScores.execution_integrity, 1);
});
test("no positive target receives no perfect quality metric", () => {
  const envelope = localRecord([], "P05"),
    result = getAssert(envelope, { vars: variables(envelope) });
  assert.equal(result.pass, true);
  assert.ok(!("source_complete" in result.namedScores));
  assert.ok(!("goal_coverage" in result.namedScores));
  assert.match(result.reason, /not applicable/);
});
test("source text and date mutations fail integrity", () => {
  for (const field of ["text", "source_date"] as const) {
    const row = localRecord();
    (row.record as NativeRecord).outcome.hits[0].section[field] += " changed";
    const result = grade(row);
    assert.equal(result.pass, false);
    assert.equal(result.namedScores.execution_integrity, 0);
  }
});
test("failed unsupported missing and mismatched input executions cannot pass", () => {
  for (const status of ["failed", "unsupported"]) {
    const row = localRecord();
    (row.record as NativeRecord).execution_status = status;
    assert.equal(grade(row).pass, false);
  }
  const row = localRecord();
  (row.record as NativeRecord).question = "different";
  assert.equal(grade(row).pass, false);
  row.status = "failed";
  assert.equal(grade(row).pass, false);
});
test("AND alternatives cannot be mixed and minimum union counts shared sections once", () => {
  const ref = (source_id: string, section_id: string) => ({
    source_id,
    section_id,
  });
  const goals: Goal[] = [
    {
      evidence_alternatives: [
        [ref("A", "S1"), ref("A", "S2")],
        [ref("B", "S1"), ref("B", "S2")],
      ],
    },
    { evidence_alternatives: [[ref("B", "S2")], [ref("C", "S1")]] },
  ];
  for (const [offered, expected] of [
    [[], 0],
    [["A:S1", "B:S2"], 0.5],
    [["A:S1", "A:S2", "C:S1"], 1],
    [["B:S1", "B:S2"], 1],
    [["Z:S1"], 0],
  ] as [string[], number][]) {
    const metric = goalMetrics(goals, new Set(offered));
    assert.equal(metric.goal_coverage, expected);
    assert.equal(metric.source_complete, expected === 1);
    assert.equal(metric.minimum_required_sections, 2);
  }
  assert.equal(
    goalMetrics(
      [
        { evidence_alternatives: [[ref("A", "S1")]] },
        { evidence_alternatives: [[ref("A", "S1"), ref("A", "S2")]] },
      ],
      new Set(),
    ).minimum_required_sections,
    2,
  );
  assert.equal(
    goalMetrics([goals[0]], new Set(["A:S1", "B:S2"])).goal_coverage,
    0,
  );
});
test("unselected hits cannot complete sections and inconsistent candidate traces fail", () => {
  const row = localRecord(["S2"]);
  (row.record as NativeRecord).outcome.hits.push({
    section: section("document.md", "S3"),
    inclusion: "activity_expansion",
    scores: null,
  });
  assert.equal(grade(row).namedScores.execution_integrity, 0);
  const other = localRecord();
  (other.record as NativeRecord).outcome.candidates = [];
  assert.equal(grade(other).pass, false);
});
test("wrong corpus method and storage profile fail integrity", () => {
  const changes = [
    (r: NativeRecord) => (r.dataset.corpus_sha256 = "0".repeat(64)),
    (r: NativeRecord) => (r.config.retrieval.method = "bm25"),
    (r: NativeRecord) => (r.config.profile = "sqlite_sections"),
  ];
  for (const change of changes) {
    const row = localRecord();
    change(row.record as NativeRecord);
    assert.equal(grade(row).namedScores.execution_integrity, 0);
  }
});
test("Codex binds model configuration query server tool payload and validated audit", () => {
  const row = codexRecord();
  assert.equal(grade(row).pass, true);
  const mutations = [
    (r: LiveRecord) => (r.run!.model = "gpt-6-luna"),
    (r: LiveRecord) => (r.trace_integrity_status = "invalid"),
    (r: LiveRecord) => (r.run!.question = "unrelated"),
    (r: LiveRecord) => (r.config.profile = "sqlite_sections"),
    (r: LiveRecord) => (r.run!.tool_calls[0].server = "untrusted"),
    (r: LiveRecord) => (r.run!.tool_calls[0].tool = "shell"),
    (r: LiveRecord) => (r.payload_mode = "full"),
  ];
  for (const change of mutations) {
    const changed = structuredClone(row);
    change(changed.record as LiveRecord);
    assert.equal(grade(changed).pass, false);
  }
});
test("full and compact audits produce the same strict source quality", () => {
  const compact = grade(codexRecord()),
    full = grade(codexRecord("full"), { payload_mode: "full" });
  assert.equal(compact.pass, true);
  assert.equal(full.pass, true);
  assert.equal(
    compact.namedScores.goal_coverage,
    full.namedScores.goal_coverage,
  );
});
test("missing corrupted reordered audit and extra visible hits fail", () => {
  const mutations = [
    (r: LiveRecord) => delete r.source_audit_jsonl,
    (r: LiveRecord) => (r.source_audit_jsonl += " "),
    (r: LiveRecord) =>
      r.run!.tool_calls[0].result!.hits.push({
        section: section("document.md", "S4"),
      } as never),
  ];
  for (const change of mutations) {
    const row = codexRecord("compact", 2);
    change(row.record as LiveRecord);
    assert.equal(grade(row).pass, false);
  }
  const row = codexRecord("compact", 2),
    record = row.record as LiveRecord;
  record.source_audit_jsonl =
    record.source_audit_jsonl!.trimEnd().split("\n").reverse().join("\n") +
    "\n";
  record.audit_trace!.sha256 = sha256(record.source_audit_jsonl);
  assert.equal(grade(row).pass, false);
});
test("multisearch has a per-search capacity and no cumulative section cap", () => {
  const result = grade(codexRecord("compact", 2));
  assert.equal(result.metadata!.source_metrics.section_capacity_limit, null);
  assert.equal(
    result.metadata!.source_metrics.per_search_section_capacity_limit,
    3,
  );
});
test("activity expansion reports minimum activity capacity and empty rank is known zero", () => {
  const row = localRecord(["S5"], "T01"),
    record = row.record as NativeRecord;
  Object.assign(record.config.retrieval, {
    selection: "activity_expansion",
    top_k: 1,
  });
  Object.assign(record.outcome.config, {
    selection: "activity_expansion",
    top_k: 1,
  });
  const metric = getAssert(row, { vars: variables(row) }).metadata!
    .source_metrics;
  assert.equal(metric.minimum_required_activities, 3);
  assert.equal(metric.seed_activity_capacity_limit, 1);
  assert.equal(metric.goal_set_exceeds_capacity, true);
  const empty = grade(localRecord([]));
  assert.equal(empty.namedScores.first_goal_support_reciprocal_rank, 0);
  assert.equal(empty.namedScores.first_relevant_reciprocal_rank, 0);
});
test("garden word overlap retains its separate source labels", () => {
  const labels = loadCase("garden", "Q1");
  assert.deepEqual(labels.facts![0].evidence_alternatives![0][0], {
    source_id: "ACT-TUIN-001",
    section_id: "S2",
  });
  assert.equal(labels.facts!.length, 2);
});
test("compact preserves exact sources and reports only payload metrics", () => {
  const { envelope, vars } = compactResult(),
    result = getAssert(envelope, { vars });
  assert.equal(result.pass, true);
  assert.ok(!("source_complete" in result.namedScores));
  assert.ok(result.namedScores.payload_reduction > 0);
  assert.equal(result.metadata!.source_metrics.answer_quality, "not_assessed");
});
test("compact projection mutations byte count and provenance changes fail", () => {
  for (const change of [
    (r: CompactRecord) =>
      (r.compact_response.hits[0].section.source_date = "2026-01-01"),
    (r: CompactRecord) => (r.input_sha256 = "b".repeat(64)),
    (r: CompactRecord) => (r.full_payload_bytes = 1),
  ]) {
    const { envelope, vars } = compactResult();
    change(envelope.record as CompactRecord);
    assert.equal(getAssert(envelope, { vars }).pass, false);
  }
});
test("malformed private output does not leak its contents through parser diagnostics", () => {
  const result = getAssert("SECRET-CREDENTIAL-AND-REASONING", {
    vars: variables(),
  });
  assert.equal(result.pass, false);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.ok(!JSON.stringify(result).includes("CREDENTIAL"));
});
