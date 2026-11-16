import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, readJson, sha256 } from "../json.ts";
import type {
  Envelope,
  NativeRecord,
  Section,
  Variables,
  LiveRecord,
  SearchResponse,
  ToolCall,
  AuditRow,
  CompactRecord,
  CompactResponse,
} from "../types.ts";
export const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
export function section(sourceFile: string, id: string): Section {
  const text = readFileSync(resolve(ROOT, "fixtures", sourceFile), "utf8");
  const pieces = text.split(/^## (S\d+) — (.+)\n/m),
    index = pieces.findIndex((piece, i) => i % 3 === 1 && piece === id);
  return {
    source_id: /^ID: (.+)$/m.exec(text)![1],
    source_title: /^# (.+)$/m.exec(text)![1],
    source_date: /^Brondatum: (.+)$/m.exec(text)![1],
    id,
    heading: pieces[index + 1],
    text: pieces[index + 2].trim(),
  };
}
export function localRecord(keys = ["S2", "S3"], caseId = "P01"): Envelope {
  const questions = ["questions.json", "heldout-questions.json"].flatMap(
    (name) =>
      readJson<{
        cases: {
          id: string;
          question: string;
          family: string;
          split: string;
          kind: string;
        }[];
      }>(resolve(ROOT, "evals/shared/datasets/legacy", name)).cases,
  );
  const row = questions.find((row) => row.id === caseId)!;
  const record = readJson<NativeRecord>(
    resolve(ROOT, "evals/rag/fixtures/regressions/t02-dense-search.json"),
  );
  Object.assign(record, {
    run_id: "measured-run-one",
    case_id: caseId,
    question: row.question,
    family: row.family,
    split: row.split,
    kind: row.kind,
  });
  const hits = keys.map((key, i) => ({
    section: section("document.md", key),
    inclusion: "seed",
    scores: {
      dense_similarity: 0.9 - i * 0.1,
      bm25_score: null,
      dense_rank: i + 1,
      keyword_rank: null,
      rank_score: 0.9 - i * 0.1,
    },
  }));
  const candidates = hits.map((hit) => ({
    key: { source_id: hit.section.source_id, section_id: hit.section.id },
    scores: hit.scores,
  }));
  Object.assign(record.outcome, {
    query: row.question,
    hits,
    seeds: candidates.map((candidate) => candidate.key),
    candidates,
    omitted: [],
  });
  record.outcome.work.union_candidates = candidates.length;
  record.outcome.estimated_context_tokens = hits.reduce(
    (total, hit) =>
      total +
      Math.ceil(
        Array.from(
          canonicalJson(
            Object.fromEntries(
              [
                "source_id",
                "source_date",
                "source_title",
                "id",
                "heading",
                "text",
              ].map((key) => [key, hit.section[key as keyof Section]]),
            ),
          ),
        ).length / 4,
      ),
    0,
  );
  return {
    schema_version: 1,
    operation: "retrieve",
    status: "completed",
    dataset_id: "legacy",
    case_id: caseId,
    question: row.question,
    record,
  };
}
export function variables(
  envelope = localRecord(),
  extra: Partial<Variables> = {},
): Variables {
  const record = envelope.record as NativeRecord;
  return {
    dataset: envelope.dataset_id,
    case_id: envelope.case_id,
    question: envelope.question,
    mode: "local",
    profile: record.config.profile,
    ...record.config.retrieval,
    model: "gpt-6.1-sol",
    ...extra,
  };
}
export function codexRecord(payloadMode = "compact", count = 1): Envelope {
  const local = localRecord(),
    native = local.record as NativeRecord;
  const sources = [
    "document.md",
    "bicycle-workshop.md",
    "language-cafe.md",
    "community-cooking.md",
    "walking.md",
  ].map((name) => {
    const row = section(name, "S1");
    return {
      id: row.source_id,
      title: row.source_title,
      date: row.source_date,
    };
  });
  const full: SearchResponse = {
    schema_version: 1,
    question: local.question,
    top_k: 3,
    as_of: "2026-10-20",
    sources,
    manifest: {
      config: native.config,
      corpus_identity: native.outcome.corpus_identity,
    },
    outcome: native.outcome,
    hits: native.outcome.hits,
    preparation: native.preparation,
  };
  const audits: AuditRow[] = [],
    calls: ToolCall[] = [],
    session = "unit-mcp-audit";
  for (let index = 1; index <= count; index++) {
    const digest = sha256(canonicalJson(full, true));
    const trace = {
      session_id: session,
      call_index: index,
      request_id: `${session}-request-${index}`,
      trace_id: `${session}-trace-${index}`,
      full_response_sha256: digest,
    };
    const visible =
      payloadMode === "full"
        ? full
        : {
            question: full.question,
            top_k: full.top_k,
            sources: full.sources,
            as_of: full.as_of,
            manifest: full.manifest,
            schema_version: 2,
            payload_mode: "compact",
            hits: full.hits.map((hit) => ({ section: hit.section })),
            trace,
          };
    audits.push({
      schema_version: 1,
      ...trace,
      payload_mode: payloadMode,
      payload_bytes: Buffer.byteLength(canonicalJson(visible, true)),
      full_response: full,
    });
    calls.push({
      server: "coa",
      tool: "search_document",
      query: local.question,
      top_k: 3,
      status: "completed",
      result: structuredClone(visible),
    });
  }
  const raw = audits.map((row) => canonicalJson(row, true) + "\n").join("");
  const live = {
    schema_version: 2,
    run_id: "native-codex-one",
    status: "completed",
    question: local.question,
    config: native.config,
    filters: native.request_filters,
    source_guard_passed: true,
    payload_mode: payloadMode,
    trace_integrity_status: "validated",
    source_audit_jsonl: raw,
    audit_trace: {
      session_id: session,
      sha256: sha256(raw),
      trace_bytes: Buffer.byteLength(raw),
      payload_bytes: audits.reduce((sum, row) => sum + row.payload_bytes, 0),
      successful_searches: audits.length,
    },
    run: {
      status: "completed",
      question: local.question,
      model: "gpt-6.1-sol",
      sources,
      as_of: "2026-10-20",
      tool_calls: calls,
    },
  } as LiveRecord;
  return { ...local, operation: "codex", record: live };
}
export function compactResult(): { envelope: Envelope; vars: Variables } {
  const original = codexRecord("full"),
    live = original.record as LiveRecord,
    full = live.run!.tool_calls[0].result as SearchResponse;
  delete full.schema_version;
  const fullText = canonicalJson(full, true);
  const compact = {
    question: full.question,
    top_k: full.top_k,
    as_of: full.as_of,
    sources: full.sources,
    manifest: full.manifest,
    schema_version: 2,
    payload_mode: "compact",
    hits: full.hits.map((hit) => ({ section: hit.section })),
    trace: { full_response_sha256: sha256(fullText) },
  } as CompactResponse;
  const compactText = canonicalJson(compact, true);
  const record: CompactRecord = {
    schema_version: 1,
    status: "completed",
    execution_mode: "offline_projection_replay",
    input_sha256: "a".repeat(64),
    full_response: full,
    compact_response: compact,
    full_response_json: fullText,
    compact_response_json: compactText,
    full_payload_bytes: Buffer.byteLength(fullText),
    compact_payload_bytes: Buffer.byteLength(compactText),
  };
  return {
    envelope: { ...original, operation: "compact", record },
    vars: { ...variables(localRecord()), input_sha256: "a".repeat(64) },
  };
}
