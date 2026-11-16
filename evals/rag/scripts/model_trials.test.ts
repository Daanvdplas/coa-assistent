import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as trials from "./model_trials.ts";
const ids = Array.from(
  { length: 10 },
  (_, i) => `RAG26-${String(i + 1).padStart(2, "0")}`,
);
test("schedule contains each model question trial once and balanced pilot", () => {
  const rows = trials.schedule(ids);
  assert.equal(rows.length, 60);
  assert.equal(
    new Set(rows.map((r) => `${r.model}/${r.case_id}/${r.trial}`)).size,
    60,
  );
  assert.deepEqual(
    rows.slice(0, 4).map((r) => [r.model, r.case_id, r.trial]),
    [
      ["gpt-6.1-sol", "RAG26-01", 1],
      ["gpt-6-luna", "RAG26-01", 1],
      ["gpt-6-luna", "RAG26-02", 1],
      ["gpt-6.1-sol", "RAG26-02", 1],
    ],
  );
});
test("reservation cannot repeat an uncertain attempt", () => {
  const state: trials.State = {
    started_at: null,
    attempts: [],
    stopped: false,
  };
  trials.reserve(state, trials.schedule(ids), 100);
  assert.equal(state.attempts[0].status, "reserved");
  assert.throws(() => trials.reserve(state, trials.schedule(ids), 101));
});
test("global generation and time caps never extend on resume", () => {
  const state: trials.State = { started_at: 100, attempts: [], stopped: false };
  const rows = trials.schedule(ids);
  for (let i = 0; i < 60; i++) {
    trials.reserve(state, rows, 101);
    state.attempts.at(-1)!.status = "completed";
  }
  assert.throws(() => trials.reserve(state, rows, 102));
  state.attempts = [];
  assert.throws(() => trials.reserve(state, rows, 7300));
});
test("attempt order tampering is rejected", () => {
  const rows = trials.schedule(ids);
  const state: trials.State = {
    started_at: 100,
    attempts: [{ ...rows[1], status: "completed", reserved_at: 100 }],
    stopped: false,
  };
  assert.throws(() => trials.reserve(state, rows, 101));
});
test("last reserved attempt is not a completed cohort", () => {
  const state = {
    attempts: Array.from({ length: 60 }, () => ({ status: "completed" })),
    stopped: false,
  };
  assert.equal(trials.cohortComplete(state), true);
  state.attempts[59].status = "reserved";
  assert.equal(trials.cohortComplete(state), false);
});
test("exact tool action can be known without claiming a complete answer", () => {
  const record = {
    live: {
      status: "failed",
      run: null,
      error: "model_contract_violation",
      safe_diagnostic: {
        category: "model_contract_violation",
        stage: "agent_event_validation",
        exit_code: 0,
        json_event_lines_valid: true,
        event_types: ["item.completed"],
        item_types: ["mcp_tool_call"],
        provider_error_code: null,
        validation_reason: "outside_contract_tool",
        tool_event_category: "other_mcp_tool",
      },
    },
  };
  assert.equal(trials.verifiedModelFailure(record, 1), true);
  assert.equal(trials.verifiedModelFailure(record, -9), false);
  record.live.safe_diagnostic.validation_reason = "missing_required_search";
  record.live.safe_diagnostic.tool_event_category = "none";
  assert.equal(trials.verifiedModelFailure(record, 1), false);
  record.live.error = "unexpected_tool";
  assert.equal(trials.verifiedModelFailure(record, 1), false);
});
test("manifest output creation never overwrites existing evidence", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coa-trials-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "frozen.json");
  trials.writeNew(path, { fixed: true });
  assert.throws(() => trials.writeNew(path, { fixed: false }));
  assert.deepEqual(trials.load(path), { fixed: true });
});
test("pilot approval is bound to exact first four attempts", () => {
  const attempts = Array.from({ length: 4 }, (_, i) => ({
    slot: i + 1,
    status: "completed",
  }));
  const approval = {
    approved: true,
    preregistration_sha256: "abc",
    pilot_attempts_sha256: trials.jsonHash(attempts),
  };
  trials.validatePilotApproval(approval, "abc", attempts);
  attempts[0].status = "failed";
  assert.throws(() => trials.validatePilotApproval(approval, "abc", attempts));
});
test("timeout cleans a descendant with its own process group", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coa-cancel-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pidFile = join(directory, "child.pid");
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);`;
  await assert.rejects(
    trials.runCancellable(
      [process.execPath, "-e", script, pidFile],
      process.env,
      0.5,
    ),
    /timed out/,
  );
  const pid = readFileSync(pidFile, "utf8");
  const result = spawnSync("ps", ["-p", pid, "-o", "stat="], {
    encoding: "utf8",
  });
  assert.ok(result.status !== 0 || result.stdout.trim().startsWith("Z"));
});
test("output overflow stops owned descendants without exposing captured bytes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coa-output-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pidFile = join(directory, "child.pid");
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));process.stdout.write('PRIVATE-OUTPUT'.repeat(1400000));setInterval(()=>{},1000);`;
  await assert.rejects(
    trials.runCancellable(
      [process.execPath, "-e", script, pidFile],
      process.env,
      5,
    ),
    (error) =>
      error instanceof Error &&
      error.message === "Process output exceeded 16777216 bytes",
  );
  const pid = readFileSync(pidFile, "utf8");
  const result = spawnSync("ps", ["-p", pid, "-o", "stat="], {
    encoding: "utf8",
  });
  assert.ok(result.status !== 0 || result.stdout.trim().startsWith("Z"));
});
test("historical JSON hashes retain integral floats and Python exponent spelling", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coa-hash-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const input = '{"integer":1,"integral_float":1.0,"small":1e-7,"text":"é😀"}';
  trials.writeNew(path, JSON.parse(input));
  writeFileSync(path, input);
  const value = trials.load(path);
  assert.equal(
    trials.canonicalJson(value),
    '{"integer":1,"integral_float":1.0,"small":1e-07,"text":"é😀"}',
  );
  trials.saveState(path, value);
  assert.equal(
    trials.canonicalJson(trials.load(path)),
    trials.canonicalJson(value),
  );
});
