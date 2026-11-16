/** Keep the frozen sixty-session Codex protocol around Promptfoo execution. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as legacy from "../scripts/model_trials.ts";
import { checkedFile, readJson, same } from "./json.ts";
import { lockedTransaction } from "./ledger.ts";
import type {
  CorpusIdentity,
  NativeRecord,
  RuntimeConfiguration,
  Variables,
} from "./types.ts";
export const DATASET = "strengthened-10-20261106";
const HERE = fileURLToPath(new URL(".", import.meta.url)),
  ROOT = resolve(HERE, "../../..");
export const DATA = join(ROOT, "evals/shared/datasets", DATASET);
export interface ModelToken {
  smoke: boolean;
  case_id: string;
  model: string;
  state_path?: string;
  prereg_path?: string;
  lock_path?: string;
  slot?: number;
  codex_binary?: string;
}
interface Attempt extends legacy.Attempt {
  finished_at?: number;
  audit_path?: string;
  audit_sha256?: string;
}
interface ModelState {
  preregistration_sha256: string;
  started_at: number | null;
  attempts: Attempt[];
  stopped: boolean;
  common_runtime_configuration?: Omit<RuntimeConfiguration, "model">;
  retrieval_corpus_identity?: CorpusIdentity;
}
interface Prereg {
  schema_version: number;
  protocol: string;
  dataset: string;
  codex_binary: string;
  runtime_binaries: Record<string, string>;
  schedule: legacy.Row[];
  max_attempts: number;
  max_seconds: number;
  pins: Record<string, string>;
}
interface Approval {
  reviewer?: string;
  approved?: boolean;
  preregistration_sha256?: string;
  pilot_attempts_sha256?: string;
}
export function caseIds(): string[] {
  return readJson<{ cases: { id: string }[] }>(
    join(DATA, "questions.json"),
  ).cases.map((row) => row.id);
}
export function orderedSchedule() {
  return legacy
    .schedule(caseIds())
    .map((row) => ({ ...row, phase: row.slot <= 4 ? "pilot" : "remaining" }));
}
export function requireApproval(
  approval: Approval,
  preregHash: string,
  attempts: { status: string }[],
): void {
  if (typeof approval.reviewer !== "string" || !approval.reviewer.trim())
    throw new Error("Independent reviewer identity is required");
  legacy.validatePilotApproval(approval, preregHash, attempts);
}
export function classifyResult(
  record: NativeRecord | null,
  returncode: number,
): string {
  if (!record || !record.live || typeof record.live !== "object")
    return "failed";
  const live = record.live;
  if (
    returncode === 0 &&
    live.status === "completed" &&
    live.source_guard_passed === true &&
    live.trace_integrity_status === "validated" &&
    live.run?.status === "completed"
  )
    return "completed";
  try {
    if (legacy.verifiedModelFailure({ live }, returncode)) return live.error!;
  } catch {}
  return "failed";
}
function paths(): [string, string, string] {
  const ledger = resolve(process.env.COA_PROMPTFOO_LEDGER!),
    stem = ledger.replace(/\.[^/.]+$/, "");
  return [
    stem + ".models-prereg.json",
    stem + ".models-state.json",
    stem + ".models.lock",
  ];
}
function codexBinaries(): [string, string] {
  let codex = process.env.COA_CODEX_BIN;
  if (!codex) {
    const releases = join(
      process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      "packages/app-server-daemon/releases",
    );
    const candidates = existsSync(releases)
      ? readdirSync(releases)
          .map((name) => join(releases, name, "bin", "codex"))
          .filter(
            (path) =>
              existsSync(path) &&
              existsSync(join(dirname(path), "codex-code-mode-host")),
          )
      : [];
    codex = candidates.sort(
      (a, b) =>
        statSync(dirname(dirname(b))).mtimeMs -
        statSync(dirname(dirname(a))).mtimeMs,
    )[0];
    if (!codex)
      codex = (process.env.PATH ?? "")
        .split(":")
        .map((directory) => join(directory, "codex"))
        .find((path) => existsSync(path) && statSync(path).isFile());
  }
  if (!codex) throw new Error("Codex binary is unavailable");
  codex = realpathSync(codex);
  return [codex, realpathSync(join(dirname(codex), "codex-code-mode-host"))];
}
function pinFiles(): Record<string, string> {
  const [codex, host] = codexBinaries(),
    files = [
      codex,
      host,
      realpathSync(process.env.COA_RAG_BINARY!),
      ...[
        "model_control.ts",
        "provider.ts",
        "assertions.ts",
        "ledger.ts",
        "json.ts",
        "types.ts",
        "cases.cjs",
        "data-pins.json",
      ].map((name) => join(HERE, name)),
      join(ROOT, "evals/rag/scripts/model_trials.ts"),
      join(DATA, "FROZEN.json"),
      join(DATA, "questions.json"),
    ];
  files.push(
    ...readJson<{ integrity: { sources: { path: string }[] } }>(
      join(DATA, "FROZEN.json"),
    ).integrity.sources.map((row) => join(ROOT, row.path)),
  );
  return Object.fromEntries(files.map((path) => [path, legacy.fileHash(path)]));
}
function loadChecked(
  preregPath: string,
  statePath: string,
): [Prereg, ModelState] {
  const prereg = legacy.load<Prereg>(preregPath),
    state = legacy.load<ModelState>(statePath);
  if (
    state.preregistration_sha256 !== legacy.fileHash(preregPath) ||
    !same(prereg.schedule, legacy.schedule(caseIds()))
  )
    throw new Error("Model preregistration or schedule changed");
  for (const [name, digest] of Object.entries(prereg.pins))
    if (legacy.fileHash(name) !== digest)
      throw new Error("Pinned model protocol input/runtime changed");
  for (const attempt of state.attempts)
    if (["completed", ...legacy.MODEL_FAILURES].includes(attempt.status)) {
      if (legacy.fileHash(attempt.record_path!) !== attempt.record_sha256)
        throw new Error("Previously saved native evidence changed");
      if (
        attempt.audit_path &&
        legacy.fileHash(attempt.audit_path) !== attempt.audit_sha256
      )
        throw new Error("Previously saved audit evidence changed");
    }
  return [prereg, state];
}
function validateModelInput(
  variables: Partial<Variables>,
): "pilot" | "remaining" | "smoke" {
  const phase = process.env.COA_PROMPTFOO_PHASE;
  if (phase !== "pilot" && phase !== "remaining" && phase !== "smoke")
    throw new Error(
      "Models require an explicit pilot, remaining or smoke phase",
    );
  if (
    (variables.dataset ?? DATASET) !== DATASET ||
    !caseIds().includes(variables.case_id!) ||
    !legacy.MODELS.includes(variables.model as (typeof legacy.MODELS)[number])
  )
    throw new Error("Model protocol requires the canonical dataset/case/model");
  const defaults = {
    payload_mode: "compact",
    method: "dense",
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
  };
  if (
    Object.entries(defaults).some(
      ([key, value]) =>
        !same(
          key in variables ? variables[key as keyof Variables] : value,
          value,
        ),
    ) ||
    Object.keys(variables.filters ?? {}).length
  )
    throw new Error(
      "Model comparison treatment differs from its fixed dense protocol",
    );
  return phase;
}
export async function authorizeModel(
  variables: Partial<Variables>,
): Promise<ModelToken> {
  const phase = validateModelInput(variables),
    maximum = Number(process.env.COA_PROMPTFOO_MAX_GENERATIONS),
    seconds = Number(process.env.COA_PROMPTFOO_MAX_SECONDS);
  if (phase === "smoke") {
    const selected = (process.env.COA_PROMPTFOO_CASES ?? "").split(",");
    if (
      !selected.length ||
      !selected.every((value) => caseIds().includes(value)) ||
      !selected.includes(variables.case_id!) ||
      process.env.COA_PROMPTFOO_REPEATS !== "1" ||
      !Number.isInteger(maximum) ||
      maximum < 1 ||
      maximum > 8 ||
      !Number.isInteger(seconds) ||
      seconds < 1 ||
      seconds > 900
    )
      throw new Error(
        "Smoke requires selected canonical cases, repeat1 and at most8 sessions/900seconds",
      );
    return {
      smoke: true,
      case_id: variables.case_id!,
      model: variables.model!,
    };
  }
  if (
    !Number.isInteger(maximum) ||
    maximum < 4 ||
    maximum > 60 ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 7200
  )
    throw new Error(
      "The sixty-session protocol allows at most60 attempts and7200seconds",
    );
  const [, , lockPath] = paths();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  return lockedTransaction(
    lockPath,
    fileURLToPath(import.meta.url),
    "authorize",
    { variables },
    true,
  );
}
function authorizeUnlocked(variables: Partial<Variables>): ModelToken {
  const phase = validateModelInput(variables),
    maximum = Number(process.env.COA_PROMPTFOO_MAX_GENERATIONS),
    seconds = Number(process.env.COA_PROMPTFOO_MAX_SECONDS),
    [preregPath, statePath, lockPath] = paths();
  if (!existsSync(preregPath)) {
    if (phase !== "pilot" || existsSync(statePath))
      throw new Error("Start a new comparison with its pilot");
    const ledger = resolve(process.env.COA_PROMPTFOO_LEDGER!);
    if (
      existsSync(ledger) &&
      legacy.load<{ attempts: unknown[] }>(ledger).attempts?.length
    )
      throw new Error("A new model protocol requires an unused global ledger");
    const [codex, host] = codexBinaries();
    const prereg: Prereg = {
      codex_binary: codex,
      runtime_binaries: {
        codex: legacy.fileHash(codex),
        code_mode_host: legacy.fileHash(host),
        mcp: legacy.fileHash(realpathSync(process.env.COA_RAG_BINARY!)),
      },
      schema_version: 1,
      protocol: "promptfoo-model-trials-v1",
      dataset: DATASET,
      schedule: legacy.schedule(caseIds()),
      max_attempts: maximum,
      max_seconds: seconds,
      pins: pinFiles(),
    };
    legacy.writeNew(preregPath, prereg);
    legacy.writeNew(statePath, {
      preregistration_sha256: legacy.fileHash(preregPath),
      started_at: null,
      attempts: [],
      stopped: false,
    });
  }
  const [prereg, state] = loadChecked(preregPath, statePath);
  if (prereg.max_attempts !== maximum || prereg.max_seconds !== seconds)
    throw new Error("Existing model limits cannot change");
  if (phase === "remaining")
    requireApproval(
      legacy.load<Approval>(
        process.env.COA_PROMPTFOO_APPROVAL ??
          join(dirname(statePath), "PILOT_APPROVED.json"),
      ),
      state.preregistration_sha256,
      state.attempts,
    );
  else if (state.attempts.length >= 4)
    throw new Error(
      "Pilot ends after four attempts; independent hash-bound approval is required",
    );
  if (
    state.stopped ||
    state.attempts.some(
      (row) => !["completed", ...legacy.MODEL_FAILURES].includes(row.status),
    )
  )
    throw new Error(
      "Uncertain, reserved or failed model attempt exists; stopped without retry",
    );
  const index = state.attempts.length;
  if (index >= maximum) throw new Error("Model attempt budget exhausted");
  const expected = prereg.schedule[index];
  if (
    ["case_id", "model", "slot", "trial"].some(
      (key) =>
        variables[key as keyof Variables] !== expected[key as keyof legacy.Row],
    )
  )
    throw new Error(
      "Model slot/order differs from the preregistered interleaving",
    );
  if (
    state.started_at !== null &&
    Date.now() / 1000 - state.started_at >= seconds
  )
    throw new Error("Model protocol time budget exhausted");
  const attempt = legacy.reserve(state, prereg.schedule, Date.now() / 1000);
  legacy.saveState(statePath, state);
  return {
    smoke: false,
    state_path: statePath,
    prereg_path: preregPath,
    lock_path: lockPath,
    slot: attempt.slot,
    case_id: expected.case_id,
    model: expected.model,
    codex_binary: prereg.codex_binary,
  };
}
export function boundNative(
  token: ModelToken,
  record: NativeRecord | null,
  nativePath: string | null,
  status: string,
): [string, string | null] | null {
  if (status === "failed") return null;
  if (!record || !nativePath || !record.live)
    throw new Error("Native record is missing");
  const live = record.live,
    path = realpathSync(nativePath);
  if (live.trace_integrity_status === "invalid")
    throw new Error("Invalid native trace is never a model outcome");
  if (
    record.dataset_id !== DATASET ||
    record.case_id !== token.case_id ||
    record.requested_model !== token.model
  )
    throw new Error(
      "Native model execution identity differs from its reserved slot",
    );
  const question = readJson<{ cases: { id: string; question: string }[] }>(
    join(DATA, "questions.json"),
  ).cases.find((row) => row.id === token.case_id)!.question;
  if (
    live.question !== question ||
    (live.run && live.run.model !== token.model)
  )
    throw new Error("Native model input/model changed");
  const expected = readJson<{
    integrity: {
      corpus_sha256: string;
      sources: { id: string; date: string }[];
    };
  }>(join(DATA, "FROZEN.json")).integrity;
  if (record.dataset?.corpus_sha256 !== expected.corpus_sha256)
    throw new Error("Native model corpus changed");
  const trace = live.audit_trace;
  if (!trace?.path) {
    if (
      status === "model_contract_violation" &&
      ["missing_required_search", "outside_contract_tool"].includes(
        live.safe_diagnostic?.validation_reason ?? "",
      ) &&
      live.trace_integrity_status !== "invalid"
    )
      return [path, null];
    throw new Error("Native source audit is missing");
  }
  const audit = checkedFile(trace.path, dirname(path), 16 * 1024 * 1024);
  if (legacy.fileHash(audit) !== trace.sha256)
    throw new Error(
      "Native audit bytes changed or escaped its execution directory",
    );
  const lines = readFileSync(audit, "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          full_response: { sources: { id: string; date: string }[] };
        },
    );
  if (status === "model_output_invalid" && !lines.length)
    throw new Error("Invalid output lacks its required search evidence");
  const catalogue = expected.sources.map((row) => [row.id, row.date]);
  if (
    lines.some(
      (entry) =>
        !same(
          entry.full_response.sources.map((row) => [row.id, row.date]),
          catalogue,
        ),
    )
  )
    throw new Error("Failed model source catalogue changed");
  return [path, audit];
}
export function bindCommon(
  state: {
    common_runtime_configuration?: Omit<RuntimeConfiguration, "model">;
    retrieval_corpus_identity?: CorpusIdentity;
  },
  record: NativeRecord,
  prereg: { runtime_binaries: Record<string, string> },
  audit: string | null,
): void {
  const runtime = record.live?.runtime_configuration;
  if (
    !runtime ||
    typeof runtime !== "object" ||
    runtime.model !== record.requested_model ||
    !same(runtime.binaries, prereg.runtime_binaries)
  )
    throw new Error("Shared Codex/host/MCP runtime binding changed");
  const { model, ...common } = runtime;
  if (
    state.common_runtime_configuration &&
    !same(state.common_runtime_configuration, common)
  )
    throw new Error("Runtime treatment differs across models");
  const identities: CorpusIdentity[] = [],
    run = record.live?.run;
  if (run) identities.push(run.manifest.corpus_identity);
  if (audit)
    for (const line of readFileSync(audit, "utf8")
      .trimEnd()
      .split("\n")
      .filter(Boolean))
      identities.push(
        (
          JSON.parse(line) as {
            full_response: { manifest: { corpus_identity: CorpusIdentity } };
          }
        ).full_response.manifest.corpus_identity,
      );
  for (const identity of identities) {
    if (
      state.retrieval_corpus_identity &&
      !same(state.retrieval_corpus_identity, identity)
    )
      throw new Error("Shared corpus/embedding/vector identity changed");
    state.retrieval_corpus_identity = identity;
  }
  state.common_runtime_configuration = common;
}
export function executionSchedule(): ReturnType<typeof orderedSchedule> {
  const rows = orderedSchedule(),
    phase = process.env.COA_PROMPTFOO_PHASE;
  if (phase !== "pilot" && phase !== "remaining") return rows;
  const [preregPath, statePath] = paths();
  if (!existsSync(preregPath)) {
    if (phase === "remaining" || existsSync(statePath))
      throw new Error("Remaining requires the completed original pilot");
    return rows.slice(0, 4);
  }
  const [, state] = loadChecked(preregPath, statePath);
  if (
    state.stopped ||
    state.attempts.some(
      (row) => !["completed", ...legacy.MODEL_FAILURES].includes(row.status),
    )
  )
    throw new Error(
      "Uncertain or reserved model attempt exists; never resume automatically",
    );
  if (phase === "remaining")
    requireApproval(
      legacy.load<Approval>(
        process.env.COA_PROMPTFOO_APPROVAL ??
          join(dirname(statePath), "PILOT_APPROVED.json"),
      ),
      state.preregistration_sha256,
      state.attempts,
    );
  return phase === "pilot"
    ? rows.slice(state.attempts.length, 4)
    : rows.slice(state.attempts.length);
}
export async function finishModel(
  token: ModelToken,
  record: NativeRecord | null,
  returncode: number,
  nativePath: string | null,
): Promise<{ status: string; model_failure_class?: string }> {
  if (token.smoke) return finishUnlocked(token, record, returncode, nativePath);
  return lockedTransaction(
    token.lock_path!,
    fileURLToPath(import.meta.url),
    "finish",
    { token, record, returncode, nativePath },
    true,
  );
}
function finishUnlocked(
  token: ModelToken,
  record: NativeRecord | null,
  returncode: number,
  nativePath: string | null,
) {
  let status = classifyResult(record, returncode),
    bound: [string, string | null] | null;
  try {
    bound = boundNative(token, record, nativePath, status);
  } catch {
    status = "failed";
    bound = null;
  }
  let result: { status: string; model_failure_class?: string } = { status };
  if (legacy.MODEL_FAILURES.includes(status))
    result.model_failure_class = status;
  if (token.smoke) return result;
  const [prereg, state] = loadChecked(token.prereg_path!, token.state_path!),
    attempt = state.attempts.at(-1)!;
  if (attempt.slot !== token.slot || attempt.status !== "reserved")
    throw new Error("Reserved model attempt changed");
  if (bound) {
    const [path, audit] = bound;
    try {
      bindCommon(state, record!, prereg, audit);
    } catch {
      status = "failed";
      result = { status: "failed" };
    }
    Object.assign(attempt, {
      record_path: path,
      record_sha256: legacy.fileHash(path),
    });
    if (audit)
      Object.assign(attempt, {
        audit_path: audit,
        audit_sha256: legacy.fileHash(audit),
      });
  }
  Object.assign(attempt, { status, finished_at: Date.now() / 1000 });
  if (status === "failed") state.stopped = true;
  legacy.saveState(token.state_path!, state);
  return result;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "schedule")
    process.stdout.write(JSON.stringify(executionSchedule()));
  else {
    try {
      if (process.argv[3] !== "--payload-file")
        throw new Error("Expected private transaction input");
      const payload = JSON.parse(readFileSync(process.argv[4], "utf8")) as {
        variables: Partial<Variables>;
        token: ModelToken;
        record: NativeRecord | null;
        returncode: number;
        nativePath: string | null;
      };
      const value =
        process.argv[2] === "authorize"
          ? authorizeUnlocked(payload.variables)
          : process.argv[2] === "finish"
            ? finishUnlocked(
                payload.token,
                payload.record,
                payload.returncode,
                payload.nativePath,
              )
            : (() => {
                throw new Error("Unknown model protocol transaction");
              })();
      process.stdout.write(JSON.stringify({ value }));
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          error:
            error instanceof SyntaxError
              ? "Invalid model protocol JSON"
              : error instanceof Error
                ? error.message
                : "Model protocol failed",
        }),
      );
    }
  }
}
