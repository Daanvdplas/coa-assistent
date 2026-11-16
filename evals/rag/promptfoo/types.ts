export interface Reference {
  source_id: string;
  section_id: string;
  id?: string;
}
export interface Section {
  source_id: string;
  source_title: string;
  source_date: string;
  id: string;
  heading: string;
  text: string;
}
export interface Goal {
  id?: string;
  description?: string;
  evidence_alternatives?: Reference[][];
}
export interface Criteria {
  question: string;
  question_sha256: string;
  reference_sha256: string;
  corpus_sha256: string;
  as_of: string;
  facts?: Goal[];
  relevance_labels_complete?: boolean;
  relevant_sections?: Reference[];
  required_unknowns?: string[];
  required_source_ids?: string[];
  unknown_flags?: string[];
}
export interface Config {
  method: string;
  top_k: number;
  candidate_k: number;
  context_token_limit: number;
  selection: string;
  apply_filters: boolean;
  mmr: boolean;
  rrf_k: number;
  vector_weight: number;
  mmr_lambda: number;
}
export interface Settings extends Config {
  mode: string;
  profile: string;
  model: string;
  payload_mode?: string;
}
export interface Variables extends Settings {
  dataset: string;
  case_id: string;
  question: string;
  filters?: Filters;
  browser_eval_id?: string;
  embedding_model?: string;
  payload_mode?: string;
  replay_path?: string;
  input_sha256?: string;
  slot?: number;
  trial?: number;
  phase?: string;
}
export interface Filters {
  weekdays?: string[];
  environment?: string | null;
  time?: unknown;
}
export interface Scores {
  dense_similarity: number | null;
  bm25_score: number | null;
  dense_rank: number | null;
  keyword_rank: number | null;
  rank_score: number;
}
export interface Hit {
  section: Section;
  inclusion: string;
  scores: Scores | null;
}
export interface Candidate {
  key: Reference;
  scores: Scores;
}
export interface Embedding {
  provider: string;
  model: string;
  sdk: string;
  dimensions: number;
  encoding: string;
  document_prefix?: string;
  query_prefix?: string;
}
export interface CorpusIdentity {
  source_sha256: string;
  embedding_inputs_sha256: string;
  embedding: Embedding | null;
  vectors_sha256: string | null;
}
export interface Outcome {
  version: string;
  query: string;
  config: Config;
  corpus_identity: CorpusIdentity;
  candidates: Candidate[];
  work: { union_candidates: number };
  seeds: Reference[];
  hits: Hit[];
  omitted: { key: Reference; reason: string }[];
  token_estimator: string;
  estimated_context_tokens: number;
  filters: {
    requested: boolean;
    applied: boolean;
    matched_activity_ids: string[];
  };
}
export interface Preparation {
  corpus_identity: CorpusIdentity;
  actual_profile: string;
  layout: {
    canonical_sections: number;
    activity_records: number;
    activity_section_links: number;
  };
}
export interface NativeConfig {
  profile: string;
  retrieval: Config;
}
export interface AuditSummary {
  path?: string;
  session_id: string;
  sha256: string;
  trace_bytes: number;
  payload_bytes: number;
  successful_searches: number;
}
export interface Trace {
  session_id: string;
  call_index: number;
  request_id: string;
  trace_id: string;
  full_response_sha256: string;
}
export interface Source {
  id: string;
  title: string;
  date: string;
}
export interface SearchResponse {
  schema_version?: number;
  question: string;
  top_k: number;
  sources: Source[];
  as_of: string;
  manifest: { config: NativeConfig; corpus_identity: CorpusIdentity };
  outcome: Outcome;
  hits: Hit[];
  preparation: Preparation;
}
export interface CompactResponse
  extends Omit<SearchResponse, "hits" | "outcome" | "preparation"> {
  schema_version: number;
  payload_mode: string;
  hits: { section: Section }[];
  trace: Trace;
}
export interface ToolCall {
  server: string;
  tool: string;
  query: string;
  top_k: number;
  status: string;
  result: SearchResponse | CompactResponse | null;
}
export interface Run {
  id: string;
  status: string;
  question: string;
  answer: unknown;
  tool_calls: ToolCall[];
  sources: Source[];
  as_of: string;
  client_version: string;
  model: string;
  elapsed_ms: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number | null;
  };
  manifest: { corpus_identity: CorpusIdentity };
}
export interface Diagnostic {
  category?: string;
  stage?: string;
  exit_code?: number;
  json_event_lines_valid?: boolean;
  event_types?: string[];
  item_types?: string[];
  provider_error_code?: string | null;
  validation_reason?: string;
  tool_event_category?: string;
}
export interface RuntimeConfiguration {
  model: string;
  binaries: Record<string, string>;
  [field: string]: unknown;
}
export interface LiveRecord {
  schema_version: number;
  execution_kind?: string;
  run_id: string;
  question: string;
  config_id?: string;
  config: NativeConfig;
  filters: Filters;
  status: string;
  budget_id?: string;
  generation_session_index?: number;
  ai_judge_calls?: number;
  answer_quality_status?: string;
  source_guard_passed: boolean | null;
  elapsed_ms?: number;
  payload_mode: string;
  transport_treatment_id?: string;
  trace_integrity_status: string;
  audit_trace?: AuditSummary | null;
  source_audit_jsonl?: string;
  error?: string;
  safe_diagnostic?: Diagnostic;
  run: Run | null;
  runtime_configuration?: RuntimeConfiguration;
}
export interface NativeRecord {
  schema_version: number;
  run_id: string;
  case_id: string;
  question: string;
  family?: string;
  split?: string;
  kind?: string;
  dataset_id?: string;
  requested_model?: string;
  dataset: { corpus_sha256: string; as_of: string };
  config: NativeConfig;
  outcome: Outcome;
  preparation: Preparation;
  request_filters: Filters;
  status?: string;
  execution_status: string;
  execution_kind: string;
  live?: LiveRecord;
}
export interface GardenRecord {
  status: string;
  question?: string;
  query?: string;
  method: string;
  top_k: number;
  source_manifest: { corpus_sha256: string; as_of: string };
  hits: { section: Section }[];
}
export interface CompactRecord {
  schema_version: number;
  status: string;
  execution_mode: string;
  input_sha256: string;
  full_response: SearchResponse;
  compact_response: CompactResponse;
  full_response_json: string;
  compact_response_json: string;
  full_payload_bytes: number;
  compact_payload_bytes: number;
}
export interface Envelope {
  schema_version: number;
  operation: string;
  dataset_id: string;
  case_id: string;
  question: string;
  status: string;
  record: NativeRecord | LiveRecord | GardenRecord | CompactRecord;
  model_failure_evidence?: {
    returncode: number;
    requested_model: string;
    native_record_sha256: string;
    model_failure_class: string;
  };
}
export interface Context {
  vars: Variables;
  test?: { metadata?: { suite?: string } };
}
export interface SourceMetrics {
  target_goals: number | null;
  covered_goals: number | null;
  source_complete: boolean | null;
  goal_coverage: number | null;
  minimum_required_sections?: number | null;
  goals?: {
    id: string;
    description: string;
    covered: boolean;
    alternatives: { source_id: string; section_id: string; found: boolean }[][];
  }[];
  execution_integrity?: boolean;
  source_quality_applicable?: boolean;
  answer_quality?: string;
  [metric: string]: unknown;
}
export interface Grade {
  pass: boolean;
  score: number;
  reason: string;
  namedScores: Record<string, number>;
  metadata?: { source_metrics: SourceMetrics };
}
export interface ProviderResponse {
  output?: Envelope;
  error?: string;
  metadata?: Record<string, unknown>;
  tokenUsage?: {
    numRequests: number;
    prompt?: number;
    completion?: number;
    total?: number;
    cached?: number;
  };
  cached?: boolean;
}
export interface PreparedManifest {
  schema_version: number;
  execution_id: string;
  created_at?: number;
  execution_mode?: string;
  records: Record<
    string,
    { path: string; sha256: string; run_id?: string; case_id?: string }
  >;
  groups?: number;
  runtime_binary_sha256?: string;
  embedding_manifest?: { path: string; sha256: string };
}
export interface EmbeddingSpec {
  id: string;
  repository: string;
  sdk: string;
  dimensions: number;
  encoding: string;
  document_prefix: string;
  query_prefix: string;
}
export interface AuditRow extends Trace {
  schema_version: number;
  payload_mode: string;
  payload_bytes: number;
  full_response: SearchResponse;
}
