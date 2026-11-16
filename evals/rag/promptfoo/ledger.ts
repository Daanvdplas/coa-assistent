/** The Rust helper holds a real OS lock while this short Node transaction runs. */
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  writeSync,
  writeFileSync,
  ftruncateSync,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCancellable } from "../scripts/model_trials.ts";
export interface Reservation {
  path: string;
  id: string;
  maximum: number;
  seconds: number;
  deadline: number;
}
export interface LedgerAttempt {
  id: string;
  dataset: string;
  case_id: string;
  model: string;
  status: string;
  started_at: number;
  finished_at?: number;
}
interface Ledger {
  schema_version: number;
  started_at: number;
  max_generations: number;
  max_seconds: number;
  attempts: LedgerAttempt[];
  stopped: boolean;
}
// Rust's records.rs accepts artifacts up to 128 MiB. The transaction also
// carries its token and operation metadata, with one additional MiB of room.
const MAX_TRANSACTION_BYTES = (128 + 1) * 1024 * 1024;
export async function lockedTransaction<T>(
  lockPath: string,
  script: string,
  operation: string,
  payload: unknown,
  nonblocking = false,
): Promise<T> {
  const binary = process.env.COA_RAG_BINARY;
  if (!binary)
    throw new Error("COA_RAG_BINARY must identify the trusted lock helper");
  const bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.length > MAX_TRANSACTION_BYTES)
    throw new Error(
      "Protocol transaction exceeds the private 129 MiB transport limit",
    );
  const directory = mkdtempSync(join(tmpdir(), "coa-protocol-transaction-"));
  const input = join(directory, "input.json");
  const command = [
    binary,
    "lock-exec",
    lockPath,
    ...(nonblocking ? ["--nonblocking"] : []),
    "--",
    process.execPath,
    script,
    operation,
    "--payload-file",
    input,
  ];
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
  try {
    writeFileSync(input, bytes, { flag: "wx", mode: 0o600 });
    const result = await runCancellable(command, env, 30);
    if (result.returncode !== 0)
      throw new Error("Locked protocol transaction failed");
    const response = JSON.parse(result.stdout.toString()) as {
      value?: T;
      error?: string;
    };
    if (response.error) throw new Error(response.error);
    return response.value as T;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const script = fileURLToPath(import.meta.url);
export async function reserve(
  dataset: string,
  caseId: string,
  model: string,
): Promise<Reservation> {
  if (process.env.COA_PROMPTFOO_ALLOW_CODEX !== "1")
    throw new Error("Codex requires explicit COA_PROMPTFOO_ALLOW_CODEX=1");
  const path = resolve(process.env.COA_PROMPTFOO_LEDGER!),
    maximum = Number(process.env.COA_PROMPTFOO_MAX_GENERATIONS ?? "8"),
    seconds = Number(process.env.COA_PROMPTFOO_MAX_SECONDS ?? "900");
  if (
    !Number.isInteger(maximum) ||
    maximum < 1 ||
    maximum > 200 ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 14400
  )
    throw new Error(
      "Codex limits must be 1..200 sessions and 1..14400 seconds",
    );
  return lockedTransaction(path, script, "reserve", {
    path,
    dataset,
    caseId,
    model,
    maximum,
    seconds,
  });
}
export async function finish(
  path: string,
  id: string,
  completed: boolean | string,
): Promise<void> {
  await lockedTransaction(path, script, "finish", { path, id, completed });
}
function lockedDescriptor(): number {
  const value = process.env.COA_OPERATOR_LOCK_FD;
  if (!value || !/^\d+$/.test(value))
    throw new Error("Missing inherited ledger lock");
  const descriptor = Number(value);
  if (descriptor < 3 || !fstatSync(descriptor).isFile())
    throw new Error("Invalid inherited ledger lock");
  return descriptor;
}
function saveLedger(state: Ledger): void {
  // Read and write the exact inode locked by Rust, even if its name changes.
  const descriptor = lockedDescriptor();
  const bytes = Buffer.from(JSON.stringify(state));
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (!count) throw new Error("Ledger write made no progress");
    offset += count;
  }
  ftruncateSync(descriptor, bytes.length);
  fsyncSync(descriptor);
}
function reserveUnlocked(payload: {
  path: string;
  dataset: string;
  caseId: string;
  model: string;
  maximum: number;
  seconds: number;
}): Reservation {
  const { path, dataset, caseId, model, maximum, seconds } = payload,
    now = Date.now() / 1000,
    raw = readFileSync(lockedDescriptor(), "utf8");
  const state: Ledger = raw
    ? JSON.parse(raw)
    : {
        schema_version: 1,
        started_at: now,
        max_generations: maximum,
        max_seconds: seconds,
        attempts: [],
        stopped: false,
      };
  if (
    state.schema_version !== 1 ||
    state.max_generations !== maximum ||
    state.max_seconds !== seconds
  )
    throw new Error("Existing Codex ledger limits cannot be changed or reset");
  if (state.stopped || state.attempts.some((row) => row.status === "reserved"))
    throw new Error("Codex batch stopped after a failed or uncertain attempt");
  if (now >= state.started_at + seconds || state.attempts.length >= maximum)
    throw new Error("Codex session/time budget exhausted");
  const attempt = {
    id: randomUUID().replaceAll("-", ""),
    dataset,
    case_id: caseId,
    model,
    status: "reserved",
    started_at: now,
  };
  state.attempts.push(attempt);
  saveLedger(state);
  return {
    path,
    id: attempt.id,
    maximum,
    seconds,
    deadline: state.started_at + seconds,
  };
}
function finishUnlocked(payload: {
  path: string;
  id: string;
  completed: boolean | string;
}): null {
  const state = JSON.parse(readFileSync(lockedDescriptor(), "utf8")) as Ledger,
    attempt = state.attempts.find((row) => row.id === payload.id);
  if (!attempt) throw new Error("Reserved Codex attempt is missing");
  const status =
    payload.completed === true
      ? "completed"
      : ["model_output_invalid", "model_contract_violation"].includes(
            String(payload.completed),
          )
        ? String(payload.completed)
        : "failed";
  Object.assign(attempt, { status, finished_at: Date.now() / 1000 });
  if (status === "failed") state.stopped = true;
  saveLedger(state);
  return null;
}
if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    if (process.argv[3] !== "--payload-file")
      throw new Error("Expected private transaction input");
    const payload = JSON.parse(readFileSync(process.argv[4], "utf8"));
    const value =
      process.argv[2] === "reserve"
        ? reserveUnlocked(payload)
        : process.argv[2] === "finish"
          ? finishUnlocked(payload)
          : (() => {
              throw new Error("Unknown ledger transaction");
            })();
    process.stdout.write(JSON.stringify({ value }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        error:
          error instanceof SyntaxError
            ? "Invalid ledger JSON"
            : error instanceof Error
              ? error.message
              : "Ledger transaction failed",
      }),
    );
  }
}
