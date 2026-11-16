import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callApi, DEFAULTS, requestKey } from "../provider.ts";
import { getModelAssert } from "../assertions.ts";
import { localRecord, variables } from "./fixtures.ts";
import { isolateEnvironment } from "./environment.ts";
import type { NativeRecord, Variables, Context } from "../types.ts";
import type { ProcessResult } from "../../scripts/model_trials.ts";
const lockBinary =
  process.env.COA_TEST_LOCK_BINARY ?? process.env.COA_RAG_BINARY;
function setup() {
  const restore = isolateEnvironment(),
    directory = mkdtempSync(join(tmpdir(), "coa-provider-")),
    binary = join(directory, "runtime");
  writeFileSync(binary, "#!fake");
  chmodSync(binary, 0o700);
  Object.assign(process.env, {
    COA_RAG_BINARY: binary,
    COA_PROMPTFOO_ARTIFACT_DIR: join(directory, "artifacts"),
    OPENAI_API_KEY: "key-must-not-leak",
    COA_OPENAI_API_KEY_FILE: "/key/must/not/open",
  });
  return {
    directory,
    cleanup: () => {
      restore();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const success = (stdout = ""): ProcessResult => ({
  returncode: 0,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
});

test("one native execution forwards input only and scrubs cloud credentials", async () => {
  const { cleanup } = setup();
  try {
    const record = localRecord().record as NativeRecord,
      context = {
        vars: {
          dataset: "legacy",
          case_id: "P01",
          question: record.question,
          expected: "GOLD-MUST-NOT-LEAK",
        } as unknown as Variables,
      };
    const observed: { command: string[]; env: NodeJS.ProcessEnv }[] = [];
    const result = await callApi(
      "GOLD-IN-PROMPT-MUST-NOT-LEAK",
      { config: { mode: "local", method: "bm25" } },
      context,
      async (command, env) => {
        observed.push({ command, env });
        writeFileSync(
          command[command.indexOf("--output") + 1],
          JSON.stringify(record) + "\n",
        );
        return success();
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.output!.case_id, "P01");
    assert.equal(result.metadata!.run_id, "measured-run-one");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].env.OPENAI_API_KEY, undefined);
    assert.equal(observed[0].env.COA_OPENAI_API_KEY_FILE, undefined);
    assert.ok(!observed[0].command.join(" ").includes("GOLD"));
    assert.ok(!observed[0].command.includes("assess"));
    assert.equal(
      observed[0].command.filter((arg) => arg === "--cases").length,
      1,
    );
  } finally {
    cleanup();
  }
});
test("Codex and model suite require live opt-in before starting or reserving", async () => {
  const { directory, cleanup } = setup();
  try {
    let calls = 0;
    const execute = async () => {
      calls++;
      return success();
    };
    const context = { vars: variables(localRecord(), { mode: "codex" }) };
    assert.ok((await callApi("", {}, context, execute)).error);
    const modelContext = {
      vars: { ...context.vars, dataset: "strengthened-10-20261106" },
      test: { metadata: { suite: "models" } },
    };
    process.env.COA_PROMPTFOO_PHASE = "pilot";
    process.env.COA_PROMPTFOO_LEDGER = join(directory, "ledger.json");
    assert.ok((await callApi("", {}, modelContext, execute)).error);
    assert.equal(calls, 0);
    assert.equal(existsSync(process.env.COA_PROMPTFOO_LEDGER), false);
  } finally {
    cleanup();
  }
});
test("native failure never retries or exports private stdout/stderr", async () => {
  const { cleanup } = setup();
  try {
    let calls = 0;
    const result = await callApi("", {}, { vars: variables() }, async () => {
      calls++;
      return {
        returncode: 1,
        stdout: Buffer.from("private reasoning"),
        stderr: Buffer.from("sk-secret"),
      };
    });
    assert.ok(result.error);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes("sk-secret"));
    assert.ok(!JSON.stringify(result).includes("reasoning"));
  } finally {
    cleanup();
  }
});
test("browser model reaches native retrieval and partitions prepared keys", async () => {
  const { cleanup } = setup();
  try {
    const vars = variables(localRecord(), {
      method: "dense",
      top_k: 5,
      browser_eval_id: "garden-time-location",
      embedding_model: "e5-small-multilingual",
    });
    let command: string[] = [];
    const result = await callApi("", {}, { vars }, async (values) => {
      command = values;
      writeFileSync(
        values[values.indexOf("--output") + 1],
        JSON.stringify(localRecord().record) + "\n",
      );
      return success();
    });
    assert.equal(result.error, undefined);
    assert.equal(
      command[command.indexOf("--embedding-model") + 1],
      "e5-small-multilingual",
    );
    assert.notEqual(
      requestKey(vars),
      requestKey({ ...vars, embedding_model: "minilm-multilingual" }),
    );
  } finally {
    cleanup();
  }
});
test("embedding override cannot escape browser route or start a model generation", async () => {
  const { cleanup } = setup();
  try {
    let calls = 0;
    const execute = async () => {
      calls++;
      return success();
    };
    assert.ok(
      (
        await callApi(
          "",
          {},
          {
            vars: variables(localRecord(), {
              embedding_model: "e5-small-multilingual",
            }),
          },
          execute,
        )
      ).error,
    );
    assert.ok(
      (
        await callApi(
          "",
          { config: { mode: "codex" } },
          {
            vars: {
              dataset: "legacy",
              case_id: "P01",
              question: localRecord().question,
              browser_eval_id: "garden-time-location",
              embedding_model: "e5-small-multilingual",
              top_k: 5,
            } as Variables,
          },
          execute,
        )
      ).error,
    );
    assert.equal(calls, 0);
  } finally {
    cleanup();
  }
});
test(
  "process timeout uses remaining shared window; failed attempt consumes budget without retry",
  { skip: !lockBinary },
  async () => {
    const { directory, cleanup } = setup();
    try {
      process.env.COA_RAG_BINARY = lockBinary;
      Object.assign(process.env, {
        COA_PROMPTFOO_ALLOW_CODEX: "1",
        COA_PROMPTFOO_LEDGER: join(directory, "ledger.json"),
        COA_PROMPTFOO_MAX_GENERATIONS: "8",
        COA_PROMPTFOO_MAX_SECONDS: "900",
      });
      writeFileSync(
        process.env.COA_PROMPTFOO_LEDGER!,
        JSON.stringify({
          schema_version: 1,
          started_at: Date.now() / 1000 - 880,
          max_generations: 8,
          max_seconds: 900,
          attempts: [],
          stopped: false,
        }),
      );
      let calls = 0;
      const result = await callApi(
        "",
        {},
        { vars: variables(localRecord(), { mode: "codex" }) },
        async (command, _env, timeout) => {
          calls++;
          assert.ok(timeout > 0 && timeout <= 20);
          writeFileSync(
            command[command.indexOf("--output") + 1],
            JSON.stringify({
              live: {
                status: "completed",
                question: localRecord().question,
                run_id: "native-one",
                run: { model: "gpt-6.1-sol" },
              },
            }) + "\n",
          );
          return success();
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(calls, 1);
      process.env.COA_PROMPTFOO_LEDGER = join(directory, "failed.json");
      const fail = async () => {
        calls++;
        return {
          returncode: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("private"),
        };
      };
      assert.ok(
        (
          await callApi(
            "",
            {},
            { vars: variables(localRecord(), { mode: "codex" }) },
            fail,
          )
        ).error,
      );
      assert.ok(
        (
          await callApi(
            "",
            {},
            { vars: variables(localRecord(), { mode: "codex" }) },
            fail,
          )
        ).error,
      );
      assert.equal(calls, 2);
      const state = JSON.parse(
        readFileSync(process.env.COA_PROMPTFOO_LEDGER!, "utf8"),
      );
      assert.equal(state.attempts.length, 1);
      assert.equal(state.stopped, true);
    } finally {
      cleanup();
    }
  },
);
test(
  "verified model defect consumes attempt and keeps quality unknown; auth errors stop batch",
  { skip: !lockBinary },
  async () => {
    const { directory, cleanup } = setup();
    try {
      process.env.COA_RAG_BINARY = lockBinary;
      Object.assign(process.env, {
        COA_PROMPTFOO_ALLOW_CODEX: "1",
        COA_PROMPTFOO_LEDGER: join(directory, "ledger.json"),
        COA_PROMPTFOO_MAX_GENERATIONS: "8",
        COA_PROMPTFOO_MAX_SECONDS: "900",
        COA_PROMPTFOO_PHASE: "smoke",
        COA_PROMPTFOO_CASES: "RAG26-01",
        COA_PROMPTFOO_REPEATS: "1",
      });
      const question = JSON.parse(
        readFileSync(
          new URL(
            "../../../shared/datasets/strengthened-10-20261106/questions.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ).cases[0].question;
      const frozen = JSON.parse(
        readFileSync(
          new URL(
            "../../../shared/datasets/strengthened-10-20261106/FROZEN.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const context: Context = {
        vars: {
          ...DEFAULTS,
          mode: "codex",
          method: "dense",
          dataset: "strengthened-10-20261106",
          case_id: "RAG26-01",
          question,
        },
        test: { metadata: { suite: "models" } },
      };
      let prematureCalls = 0;
      const mustNotExecute = async () => {
        prematureCalls++;
        return success();
      };
      process.env.COA_PROMPTFOO_PHASE = "plan";
      assert.ok((await callApi("", {}, context, mustNotExecute)).error);
      assert.equal(existsSync(process.env.COA_PROMPTFOO_LEDGER!), false);
      writeFileSync(join(directory, "codex"), "fake Codex");
      writeFileSync(join(directory, "codex-code-mode-host"), "fake host");
      Object.assign(process.env, {
        COA_CODEX_BIN: join(directory, "codex"),
        COA_PROMPTFOO_ALLOW_CODEX: "0",
        COA_PROMPTFOO_PHASE: "pilot",
        COA_PROMPTFOO_MAX_GENERATIONS: "60",
        COA_PROMPTFOO_MAX_SECONDS: "7200",
      });
      assert.ok((await callApi("", {}, context, mustNotExecute)).error);
      assert.equal(
        existsSync(join(directory, "ledger.models-state.json")),
        false,
      );
      assert.equal(prematureCalls, 0);
      Object.assign(process.env, {
        COA_PROMPTFOO_ALLOW_CODEX: "1",
        COA_PROMPTFOO_PHASE: "smoke",
        COA_PROMPTFOO_MAX_GENERATIONS: "8",
        COA_PROMPTFOO_MAX_SECONDS: "900",
      });
      const raw = {
        schema_version: 1,
        dataset_id: context.vars.dataset,
        case_id: context.vars.case_id,
        requested_model: "gpt-6.1-sol",
        dataset: { corpus_sha256: frozen.integrity.corpus_sha256 },
        live: {
          schema_version: 2,
          status: "failed",
          question,
          run_id: "verified-failed-model",
          run: null,
          error: "model_contract_violation",
          safe_diagnostic: {
            category: "model_contract_violation",
            stage: "agent_event_validation",
            exit_code: 0,
            json_event_lines_valid: true,
            event_types: ["turn.completed"],
            item_types: ["agent_message"],
            provider_error_code: null as string | null,
            validation_reason: "missing_required_search",
            tool_event_category: "none",
          },
          audit_trace: null,
          trace_integrity_status: "not_checked",
          source_guard_passed: null,
        },
      };
      const execute = async (command: string[]) => {
        writeFileSync(
          command[command.indexOf("--output") + 1],
          JSON.stringify(raw) + "\n",
        );
        return {
          returncode: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("private"),
        };
      };
      const result = await callApi("", {}, context, execute);
      assert.equal(result.error, undefined);
      const state = JSON.parse(
        readFileSync(process.env.COA_PROMPTFOO_LEDGER!, "utf8"),
      );
      assert.equal(state.stopped, false);
      assert.equal(state.attempts[0].status, "model_contract_violation");
      const grade = getModelAssert(result.output, context);
      assert.equal(grade.pass, false);
      assert.equal(
        grade.metadata!.source_metrics.model_failure_class,
        "model_contract_violation",
      );
      assert.ok(!("source_complete" in grade.namedScores));
      raw.live.safe_diagnostic.provider_error_code = "invalid_api_key";
      assert.ok((await callApi("", {}, context, execute)).error);
      assert.equal(
        JSON.parse(readFileSync(process.env.COA_PROMPTFOO_LEDGER!, "utf8"))
          .stopped,
        true,
      );
    } finally {
      cleanup();
    }
  },
);
test("prepared request hashes retain Python integral floats, zero, Unicode and default types", async () => {
  const { parseJson } = await import("../../scripts/model_trials.ts");
  const base = { dataset: "legacy", case_id: "P01", question: "é😀\u2028\n" };
  assert.equal(
    requestKey(base),
    "d5187d21baff9c3e7c16894deaa015f0359e60ac83fc583c0de738b3b4a4729a",
  );
  assert.equal(
    requestKey({ ...base, rrf_k: 60 }),
    "6a55ac58f168ad853a8c6fd7a1f6ad77e7d8d5eb007d675a4ee50970e8a94aca",
  );
  assert.equal(
    requestKey(
      parseJson(
        '{"dataset":"legacy","case_id":"P01","question":"é😀\\u2028\\n","rrf_k":0.0}',
      ),
    ),
    "87c6f838dd42795f75cc00e0f89e4e22c902615db40e5129b664fdb78008ccba",
  );
  assert.equal(
    requestKey(
      parseJson(
        '{"dataset":"legacy","case_id":"P01","question":"é😀\\u2028\\n","mmr_lambda":0.0,"vector_weight":1.0}',
      ),
    ),
    "5830a58b79629b23fc5757fad3906019e18590e94ada22b51e69bad425e77403",
  );
});
test(
  "real native timeout preserves failed reservation and cleans owned process descendants",
  { skip: !lockBinary, timeout: 20000 },
  async () => {
    const { directory, cleanup } = setup();
    try {
      const binary = join(directory, "fake-native"),
        pids = join(directory, "owned.json"),
        ledger = join(directory, "timed-out.json");
      writeFileSync(
        binary,
        `#!${process.execPath}\nimport {spawn,spawnSync} from 'node:child_process';import {writeFileSync} from 'node:fs';
if(process.argv[2]==='lock-exec'){const result=spawnSync(process.env.COA_TEST_REAL_LOCK_BINARY,process.argv.slice(2),{env:process.env,stdio:'inherit'});process.exit(result.status??1);}
process.on('SIGINT',()=>{});const child=spawn(process.execPath,['-e',"process.on('SIGINT',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});writeFileSync(process.env.COA_TEST_OWNED_PIDS,JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);\n`,
      );
      chmodSync(binary, 0o700);
      Object.assign(process.env, {
        COA_RAG_BINARY: binary,
        COA_TEST_REAL_LOCK_BINARY: lockBinary,
        COA_TEST_OWNED_PIDS: pids,
        COA_PROMPTFOO_ALLOW_CODEX: "1",
        COA_PROMPTFOO_LEDGER: ledger,
        COA_PROMPTFOO_MAX_GENERATIONS: "8",
        COA_PROMPTFOO_MAX_SECONDS: "6",
      });
      const result = await callApi(
        "",
        {},
        { vars: variables(localRecord(), { mode: "codex" }) },
      );
      assert.ok(result.error);
      assert.ok(
        existsSync(pids),
        "the real fake native child must actually start",
      );
      const state = JSON.parse(readFileSync(ledger, "utf8"));
      assert.equal(state.attempts.length, 1);
      assert.equal(state.attempts[0].status, "failed");
      assert.equal(state.stopped, true);
      const owned = JSON.parse(readFileSync(pids, "utf8")) as number[];
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const pid of owned) assert.throws(() => process.kill(pid, 0));
      assert.ok(
        (
          await callApi(
            "",
            {},
            { vars: variables(localRecord(), { mode: "codex" }) },
          )
        ).error,
      );
      assert.equal(JSON.parse(readFileSync(ledger, "utf8")).attempts.length, 1);
    } finally {
      cleanup();
    }
  },
);
