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
  NativeConfig,
  EmbeddingSpec,
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
export const PREPARATION_FAILURES = {
  onnx_model_compile_io:
    "Het ONNX-model kon niet worden gecompileerd (I/O-fout).",
  local_preparation_failed:
    "De lokale voorbereiding is mislukt; de bronzoekactie is niet afgerond.",
} as const;
function preparationFailed(
  base: string,
  privateReason: string,
  nativeRunId?: string,
): never {
  // Native errors can contain private cache paths. Publish the known cause,
  // while leaving the complete original record in its private native.jsonl.
  const code =
    /ONNX/i.test(privateReason) &&
    /compil/i.test(privateReason) &&
    /I\/O/i.test(privateReason)
      ? "onnx_model_compile_io"
      : "local_preparation_failed";
  const message = PREPARATION_FAILURES[code];
  writeNew(join(base, "preparation-error.json"), {
    schema_version: 1,
    code,
    message,
    stage: "local_preparation",
    native_run_id:
      typeof nativeRunId === "string" &&
      /^[a-zA-Z0-9_.-]{1,240}$/.test(nativeRunId)
        ? nativeRunId
        : null,
  });
  throw new Error(message);
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
        preparationFailed(base, result.stderr.toString());
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
      preparationFailed(base, result.stderr.toString());
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
      if (row.execution_status !== "completed" || !row.outcome) {
        const reason =
          "error" in row && typeof row.error === "string" ? row.error : "";
        preparationFailed(base, reason, row.run_id);
      }
      if (group.embedding_model) {
        const actual = row.outcome?.corpus_identity?.embedding,
          expected =
            group.settings.method === "bm25"
              ? null
              : embeddingModels[group.embedding_model];
        if (actual === undefined || !same(actual, expected))
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

/** One question/execution; no model, corpus or vector state survives this batch. */
export async function prepareBenchmarkBatch(
  request: PrepareRequest,
  output: string,
  execute: Executor = runCancellable,
): Promise<PreparedManifest> {
  if (request.schema_version !== 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.execution_id) || !request.tests.length)
    throw new Error("Expected a fresh single-question benchmark batch");
  if (existsSync(output)) throw new Error("Choose a new prepared manifest");
  const first = request.tests[0].vars;
  if (!["demo-12-20261118", "regression-12-20261118"].includes(first.dataset))
    throw new Error("Benchmark batch requires a current twelve-document question");
  const base = resolve(process.env.COA_PROMPTFOO_ARTIFACT_DIR!);
  mkdirSync(base, {recursive:true,mode:0o700});
  const selected = new Map<string, {vars:Variables;config:NativeConfig;model?:string}>();
  for (const {vars} of request.tests) {
    if (vars.dataset !== first.dataset || vars.case_id !== first.case_id || vars.mode !== "local" ||
        vars.question !== question(first.dataset, first.case_id) || Object.keys(vars.filters ?? {}).length || vars.apply_filters)
      throw new Error("Benchmark batch must contain only one unchanged local question");
    const key = requestKey(vars);
    if (selected.has(key)) throw new Error("Duplicate benchmark request identity");
    const retrieval = Object.fromEntries(Object.keys(DEFAULTS).filter(key=>!["mode","profile","model"].includes(key)).map(key=>[key,vars[key as keyof Variables] ?? DEFAULTS[key as keyof Settings]])) as unknown as NativeConfig["retrieval"];
    const model = vars.method === "bm25" ? undefined : browserEmbeddingModel(vars) ?? "minilm-multilingual";
    selected.set(key,{vars,config:{profile:vars.profile,retrieval},...(model?{model}:{})});
  }
  const binary = realpathSync(process.env.COA_RAG_BINARY!);
  const input = join(base,"benchmark-native-input.json"), native = join(base,"native.jsonl"), modelsPath=join(base,"benchmark-embeddings.json");
  writeNew(input,{schema_version:1,execution_id:request.execution_id,dataset:first.dataset,case_id:first.case_id,
    requests:[...selected].map(([request_id,row])=>({request_id,...(row.model?{embedding_model:row.model}:{}),config:row.config}))});
  const result = await execute([binary,"lab","benchmark-batch","--input",input,"--output",native,"--embedding-manifest",modelsPath,
    "--model-cache",resolve(process.env.COA_RAG_MODEL_CACHE ?? join(ROOT,".model-cache")),"--sqlite-dir",join(base,"retrieval-cache")],
    {...childEnvironment(),TOKENIZERS_PARALLELISM:"false",RAYON_NUM_THREADS:"2"},3600,ROOT);
  if (result.returncode !== 0) preparationFailed(base,result.stderr.toString());
  const models = parseJson<{schema_version:number;execution_id:string;models:Record<string,Embedding>}>(readFileSync(modelsPath,"utf8"));
  if (models.schema_version !== 1 || models.execution_id !== request.execution_id)
    throw new Error("Prepared model identities belong to another benchmark execution");
  const specs = parseJson<EmbeddingSpec[]>(readFileSync(join(ROOT,"evals/rag/embedding-models.json"),"utf8"));
  const expectedModels = new Set([...selected.values()].flatMap(row=>row.model?[row.model]:[]));
  for (const [model,identity] of Object.entries(models.models)) {
    const spec=specs.find(row=>row.id===model);
    if (!expectedModels.has(model) || !spec || identity.provider!=="local-fastembed" || !identity.model.startsWith(spec.repository+"@") ||
        !/^[a-f0-9]{40}$/i.test(identity.model.slice(spec.repository.length+1)) || identity.sdk!==spec.sdk || identity.dimensions!==spec.dimensions ||
        (identity.document_prefix??"")!==spec.document_prefix || (identity.query_prefix??"")!==spec.query_prefix ||
        !identity.encoding.startsWith(spec.encoding+"; model_files_sha256=") || !/[a-f0-9]{64}$/.test(identity.encoding))
      throw new Error("Prepared embedding identity differs from the selected model");
  }
  const frozen = parseJson<{corpus_sha256:string;as_of:string}>(readFileSync(join(ROOT,"evals/shared/datasets",first.dataset,"questions.json"),"utf8"));
  const rows = readFileSync(native,"utf8").split("\n").filter(Boolean).map(line=>parseJson<{request_id:string;record:NativeRecord & {batch_id:string}}>(line));
  if (rows.length!==selected.size || new Set(rows.map(row=>row.request_id)).size!==selected.size || new Set(rows.map(row=>row.record.run_id)).size!==selected.size)
    throw new Error("Native benchmark returned missing or duplicate executions");
  const manifest:PreparedManifest={schema_version:1,execution_id:request.execution_id,created_at:Date.now()/1000,execution_mode:"fresh_batch_retrieval",records:{},groups:1,
    runtime_binary_sha256:sha256(readFileSync(binary)),embedding_manifest:{path:modelsPath,sha256:sha256(readFileSync(modelsPath))}};
  for (const {request_id,record} of rows) {
    const expected=selected.get(request_id);
    const noFilters=same(record.request_filters,{}) || same(record.request_filters,{weekdays:[],environment:null,time:null});
    if (!expected || !record.batch_id.startsWith(request.execution_id+"-native-") || record.run_id!==record.batch_id+"--"+request_id ||
        record.case_id!==first.case_id || record.question!==first.question || record.dataset.corpus_sha256!==frozen.corpus_sha256 || record.dataset.as_of!==frozen.as_of ||
        !same(record.config,expected.config) || !noFilters)
      throw new Error("Native benchmark execution differs from its selected request");
    if (record.execution_status==="completed") {
      if (!record.outcome || record.outcome.query!==first.question || !same(record.outcome.config,expected.config.retrieval) ||
          !same(record.outcome.corpus_identity.embedding,expected.model?models.models[expected.model]:null))
        throw new Error("Native benchmark corpus or embedding binding differs");
    }
    const path=join(base,request_id+".json");
    writeNew(path,record);
    manifest.records[request_id]={path,sha256:sha256(readFileSync(path)),run_id:record.run_id,case_id:record.case_id};
  }
  writeNew(output,manifest);
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
