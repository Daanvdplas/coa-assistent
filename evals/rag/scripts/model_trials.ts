/** Historical model-trial readers. New model execution belongs to promptfoo. */
import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { floatText } from "../promptfoo/json.ts";
export const DATASET = "strengthened-10-20261106";
export const MODELS = ["gpt-6.1-sol", "gpt-6-luna"] as const;
export const PILOT_CASES = ["RAG26-01", "RAG26-02"];
export const MAX_ATTEMPTS = 60;
export const MAX_SECONDS = 7200;
export const MODEL_FAILURES = [
  "model_output_invalid",
  "model_contract_violation",
];
export interface Row {
  slot: number;
  model: string;
  case_id: string;
  trial: number;
}
export interface Attempt extends Row {
  status: string;
  reserved_at: number;
  record_path?: string;
  record_sha256?: string;
}
export interface State {
  started_at: number | null;
  attempts: Attempt[];
  stopped: boolean;
  preregistration_sha256?: string;
}
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
// JSON.parse's native source context preserves the float/int distinction in
// historical files without changing the values returned to callers.
const sourceFloats = new WeakMap<object, Set<string>>();
export function isFloatField(holder: object, key: string): boolean {
  return sourceFloats.get(holder)?.has(key) ?? false;
}
export function markFloatField(holder: object, key: string): void {
  let keys = sourceFloats.get(holder);
  if (!keys) {
    keys = new Set();
    sourceFloats.set(holder, keys);
  }
  keys.add(key);
}
export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(
    text,
    function (
      this: object,
      key: string,
      value: unknown,
      context?: { source?: string },
    ) {
      if (typeof value === "number" && /[.eE]/.test(context?.source ?? "")) {
        let keys = sourceFloats.get(this);
        if (!keys) {
          keys = new Set();
          sourceFloats.set(this, keys);
        }
        keys.add(key);
      }
      return value;
    },
  ) as T;
}
export function load<T = unknown>(path: string): T {
  return parseJson<T>(readFileSync(path, "utf8"));
}
function compareKeys(a: string, b: string): number {
  const left = Array.from(a),
    right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}
export function canonicalJson(value: unknown): string {
  function encode(item: unknown, holder?: object, key = ""): string {
    if (typeof item === "number")
      return !Number.isInteger(item) ||
        Object.is(item, -0) ||
        (holder && sourceFloats.get(holder)?.has(key))
        ? floatText(item)
        : JSON.stringify(item);
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return JSON.stringify(item);
    if (Array.isArray(item))
      return (
        "[" +
        item
          .map((value, index) => encode(value, item, String(index)))
          .join(",") +
        "]"
      );
    if (typeof item !== "object") throw new Error("Expected JSON value");
    const record = item as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .sort(compareKeys)
        .map(
          (key) => JSON.stringify(key) + ":" + encode(record[key], record, key),
        )
        .join(",") +
      "}"
    );
  }
  return encode(value);
}
function prettyJson(value: unknown): string {
  const rawJson = (JSON as typeof JSON & { rawJSON: (text: string) => unknown })
    .rawJSON;
  return JSON.stringify(
    value,
    function (this: object, key: string, item: unknown) {
      if (
        typeof item === "number" &&
        (!Number.isInteger(item) ||
          Object.is(item, -0) ||
          sourceFloats.get(this)?.has(key))
      )
        return rawJson(floatText(item));
      return item;
    },
    2,
  );
}

export function jsonHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export function writeNew(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    chmodSync(path, 0o600);
    writeFileSync(fd, prettyJson(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function saveState(path: string, state: unknown): void {
  const temporary = path.replace(/\.[^/.]+$/, "") + ".next";
  writeNew(temporary, state);
  renameSync(temporary, path);
}
export function schedule(caseIds: string[]): Row[] {
  if (
    caseIds.length !== 10 ||
    new Set(caseIds).size !== 10 ||
    PILOT_CASES.some((id) => !caseIds.includes(id))
  )
    throw new Error(
      "Exactly ten unique frozen questions, including the two pilot cases, required",
    );
  const pairs: [number, string][] = PILOT_CASES.map((id) => [1, id] as const);
  for (let trial = 1; trial <= 3; trial++)
    for (const id of caseIds)
      if (trial !== 1 || !PILOT_CASES.includes(id)) pairs.push([trial, id]);
  const rows: Row[] = [];
  for (const [index, [trial, case_id]] of pairs.entries())
    for (const model of index % 2 === 0 ? MODELS : [...MODELS].reverse())
      rows.push({ slot: rows.length + 1, model, case_id, trial });
  return rows;
}
export function reserve(state: State, rows: Row[], now: number): Attempt {
  const attempts = state.attempts;
  if (state.stopped || attempts.length >= MAX_ATTEMPTS)
    throw new Error("Experiment stopped or all60 attempts consumed");
  if (
    attempts.some((a) => !["completed", ...MODEL_FAILURES].includes(a.status))
  )
    throw new Error(
      "Uncertain or failed attempt exists; never retry automatically",
    );
  if (
    attempts.some((a, i) =>
      Object.entries(rows[i]).some(
        ([key, value]) => a[key as keyof Row] !== value,
      ),
    )
  )
    throw new Error("Attempt history differs from preregistered order");
  state.started_at ??= now;
  if (now < state.started_at || now - state.started_at >= MAX_SECONDS)
    throw new Error(
      "Global7200-second window expired or clock moved backwards",
    );
  if (attempts.length && now < attempts.at(-1)!.reserved_at)
    throw new Error("Clock moved before last reservation");
  const attempt = {
    ...rows[attempts.length],
    status: "reserved",
    reserved_at: now,
  };
  attempts.push(attempt);
  return attempt;
}
export function validatePilotApproval(
  approval: {
    approved?: boolean;
    preregistration_sha256?: string;
    pilot_attempts_sha256?: string;
  },
  preregHash: string,
  attempts: { status: string }[],
): void {
  if (
    approval.approved !== true ||
    approval.preregistration_sha256 !== preregHash ||
    attempts.length < 4 ||
    attempts
      .slice(0, 4)
      .some((a) => !["completed", ...MODEL_FAILURES].includes(a.status)) ||
    approval.pilot_attempts_sha256 !== jsonHash(attempts.slice(0, 4))
  )
    throw new Error(
      "Independent pilot approval is absent or bound to different evidence",
    );
}
interface Diagnostic {
  category?: string;
  stage?: string;
  exit_code?: number;
  json_event_lines_valid?: boolean;
  event_types?: string[];
  item_types?: string[];
  provider_error_code?: unknown;
  validation_reason?: string;
  tool_event_category?: string;
}
export function verifiedModelFailure(
  record: {
    live: {
      status: string;
      run?: unknown;
      error?: string;
      safe_diagnostic?: Diagnostic | null;
    };
  },
  returncode: number,
): boolean {
  const live = record.live,
    d = live.safe_diagnostic ?? {},
    category = live.error,
    events = new Set(d.event_types ?? []),
    items = new Set(d.item_types ?? []);
  if (
    returncode !== 1 ||
    live.status !== "failed" ||
    live.run != null ||
    !category ||
    !MODEL_FAILURES.includes(category) ||
    d.category !== category ||
    d.stage !== "agent_event_validation" ||
    d.exit_code !== 0 ||
    d.json_event_lines_valid !== true ||
    d.provider_error_code != null ||
    events.has("error") ||
    events.has("turn.failed") ||
    items.has("error")
  )
    return false;
  const reason = d.validation_reason,
    tool = d.tool_event_category;
  if (category === "model_output_invalid")
    return (
      reason === "invalid_model_answer" &&
      events.has("turn.completed") &&
      items.has("agent_message")
    );
  if (reason === "missing_required_search")
    return (
      tool === "none" &&
      events.has("turn.completed") &&
      items.has("agent_message") &&
      [...items].every((i) => ["reasoning", "agent_message"].includes(i))
    );
  if (
    ["invalid_search_arguments", "search_limit_exceeded"].includes(reason ?? "")
  )
    return tool === "search_document" && items.has("mcp_tool_call");
  if (reason === "outside_contract_tool")
    return (
      (tool === "other_mcp_tool" && items.has("mcp_tool_call")) ||
      (["command_execution", "file_change", "web_search"].includes(
        tool ?? "",
      ) &&
        items.has(tool!))
    );
  return false;
}
export function cohortComplete(state: {
  attempts: { status: string }[];
  stopped: boolean;
}): boolean {
  return (
    state.attempts.length === MAX_ATTEMPTS &&
    !state.stopped &&
    state.attempts.every((a) =>
      ["completed", ...MODEL_FAILURES].includes(a.status),
    )
  );
}
interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  started: string;
}
function processSnapshot(): Map<number, ProcessIdentity> {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error("Cannot inspect owned process identities");
  const processes = new Map<number, ProcessIdentity>();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (match) {
      const [, pid, parent, group, started] = match;
      processes.set(Number(pid), {
        pid: Number(pid),
        parent: Number(parent),
        group: Number(group),
        started,
      });
    }
  }
  return processes;
}
function descendants(parent: number): Map<number, ProcessIdentity> {
  const processes = processSnapshot(),
    owned = new Set([parent]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of processes.values())
      if (owned.has(p.parent) && !owned.has(p.pid)) {
        owned.add(p.pid);
        changed = true;
      }
  }
  return new Map([...processes].filter(([pid]) => owned.has(pid)));
}
function send(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
export interface ProcessResult {
  returncode: number;
  stdout: Buffer;
  stderr: Buffer;
}
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export async function runCancellable(
  command: string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
  cwd?: string,
): Promise<ProcessResult> {
  const child = spawn(command[0], command.slice(1), {
    env,
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let totalBytes = 0,
    settled = false,
    stop: (reason: "timeout" | "interrupt" | "overflow") => void = () => {};
  const stopped = new Promise<"timeout" | "interrupt" | "overflow">(
    (accept) => {
      stop = accept;
    },
  );
  const capture = (chunks: Buffer[], data: Buffer) => {
    totalBytes += data.length;
    if (totalBytes > MAX_OUTPUT_BYTES) {
      stop("overflow");
      return;
    }
    chunks.push(data);
  };
  child.stdout.on("data", (data: Buffer) => capture(stdout, data));
  child.stderr.on("data", (data: Buffer) => capture(stderr, data));
  const closed = new Promise<number>((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      settled = true;
      accept(code ?? (signal === "SIGINT" ? -2 : -9));
    });
  });
  const timer = setTimeout(() => stop("timeout"), timeout * 1000),
    interrupt = () => stop("interrupt");
  process.once("SIGINT", interrupt);
  try {
    const result = await Promise.race([closed, stopped]);
    if (typeof result === "number")
      return {
        returncode: result,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
    const owned = descendants(child.pid!);
    send(child.pid!, "SIGINT");
    await Promise.race([closed, delay(5000, undefined, { ref: false })]);
    const current = processSnapshot();
    for (const [pid, identity] of owned) {
      const actual = current.get(pid);
      if (
        actual &&
        actual.group === identity.group &&
        actual.started === identity.started
      )
        send(pid === identity.group ? -pid : pid, "SIGKILL");
    }
    if (!settled) send(child.pid!, "SIGKILL");
    await Promise.race([closed, delay(5000, undefined, { ref: false })]);
    child.stdout.destroy();
    child.stderr.destroy();
    throw new Error(
      result === "timeout"
        ? "Process timed out"
        : result === "interrupt"
          ? "Process interrupted"
          : "Process output exceeded " + MAX_OUTPUT_BYTES + " bytes",
    );
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
  }
}

export async function commandJson<T = unknown>(
  command: string[],
  env: NodeJS.ProcessEnv,
): Promise<T> {
  const result = await runCancellable(command, env, 30);
  if (result.returncode !== 0) throw new Error("Native command failed");
  return JSON.parse(result.stdout.toString()) as T;
}
interface Plan {
  requested_model: string;
  planned_sessions: number;
  max_search_calls_per_session: number;
  max_session_seconds: number;
  runs: { case_id: string }[];
  selection_sha256: string;
}
interface Prereg {
  binary: string;
  codex_binary: string;
  pins: Record<string, string>;
  schedule: Row[];
  plans: Record<string, Plan>;
  [key: string]: unknown;
}
export function checkedPrereg(directory: string): [Prereg, State] {
  const prereg = load<Prereg>(join(directory, "PREREGISTRATION.json")),
    state = load<State>(join(directory, "STATE.json"));
  if (
    fileHash(join(directory, "PREREGISTRATION.json")) !==
    state.preregistration_sha256
  )
    throw new Error("Preregistration changed");
  for (const [path, expected] of Object.entries(prereg.pins))
    if (fileHash(path) !== expected)
      throw new Error(
        `Pinned executable/reference/analysis file changed: ${path}`,
      );
  for (const attempt of state.attempts)
    if (
      ["completed", "model_output_invalid"].includes(attempt.status) &&
      fileHash(attempt.record_path!) !== attempt.record_sha256
    )
      throw new Error("Previously saved attempt bytes changed");
  if (
    canonicalJson(prereg.schedule) !==
    canonicalJson(schedule(prereg.plans[MODELS[0]].runs.map((r) => r.case_id)))
  )
    throw new Error("Schedule no longer matches the native plan");
  return [prereg, state];
}
function modelEnv(prereg: Prereg, model: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COA_CODEX_MODEL: model,
    COA_CODEX_BIN: prereg.codex_binary,
  };
}
async function assessCohorts(directory: string): Promise<void> {
  const [prereg, state] = checkedPrereg(directory);
  if (!cohortComplete(state))
    throw new Error(
      "A full non-stopped60-attempt cohort is required; partial evidence remains saved",
    );
  const index: unknown[] = [];
  for (const model of MODELS)
    for (let trial = 1; trial <= 3; trial++) {
      const attempts = state.attempts.filter(
        (a) => a.model === model && a.trial === trial,
      );
      if (
        attempts.length !== 10 ||
        new Set(attempts.map((a) => a.case_id)).size !== 10
      )
        throw new Error("Incomplete or duplicate model/trial cohort");
      const path = join(
          directory,
          "cohorts",
          `${model === MODELS[0] ? "sol" : "luna"}-trial${trial}.jsonl`,
        ),
        fd = openSync(path, "wx", 0o600);
      try {
        for (const a of attempts) {
          if (fileHash(a.record_path!) !== a.record_sha256)
            throw new Error("Native attempt bytes changed");
          writeFileSync(fd, readFileSync(a.record_path!));
        }
      } finally {
        closeSync(fd);
      }
      const assessment = path.replace(/\.jsonl$/, ".assessment.jsonl"),
        report = path.replace(/\.jsonl$/, ".report.json");
      for (const command of [
        [
          prereg.binary,
          "lab",
          "agent-assess",
          "--input",
          path,
          "--output",
          assessment,
        ],
        [
          prereg.binary,
          "lab",
          "agent-report",
          "--input",
          path,
          "--assessments",
          assessment,
          "--output",
          report,
        ],
      ]) {
        const result = await runCancellable(
          command,
          modelEnv(prereg, model),
          7200,
        );
        if (result.returncode !== 0)
          throw new Error("Native assessment failed");
      }
      for (const a of attempts)
        index.push({
          ...a,
          cohort_records_path: path,
          assessment_path: assessment,
          report_path: report,
        });
    }
  writeNew(join(directory, "ANALYSIS_INDEX.json"), {
    schema_version: 1,
    preregistration_sha256: state.preregistration_sha256,
    attempts: index,
    ai_judge_calls: 0,
  });
}
async function makePlan(args: Record<string, string>): Promise<void> {
  const binary = realpathSync(args.binary),
    codex = realpathSync(args["codex-binary"]),
    host = join(dirname(codex), "codex-code-mode-host");
  const versionResult = await runCancellable(
      [codex, "--version"],
      process.env,
      15,
    ),
    version = versionResult.stdout.toString().trim();
  if (versionResult.returncode !== 0 || !version.includes("0.166.0"))
    throw new Error("Both models must use the preregistered0.166.0 runtime");
  const plans: Record<string, Plan> = {};
  for (const model of MODELS) {
    const plan = await commandJson<Plan>(
      [binary, "lab", "agent-plan", "--dataset", DATASET, "--methods", "dense"],
      { ...process.env, COA_CODEX_MODEL: model, COA_CODEX_BIN: codex },
    );
    if (
      plan.requested_model !== model ||
      plan.planned_sessions !== 10 ||
      plan.max_search_calls_per_session !== 4 ||
      plan.max_session_seconds !== 120
    )
      throw new Error(
        "Native input-only plan differs from the intended experiment",
      );
    if (
      [
        "evidence_alternatives",
        "evaluation_only_canary",
        "required_unknowns",
      ].some((key) => JSON.stringify(plan).includes(key))
    )
      throw new Error("Protected reference labels in runtime plan");
    plans[model] = plan;
  }
  const left = plans[MODELS[0]],
    right = plans[MODELS[1]];
  if (
    canonicalJson(left.runs) !== canonicalJson(right.runs) ||
    left.selection_sha256 !== right.selection_sha256
  )
    throw new Error(
      "Models differ in something other than model/protocol identity",
    );
  const rows = schedule(left.runs.map((r) => r.case_id)),
    directory = resolve(args.directory);
  mkdirSync(directory, { mode: 0o700 });
  for (const sub of ["runs", "ledgers", "cohorts"])
    mkdirSync(join(directory, sub), { mode: 0o700 });
  const baseline = realpathSync(args["retrieval-baseline"]);
  const records = readFileSync(baseline, "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          live: {
            config: { retrieval: { method: string } };
            run?: { manifest: { corpus_identity: Json } };
          };
        },
    );
  const identities = records
    .filter((r) => r.live.config.retrieval.method === "dense" && r.live.run)
    .map((r) => r.live.run!.manifest.corpus_identity);
  if (
    !identities.length ||
    identities.some((i) => canonicalJson(i) !== canonicalJson(identities[0]))
  )
    throw new Error(
      "Existing same-corpus dense retrieval identity is absent or inconsistent",
    );
  const previousPath = realpathSync(args["previous-stop-manifest"]),
    previous = load<{
      state: string;
      attempts: number;
      files: { path: string; sha256: string }[];
    }>(previousPath);
  if (previous.state !== "STOPPED_NO_RETRY" || previous.attempts !== 6)
    throw new Error("Expected the preserved six-attempt aborted experiment");
  for (const item of previous.files)
    if (fileHash(join(dirname(previousPath), item.path)) !== item.sha256)
      throw new Error("An aborted-experiment artifact changed");
  const paths = [
    binary,
    codex,
    host,
    fileURLToPath(import.meta.url),
    realpathSync(args.freeze),
    realpathSync(args["analysis-plan"]),
    baseline,
    previousPath,
  ];
  const prereg = {
    schema_version: 1,
    created_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    binary,
    codex_binary: codex,
    runtime_version: version,
    pins: Object.fromEntries(paths.map((path) => [path, fileHash(path)])),
    dataset: DATASET,
    models: MODELS,
    search_method: "dense",
    retrieval_corpus_identity: identities[0],
    search_method_reason:
      "Existing demo default; fixed before new outcomes, not selected by performance",
    model_cache: realpathSync(args["model-cache"]),
    reasoning_effort: "low",
    plans,
    schedule: rows,
    max_generation_attempts: MAX_ATTEMPTS,
    max_global_seconds: MAX_SECONDS,
    max_search_attempts_per_session: 4,
    max_native_seconds_per_session: 120,
    ai_judge_calls: 0,
    previous_aborted_experiment: {
      manifest_path: previousPath,
      manifest_sha256: fileHash(previousPath),
      attempts: 6,
      excluded_from_new_comparison: true,
    },
    total_authorized_attempts_including_aborted: 66,
    pilot_slots: [1, 2, 3, 4],
    pilot_cases: PILOT_CASES,
    pilot_reason:
      "Integration verification includes the simple time/location case and the case of the prior unclassified tool failure; all ten questions remain in the full comparison without score-based selection",
    ordering:
      "Fixed paired question/trial order; model order alternates for each pair; pilot four first",
    repetition_identity:
      "Separate model/trial cohort files; one pinned30-attempt ledger per model, one external60-attempt global reservation",
    failure_policy:
      "Completed sessions, including rejected tool attempts, are valid model outcomes. A safely evidenced model_output_invalid or model_contract_violation remains a failed native attempt with unknown source coverage. Specific proven model actions need not imply a complete final answer. Broad errors, missing records, trace/pin mismatch, provider/auth/network errors stop; no retries or fallback.",
    limitations: [
      "Development questions on synthetic data; no blind holdout or answer-correctness judging",
      "Equal reasoning labels do not imply equal compute",
      "This question set is not comparable to the previous35/40set",
    ],
  };
  writeNew(join(directory, "PREREGISTRATION.json"), prereg);
  writeNew(join(directory, "STATE.json"), {
    preregistration_sha256: fileHash(join(directory, "PREREGISTRATION.json")),
    started_at: null,
    attempts: [],
    stopped: false,
  });
  console.log(
    JSON.stringify({
      directory,
      preregistration_sha256: fileHash(join(directory, "PREREGISTRATION.json")),
      sessions: rows.length,
    }),
  );
}
async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "run")
    throw new Error(
      "RAG model execution is now controlled by promptfoo: npm run eval:rag:live -- --suite models --ledger <new.json> --max-generations <cap> --max-seconds <cap>. Historical plan/assess readers remain available.",
    );
  const flags =
    command === "plan"
      ? [
          "binary",
          "codex-binary",
          "freeze",
          "analysis-plan",
          "retrieval-baseline",
          "previous-stop-manifest",
          "model-cache",
          "directory",
        ]
      : ["directory"];
  if (!["plan", "assess"].includes(command))
    throw new Error("Usage: model_trials.ts plan|assess [options]");
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: Object.fromEntries(
      flags.map((flag) => [flag, { type: "string" as const }]),
    ),
  });
  for (const flag of flags)
    if (!values[flag]) throw new Error(`Missing --${flag}`);
  if (command === "plan") await makePlan(values as Record<string, string>);
  else await assessCohorts(realpathSync(values.directory as string));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
