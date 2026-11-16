/** Execute only the selected local requests, sharing preparation within one run. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runCancellable, parseJson } from "../scripts/model_trials.ts";
import { canonicalJson, same, sha256, writeNew } from "./json.ts";
import {
  browserEmbeddingModel,
  childEnvironment,
  commonArguments,
  DEFAULTS,
  question,
  requestKey,
  ROOT,
} from "./provider.ts";
import type { Executor } from "./provider.ts";
import type {
  Embedding,
  Filters,
  NativeRecord,
  PreparedManifest,
  Settings,
  Variables,
} from "./types.ts";
export interface PrepareRequest {
  schema_version: number;
  execution_id: string;
  tests: { vars: Variables }[];
}
interface Group {
  dataset: string;
  settings: Settings;
  embedding_model?: string;
  filters: Filters;
  tests: Variables[];
}
export async function prepare(
  request: PrepareRequest,
  output: string,
  execute: Executor = runCancellable,
): Promise<PreparedManifest> {
  if (
    request.schema_version !== 1 ||
    typeof request.execution_id !== "string" ||
    !request.execution_id
  )
    throw new Error("Expected a versioned, fresh promptfoo selection");
  if (existsSync(output)) throw new Error("Choose a new prepared manifest");
  const base = resolve(process.env.COA_PROMPTFOO_ARTIFACT_DIR!);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const binary = realpathSync(process.env.COA_RAG_BINARY!),
    cache = resolve(
      process.env.COA_RAG_MODEL_CACHE ?? join(ROOT, ".model-cache"),
    ),
    groups = new Map<string, Group>();
  for (const test of request.tests) {
    const variables = test.vars,
      settings = {
        ...DEFAULTS,
        ...Object.fromEntries(
          Object.keys(DEFAULTS)
            .filter((key) => key in variables)
            .map((key) => [key, variables[key as keyof Variables]]),
        ),
      } as Settings;
    if (settings.mode !== "local") continue;
    if (variables.question !== question(variables.dataset, variables.case_id))
      throw new Error("Selected question differs from frozen input");
    const embedding_model = browserEmbeddingModel(variables),
      filters = variables.filters ?? {};
    const key = canonicalJson(
      {
        dataset: variables.dataset,
        settings,
        embedding_model: embedding_model ?? null,
        filters: variables.dataset === "independent-20261103" ? null : filters,
      },
      true,
    );
    let group = groups.get(key);
    if (!group) {
      group = {
        dataset: variables.dataset,
        settings,
        embedding_model,
        filters,
        tests: [],
      };
      groups.set(key, group);
    }
    group.tests.push(variables);
  }
  const manifest: PreparedManifest = {
    schema_version: 1,
    execution_id: request.execution_id,
    created_at: Date.now() / 1000,
    execution_mode: "fresh_batch_retrieval",
    records: {},
    groups: groups.size,
    runtime_binary_sha256: sha256(readFileSync(binary)),
  };
  const embeddingModels: Record<string, Embedding> = {};
  for (const group of groups.values()) {
    const model = group.embedding_model;
    if (
      model &&
      group.settings.method !== "bm25" &&
      !(model in embeddingModels)
    ) {
      const result = await execute(
        [
          binary,
          "lab",
          "embedding-identity",
          "--embedding-model",
          model,
          "--model-cache",
          cache,
        ],
        childEnvironment(),
        3600,
        ROOT,
      );
      if (result.returncode !== 0)
        throw new Error(
          "Local embedding preparation failed; private process output not exported",
        );
      const resolved = parseJson<{
        model_id: string;
        embedding_identity: Embedding;
      }>(result.stdout.toString());
      if (
        resolved.model_id !== model ||
        !resolved.embedding_identity ||
        typeof resolved.embedding_identity !== "object" ||
        Array.isArray(resolved.embedding_identity)
      )
        throw new Error("Resolved model identity differs from selected model");
      embeddingModels[model] = resolved.embedding_identity;
    }
  }
  if (Object.keys(embeddingModels).length) {
    const path = join(base, "embedding-" + request.execution_id + ".json");
    writeNew(path, {
      schema_version: 1,
      execution_id: request.execution_id,
      models: embeddingModels,
    });
    manifest.embedding_manifest = { path, sha256: sha256(readFileSync(path)) };
  }
  for (const group of groups.values()) {
    const directory = mkdtempSync(join(base, "prepared-")),
      native = join(directory, "native.jsonl"),
      caseIds = [...new Set(group.tests.map((row) => row.case_id))].sort();
    const command = [
      binary,
      "lab",
      "run",
      "--dataset",
      group.dataset,
      "--cases",
      caseIds.join(","),
      ...commonArguments(group.settings),
      "--output",
      native,
      "--model-cache",
      cache,
      "--sqlite-dir",
      join(base, "retrieval-cache"),
    ];
    if (group.embedding_model)
      command.push("--embedding-model", group.embedding_model);
    if (
      group.dataset !== "independent-20261103" &&
      group.settings.apply_filters &&
      Object.keys(group.filters).length
    )
      command.push("--query-filters", JSON.stringify(group.filters));
    const result = await execute(command, childEnvironment(), 3600, ROOT);
    if (result.returncode !== 0)
      throw new Error(
        "Fresh local preparation failed; private process output not exported",
      );
    const rows = readFileSync(native, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => parseJson<NativeRecord>(line));
    if (
      rows.length !== caseIds.length ||
      new Set(rows.map((row) => row.case_id)).size !== caseIds.length ||
      rows.some((row) => !caseIds.includes(row.case_id))
    )
      throw new Error(
        "Native preparation returned missing, duplicate or unrequested cases",
      );
    const byCase = new Map(rows.map((row) => [row.case_id, row]));
    for (const variables of group.tests) {
      const row = byCase.get(variables.case_id)!;
      if (row.question !== variables.question)
        throw new Error("Prepared case query differs");
      if (group.embedding_model) {
        const actual = row.outcome?.corpus_identity?.embedding,
          expected =
            group.settings.method === "bm25"
              ? null
              : embeddingModels[group.embedding_model];
        if (!same(actual, expected))
          throw new Error(
            "Retrieved evidence differs from independently prepared embedding model",
          );
      }
      const key = requestKey(variables),
        path = join(directory, key + ".json");
      if (!existsSync(path)) writeNew(path, row);
      manifest.records[key] = {
        path,
        sha256: sha256(readFileSync(path)),
        run_id: row.run_id,
        case_id: row.case_id,
      };
    }
  }
  mkdirSync(dirname(output), { recursive: true });
  writeNew(output, manifest);
  return manifest;
}
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { input: { type: "string" }, output: { type: "string" } },
  });
  if (!values.input || !values.output)
    throw new Error("Usage: prepare.ts --input FILE --output NEW_FILE");
  const result = await prepare(
    parseJson<PrepareRequest>(readFileSync(values.input, "utf8")),
    resolve(values.output),
  );
  console.log(
    JSON.stringify({
      records: Object.keys(result.records).length,
      groups: result.groups,
      execution_id: result.execution_id,
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
