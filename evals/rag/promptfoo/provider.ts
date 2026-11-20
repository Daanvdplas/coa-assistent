/** Execution only: frozen questions go to Rust; no protected labels or cloud keys. */
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type {
  ApiProvider,
  CallApiContextParams,
  ProviderOptions,
  ProviderResponse as PromptfooResponse,
} from "promptfoo";
import {
  runCancellable,
  canonicalJson as originalJson,
  parseJson,
  isFloatField,
  markFloatField,
} from "../scripts/model_trials.ts";
import type { ProcessResult } from "../scripts/model_trials.ts";
import { checkedFile, readJson, sha256 } from "./json.ts";
import { reserve, finish } from "./ledger.ts";
import type { Reservation } from "./ledger.ts";
import { authorizeModel, finishModel } from "./model_control.ts";
import type { ModelToken } from "./model_control.ts";
import type {
  CompactRecord,
  Context,
  EmbeddingSpec,
  Envelope,
  GardenRecord,
  LiveRecord,
  NativeRecord,
  PreparedManifest,
  ProviderResponse,
  Settings,
  Variables,
  BrowserCaseBinding,
  BrowserPreset,
} from "./types.ts";
const browserCases = createRequire(import.meta.url)("./browser_cases.cjs") as {
  resolveBrowserCase(id: string): BrowserCaseBinding;
  resolveLegacyBrowserCase(id: string): BrowserCaseBinding;
  browserPreset(id?: BrowserPreset): Partial<Settings> & { embedding_model?: string };
};
export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const HERE = fileURLToPath(new URL(".", import.meta.url));
const METHODS = new Set(["dense", "bm25", "hybrid_rrf", "hybrid_weighted"]),
  PROFILES = new Set([
    "documents_sections",
    "documents_activities",
    "sqlite_sections",
    "sqlite_activities",
  ]),
  MODELS = new Set(["gpt-6.1-sol", "gpt-6-luna"]);
export const DEFAULTS: Settings = {
  mode: "local",
  method: "bm25",
  profile: "documents_sections",
  top_k: 3,
  candidate_k: 30,
  context_token_limit: 1200,
  selection: "sections",
  apply_filters: false,
  mmr: false,
  rrf_k: 60,
  vector_weight: 0.7,
  mmr_lambda: 0.7,
  model: "gpt-6.1-sol",
};
export type Executor = (
  command: string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
  cwd?: string,
) => Promise<ProcessResult>;
export function question(dataset: string, caseId: string): string {
  let paths: string[];
  if (dataset === "garden")
    paths = ["evals/rag/datasets/garden/questions.json"];
  else if (dataset === "legacy")
    paths = ["questions.json", "heldout-questions.json"].map(
      (name) => "evals/shared/datasets/legacy/" + name,
    );
  else if (
    [
      "independent-20261103",
      "expanded-10-20261105",
      "strengthened-10-20261106",
      "demo-12-20261118",
      "regression-12-20261118",
    ].includes(dataset)
  )
    paths = ["evals/shared/datasets/" + dataset + "/questions.json"];
  else throw new Error("Unknown input dataset");
  for (const path of paths) {
    const payload = readJson<
      | { id: string; question?: string; text?: string }[]
      | { cases: { id: string; question?: string; text?: string }[] }
    >(join(ROOT, path));
    const row = (Array.isArray(payload) ? payload : payload.cases).find(
      (row) => row.id === caseId,
    );
    if (row) return row.question ?? row.text!;
  }
  throw new Error("Unknown frozen input case");
}
export function childEnvironment(model?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "COA_OPENAI_API_KEY_FILE",
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "ORQ_API_KEY",
    "ORQ_API_KEY_FILE",
  ])
    delete env[key];
  if (model !== undefined) env.COA_CODEX_MODEL = model;
  return env;
}
function select<T extends object, K extends keyof T>(
  record: T,
  names: readonly K[],
): Pick<T, K> {
  return Object.fromEntries(
    names.filter((key) => key in record).map((key) => [key, record[key]]),
  ) as Pick<T, K>;
}
export function safeLive(
  record: NativeRecord | LiveRecord,
  artifactRoot?: string,
): LiveRecord {
  const live =
    "live" in record && record.live ? record.live : (record as LiveRecord);
  const clean = select(live, [
    "schema_version",
    "execution_kind",
    "run_id",
    "question",
    "config_id",
    "config",
    "filters",
    "status",
    "budget_id",
    "generation_session_index",
    "ai_judge_calls",
    "answer_quality_status",
    "source_guard_passed",
    "elapsed_ms",
    "payload_mode",
    "transport_treatment_id",
    "trace_integrity_status",
  ]) as LiveRecord;
  if (live.audit_trace) {
    const trace = live.audit_trace;
    clean.audit_trace = select(trace, [
      "session_id",
      "sha256",
      "trace_bytes",
      "payload_bytes",
      "successful_searches",
    ]);
    const path = checkedFile(
        trace.path!,
        artifactRoot ?? process.env.COA_PROMPTFOO_ARTIFACT_DIR!,
        16 * 1024 * 1024,
      ),
      raw = readFileSync(path);
    if (
      raw.length !== trace.trace_bytes ||
      sha256(raw) !== trace.sha256 ||
      raw.at(-1) !== 10
    )
      throw new Error("Native source audit bytes changed");
    const allowed = [
      "schema_version",
      "session_id",
      "call_index",
      "request_id",
      "trace_id",
      "payload_mode",
      "payload_bytes",
      "full_response_sha256",
      "full_response",
    ]
      .sort()
      .join(",");
    if (
      raw
        .toString()
        .slice(0, -1)
        .split("\n")
        .some(
          (line) =>
            Object.keys(JSON.parse(line) as object)
              .sort()
              .join(",") !== allowed,
        )
    )
      throw new Error("Unknown native source audit fields");
    clean.source_audit_jsonl = raw.toString();
  }
  if (live.error !== undefined && live.error !== null) clean.error = live.error;
  if (live.safe_diagnostic !== undefined && live.safe_diagnostic !== null)
    clean.safe_diagnostic = select(live.safe_diagnostic, [
      "category",
      "stage",
      "exit_code",
      "json_event_lines_valid",
      "event_types",
      "item_types",
      "provider_error_code",
      "validation_reason",
      "tool_event_category",
    ]);
  clean.run = live.run
    ? (select(live.run, [
        "id",
        "status",
        "question",
        "answer",
        "tool_calls",
        "sources",
        "as_of",
        "client_version",
        "model",
        "elapsed_ms",
        "usage",
      ]) as LiveRecord["run"])
    : null;
  return clean;
}
export function browserEmbeddingModel(
  variables: Partial<Variables>,
): string | undefined {
  const evalId = variables.browser_eval_id;
  if (evalId === undefined || evalId === null) {
    if ("embedding_model" in variables || "browser_preset" in variables)
      throw new Error("Embedding override requires the browser route");
    return undefined;
  }
  const selected =
    variables.dataset === "legacy"
      ? browserCases.resolveLegacyBrowserCase(evalId)
      : browserCases.resolveBrowserCase(evalId);
  if (
    selected.case_id !== variables.case_id ||
    selected.dataset !== variables.dataset ||
    (variables.mode ?? "local") !== "local" ||
    (variables.question !== undefined &&
      variables.question !== selected.question) ||
    (variables.corpus_sha256 !== undefined &&
      variables.corpus_sha256 !== selected.corpus_sha256)
  )
    throw new Error(
      "Browser question, dataset or corpus differs from frozen input",
    );
  if (variables.model !== undefined && !MODELS.has(variables.model))
    throw new Error("Unknown browser execution model");
  if (
    !readJson<EmbeddingSpec[]>(
      join(ROOT, "evals/rag/embedding-models.json"),
    ).some((row) => row.id === variables.embedding_model)
  )
    throw new Error("Unknown browser embedding model");
  if (variables.method !== undefined && !METHODS.has(variables.method))
    throw new Error("Unknown browser retrieval method");
  const preset = browserCases.browserPreset(variables.browser_preset);
  if (
    Object.entries(preset).some(
      ([key, expected]) =>
        variables[key as keyof Variables] !== undefined &&
        variables[key as keyof Variables] !== expected,
    ) ||
    (variables.filters && Object.keys(variables.filters).length)
  )
    throw new Error("Browser settings differ from the fixed preset");
  return variables.embedding_model;
}
export function requestKey(variables: Partial<Variables>): string {
  const selected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(DEFAULTS))
    selected[key] =
      key in variables ? variables[key as keyof Variables] : value;
  for (const key of ["dataset", "case_id", "question"] as const) {
    if (!(key in variables)) throw new Error("Missing frozen request input");
    selected[key] = variables[key];
  }
  selected.filters = variables.filters ?? {};
  const embedding = browserEmbeddingModel(variables);
  if (embedding)
    Object.assign(selected, {
      browser_eval_id: variables.browser_eval_id,
      embedding_model: embedding,
      ...(variables.browser_preset ? { browser_preset: variables.browser_preset } : {}),
    });
  // Python's default rrf_k is a float, whereas the frozen JS case matrix sends
  // an integer 60. Preserve that distinction without changing case identities.
  for (const key of Object.keys(selected))
    if (isFloatField(variables, key)) markFloatField(selected, key);
  if (!("rrf_k" in variables)) markFloatField(selected, "rrf_k");
  return sha256(originalJson(selected));
}
export function commonArguments(settings: Settings): string[] {
  return [
    "--methods",
    settings.method,
    "--profiles",
    settings.profile,
    "--top-k",
    String(settings.top_k),
    "--candidate-k",
    String(settings.candidate_k),
    "--context-limit",
    String(settings.context_token_limit),
    "--selection",
    settings.selection,
    "--apply-filters",
    settings.apply_filters ? "on" : "off",
    "--mmr",
    settings.mmr ? "on" : "off",
    "--rrf-k",
    String(settings.rrf_k),
    "--vector-weight",
    String(settings.vector_weight),
    "--mmr-lambda",
    String(settings.mmr_lambda),
  ];
}
function preparedRecord(variables: Variables): NativeRecord {
  const manifest = readJson<PreparedManifest>(
    process.env.COA_PROMPTFOO_PREPARED!,
  );
  if (
    manifest.schema_version !== 1 ||
    !process.env.COA_PROMPTFOO_EXECUTION_ID ||
    manifest.execution_id !== process.env.COA_PROMPTFOO_EXECUTION_ID
  )
    throw new Error("Prepared retrieval belongs to a different execution");
  const row = manifest.records[requestKey(variables)],
    path = checkedFile(
      row.path,
      process.env.COA_PROMPTFOO_ARTIFACT_DIR!,
      2 * 1024 * 1024,
    ),
    raw = readFileSync(path);
  if (sha256(raw) !== row.sha256)
    throw new Error("Prepared retrieval record changed");
  return parseJson<NativeRecord>(raw.toString());
}
export function responseFor(
  raw: NativeRecord | LiveRecord | GardenRecord | CompactRecord,
  variables: Variables,
  settings: Settings,
  operation: string,
  executionMode: string,
): ProviderResponse {
  const record =
    operation === "codex" ? safeLive(raw as NativeRecord | LiveRecord) : raw;
  const status =
    "status" in record && record.status
      ? record.status
      : "execution_status" in record
        ? record.execution_status
        : "unknown";
  if (status !== "completed")
    return {
      error: "Native execution status: " + String(status),
      metadata: {
        case_id: variables.case_id,
        dataset: variables.dataset,
        mode: settings.mode,
        status,
        native_run_id: "run_id" in record ? record.run_id : undefined,
      },
    };
  const envelope: Envelope = {
    schema_version: 1,
    operation,
    dataset_id: variables.dataset,
    case_id: variables.case_id,
    question: variables.question,
    status,
    record,
  };
  const runId = "run_id" in record ? record.run_id : undefined,
    metadata = {
      run_id: runId ?? operation + "-" + randomUUID().replaceAll("-", ""),
      case_id: variables.case_id,
      dataset: variables.dataset,
      method: settings.method,
      profile: settings.profile,
      mode: settings.mode,
      model: operation === "codex" ? settings.model : null,
      answer_quality: "not_assessed",
      execution_mode: executionMode,
    };
  const tokenUsage: NonNullable<ProviderResponse["tokenUsage"]> = {
      numRequests: operation === "codex" ? 1 : 0,
    },
    usage =
      operation === "codex" ? (record as LiveRecord).run?.usage : undefined;
  if (usage) {
    Object.assign(tokenUsage, {
      prompt: usage.input_tokens,
      completion: usage.output_tokens,
      total: usage.input_tokens + usage.output_tokens,
    });
    if (
      usage.cached_input_tokens !== null &&
      usage.cached_input_tokens !== undefined
    )
      tokenUsage.cached = usage.cached_input_tokens;
  }
  return { output: envelope, metadata, tokenUsage, cached: false };
}
export async function callApi(
  _prompt: string,
  options: { config?: Partial<Settings> },
  context: Context,
  execute: Executor = runCancellable,
): Promise<ProviderResponse> {
  let reservation: Reservation | undefined,
    modelToken: ModelToken | undefined,
    output: string | null = null;
  try {
    const variables = context.vars ?? ({} as Variables),
      overrides = Object.fromEntries(
        Object.keys(DEFAULTS)
          .filter((key) => key in variables)
          .map((key) => [key, variables[key as keyof Variables]]),
      );
    const settings = {
      ...DEFAULTS,
      ...options.config,
      ...overrides,
    } as Settings;
    const { dataset, case_id: caseId, question: input } = variables,
      embedding = browserEmbeddingModel({ ...settings, ...variables }),
      { mode, method, profile } = settings;
    if (input !== question(dataset, caseId))
      throw new Error("Question differs from frozen input");
    if (embedding && mode !== "local")
      throw new Error("Browser search cannot start model generations");
    if (!["local", "codex", "garden", "compact", "compact-live"].includes(mode))
      throw new Error("Unknown execution mode");
    if (
      !PROFILES.has(profile) ||
      (!METHODS.has(method) &&
        !(mode === "garden" && method === "keyword_overlap"))
    )
      throw new Error("Unsupported method/profile");
    if (!MODELS.has(settings.model)) throw new Error("Unknown Codex model");
    if (
      !Number.isInteger(settings.top_k) ||
      settings.top_k < 1 ||
      settings.top_k > 6
    )
      throw new Error("Invalid top-k");
    if (context.test?.metadata?.suite === "models") {
      if (mode !== "codex")
        throw new Error("Models require the canonical Codex execution mode");
      if (process.env.COA_PROMPTFOO_ALLOW_CODEX !== "1")
        throw new Error(
          "Models require explicit Codex opt-in before protocol reservation",
        );
      modelToken = await authorizeModel({ ...variables, ...settings });
    }
    if (mode === "codex" || mode === "compact-live")
      reservation = await reserve(dataset, caseId, settings.model);
    if (mode === "local" && process.env.COA_PROMPTFOO_PREPARED)
      return responseFor(
        preparedRecord(variables),
        variables,
        settings,
        "retrieve",
        "fresh_batch_retrieval",
      );
    const binary = realpathSync(
      process.env.COA_RAG_BINARY ??
        join(ROOT, "target/debug/meedoen-retrieval"),
    );
    if (!statSync(binary).isFile())
      throw new Error("COA_RAG_BINARY must be executable");
    accessSync(binary, constants.X_OK);
    const base = resolve(
      process.env.COA_PROMPTFOO_ARTIFACT_DIR ?? join(tmpdir(), "coa-promptfoo"),
    );
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(base, "case-"));
    output = join(directory, "native.jsonl");
    const cache = resolve(
        process.env.COA_RAG_MODEL_CACHE ?? join(ROOT, ".model-cache"),
      ),
      command = [binary, "lab"],
      common = commonArguments(settings);
    let cwd = ROOT;
    if (mode === "compact") {
      const relative = variables.replay_path!,
        source = checkedFile(
          join(ROOT, relative),
          join(ROOT, "evals/rag/fixtures"),
          16 * 1024 * 1024,
        ),
        pins = readJson<{ files: Record<string, string> }>(
          join(HERE, "data-pins.json"),
        ).files;
      if (
        pins[relative] !== sha256(readFileSync(source)) ||
        variables.input_sha256 !== pins[relative]
      )
        throw new Error(
          "Replay input changed or is outside canonical fixtures",
        );
      command.push("compact-project", "--input", source);
    } else if (mode === "garden") {
      command.push(
        "garden-search",
        "--question",
        input,
        "--method",
        method,
        "--top-k",
        String(settings.top_k),
      );
      cwd = dirname(cache);
    } else if (mode === "local") {
      command.push(
        "run",
        "--dataset",
        dataset,
        "--cases",
        caseId,
        ...common,
        "--output",
        output,
        "--model-cache",
        cache,
        "--sqlite-dir",
        join(base, "retrieval-cache"),
      );
      if (embedding) command.push("--embedding-model", embedding);
      if (
        dataset !== "independent-20261103" &&
        settings.apply_filters &&
        Object.keys(variables.filters ?? {}).length
      )
        command.push("--query-filters", JSON.stringify(variables.filters));
    } else {
      const { path, maximum, seconds } = reservation!,
        nativeKey = sha256(
          dataset +
            settings.model +
            mode +
            (settings.payload_mode ?? "compact"),
        ).slice(0, 16),
        nativeLedger = join(
          dirname(path),
          basename(path).replace(/\.[^/.]+$/, "") +
            "-native-" +
            nativeKey +
            ".json",
        );
      if (mode === "compact-live")
        command.push(
          "ask",
          "--live",
          "--question",
          input,
          ...common,
          "--payload-mode",
          variables.payload_mode ?? "compact",
        );
      else {
        command.push(
          "agent-run",
          "--live",
          "--cases",
          caseId,
          "--methods",
          method,
        );
        if (
          ["expanded-10-20261105", "strengthened-10-20261106", "demo-12-20261118"].includes(dataset)
        )
          command.push("--dataset", dataset);
      }
      command.push(
        "--output",
        output,
        "--ledger",
        nativeLedger,
        "--model-cache",
        cache,
        "--max-generations",
        String(maximum),
        "--max-seconds",
        String(seconds),
      );
    }
    let timeout = 150;
    if (reservation) {
      timeout = Math.min(timeout, reservation.deadline - Date.now() / 1000 - 5);
      if (timeout <= 0)
        throw new Error(
          "No shared time remains for a safely bounded Codex call",
        );
    }
    const env = childEnvironment(reservation ? settings.model : undefined);
    if (modelToken?.codex_binary) env.COA_CODEX_BIN = modelToken.codex_binary;
    const result = await execute(command, env, timeout, cwd);
    if (result.returncode !== 0 && !modelToken)
      throw new Error(
        "Native runtime failed; private process output was not exported",
      );
    const raw = parseJson<NativeRecord>(
        mode === "garden" || mode === "compact"
          ? result.stdout.toString()
          : readFileSync(output, "utf8").trim(),
      ),
      operation =
        mode === "compact"
          ? "compact"
          : mode === "garden"
            ? "garden"
            : reservation
              ? "codex"
              : "retrieve";
    if (modelToken) {
      safeLive(raw);
      const verdict = await finishModel(
        modelToken,
        raw,
        result.returncode,
        output,
      );
      modelToken = undefined;
      if (
        ["model_output_invalid", "model_contract_violation"].includes(
          verdict.status,
        )
      ) {
        const failure = verdict.status,
          record = safeLive(raw),
          envelope: Envelope = {
            schema_version: 1,
            operation: "codex",
            dataset_id: dataset,
            case_id: caseId,
            question: input,
            status: "failed",
            record,
            model_failure_evidence: {
              returncode: result.returncode,
              requested_model: raw.requested_model!,
              native_record_sha256: sha256(readFileSync(output)),
              model_failure_class: failure,
            },
          };
        await finish(reservation!.path, reservation!.id, failure);
        reservation = undefined;
        return {
          output: envelope,
          metadata: {
            run_id: record.run_id,
            case_id: caseId,
            dataset,
            method,
            profile,
            mode,
            model: settings.model,
            model_failure_class: failure,
            execution_mode: "fresh_runtime_execution",
          },
          tokenUsage: { numRequests: 1 },
          cached: false,
        };
      }
      if (verdict.status !== "completed")
        throw new Error("Model protocol could not verify the native execution");
    }
    if (result.returncode !== 0)
      throw new Error(
        "Native runtime failed; private process output was not exported",
      );
    const response = responseFor(
      raw,
      variables,
      settings,
      operation,
      mode === "compact"
        ? "offline_projection_replay"
        : "fresh_runtime_execution",
    );
    if (reservation) {
      await finish(reservation.path, reservation.id, !response.error);
      reservation = undefined;
    }
    return response;
  } catch {
    if (modelToken) {
      try {
        await finishModel(modelToken, null, -1, output);
      } catch {}
    }
    if (reservation) {
      try {
        await finish(reservation.path, reservation.id, false);
      } catch {}
    }
    return {
      error:
        "COA runtime/configuration failed; no retry or private process output was exported",
    };
  }
}
/** Promptfoo 0.125.1 constructs this class and calls (prompt,context,options). */
export default class CoaProvider implements ApiProvider {
  private readonly options: ProviderOptions<Partial<Settings>>;
  constructor(options: ProviderOptions<Partial<Settings>> = {}) {
    this.options = options;
  }
  id(): string {
    return this.options.id ?? "coa-rag-runtime";
  }
  async callApi(
    prompt: string,
    context?: CallApiContextParams,
  ): Promise<PromptfooResponse> {
    return callApi(
      prompt,
      this.options,
      context as unknown as Context,
    ) as Promise<PromptfooResponse>;
  }
}
