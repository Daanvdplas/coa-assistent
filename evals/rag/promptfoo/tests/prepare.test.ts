import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepare } from "../prepare.ts";
import { DEFAULTS, callApi, question, requestKey, ROOT } from "../provider.ts";
import type { Executor } from "../provider.ts";
import type {
  Embedding,
  EmbeddingSpec,
  NativeRecord,
  PreparedManifest,
  Variables,
} from "../types.ts";
import { canonicalJson, readJson, sha256 } from "../json.ts";
import { localRecord, variables } from "./fixtures.ts";
import { isolateEnvironment } from "./environment.ts";
function setup(t: test.TestContext) {
  t.after(isolateEnvironment());
  const root = mkdtempSync(join(tmpdir(), "coa-prepare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "runtime");
  writeFileSync(binary, "#!fake", { mode: 0o700 });
  Object.assign(process.env, {
    COA_RAG_BINARY: binary,
    COA_PROMPTFOO_ARTIFACT_DIR: join(root, "artifacts"),
    COA_PROMPTFOO_EXECUTION_ID: "fresh-test-execution",
  });
  const rows = ["P01", "P02"].map((id) => ({
    vars: {
      ...DEFAULTS,
      filters: {},
      ...variables(localRecord(undefined, id)),
    },
  }));
  return { root, rows };
}
const completed = {
  returncode: 0,
  stdout: Buffer.from("{}"),
  stderr: Buffer.alloc(0),
};
test("exact selected cases share preparation without native assessment", async (t) => {
  const { root, rows } = setup(t),
    seen: string[][] = [];
  const execute: Executor = async (command) => {
    seen.push(command);
    const cases = command[command.indexOf("--cases") + 1].split(",");
    writeFileSync(
      command[command.indexOf("--output") + 1],
      cases
        .map((id) => canonicalJson(localRecord(undefined, id).record) + "\n")
        .join(""),
    );
    return completed;
  };
  const output = join(root, "prepared.json"),
    manifest = await prepare(
      { schema_version: 1, execution_id: "fresh-test-execution", tests: rows },
      output,
      execute,
    );
  assert.equal(seen.length, 1);
  assert.deepEqual(
    new Set(seen[0][seen[0].indexOf("--cases") + 1].split(",")),
    new Set(["P01", "P02"]),
  );
  assert.ok(!seen[0].includes("assess"));
  assert.equal(Object.keys(manifest.records).length, 2);
  process.env.COA_PROMPTFOO_PREPARED = output;
  let calls = 0;
  const result = await callApi("", {}, rows[0], async () => {
    calls++;
    return completed;
  });
  assert.equal(result.error, undefined);
  assert.equal(calls, 0);
  assert.equal(result.metadata?.execution_mode, "fresh_batch_retrieval");
});
test("native independent per-case filters are not overridden by a global flag", async (t) => {
  const { root } = setup(t);
  const rows = [
    ["IND26-01", { environment: "indoor" }],
    ["IND26-03", { weekdays: ["sunday"] }],
  ].map(([id, filters]) => ({
    vars: {
      ...DEFAULTS,
      mode: "local",
      apply_filters: true,
      selection: "activity_expansion",
      dataset: "independent-20261103",
      case_id: id as string,
      question: question("independent-20261103", id as string),
      filters,
    } as Variables,
  }));
  const observed: string[][] = [];
  const execute: Executor = async (command) => {
    observed.push(command);
    assert.ok(!command.includes("--query-filters"));
    const records = rows.map((row) => ({
      ...localRecord().record,
      case_id: row.vars.case_id,
      question: row.vars.question,
    }));
    writeFileSync(
      command[command.indexOf("--output") + 1],
      records.map((row) => canonicalJson(row) + "\n").join(""),
    );
    return completed;
  };
  await prepare(
    { schema_version: 1, execution_id: "fresh-test-execution", tests: rows },
    join(root, "ind-prepared.json"),
    execute,
  );
  assert.equal(observed.length, 1);
});
test("changed native record or wrong execution id is not a cache hit", async (t) => {
  const { root, rows } = setup(t),
    base = process.env.COA_PROMPTFOO_ARTIFACT_DIR!;
  mkdirSync(base);
  const native = join(base, "prepared-case.json"),
    original = canonicalJson(localRecord().record);
  writeFileSync(native, original);
  const manifest: PreparedManifest = {
    schema_version: 1,
    execution_id: "fresh-test-execution",
    records: {
      [requestKey(rows[0].vars)]: { path: native, sha256: sha256(original) },
    },
  };
  const output = join(root, "prepared.json");
  writeFileSync(output, JSON.stringify(manifest));
  process.env.COA_PROMPTFOO_PREPARED = output;
  let calls = 0;
  const execute: Executor = async () => {
    calls++;
    return completed;
  };
  const valid = await callApi("", {}, rows[0], execute);
  assert.equal(valid.error, undefined);
  assert.equal(valid.metadata?.execution_mode, "fresh_batch_retrieval");
  assert.equal(calls, 0);
  for (const changed of ["execution_id", "native_bytes"]) {
    writeFileSync(native, original + (changed === "native_bytes" ? " " : ""));
    process.env.COA_PROMPTFOO_EXECUTION_ID =
      changed === "execution_id" ? "another-execution" : "fresh-test-execution";
    assert.ok((await callApi("", {}, rows[0], execute)).error);
    assert.equal(calls, 0);
  }
});
test("browser preparation pins the resolved model before retrieval", async (t) => {
  const { root, rows } = setup(t),
    model = "e5-small-multilingual";
  const vars = {
    ...rows[0].vars,
    method: "dense",
    top_k: 5,
    browser_eval_id: "garden-time-location",
    embedding_model: model,
  };
  const spec = readJson<EmbeddingSpec[]>(
    join(ROOT, "evals/rag/embedding-models.json"),
  ).find((row) => row.id === model)!;
  const identity: Embedding = {
    provider: "local-fastembed",
    model: spec.repository + "@" + "a".repeat(40),
    sdk: spec.sdk,
    dimensions: spec.dimensions,
    encoding: spec.encoding + "; model_files_sha256=" + "b".repeat(64),
    document_prefix: spec.document_prefix,
    query_prefix: spec.query_prefix,
  };
  const seen: string[][] = [];
  const execute: Executor = async (command) => {
    seen.push(command);
    if (command[2] === "embedding-identity")
      return {
        ...completed,
        stdout: Buffer.from(
          JSON.stringify({
            model_id: model,
            embedding_identity: identity,
            identity_sha256: "c".repeat(64),
          }),
        ),
      };
    const record = localRecord().record as NativeRecord;
    record.outcome.corpus_identity.embedding = identity;
    writeFileSync(
      command[command.indexOf("--output") + 1],
      canonicalJson(record) + "\n",
    );
    return completed;
  };
  const manifest = await prepare(
    {
      schema_version: 1,
      execution_id: "fresh-test-execution",
      tests: [{ vars }],
    },
    join(root, "prepared-browser.json"),
    execute,
  );
  assert.equal(seen[0][2], "embedding-identity");
  assert.ok(seen[1].includes("--embedding-model"));
  const pin = manifest.embedding_manifest!,
    raw = readFileSync(pin.path);
  assert.equal(sha256(raw), pin.sha256);
  assert.deepEqual(JSON.parse(raw.toString()).models[model], identity);
});

test("native model compilation failure keeps its safe cause instead of comparing an absent outcome", async (t) => {
  const { root, rows } = setup(t);
  const binary = process.env.COA_RAG_BINARY!;
  const model = "e5-small-multilingual";
  const identity = {
    provider: "local-fastembed",
    model: "test-e5@" + "a".repeat(40),
    sdk: "fastembed 7.1.2",
    dimensions: 384,
    encoding: "fixture",
    document_prefix: "passage: ",
    query_prefix: "query: ",
  };
  const failed = {
    ...(localRecord().record as NativeRecord),
    execution_status: "failed",
    outcome: null,
    error:
      "Preparation failed: ONNX runtime error: Error compiling model: compiler error: I/O error at /Users/private/model-cache/key-file",
  };
  writeFileSync(
    binary,
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[1]==='embedding-identity'){process.stdout.write(JSON.stringify(${JSON.stringify({ model_id: model, embedding_identity: identity })}));}else{fs.writeFileSync(args[args.indexOf('--output')+1],JSON.stringify(${JSON.stringify(failed)})+'\\n');}\n`,
    { mode: 0o700 },
  );
  const output = join(root, "failed-prepared.json");
  await assert.rejects(
    prepare(
      {
        schema_version: 1,
        execution_id: "failed-native-fixture",
        tests: [
          {
            vars: {
              ...rows[0].vars,
              method: "dense",
              top_k: 5,
              browser_eval_id: "garden-time-location",
              embedding_model: model,
            },
          },
        ],
      },
      output,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ONNX/);
      assert.match(error.message, /I\/O/);
      assert.doesNotMatch(
        error.message,
        /Expected JSON protocol|\/Users\/|key-file/,
      );
      return true;
    },
  );
  const diagnostic = readJson<{
    code: string;
    message: string;
    native_run_id: string;
  }>(join(process.env.COA_PROMPTFOO_ARTIFACT_DIR!, "preparation-error.json"));
  assert.equal(diagnostic.code, "onnx_model_compile_io");
  assert.equal(diagnostic.native_run_id, failed.run_id);
  assert.doesNotMatch(JSON.stringify(diagnostic), /\/Users\/|key-file/);
  const base = process.env.COA_PROMPTFOO_ARTIFACT_DIR!;
  const directory = readdirSync(base).find((name) =>
    name.startsWith("prepared-"),
  )!;
  assert.equal(
    readFileSync(join(base, directory, "native.jsonl"), "utf8"),
    JSON.stringify(failed) + "\n",
    "the original failed native evidence stays byte-identical",
  );
});
