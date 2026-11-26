import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const REPOSITORY = "Daanvdplas/coa-assistent";
const REPOSITORY_ID = "1425707184";
const BRANCH = "refs/heads/qa/coa-live-10-20261126-01";
const WORKFLOW = ".github/workflows/coa-live-10-20261126.yml";
const SITE = "https://coa-assistent.app";
const QUESTION = "Fictieve capaciteitstest COA-10-20261126-01. Welke van de verzonnen activiteiten past bij een fictieve deelnemer die rustig wil bewegen?";
const CLIENTS = 10;
const LAUNCH_UTC: string = "2026-11-26T19:09:00Z";
const EXPECTED_SPEND_CONTROL = "monthly_budget";
const EXPECTED_CONFIG_SHA256: string = "204e04779cc72fa888322e55ca585e3292b9189d694bfc50e0bc6f95314da2f0";
const READY_STEP = "Prepare normal demo session";
const DENIALS = new Set(["capacity", "visitor_busy", "ip_rate_limit", "demo_rate_limit", "session_cooldown"]);

type Json = Record<string, unknown>;

type Context = {
  client: number;
  launch: number;
  runId: string;
  sha: string;
  sessionFile: string;
};

class SafeFailure extends Error {}

function checkedString(value: string | undefined, expression: RegExp, category: string) {
  if (!value || !expression.test(value)) throw new SafeFailure(category);
  return value;
}

function isSession(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32,128}$/.test(value);
}

async function workflowContext(): Promise<Context> {
  const env = process.env;
  const launch = Date.parse(LAUNCH_UTC);
  if (LAUNCH_UTC === "UNARMED" || EXPECTED_CONFIG_SHA256 === "UNARMED" || !Number.isFinite(launch) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(LAUNCH_UTC) ||
      !/^[0-9a-f]{64}$/.test(EXPECTED_CONFIG_SHA256) || new Date(launch).toISOString() !== LAUNCH_UTC.replace("Z", ".000Z")) throw new SafeFailure("unarmed");
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REPOSITORY_ID !== REPOSITORY_ID ||
      env.GITHUB_REF !== BRANCH || env.GITHUB_WORKFLOW_REF !== REPOSITORY + "/" + WORKFLOW + "@" + BRANCH ||
      env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_RUN_NUMBER !== "1" || env.GITHUB_RUN_ATTEMPT !== "1" ||
      env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA) throw new SafeFailure("unauthorized_workflow_context");
  const sha = checkedString(env.GITHUB_SHA, /^[0-9a-f]{40}$/, "invalid_workflow_sha");
  const runId = checkedString(env.GITHUB_RUN_ID, /^[0-9]+$/, "invalid_workflow_run");
  const client = Number(checkedString(env.COA_LIVE_CLIENT, /^(?:[1-9]|10)$/, "invalid_client"));
  const eventPath = checkedString(env.GITHUB_EVENT_PATH, /^\//, "missing_event");
  const event = JSON.parse(await readFile(eventPath, "utf8")) as Json;
  const eventRepo = event.repository as Json | null;
  if (!eventRepo || String(eventRepo.id) !== REPOSITORY_ID || eventRepo.private !== false ||
      event.ref !== BRANCH || event.after !== sha || event.created !== true ||
      event.deleted !== false || event.forced !== false) throw new SafeFailure("unauthorized_push_event");
  if (launch - Date.now() > 9 * 60_000 || Date.now() >= launch - 10_000) throw new SafeFailure("outside_preparation_window");
  return { client, launch, runId, sha, sessionFile: sessionPath() };
}

function sessionPath() {
  const scratch = checkedString(process.env.RUNNER_TEMP, /^\//, "missing_runner_temp");
  return join(scratch, ".coa-live-10-session");
}

async function safeJson(response: Response): Promise<Json> {
  const value = await response.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SafeFailure("unexpected_content");
  return value;
}

async function request(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8_000) });
}

async function verifyHealth() {
  const response = await request(SITE + "/api/source");
  if (!response.ok) throw new SafeFailure("health_http_" + response.status);
  const info = await safeJson(response);
  const config = info.model_configuration as Json | null;
  if (info.runtime_ready !== true || info.guided_retrieval_available !== true ||
      !Array.isArray(info.sources) || info.sources.length !== 12 || !config ||
      config.spend_control !== EXPECTED_SPEND_CONTROL || config.budget_policy_version !== 2 ||
      config.offline_mock !== false || config.max_provider_requests !== 5 ||
      config.max_input_tokens_per_request !== 300_000 || config.max_output_tokens_per_request !== 4_096) {
    throw new SafeFailure("unexpected_production_configuration");
  }
  const canonical = Object.fromEntries(Object.keys(config).sort().map((key) => [key, config[key]]));
  const hash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  if (hash !== EXPECTED_CONFIG_SHA256) throw new SafeFailure("production_configuration_hash_mismatch");
}

async function prepare(ctx: Context) {
  await verifyHealth();
  const response = await request(SITE + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new SafeFailure("session_http_" + response.status);
  const session = (await safeJson(response)).session_id;
  if (!isSession(session)) throw new SafeFailure("invalid_session");
  process.umask(0o077);
  await writeFile(ctx.sessionFile, session, { mode: 0o600, flag: "wx" });
  if (Date.now() >= ctx.launch - 10_000) throw new SafeFailure("missed_preparation_window");
  console.log(JSON.stringify({ client: ctx.client, stage: "ready" }));
}

export function allPrepared(body: Json, sha: string, runId: string): boolean {
  if (body.total_count !== CLIENTS || !Array.isArray(body.jobs) || body.jobs.length !== CLIENTS) return false;
  const clients = new Set<number>();
  for (const job of body.jobs) {
    const name = typeof job?.name === "string" && /^COA client ([1-9]|10)$/.exec(job.name);
    if (!name || job.head_sha !== sha || String(job.run_id) !== runId || job.status !== "in_progress" ||
        !Array.isArray(job.steps) ||
        !job.steps.some((step: Json) => step?.name === READY_STEP && step.status === "completed" && step.conclusion === "success")) {
      return false;
    }
    clients.add(Number(name[1]));
  }
  return clients.size === CLIENTS;
}

async function waitForAllClients(ctx: Context) {
  const token = checkedString(process.env.COA_LIVE_GITHUB_READ_TOKEN, /^[A-Za-z0-9_]+$/, "missing_actions_read_token");
  const jobs = "https://api.github.com/repos/" + REPOSITORY + "/actions/runs/" + ctx.runId + "/attempts/1/jobs?per_page=10";
  await delay(Math.max(0, ctx.launch - 90_000 - Date.now()));
  const deadline = ctx.launch - 9_000;
  while (Date.now() < deadline) {
    const response = await request(jobs, {
      headers: { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + token },
    });
    if (!response.ok) throw new SafeFailure("coordination_http_" + response.status);
    if (allPrepared(await safeJson(response), ctx.sha, ctx.runId) && Date.now() < deadline) return;
    await delay(5_000);
  }
  throw new SafeFailure("ten_clients_not_ready");
}

async function trackRun(ctx: Context, runId: string, session: string) {
  const deadline = Date.now() + 115_000;
  while (Date.now() < deadline) {
    const response = await request(SITE + "/api/runs/" + runId, { headers: { "X-Test-Session": session } });
    if (!response.ok) throw new SafeFailure("status_http_" + response.status);
    const status = (await safeJson(response)).status;
    if (status === "completed") {
      console.log(JSON.stringify({ client: ctx.client, stage: "terminal", status, utc: new Date().toISOString() }));
      return;
    }
    if (status !== "pending") throw new SafeFailure(status === "failed" ? "answer_failed" : "unexpected_run_status");
    await delay(3_000);
  }
  throw new SafeFailure("status_timeout");
}

async function submit(ctx: Context) {
  const session = await readFile(ctx.sessionFile, "utf8").catch(() => "");
  if (!isSession(session)) throw new SafeFailure("session_missing");
  await waitForAllClients(ctx);
  await verifyHealth();
  await delay(Math.max(0, ctx.launch - Date.now()));
  if (Date.now() > ctx.launch + 1_500) throw new SafeFailure("missed_submit_window");
  const claim = await open(ctx.sessionFile + ".question-claimed", "wx", 0o600).catch(() => {
    throw new SafeFailure("question_claim_unavailable");
  });
  await claim.close();
  const dispatched = Date.now();
  if (dispatched < ctx.launch || dispatched > ctx.launch + 1_500) throw new SafeFailure("missed_submit_window");
  let response: Response;
  try {
    response = await request(SITE + "/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Session": session },
      body: JSON.stringify({ question: QUESTION, answer_language: "nl", retrieval_method: "guided" }),
    });
  } catch {
    throw new SafeFailure("submission_outcome_unknown");
  }
  if (response.status >= 500) throw new SafeFailure("submission_outcome_unknown");
  if (!response.ok) {
    const body = await safeJson(response).catch(() => ({} as Json));
    const code = typeof body.code === "string" && DENIALS.has(body.code) ? body.code : "unclassified";
    throw new SafeFailure("submission_http_" + response.status + "_" + code);
  }
  const body = await safeJson(response).catch(() => ({} as Json));
  if (typeof body.id !== "string" || !/^r-[0-9]+-[0-9]+$/.test(body.id) || body.status !== "pending") {
    throw new SafeFailure("submission_outcome_unknown");
  }
  console.log(JSON.stringify({
    client: ctx.client, stage: "accepted", status: response.status,
    dispatched_utc: new Date(dispatched).toISOString(), acknowledged_utc: new Date().toISOString(),
  }));
  await trackRun(ctx, body.id, session);
}

async function main() {
  const command = process.argv[2];
  if (command === "cleanup") {
    await unlink(sessionPath()).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw new SafeFailure("session_cleanup_failed");
    });
    return;
  }
  const ctx = await workflowContext();
  if (command === "prepare") await prepare(ctx);
  else if (command === "submit") await submit(ctx);
  else throw new SafeFailure("invalid_command");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const category = error instanceof SafeFailure ? error.message : "runtime_error";
    console.error(JSON.stringify({ stage: "abort", category }));
    process.exitCode = 1;
  });
}
