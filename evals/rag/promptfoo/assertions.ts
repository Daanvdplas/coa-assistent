/** Source assertions alone read protected labels. Providers only see questions. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, checkedFile, readJson, same, sha256 } from "./json.ts";
import type {
  AuditRow,
  Candidate,
  CompactRecord,
  CompactResponse,
  Config,
  Context,
  Criteria,
  EmbeddingSpec,
  Envelope,
  GardenRecord,
  Goal,
  Grade,
  LiveRecord,
  NativeRecord,
  Reference,
  SearchResponse,
  Section,
  SourceMetrics,
  ToolCall,
  Variables,
} from "./types.ts";
import { classifyResult } from "./model_control.ts";
export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const DATASETS = new Set([
  "legacy",
  "independent-20261103",
  "expanded-10-20261105",
  "strengthened-10-20261106",
  "garden",
  "demo-12-20261118",
]);
function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}
function readPinned<T>(relative: string): T {
  const pins = readJson<{ files: Record<string, string> }>(
      resolve(HERE, "data-pins.json"),
    ).files,
    raw = readFileSync(resolve(ROOT, relative));
  requireCondition(
    pins[relative] === sha256(raw),
    "Frozen evaluation input changed: " + relative,
  );
  return JSON.parse(raw.toString()) as T;
}
export function loadCase(dataset: string, caseId: string): Criteria {
  requireCondition(DATASETS.has(dataset), "Unknown dataset");
  const base = "evals/shared/datasets/" + dataset;
  const files =
    dataset === "garden"
      ? [
          [
            "evals/rag/datasets/garden/questions.json",
            "evals/rag/datasets/garden/expectations.json",
          ],
        ]
      : dataset === "legacy"
        ? [
            [base + "/questions.json", base + "/expectations.json"],
            [
              base + "/heldout-questions.json",
              base + "/heldout-expectations.json",
            ],
          ]
        : [[base + "/questions.json", base + "/expectations.json"]];
  type Question = { id: string; question?: string; text?: string };
  for (const [questionsPath, labelsPath] of files) {
    const questions = readPinned<
        Question[] | { cases: Question[]; corpus_sha256: string; as_of: string }
      >(questionsPath),
      labels = readPinned<{
        cases: (Criteria & { case_id?: string; question_id?: string })[];
        as_of: string;
      }>(labelsPath);
    const question = (
      Array.isArray(questions) ? questions : questions.cases
    ).find((row) => row.id === caseId);
    if (!question) continue;
    const criteria = labels.cases.find(
      (row) =>
        (dataset === "garden" ? row.question_id : row.case_id) === caseId,
    );
    requireCondition(criteria, "Missing protected reference case");
    const result = {
      ...criteria,
      question: question.question ?? question.text!,
      question_sha256: sha256(readFileSync(resolve(ROOT, questionsPath))),
      reference_sha256: sha256(readFileSync(resolve(ROOT, labelsPath))),
      corpus_sha256: Array.isArray(questions)
        ? readPinned<{ corpus_sha256: string }>(
            "evals/shared/datasets/legacy/questions.json",
          ).corpus_sha256
        : questions.corpus_sha256,
      as_of: Array.isArray(questions) ? labels.as_of : questions.as_of,
    };
    if (dataset === "garden")
      Object.assign(result, {
        facts: criteria.required_source_ids!.map((key, i) => {
          const [source_id, section_id] = key.split(":");
          return {
            id: "source-" + i,
            evidence_alternatives: [[{ source_id, section_id }]],
          };
        }),
        relevance_labels_complete: false,
        relevant_sections: [],
        required_unknowns: criteria.unknown_flags ?? [],
      });
    return result;
  }
  throw new Error("Unknown case in frozen dataset");
}
export function key(reference: Reference | Section): string {
  return (
    reference.source_id +
    ":" +
    ("section_id" in reference ? reference.section_id : reference.id)
  );
}
const subset = (left: Set<string>, right: Set<string>) =>
  [...left].every((value) => right.has(value));
export function goalMetrics(
  goals: Goal[],
  offered: Set<string>,
): SourceMetrics {
  const alternatives = goals
    .filter((goal) => goal.evidence_alternatives?.length)
    .map((goal) =>
      goal.evidence_alternatives!.map((option) => new Set(option.map(key))),
    );
  if (!alternatives.length)
    return {
      target_goals: 0,
      covered_goals: 0,
      source_complete: null,
      goal_coverage: null,
      minimum_required_sections: null,
    };
  const covered = alternatives.filter((options) =>
    options.some((option) => subset(option, offered)),
  ).length;
  let frontier = [new Set<string>()];
  for (const options of alternatives) {
    let next: Set<string>[] = [];
    for (const previous of frontier)
      for (const option of options) {
        const union = new Set([...previous, ...option]);
        if (next.some((other) => subset(other, union))) continue;
        next = next.filter((other) => !subset(union, other));
        next.push(union);
      }
    frontier = next;
  }
  return {
    target_goals: alternatives.length,
    covered_goals: covered,
    source_complete: covered === alternatives.length,
    goal_coverage: covered / alternatives.length,
    minimum_required_sections: Math.min(...frontier.map((set) => set.size)),
  };
}
export function canonicalSources(expanded = false, demo = false): Map<string, Section> {
  const names = [
    "document.md",
    "bicycle-workshop.md",
    "language-cafe.md",
    "community-cooking.md",
    "walking.md",
  ];
  if (expanded || demo)
    for (let i = 6; i <= 10; i++)
      names.push(
        `expanded-10-20261105/activity-${String(i).padStart(3, "0")}.md`,
      );
  if (demo)
    for (const number of [11, 12])
      names.push(`demo-12-20261113/activity-${String(number).padStart(3, "0")}.md`);
  const pins = readJson<{ files: Record<string, string> }>(
      resolve(HERE, "data-pins.json"),
    ).files,
    sources = new Map<string, Section>();
  for (const name of names) {
    const relative = "fixtures/" + name,
      raw = readFileSync(resolve(ROOT, relative));
    requireCondition(
      pins[relative] === sha256(raw),
      "Canonical source changed: " + relative,
    );
    const text = raw.toString(),
      pieces = text.split(/^## (S\d+) — (.+)\n/m);
    const header = {
      source_id: /^ID: (.+)$/m.exec(text)![1],
      source_title: /^# (.+)$/m.exec(text)![1],
      source_date: /^Brondatum: (.+)$/m.exec(text)![1],
    };
    for (let i = 1; i < pieces.length; i += 3) {
      const section = {
        ...header,
        id: pieces[i],
        heading: pieces[i + 1],
        text: pieces[i + 2].trim(),
      };
      sources.set(key(section), section);
    }
  }
  return sources;
}
export function orderedSection(section: Section): Section {
  return {
    source_id: section.source_id,
    source_date: section.source_date,
    source_title: section.source_title,
    id: section.id,
    heading: section.heading,
    text: section.text,
  };
}
function validateConfig(
  actual: NativeRecord["config"],
  variables: Variables,
): Config {
  requireCondition(
    actual.profile === variables.profile,
    "Storage profile differs from requested configuration",
  );
  const config = actual.retrieval;
  for (const field of [
    "method",
    "top_k",
    "candidate_k",
    "context_token_limit",
    "selection",
    "apply_filters",
    "mmr",
    "rrf_k",
    "vector_weight",
    "mmr_lambda",
  ] as const)
    requireCondition(
      field in variables && same(config[field], variables[field]),
      "Retrieval configuration differs from request: " + field,
    );
  return config;
}
function browserEmbedding(record: NativeRecord, variables: Variables): string {
  if (variables.browser_eval_id === undefined) return "";
  const cases: Record<string, string> = {
    "garden-time-location": "P01",
    "indoor-tuesday": "T02",
    "two-activities": "T05",
  };
  requireCondition(
    cases[variables.browser_eval_id] === variables.case_id &&
      ["legacy", "demo-12-20261118"].includes(variables.dataset),
    "Browser case differs from its existing reference",
  );
  const fixed = {
    profile: "documents_sections",
    top_k: 5,
    candidate_k: 30,
    context_token_limit: 1200,
    selection: "sections",
    apply_filters: false,
    mmr: false,
  };
  requireCondition(
    Object.entries(fixed).every(([field, value]) =>
      same(variables[field as keyof Variables], value),
    ),
    "Browser search treatment differs from its fixed protocol",
  );
  const spec = readJson<EmbeddingSpec[]>(
    resolve(ROOT, "evals/rag/embedding-models.json"),
  ).find((row) => row.id === variables.embedding_model);
  requireCondition(spec, "Unknown selected browser embedding model");
  const corpus = record.outcome.corpus_identity,
    identity = corpus.embedding;
  if (variables.method === "bm25") {
    requireCondition(
      identity === null && corpus.vectors_sha256 === null,
      "Word-only search must not claim embeddings or vectors",
    );
    return "";
  }
  const path = checkedFile(
      process.env.COA_PROMPTFOO_EMBEDDING_MANIFEST!,
      process.env.COA_PROMPTFOO_ARTIFACT_DIR!,
      1024 * 1024,
    ),
    raw = readFileSync(path);
  requireCondition(
    sha256(raw) === process.env.COA_PROMPTFOO_EMBEDDING_MANIFEST_SHA256,
    "Independent embedding preparation bytes changed",
  );
  const manifest = JSON.parse(raw.toString()) as {
    schema_version: number;
    execution_id: string;
    models: Record<string, unknown>;
  };
  requireCondition(
    manifest.schema_version === 1 &&
      manifest.execution_id === process.env.COA_PROMPTFOO_EXECUTION_ID &&
      same(manifest.models?.[spec.id], identity),
    "Actual embedding differs from independently prepared model",
  );
  const fields = new Set([
    "provider",
    "model",
    "sdk",
    "dimensions",
    "encoding",
    "document_prefix",
    "query_prefix",
  ]);
  requireCondition(
    identity &&
      typeof identity === "object" &&
      Object.keys(identity).every((field) => fields.has(field)),
    "Unknown embedding identity fields",
  );
  requireCondition(
    identity.provider === "local-fastembed" &&
      identity.sdk === spec.sdk &&
      identity.dimensions === spec.dimensions,
    "Actual embedding SDK/provider/dimensions differ",
  );
  requireCondition(
    identity.model.startsWith(spec.repository + "@") &&
      /^[0-9a-f]{40}$/.test(identity.model.slice(spec.repository.length + 1)),
    "Actual embedding repository/revision differs",
  );
  requireCondition(
    identity.encoding.startsWith(spec.encoding + "; model_files_sha256=") &&
      /^[0-9a-f]{64}$/.test(
        identity.encoding.slice(
          (spec.encoding + "; model_files_sha256=").length,
        ),
      ),
    "Actual embedding encoding/artifact identity differs",
  );
  for (const field of ["document_prefix", "query_prefix"] as const)
    requireCondition(
      (identity[field] ?? "") === spec[field],
      "Actual embedding prefix differs",
    );
  requireCondition(
    /^[0-9a-f]{64}$/.test(corpus.vectors_sha256 ?? ""),
    "Embedding search lacks its vector content identity",
  );
  return spec.document_prefix;
}
function validateLocal(
  record: NativeRecord,
  variables: Variables,
  criteria: Criteria,
  canonical: Map<string, Section>,
): void {
  const config = validateConfig(record.config, variables),
    identity = record.dataset ?? {};
  requireCondition(
    identity.corpus_sha256 === criteria.corpus_sha256 &&
      identity.as_of === criteria.as_of,
    "Recorded dataset corpus/date differs from frozen input",
  );
  const outcome = record.outcome;
  requireCondition(
    outcome?.version === "retrieval-v1" && same(outcome.config, config),
    "Retrieval trace version/configuration differs",
  );
  const sourceSections = [...canonical.values()].map(orderedSection),
    expectedSource = sha256(canonicalJson(sourceSections)),
    prefix = browserEmbedding(record, variables);
  const inputs = sourceSections.map(
      (section) =>
        prefix +
        section.source_title +
        "\n" +
        section.heading +
        "\n" +
        section.text,
    ),
    expectedEmbedding = sha256(canonicalJson(inputs));
  const corpus = outcome.corpus_identity ?? {};
  requireCondition(
    corpus.source_sha256 === expectedSource &&
      corpus.embedding_inputs_sha256 === expectedEmbedding,
    "Prepared corpus/source embedding inputs differ",
  );
  const preparation = record.preparation ?? {};
  requireCondition(
    same(preparation.corpus_identity, corpus) &&
      preparation.actual_profile === record.config.profile,
    "Actual preparation differs from requested corpus/profile",
  );
  const candidates = outcome.candidates ?? [],
    candidateMap = new Map(
      candidates.map((candidate) => [key(candidate.key), candidate]),
    );
  requireCondition(
    candidateMap.size === candidates.length &&
      [...candidateMap.keys()].every((key) => canonical.has(key)),
    "Duplicate or unknown candidate sections",
  );
  requireCondition(
    outcome.work?.union_candidates === candidates.length,
    "Candidate work trace is inconsistent",
  );
  const usesDense = config.method !== "bm25",
    usesKeyword = config.method !== "dense";
  for (const [rankName, scoreName, used] of [
    ["dense_rank", "dense_similarity", usesDense],
    ["keyword_rank", "bm25_score", usesKeyword],
  ] as const) {
    const ranks = candidates.flatMap((candidate) =>
      candidate.scores[rankName] === null ||
      candidate.scores[rankName] === undefined
        ? []
        : [candidate.scores[rankName]!],
    );
    requireCondition(
      ranks.length <= config.candidate_k &&
        new Set(ranks).size === ranks.length &&
        same(
          [...ranks].sort((a, b) => a - b),
          Array.from({ length: ranks.length }, (_, i) => i + 1),
        ),
      "Candidate ranks are inconsistent",
    );
    for (const candidate of candidates) {
      const scores = candidate.scores,
        score = scores[scoreName];
      requireCondition(
        (score !== null && score !== undefined) === used &&
          (used || scores[rankName] === null || scores[rankName] === undefined),
        "Candidate scoring method differs",
      );
      if (score !== null && score !== undefined)
        requireCondition(
          Number.isFinite(score) &&
            (scoreName === "dense_similarity"
              ? score >= -1 && score <= 1
              : score >= 0),
          "Invalid retrieval score",
        );
      if (
        scoreName === "bm25_score" &&
        scores[rankName] !== null &&
        scores[rankName] !== undefined
      )
        requireCondition(
          score !== null && score > 0,
          "Nonpositive keyword candidate rank",
        );
    }
  }
  requireCondition(
    candidates.every((candidate) =>
      Number.isFinite(candidate.scores.rank_score),
    ),
    "Invalid ranking score",
  );
  const order = (a: Candidate, b: Candidate) =>
    b.scores.rank_score - a.scores.rank_score ||
    (key(a.key) < key(b.key) ? -1 : key(a.key) > key(b.key) ? 1 : 0);
  requireCondition(
    same(candidates, [...candidates].sort(order)),
    "Candidate order differs from recorded rank scores",
  );
  const seeds = (outcome.seeds ?? []).map(key),
    hits = outcome.hits ?? [],
    offered = hits.map((hit) => key(hit.section)),
    actualSeeds = hits
      .filter((hit) => hit.inclusion === "seed")
      .map((hit) => key(hit.section));
  requireCondition(
    new Set(seeds).size === seeds.length &&
      seeds.every((seed) => candidateMap.has(seed)) &&
      same(seeds, actualSeeds) &&
      seeds.length <= config.top_k,
    "Seed selection is not bound to candidates and offered hits",
  );
  requireCondition(
    config.selection !== "sections" ||
      (same(offered, seeds) && hits.length <= config.top_k),
    "Sections selection contains unselected or excess source hits",
  );
  const seedActivities = new Set(
    (outcome.seeds ?? []).map((ref) => ref.source_id),
  );
  for (const hit of hits) {
    requireCondition(
      same(hit.scores, candidateMap.get(key(hit.section))?.scores ?? null),
      "Offered scores differ from candidates",
    );
    requireCondition(
      ["seed", "activity_expansion"].includes(hit.inclusion) &&
        (hit.inclusion !== "activity_expansion" ||
          seedActivities.has(hit.section.source_id)),
      "Invalid activity expansion",
    );
  }
  const omitted = outcome.omitted ?? [],
    omittedKeys = omitted.map((row) => key(row.key));
  requireCondition(
    new Set(omittedKeys).size === omittedKeys.length &&
      omittedKeys.every(
        (key) => canonical.has(key) && !offered.includes(key),
      ) &&
      (config.selection !== "sections" || !omitted.length),
    "Invalid omitted-section trace",
  );
  requireCondition(
    omitted.every(
      (row) =>
        String(row.reason ?? "").trim() &&
        seedActivities.has(row.key.source_id),
    ),
    "Unbound omitted activity section",
  );
  const tokens = hits.reduce(
    (total, hit) =>
      total +
      Math.ceil(
        Array.from(canonicalJson(orderedSection(hit.section))).length / 4,
      ),
    0,
  );
  requireCondition(
    outcome.token_estimator === "unicode-scalar-ceil-div4-json-section-v1" &&
      outcome.estimated_context_tokens === tokens &&
      tokens <= config.context_token_limit,
    "Offered context differs from the measured token budget",
  );
  const layout = preparation.layout ?? {};
  requireCondition(
    layout.canonical_sections === canonical.size,
    "Declared storage layout does not contain the canonical corpus",
  );
  const activities = record.config.profile.endsWith("_activities");
  requireCondition(
    layout.activity_records ===
      (activities
        ? new Set([...canonical.values()].map((section) => section.source_id))
            .size
        : 0) &&
      layout.activity_section_links === (activities ? canonical.size : 0),
    "Storage structure differs from requested layout",
  );
  const normalized = {
    weekdays: [],
    environment: null,
    time: null,
    ...variables.filters,
  };
  requireCondition(
    same(record.request_filters, normalized),
    "Typed input filters differ from requested user constraints",
  );
  const filters = outcome.filters ?? {},
    requested = Boolean(
      normalized.weekdays?.length ||
        normalized.environment !== null ||
        normalized.time !== null,
    );
  requireCondition(
    filters.requested === requested &&
      filters.applied === (config.apply_filters && requested),
    "Typed filter application trace differs",
  );
  requireCondition(
    !filters.applied ||
      hits.every((hit) =>
        filters.matched_activity_ids?.includes(hit.section.source_id),
      ),
    "Offered source does not match the applied filter trace",
  );
}
/** Locate the native value span; JSON.parse/stringify would change float bytes. */
export function rawJsonField(text: string, field: string): string {
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(text[index] ?? "") && index < text.length) index++;
  };
  function valueEnd(start: number): number {
    let string = false,
      escape = false,
      depth = 0;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (string) {
        if (escape) escape = false;
        else if (char === "\\") escape = true;
        else if (char === '"') {
          string = false;
          if (!depth) return i + 1;
        }
        continue;
      }
      if (char === '"') {
        string = true;
        continue;
      }
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        if (!depth) return i;
        depth--;
        if (!depth) return i + 1;
      } else if (!depth && (char === "," || /\s/.test(char))) return i;
    }
    return text.length;
  }
  whitespace();
  requireCondition(text[index++] === "{", "Audit row is not a JSON object");
  while (index < text.length) {
    whitespace();
    if (text[index] === "}") break;
    const end = valueEnd(index),
      name = JSON.parse(text.slice(index, end));
    index = end;
    whitespace();
    requireCondition(text[index++] === ":", "Invalid audit field separator");
    whitespace();
    const start = index;
    index = valueEnd(start);
    const value = text.slice(start, index);
    JSON.parse(value);
    if (name === field) return value;
    whitespace();
    if (text[index] === ",") index++;
    else if (text[index] === "}") break;
    else throw new Error("Invalid audit object delimiter");
  }
  throw new Error("Missing full audit response");
}
function auditedResponses(
  live: LiveRecord,
  calls: ToolCall[],
): [ToolCall, SearchResponse | null][] {
  const raw = live.source_audit_jsonl,
    summary = live.audit_trace;
  requireCondition(
    typeof raw === "string" &&
      raw.endsWith("\n") &&
      Buffer.byteLength(raw) === summary?.trace_bytes &&
      sha256(raw) === summary.sha256,
    "Missing or changed SHA-bound source audit",
  );
  const lines = raw.slice(0, -1).split("\n"),
    rows = lines.map((line) => JSON.parse(line) as AuditRow),
    successes = calls.filter((call) => call.status === "completed");
  requireCondition(
    rows.length === successes.length &&
      rows.length === summary.successful_searches &&
      rows.reduce((sum, row) => sum + row.payload_bytes, 0) ===
        summary.payload_bytes,
    "Source audit call/byte counts differ",
  );
  let auditIndex = 0;
  return calls.map((call) => {
    if (call.status !== "completed") {
      requireCondition(
        call.result === null || call.result === undefined,
        "Failed search cannot supply source evidence",
      );
      return [call, null];
    }
    const audit = rows[auditIndex],
      line = lines[auditIndex++],
      index = auditIndex,
      session = summary.session_id;
    const trace = {
      session_id: session,
      call_index: index,
      request_id: `${session}-request-${index}`,
      trace_id: `${session}-trace-${index}`,
      full_response_sha256: audit.full_response_sha256,
    };
    requireCondition(
      audit.schema_version === 1 &&
        audit.payload_mode === live.payload_mode &&
        Object.entries(trace).every(([field, value]) =>
          same(audit[field as keyof AuditRow], value),
        ),
      "Source audit session/order/request identity differs",
    );
    const full = audit.full_response,
      fullText = rawJsonField(line, "full_response");
    requireCondition(
      same(JSON.parse(fullText), full) &&
        sha256(fullText) === audit.full_response_sha256,
      "Complete source audit digest differs",
    );
    requireCondition(
      full.question === call.query && full.top_k === call.top_k,
      "Audited source query differs from actual tool call",
    );
    let projected: SearchResponse | CompactResponse = full,
      payloadBytes = Buffer.byteLength(fullText);
    if (live.payload_mode !== "full") {
      projected = {
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
      payloadBytes = Buffer.byteLength(canonicalJson(projected, true));
    }
    requireCondition(
      same(call.result, projected) && audit.payload_bytes === payloadBytes,
      "Visible full/compact payload differs from its exact audited projection",
    );
    return [call, full];
  });
}
function observations(
  envelope: Envelope,
  variables: Variables,
  criteria: Criteria,
  canonical: Map<string, Section>,
): [
  Section[],
  string[],
  Config | { top_k: number; selection: string; context_token_limit: number },
  ToolCall[],
] {
  if (envelope.operation === "retrieve") {
    const record = envelope.record as NativeRecord;
    requireCondition(
      record.execution_status === "completed" &&
        record.execution_kind === "local_measured",
      "Retrieval was not a completed measured execution",
    );
    requireCondition(
      record.question === envelope.question &&
        record.case_id === envelope.case_id,
      "Recorded input identity differs",
    );
    requireCondition(
      record.outcome && record.outcome.query === envelope.question,
      "Missing or mismatched retrieval trace",
    );
    validateLocal(record, variables, criteria, canonical);
    const hits = record.outcome.hits.map((hit) => hit.section),
      seeds = record.outcome.seeds.map(key),
      offered = new Set(hits.map(key));
    requireCondition(
      offered.size === hits.length &&
        new Set(seeds).size === seeds.length &&
        seeds.every((seed) => offered.has(seed)),
      "Invalid duplicate or unoffered seed references",
    );
    return [hits, seeds, record.config.retrieval, []];
  }
  if (envelope.operation === "codex") {
    const raw = envelope.record as NativeRecord,
      live = raw.live ?? (envelope.record as LiveRecord);
    requireCondition(
      live.status === "completed" &&
        live.run &&
        live.question === envelope.question,
      "Codex session did not complete with the requested input",
    );
    const config = validateConfig(live.config, variables),
      run = live.run;
    requireCondition(
      run.model === variables.model &&
        run.question === envelope.question &&
        run.status === "completed" &&
        live.source_guard_passed === true,
      "Actual Codex model/input/source guard differs from request",
    );
    requireCondition(
      live.schema_version === 2 && live.trace_integrity_status === "validated",
      "New Codex run lacks a validated audit trace",
    );
    requireCondition(
      live.payload_mode === (variables.payload_mode ?? "compact"),
      "Codex transport payload differs from requested treatment",
    );
    const sources = [
      ...new Map(
        [...canonical.values()].map((source) => [
          source.source_id,
          {
            id: source.source_id,
            title: source.source_title,
            date: source.source_date,
          },
        ]),
      ).values(),
    ];
    requireCondition(
      same(run.sources, sources) && run.as_of === criteria.as_of,
      "Codex source catalogue/date differs from the canonical corpus",
    );
    const calls = run.tool_calls;
    requireCondition(
      Array.isArray(calls) && calls.length >= 1 && calls.length <= 4,
      "Missing or over-limit Codex search trace",
    );
    const hits: Section[] = [];
    for (const [call, result] of auditedResponses(live, calls)) {
      requireCondition(
        call.server === "coa" && call.tool === "search_document",
        "Untrusted tool/server cannot supply retrieval evidence",
      );
      if (call.status !== "completed") {
        requireCondition(
          result === null,
          "Failed search cannot offer source evidence",
        );
        continue;
      }
      requireCondition(
        result &&
          result.question === call.query &&
          result.top_k === config.top_k &&
          call.top_k === config.top_k,
        "Codex search response differs from its actual request",
      );
      requireCondition(
        same(result.sources, sources) && result.as_of === criteria.as_of,
        "Tool source catalogue/date differs",
      );
      const outcome = result.outcome,
        manifest = result.manifest;
      requireCondition(
        same(result.hits, outcome?.hits) &&
          same(manifest?.config, live.config) &&
          same(manifest.corpus_identity, outcome.corpus_identity) &&
          outcome.query === call.query,
        "Tool-visible evidence differs from its complete audit",
      );
      validateLocal(
        {
          config: live.config,
          dataset: {
            corpus_sha256: criteria.corpus_sha256,
            as_of: criteria.as_of,
          },
          outcome,
          preparation: result.preparation,
          request_filters: live.filters,
        } as NativeRecord,
        variables,
        criteria,
        canonical,
      );
      hits.push(...result.hits.map((hit) => hit.section));
    }
    return [hits, [], config, calls];
  }
  if (envelope.operation === "garden") {
    const record = envelope.record as GardenRecord;
    requireCondition(
      record.status === "completed" &&
        (record.question ?? record.query) === envelope.question &&
        record.method === variables.method &&
        record.top_k === variables.top_k,
      "Garden runtime/request identity differs",
    );
    requireCondition(
      record.source_manifest?.corpus_sha256 === criteria.corpus_sha256 &&
        record.source_manifest.as_of === criteria.as_of,
      "Garden source corpus/date differs",
    );
    const hits = record.hits.map((hit) => hit.section);
    requireCondition(
      hits.length <= variables.top_k &&
        new Set(hits.map(key)).size === hits.length,
      "Invalid garden source selection",
    );
    return [
      hits,
      hits.map(key),
      {
        top_k: record.top_k,
        selection: "sections",
        context_token_limit: 1000000,
      },
      [],
    ];
  }
  throw new Error("Unknown source evaluation operation");
}
export function measure(
  envelope: Envelope,
  variables: Variables,
): SourceMetrics {
  requireCondition(
    envelope.status === "completed",
    "Provider envelope is not a completed execution",
  );
  requireCondition(
    envelope.schema_version === 1,
    "Unknown promptfoo output schema",
  );
  requireCondition(
    envelope.dataset_id === variables.dataset &&
      envelope.case_id === variables.case_id,
    "Provider output belongs to a different test",
  );
  const criteria = loadCase(envelope.dataset_id, envelope.case_id);
  requireCondition(
    envelope.question === variables.question &&
      envelope.question === criteria.question,
    "Question differs from the frozen input",
  );
  const canonical = canonicalSources(
    ["expanded-10-20261105", "strengthened-10-20261106"].includes(
      envelope.dataset_id,
    ),
    envelope.dataset_id === "demo-12-20261118",
  );
  const [hits, seeds, config, calls] = observations(
    envelope,
    variables,
    criteria,
    canonical,
  );
  for (const hit of hits)
    requireCondition(
      same(canonical.get(key(hit)), hit),
      "Offered source text, date or identity is not canonical",
    );
  const offered = new Set(hits.map(key)),
    facts = criteria.facts ?? [],
    result = goalMetrics(facts, offered),
    support = new Set(
      facts.flatMap((fact) =>
        (fact.evidence_alternatives ?? []).flatMap((option) => option.map(key)),
      ),
    );
  result.goals = facts
    .filter((goal) => goal.evidence_alternatives?.length)
    .map((goal) => ({
      id: goal.id ?? "",
      description: goal.description ?? "",
      covered: goal.evidence_alternatives!.some((option) =>
        option.every((ref) => offered.has(key(ref))),
      ),
      alternatives: goal.evidence_alternatives!.map((option) =>
        option.map((ref) => ({
          source_id: ref.source_id,
          section_id: ref.section_id,
          found: offered.has(key(ref)),
        })),
      ),
    }));
  if (envelope.operation === "retrieve" && variables.browser_eval_id) {
    const corpus = (envelope.record as NativeRecord).outcome.corpus_identity;
    Object.assign(result, {
      embedding_identity: corpus.embedding,
      corpus_identity: corpus,
    });
  }
  Object.assign(result, {
    execution_integrity: true,
    reference_sha256: criteria.reference_sha256,
    question_sha256: criteria.question_sha256,
    offered_sections: offered.size,
    source_quality_applicable: result.target_goals! > 0,
    answer_quality: "not_assessed",
    unknown_obligations: (criteria.required_unknowns ?? []).length,
  });
  const reciprocal = (keys: Set<string>) => {
    const index = seeds.findIndex((key) => keys.has(key));
    return index < 0 ? 0 : 1 / (index + 1);
  };
  if (result.target_goals && envelope.operation !== "codex")
    result.first_goal_support_reciprocal_rank = reciprocal(support);
  if (
    envelope.operation !== "codex" &&
    result.minimum_required_sections !== null &&
    config.selection === "sections"
  )
    Object.assign(result, {
      section_capacity_limit: config.top_k,
      goal_set_exceeds_capacity:
        result.minimum_required_sections! > config.top_k,
    });
  if (
    envelope.operation !== "codex" &&
    config.selection === "activity_expansion"
  ) {
    const goals = facts.map((fact) => ({
        evidence_alternatives: (fact.evidence_alternatives ?? []).map(
          (option) =>
            option.map((ref) => ({ source_id: ref.source_id, section_id: "" })),
        ),
      })),
      minimum = goalMetrics(goals, new Set()).minimum_required_sections;
    Object.assign(result, {
      minimum_required_activities: minimum,
      seed_activity_capacity_limit: config.top_k,
      goal_set_exceeds_capacity:
        minimum !== null && minimum! > config.top_k ? true : null,
    });
  }
  if (envelope.operation === "codex")
    Object.assign(result, {
      section_capacity_limit: null,
      goal_set_exceeds_capacity: null,
      per_search_section_capacity_limit: config.top_k,
    });
  const relevant = new Set((criteria.relevant_sections ?? []).map(key));
  if (criteria.relevance_labels_complete && relevant.size) {
    const overlap = [...offered].filter((key) => relevant.has(key)).length;
    result.source_recall = overlap / relevant.size;
    if (offered.size) result.source_precision = overlap / offered.size;
    if (envelope.operation !== "codex")
      result.first_relevant_reciprocal_rank = reciprocal(relevant);
  }
  if (calls.length) {
    const cumulative = new Set<string>();
    let firstComplete: number | null = null;
    calls.forEach((call, i) => {
      call.result?.hits?.forEach((hit) => cumulative.add(key(hit.section)));
      if (
        result.target_goals &&
        firstComplete === null &&
        goalMetrics(facts, cumulative).source_complete
      )
        firstComplete = i + 1;
    });
    result.search_calls = calls.length;
    result.first_complete_call = firstComplete;
  }
  return result;
}
function compactAssert(envelope: Envelope, variables: Variables): Grade {
  requireCondition(
    envelope.status === "completed" &&
      envelope.schema_version === 1 &&
      envelope.dataset_id === variables.dataset &&
      envelope.case_id === variables.case_id,
    "Compact replay does not belong to this completed test",
  );
  const criteria = loadCase(variables.dataset, variables.case_id);
  requireCondition(
    envelope.question === variables.question &&
      envelope.question === criteria.question,
    "Compact replay question differs from frozen input",
  );
  const record = envelope.record as CompactRecord;
  requireCondition(
    record.status === "completed" &&
      record.execution_mode === "offline_projection_replay" &&
      record.input_sha256 === variables.input_sha256,
    "Compact replay input provenance differs",
  );
  const full = record.full_response,
    compact = record.compact_response,
    fullText = record.full_response_json,
    compactText = record.compact_response_json;
  requireCondition(
    same(JSON.parse(fullText), full) && same(JSON.parse(compactText), compact),
    "Payload objects differ from measured UTF-8 text",
  );
  requireCondition(
    Buffer.byteLength(fullText) === record.full_payload_bytes &&
      Buffer.byteLength(compactText) === record.compact_payload_bytes,
    "Payload byte measurements differ from exact serialized text",
  );
  requireCondition(
    compact.schema_version === 2 &&
      compact.payload_mode === "compact" &&
      compact.trace?.full_response_sha256 === sha256(fullText),
    "Compact audit digest/schema differs",
  );
  for (const field of [
    "question",
    "top_k",
    "sources",
    "as_of",
    "manifest",
  ] as const)
    requireCondition(
      same(compact[field], full[field]),
      "Compact payload lost canonical metadata: " + field,
    );
  requireCondition(
    same(
      compact.hits,
      full.hits.map((hit) => ({ section: hit.section })),
    ),
    "Compact payload changed the offered source sections",
  );
  requireCondition(
    full.question === envelope.question &&
      full.top_k === variables.top_k &&
      full.as_of === criteria.as_of,
    "Full payload differs from selected input/configuration",
  );
  const canonical = canonicalSources(
    ["expanded-10-20261105", "strengthened-10-20261106"].includes(
      variables.dataset,
    ),
    variables.dataset === "demo-12-20261118",
  );
  for (const hit of full.hits)
    requireCondition(
      same(canonical.get(key(hit.section)), hit.section),
      "Replay source text/date is not canonical",
    );
  requireCondition(
    same(full.hits, full.outcome?.hits) && full.outcome.query === full.question,
    "Replay-visible sources differ from full trace",
  );
  validateLocal(
    {
      config: full.manifest.config,
      dataset: { corpus_sha256: criteria.corpus_sha256, as_of: criteria.as_of },
      outcome: full.outcome,
      preparation: full.preparation,
      request_filters: {
        weekdays: [],
        environment: null,
        time: null,
        ...variables.filters,
      },
    } as NativeRecord,
    variables,
    criteria,
    canonical,
  );
  const fullBytes = record.full_payload_bytes,
    compactBytes = record.compact_payload_bytes,
    reduction = 1 - compactBytes / fullBytes;
  const metrics: SourceMetrics = {
    execution_integrity: true,
    source_quality_applicable: false,
    source_complete: null,
    goal_coverage: null,
    target_goals: 0,
    covered_goals: null,
    answer_quality: "not_assessed",
    execution_mode: "offline_projection_replay",
    full_payload_bytes: fullBytes,
    compact_payload_bytes: compactBytes,
    payload_reduction: reduction,
    quality_comparison: "not_measured",
  };
  return {
    pass: compactBytes < fullBytes,
    score: Math.max(0, reduction),
    reason: `Exact source and metadata preservation; ${fullBytes} to ${compactBytes} UTF-8 payload bytes. No answer-quality, token, latency or cost comparison.`,
    namedScores: { execution_integrity: 1, payload_reduction: reduction },
    metadata: { source_metrics: metrics },
  };
}
export function getAssert(output: unknown, context: Context): Grade {
  let measurements: SourceMetrics;
  try {
    const envelope = (
      typeof output === "string" ? JSON.parse(output) : output
    ) as Envelope;
    if (envelope.operation === "compact")
      return compactAssert(envelope, context.vars);
    measurements = measure(envelope, context.vars);
  } catch (error) {
    return {
      pass: false,
      score: 0,
      reason:
        "Execution/source integrity failed: " +
        (error instanceof SyntaxError
          ? "Invalid JSON protocol output"
          : error instanceof Error
            ? error.message
            : "Invalid protocol output"),
      namedScores: { execution_integrity: 0 },
    };
  }
  const scores: Record<string, number> = { execution_integrity: 1 };
  for (const field of [
    "goal_coverage",
    "source_complete",
    "first_goal_support_reciprocal_rank",
    "source_recall",
    "source_precision",
    "first_relevant_reciprocal_rank",
  ])
    if (measurements[field] !== null && measurements[field] !== undefined)
      scores[field] = Number(measurements[field]);
  if (!measurements.source_quality_applicable)
    return {
      pass: true,
      score: 1,
      reason:
        "Execution integrity passed; source quality not applicable: no labelled positive target. Answer behavior is not assessed.",
      namedScores: scores,
      metadata: { source_metrics: measurements },
    };
  let reason = `${measurements.covered_goals}/${measurements.target_goals} source-evidence goals complete`;
  if (measurements.goal_set_exceeds_capacity)
    reason += "; required evidence exceeds this selection capacity";
  return {
    pass: Boolean(measurements.source_complete),
    score: measurements.goal_coverage!,
    reason,
    namedScores: scores,
    metadata: { source_metrics: measurements },
  };
}
export function getModelAssert(output: unknown, context: Context): Grade {
  let envelope: Envelope;
  try {
    envelope = (
      typeof output === "string" ? JSON.parse(output) : output
    ) as Envelope;
  } catch {
    return getAssert(output, context);
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.status === "completed"
  )
    return getAssert(output, context);
  try {
    const variables = context.vars;
    requireCondition(
      context.test?.metadata?.suite === "models",
      "Model failure classification requires the models suite",
    );
    requireCondition(
      envelope.schema_version === 1 &&
        envelope.operation === "codex" &&
        envelope.status === "failed",
      "Unknown failed model envelope",
    );
    const criteria = loadCase(variables.dataset, variables.case_id);
    requireCondition(
      envelope.dataset_id === variables.dataset &&
        envelope.case_id === variables.case_id &&
        envelope.question === variables.question &&
        variables.question === criteria.question,
      "Failed model input differs from frozen case",
    );
    const evidence = envelope.model_failure_evidence!,
      record = envelope.record as LiveRecord;
    requireCondition(
      typeof evidence.native_record_sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(evidence.native_record_sha256),
      "Missing native failure evidence digest",
    );
    requireCondition(
      evidence.requested_model === variables.model &&
        record.question === variables.question &&
        record.trace_integrity_status !== "invalid",
      "Failed model identity/trace differs",
    );
    const failure = classifyResult(
      { live: record } as NativeRecord,
      evidence.returncode,
    );
    requireCondition(
      ["model_output_invalid", "model_contract_violation"].includes(failure) &&
        failure === evidence.model_failure_class,
      "Native failure is not a verified model outcome",
    );
    const metrics: SourceMetrics = {
      execution_integrity: true,
      source_quality_applicable: false,
      model_failure_class: failure,
      source_complete: null,
      goal_coverage: null,
      covered_goals: null,
      target_goals: null,
      answer_quality: "not_assessed",
    };
    return {
      pass: false,
      score: 0,
      reason:
        "Verified model outcome: " + failure + "; source quality unassessed",
      namedScores: { execution_integrity: 1 },
      metadata: { source_metrics: metrics },
    };
  } catch {
    return getAssert(output, context);
  }
}
export default { getAssert, getModelAssert };
