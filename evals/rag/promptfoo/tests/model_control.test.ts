import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  authorizeModel,
  finishModel,
  orderedSchedule,
  executionSchedule,
  requireApproval,
  bindCommon,
  boundNative,
  DATASET,
  DATA,
  caseIds,
  classifyResult,
} from "../model_control.ts";
import { jsonHash } from "../../scripts/model_trials.ts";
import { isolateEnvironment } from "./environment.ts";
import { readJson, sha256 } from "../json.ts";
import type { NativeRecord } from "../types.ts";
const binary = process.env.COA_TEST_LOCK_BINARY ?? process.env.COA_RAG_BINARY;
function setup() {
  const restore = isolateEnvironment(),
    directory = mkdtempSync(join(tmpdir(), "coa-model-"));
  writeFileSync(join(directory, "codex"), "fakeCodex");
  writeFileSync(join(directory, "codex-code-mode-host"), "fakeHost");
  Object.assign(process.env, {
    COA_RAG_BINARY: binary,
    COA_CODEX_BIN: join(directory, "codex"),
    COA_PROMPTFOO_LEDGER: join(directory, "ledger.json"),
    COA_PROMPTFOO_PHASE: "pilot",
    COA_PROMPTFOO_MAX_GENERATIONS: "60",
    COA_PROMPTFOO_MAX_SECONDS: "7200",
  });
  return {
    directory,
    cleanup: () => {
      restore();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function completed(
  directory: string,
  model: string,
  caseId: string,
): { record: NativeRecord; path: string } {
  const prereg = readJson<{ runtime_binaries: Record<string, string> }>(
    join(directory, "ledger.models-prereg.json"),
  );
  const freeze = readJson<{
    integrity: {
      corpus_sha256: string;
      sources: { id: string; date: string }[];
    };
  }>(join(DATA, "FROZEN.json")).integrity;
  const question = readJson<{ cases: { id: string; question: string }[] }>(
    join(DATA, "questions.json"),
  ).cases.find((row) => row.id === caseId)!.question;
  const identity = {
    source_sha256: "source",
    embedding_inputs_sha256: "inputs",
    vectors_sha256: "vectors",
    embedding: null,
  };
  const audit = join(directory, "audit-" + caseId + model + ".jsonl");
  writeFileSync(
    audit,
    JSON.stringify({
      full_response: {
        sources: freeze.sources.map((source) => ({
          id: source.id,
          date: source.date,
        })),
        manifest: { corpus_identity: identity },
      },
    }) + "\n",
  );
  const record = {
    dataset_id: DATASET,
    dataset: { corpus_sha256: freeze.corpus_sha256 },
    case_id: caseId,
    requested_model: model,
    live: {
      status: "completed",
      question,
      source_guard_passed: true,
      trace_integrity_status: "validated",
      audit_trace: { path: audit, sha256: sha256(readFileSync(audit)) },
      runtime_configuration: {
        model,
        binaries: prereg.runtime_binaries,
        reasoning_effort: "low",
      },
      run: {
        status: "completed",
        model,
        manifest: { corpus_identity: identity },
      },
    },
  } as unknown as NativeRecord;
  const path = join(directory, "native-" + caseId + model + ".jsonl");
  writeFileSync(path, JSON.stringify(record) + "\n");
  return { record, path };
}
test("model schedule retains exact balanced sixty slots and pilot interleaving", () => {
  const rows = orderedSchedule();
  assert.equal(rows.length, 60);
  assert.deepEqual(
    rows.slice(0, 4).map((row) => row.model),
    ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-luna", "gpt-6.1-sol"],
  );
  assert.ok(rows.slice(0, 4).every((row) => row.phase === "pilot"));
});
test("pilot approval requires independent reviewer and exact preregistration/attempt hashes", () => {
  const attempts = orderedSchedule()
    .slice(0, 4)
    .map((row, i) => ({
      ...row,
      status: "completed",
      record_sha256: String(i),
    }));
  const approval = {
    approved: true,
    reviewer: "independent",
    preregistration_sha256: "prereg",
    pilot_attempts_sha256: jsonHash(attempts),
  };
  requireApproval(approval, "prereg", attempts);
  assert.throws(() => requireApproval(approval, "different", attempts));
  assert.throws(() =>
    requireApproval({ ...approval, reviewer: "" }, "prereg", attempts),
  );
  assert.throws(() =>
    requireApproval(approval, "prereg", [
      { ...attempts[0], record_sha256: "changed" },
      ...attempts.slice(1),
    ]),
  );
});
test(
  "pilot cannot skip retry or resume a reserved/failed slot",
  { skip: !binary },
  async () => {
    const { cleanup } = setup();
    try {
      const row = orderedSchedule()[0];
      await assert.rejects(
        authorizeModel({ ...row, case_id: "RAG26-10" }),
        /order|slot/,
      );
      const token = await authorizeModel(row);
      await assert.rejects(authorizeModel(row), /Uncertain|reserved|failed/);
      assert.equal((await finishModel(token, null, 1, null)).status, "failed");
      await assert.rejects(authorizeModel(row), /stopped|failed|Uncertain/);
    } finally {
      cleanup();
    }
  },
);
test(
  "explicit small smoke does not create a fake pilot",
  { skip: !binary },
  async () => {
    const { directory, cleanup } = setup();
    try {
      Object.assign(process.env, {
        COA_PROMPTFOO_PHASE: "smoke",
        COA_PROMPTFOO_CASES: "RAG26-01",
        COA_PROMPTFOO_REPEATS: "1",
        COA_PROMPTFOO_MAX_GENERATIONS: "8",
        COA_PROMPTFOO_MAX_SECONDS: "900",
      });
      assert.equal(
        (await authorizeModel({ case_id: "RAG26-01", model: "gpt-6.1-sol" }))
          .smoke,
        true,
      );
      assert.equal(
        existsSync(join(directory, "ledger.models-state.json")),
        false,
      );
      process.env.COA_PROMPTFOO_REPEATS = "3";
      await assert.rejects(
        authorizeModel({ case_id: "RAG26-01", model: "gpt-6.1-sol" }),
      );
    } finally {
      cleanup();
    }
  },
);
test(
  "pilot saves verified evidence, resumes prefix, requires approval, and detects changed bytes",
  { skip: !binary },
  async () => {
    const { directory, cleanup } = setup();
    try {
      assert.deepEqual(
        executionSchedule().map((row) => row.slot),
        [1, 2, 3, 4],
      );
      for (const row of orderedSchedule().slice(0, 4)) {
        const token = await authorizeModel(row);
        assert.throws(() => executionSchedule(), /Uncertain|reserved/);
        const { record, path } = completed(directory, row.model, row.case_id);
        assert.equal(
          (await finishModel(token, record, 0, path)).status,
          "completed",
        );
        if (row.slot === 1)
          assert.deepEqual(
            executionSchedule().map((row) => row.slot),
            [2, 3, 4],
          );
      }
      await assert.rejects(authorizeModel(orderedSchedule()[4]), /Pilot ends/);
      process.env.COA_PROMPTFOO_PHASE = "remaining";
      await assert.rejects(authorizeModel(orderedSchedule()[4]));
      const state = readJson<{
        preregistration_sha256: string;
        attempts: unknown[];
      }>(join(directory, "ledger.models-state.json"));
      writeFileSync(
        join(directory, "PILOT_APPROVED.json"),
        JSON.stringify({
          approved: true,
          reviewer: "independent",
          preregistration_sha256: state.preregistration_sha256,
          pilot_attempts_sha256: jsonHash(state.attempts),
        }),
      );
      const token = await authorizeModel(orderedSchedule()[4]);
      assert.equal(token.slot, 5);
      const row = orderedSchedule()[4],
        { record, path } = completed(directory, row.model, row.case_id);
      assert.equal(
        (await finishModel(token, record, 0, path)).status,
        "completed",
      );
      assert.equal(executionSchedule()[0].slot, 6);
      writeFileSync(path, "changed");
      assert.throws(() => executionSchedule(), /evidence changed/);
    } finally {
      cleanup();
    }
  },
);
test(
  "pinned runtime modifications reject resume",
  { skip: !binary },
  async () => {
    const { directory, cleanup } = setup();
    try {
      const row = orderedSchedule()[0],
        token = await authorizeModel(row),
        { record, path } = completed(directory, row.model, row.case_id);
      await finishModel(token, record, 0, path);
      writeFileSync(join(directory, "codex"), "changed");
      await assert.rejects(authorizeModel(orderedSchedule()[1]), /Pinned/);
    } finally {
      cleanup();
    }
  },
);
test("models share actual binaries and complete corpus embedding/vector identity", () => {
  const pins = { codex: "c", code_mode_host: "h", mcp: "m" },
    identity = {
      source_sha256: "s",
      embedding_inputs_sha256: "i",
      vectors_sha256: "v",
      embedding: null,
    };
  const record = (model: string) =>
    ({
      requested_model: model,
      live: {
        runtime_configuration: {
          model,
          binaries: { ...pins },
          reasoning_effort: "low",
        },
        run: { manifest: { corpus_identity: structuredClone(identity) } },
      },
    }) as unknown as NativeRecord;
  const state = {};
  bindCommon(state, record("gpt-6.1-sol"), { runtime_binaries: pins }, null);
  bindCommon(state, record("gpt-6-luna"), { runtime_binaries: pins }, null);
  const changed = record("gpt-6-luna");
  changed.live!.runtime_configuration!.binaries.code_mode_host = "changed";
  assert.throws(
    () => bindCommon(state, changed, { runtime_binaries: pins }, null),
    /runtime/,
  );
  for (const field of [
    "source_sha256",
    "embedding_inputs_sha256",
    "vectors_sha256",
  ] as const) {
    const other = record("gpt-6-luna");
    other.live!.run!.manifest.corpus_identity[field] = "changed";
    assert.throws(
      () => bindCommon(state, other, { runtime_binaries: pins }, null),
      /embedding\/vector/,
    );
  }
  const other = record("gpt-6-luna");
  other.live!.run!.manifest.corpus_identity.embedding = {
    provider: "changed",
    model: "changed",
    sdk: "changed",
    dimensions: 768,
    encoding: "changed",
  };
  assert.throws(
    () => bindCommon(state, other, { runtime_binaries: pins }, null),
    /embedding\/vector/,
  );
});
test("proven no-search model contract failure may have no audit but corruption cannot pass", () => {
  const directory = mkdtempSync(join(tmpdir(), "coa-bound-"));
  try {
    const path = join(directory, "native.jsonl");
    writeFileSync(path, "native");
    const question = readJson<{ cases: { question: string }[] }>(
        join(DATA, "questions.json"),
      ).cases[0].question,
      corpus = readJson<{ integrity: { corpus_sha256: string } }>(
        join(DATA, "FROZEN.json"),
      ).integrity.corpus_sha256;
    const record = {
        dataset_id: DATASET,
        dataset: { corpus_sha256: corpus },
        case_id: caseIds()[0],
        requested_model: "gpt-6.1-sol",
        live: {
          question,
          run: null,
          safe_diagnostic: { validation_reason: "missing_required_search" },
        },
      } as unknown as NativeRecord,
      token = { smoke: true, case_id: caseIds()[0], model: "gpt-6.1-sol" };
    assert.deepEqual(
      boundNative(token, record, path, "model_contract_violation"),
      [realpathSync(path), null],
    );
    record.live!.trace_integrity_status = "invalid";
    assert.throws(() =>
      boundNative(token, record, path, "model_contract_violation"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("network authentication trace and unknown failures never become model outcomes", () => {
  assert.equal(classifyResult(null, 1), "failed");
  const record = {
    live: {
      status: "failed",
      error: "network_error",
      run: null,
      safe_diagnostic: {},
    },
  } as unknown as NativeRecord;
  assert.equal(classifyResult(record, 1), "failed");
  Object.assign(record.live!, {
    error: "model_output_invalid",
    safe_diagnostic: {
      category: "model_output_invalid",
      stage: "agent_event_validation",
      exit_code: 0,
      json_event_lines_valid: true,
      event_types: ["turn.completed"],
      item_types: ["agent_message"],
      validation_reason: "invalid_model_answer",
    },
  });
  assert.equal(classifyResult(record, 1), "model_output_invalid");
  record.live!.safe_diagnostic!.event_types!.push("turn.failed");
  assert.equal(classifyResult(record, 1), "failed");
});
test("explicit null treatment never silently defaults or consumes a model slot", async () => {
  const { directory, cleanup } = setup();
  try {
    Object.assign(process.env, {
      COA_PROMPTFOO_PHASE: "smoke",
      COA_PROMPTFOO_CASES: "RAG26-01",
      COA_PROMPTFOO_REPEATS: "1",
      COA_PROMPTFOO_MAX_GENERATIONS: "8",
      COA_PROMPTFOO_MAX_SECONDS: "900",
    });
    for (const field of ["method", "rrf_k", "apply_filters"])
      await assert.rejects(
        authorizeModel(
          JSON.parse(
            JSON.stringify({
              case_id: "RAG26-01",
              model: "gpt-6.1-sol",
              [field]: null,
            }),
          ),
        ),
        /treatment/,
      );
    assert.equal(
      existsSync(join(directory, "ledger.models-state.json")),
      false,
    );
  } finally {
    cleanup();
  }
});
