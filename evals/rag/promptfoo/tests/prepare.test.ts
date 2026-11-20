import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
test("single-question benchmark prepares different retrieval settings in one fresh native batch", async (t) => {
  const module = await import("../prepare.ts") as any;
  assert.equal(typeof module.prepareBenchmarkBatch,"function","benchmark variants need a shared native preparation entrypoint");
  const {root}=setup(t);
  const selected=[3,6].map(top_k=>({vars:{...DEFAULTS,method:"bm25",top_k,dataset:"demo-12-20261118",case_id:"RAG26-06",question:question("demo-12-20261118","RAG26-06")}}));
  let calls=0;
  const execute: Executor=async(command)=>{
    calls++;
    assert.equal(command[2],"benchmark-batch");
    const input=readJson<any>(command[command.indexOf("--input")+1]);
    assert.deepEqual(Object.keys(input).sort(),["case_id","dataset","execution_id","requests","schema_version"]);
    assert.equal(input.requests.length,2);
    assert.ok(input.requests.every((row:any)=>!row.embedding_model&&/^[a-f0-9]{64}$/.test(row.request_id)));
    const data=readJson<any>(join(ROOT,"evals/shared/datasets/demo-12-20261118/questions.json"));
    const native=input.requests.map((request:any)=>{
      const record=localRecord().record as any;
      const batch_id=input.execution_id+"-native-123-0";
      return {request_id:request.request_id,record:{...record,batch_id,run_id:batch_id+"--"+request.request_id,case_id:input.case_id,question:selected[0].vars.question,dataset:{...record.dataset,corpus_sha256:data.corpus_sha256,as_of:data.as_of},config:request.config,outcome:{...record.outcome,query:selected[0].vars.question,config:request.config.retrieval,corpus_identity:{...record.outcome.corpus_identity,embedding:null,vectors_sha256:null}},request_filters:{weekdays:[],environment:null,time:null}}};
    });
    writeFileSync(command[command.indexOf("--output")+1],native.reverse().map((row:any)=>canonicalJson(row)).join("\n")+"\n");
    writeFileSync(command[command.indexOf("--embedding-manifest")+1],JSON.stringify({schema_version:1,execution_id:input.execution_id,models:{}}));
    return completed;
  };
  const manifest=await module.prepareBenchmarkBatch({schema_version:1,execution_id:"fresh-test-execution",tests:selected},join(root,"benchmark-prepared.json"),execute);
  assert.equal(calls,1);
  assert.equal(Object.keys(manifest.records).length,2);
  assert.equal(new Set(Object.values(manifest.records).map((row:any)=>row.run_id)).size,2);
  assert.equal(manifest.execution_id,"fresh-test-execution");
  for(const test of selected){
    const entry=manifest.records[requestKey(test.vars)];
    const record=readJson<any>(entry.path);
    assert.equal(record.config.retrieval.top_k,test.vars.top_k,"native rows must map by request identity, never completion order");
    assert.equal(sha256(readFileSync(entry.path)),entry.sha256);
  }
});
test("benchmark worker grades the shared native batch with one existing promptfoo process", async (t) => {
  const workerPath=new URL("../../../benchmark/run_local_batch.ts",import.meta.url);
  assert.ok(existsSync(workerPath),"the benchmark needs one worker for its shared preparation and grading");
  const {runLocalBatch}=await import(workerPath.href);
  const {root}=setup(t),output=join(root,"worker");
  const vars={...DEFAULTS,method:"bm25",dataset:"demo-12-20261118",case_id:"RAG26-01",question:question("demo-12-20261118","RAG26-01")};
  const tests=[{vars,metadata:{suite:"quality"}}];
  const commands:string[][]=[];
  const execute:Executor=async(command,env)=>{
    commands.push(command);
    assert.equal(env.OPENAI_API_KEY,undefined);
    assert.equal(env.COA_PROMPTFOO_ALLOW_CODEX,undefined);
    if(command[2]==="benchmark-batch") {
      const input=readJson<any>(command[command.indexOf("--input")+1]),request=input.requests[0];
      const original=localRecord().record as any,data=readJson<any>(join(ROOT,"evals/shared/datasets/demo-12-20261118/questions.json")),batch_id=input.execution_id+"-native-123-0";
      writeFileSync(command[command.indexOf("--output")+1],canonicalJson({request_id:request.request_id,record:{...original,batch_id,run_id:batch_id+"--"+request.request_id,case_id:vars.case_id,question:vars.question,dataset:{...original.dataset,corpus_sha256:data.corpus_sha256,as_of:data.as_of},config:request.config,outcome:{...original.outcome,query:vars.question,config:request.config.retrieval,corpus_identity:{...original.outcome.corpus_identity,embedding:null,vectors_sha256:null}},request_filters:{weekdays:[],environment:null,time:null}}})+"\n");
      writeFileSync(command[command.indexOf("--embedding-manifest")+1],JSON.stringify({schema_version:1,execution_id:input.execution_id,models:{}}));
      return completed;
    }
    assert.equal(command[2],"eval");
    assert.ok(command.includes("--no-cache"));
    assert.equal(command[command.indexOf("--max-concurrency")+1],"1");
    const config=readJson<any>(command[command.indexOf("-c")+1]);
    assert.equal(config.tests.length,1);
    assert.ok(config.defaultTest.assert[0].value.endsWith("assertions.ts:getAssert"));
    assert.ok(config.providers[0].id.endsWith("provider.ts"));
    assert.equal(env.COA_PROMPTFOO_EXECUTION_ID,"fresh-worker-execution");
    assert.ok(env.COA_PROMPTFOO_PREPARED);
    writeFileSync(command[command.indexOf("-o")+1],JSON.stringify({evalId:"real-grader-fixture",results:{results:[{testCase:tests[0]}]}}));
    return {...completed,returncode:100};
  };
  const code=await runLocalBatch({schema_version:1,execution_id:"fresh-worker-execution",tests},output,process.env.COA_RAG_BINARY!,execute);
  assert.equal(code,100,"source misses remain completed grader outcomes");
  assert.equal(commands.length,2,"one native batch plus one promptfoo grader, no identity CLI or per-variant process");
});
test("benchmark worker preserves a private diagnostic for protocol failures",()=>{
  const worker=new URL("../../../benchmark/run_local_batch.ts",import.meta.url);
  const result=spawnSync(process.execPath,[worker.pathname],{encoding:"utf8"});
  assert.equal(result.status,1);
  assert.match(result.stderr,/Expected --input, --output-dir and --binary/);
});
for(const change of ["missing","duplicate-request","duplicate-execution","wrong-config","wrong-question","wrong-corpus","stale-execution","wrong-embedding","wrong-filters","unknown-filter-field"]){
  test(`shared benchmark rejects ${change} native evidence`,async(t)=>{
    const {prepareBenchmarkBatch}=await import("../prepare.ts");
    const {root}=setup(t),data=readJson<any>(join(ROOT,"evals/shared/datasets/demo-12-20261118/questions.json"));
    const selected=[3,6].map(top_k=>({vars:{...DEFAULTS,method:"bm25",top_k,dataset:"demo-12-20261118",case_id:"RAG26-01",question:question("demo-12-20261118","RAG26-01")}}));
    const execute:Executor=async(command)=>{
      const input=readJson<any>(command[command.indexOf("--input")+1]),batch_id=input.execution_id+"-native-123-0";
      const rows=input.requests.map((request:any)=>{
        const original=localRecord().record as any;
        return {request_id:request.request_id,record:{...original,batch_id,run_id:batch_id+"--"+request.request_id,case_id:input.case_id,question:selected[0].vars.question,
          dataset:{...original.dataset,corpus_sha256:data.corpus_sha256,as_of:data.as_of},config:request.config,request_filters:{},
          outcome:{...original.outcome,query:selected[0].vars.question,config:request.config.retrieval,corpus_identity:{...original.outcome.corpus_identity,embedding:null,vectors_sha256:null}}}};
      });
      if(change==="missing") rows.pop();
      if(change==="duplicate-request") rows[1].request_id=rows[0].request_id;
      if(change==="duplicate-execution") rows[1].record.run_id=rows[0].record.run_id;
      if(change==="wrong-config") rows[1].record.config=rows[0].record.config;
      if(change==="wrong-question") rows[1].record.question="Another question";
      if(change==="wrong-corpus") rows[1].record.dataset.corpus_sha256="0".repeat(64);
      if(change==="stale-execution") {rows[1].record.batch_id="previous-native-123-0";rows[1].record.run_id=rows[1].record.batch_id+"--"+rows[1].request_id;}
      if(change==="wrong-embedding") rows[1].record.outcome.corpus_identity.embedding={model:"other-model"};
      if(change==="wrong-filters") rows[1].record.request_filters={weekdays:["tuesday"],environment:null,time:null};
      if(change==="unknown-filter-field") rows[1].record.request_filters={weekdays:[],environment:null,time:null,extra:true};
      writeFileSync(command[command.indexOf("--output")+1],rows.map((row:any)=>canonicalJson(row)).join("\n")+"\n");
      writeFileSync(command[command.indexOf("--embedding-manifest")+1],JSON.stringify({schema_version:1,execution_id:input.execution_id,models:{}}));
      return completed;
    };
    await assert.rejects(prepareBenchmarkBatch({schema_version:1,execution_id:"fresh-negative-test",tests:selected},join(root,"negative-prepared.json"),execute),/Native benchmark/);
    assert.ok(!existsSync(join(root,"negative-prepared.json")),"invalid bindings must never become prepared evidence");
  });
}
test("one failed native variant is retained without discarding completed variants",async(t)=>{
  const {prepareBenchmarkBatch}=await import("../prepare.ts");
  const {root}=setup(t),data=readJson<any>(join(ROOT,"evals/shared/datasets/demo-12-20261118/questions.json"));
  const selected=[3,6].map(top_k=>({vars:{...DEFAULTS,method:"bm25",top_k,dataset:"demo-12-20261118",case_id:"RAG26-01",question:question("demo-12-20261118","RAG26-01")}}));
  const execute:Executor=async(command)=>{
    const input=readJson<any>(command[command.indexOf("--input")+1]),batch_id=input.execution_id+"-native-123-0";
    const rows=input.requests.map((request:any,index:number)=>{
      const original=localRecord().record as any;
      return {request_id:request.request_id,record:{...original,batch_id,run_id:batch_id+"--"+request.request_id,case_id:input.case_id,question:selected[0].vars.question,
        dataset:{...original.dataset,corpus_sha256:data.corpus_sha256,as_of:data.as_of},config:request.config,request_filters:{},execution_status:index?"failed":"completed",error:index?"fixture search failed":null,
        outcome:index?null:{...original.outcome,query:selected[0].vars.question,config:request.config.retrieval,corpus_identity:{...original.outcome.corpus_identity,embedding:null,vectors_sha256:null}}}};
    });
    writeFileSync(command[command.indexOf("--output")+1],rows.map((row:any)=>canonicalJson(row)).join("\n")+"\n");
    writeFileSync(command[command.indexOf("--embedding-manifest")+1],JSON.stringify({schema_version:1,execution_id:input.execution_id,models:{}}));
    return completed;
  };
  const path=join(root,"mixed-prepared.json"),manifest=await prepareBenchmarkBatch({schema_version:1,execution_id:"fresh-mixed-test",tests:selected},path,execute);
  assert.equal(Object.keys(manifest.records).length,2);
  process.env.COA_PROMPTFOO_PREPARED=path;
  process.env.COA_PROMPTFOO_EXECUTION_ID="fresh-mixed-test";
  const good=await callApi("",{},selected[0],async()=>{throw Error("prepared evidence must not rerun retrieval");});
  const failed=await callApi("",{},selected[1],async()=>{throw Error("a failed variant must not be retried");});
  assert.equal(good.error,undefined);
  assert.match(failed.error??"",/Native execution status: failed/);
  assert.equal(failed.metadata?.native_run_id,manifest.records[requestKey(selected[1].vars)].run_id,"failed searches retain their real execution identity");
  assert.equal(readJson<any>(manifest.records[requestKey(selected[1].vars)].path).outcome,null);
});
test("benchmark execution IDs match the native batch contract before starting a child",async(t)=>{
  const {prepareBenchmarkBatch}=await import("../prepare.ts");
  const {root}=setup(t);
  const vars={...DEFAULTS,method:"bm25",dataset:"demo-12-20261118",case_id:"RAG26-01",question:question("demo-12-20261118","RAG26-01")};
  let calls=0;
  for(const execution_id of ["contains.dot","a".repeat(129)]){
    await assert.rejects(prepareBenchmarkBatch({schema_version:1,execution_id,tests:[{vars}]},join(root,"invalid-id.json"),async()=>{calls++;return {...completed,returncode:1};}),/Expected a fresh/);
  }
  assert.equal(calls,0);
});
for(const treatment of ["matching","swapped","missing"]){
  test(`mixed MiniLM and E5 batch keeps ${treatment} model identities separate`,async(t)=>{
    const {prepareBenchmarkBatch}=await import("../prepare.ts");
    const {root}=setup(t),data=readJson<any>(join(ROOT,"evals/shared/datasets/demo-12-20261118/questions.json"));
    const base={...DEFAULTS,method:"dense",dataset:"demo-12-20261118",case_id:"RAG26-06",question:question("demo-12-20261118","RAG26-06")};
    const tests=[{vars:base},{vars:{...base,top_k:5,browser_eval_id:"quality-music",embedding_model:"e5-small-multilingual"}}];
    const specs=readJson<EmbeddingSpec[]>(join(ROOT,"evals/rag/embedding-models.json"));
    const models=Object.fromEntries(specs.map((spec,index)=>[spec.id,{provider:"local-fastembed",model:spec.repository+"@"+String(index+1).repeat(40),sdk:spec.sdk,dimensions:spec.dimensions,encoding:spec.encoding+"; model_files_sha256="+String(index+1).repeat(64),document_prefix:spec.document_prefix,query_prefix:spec.query_prefix}]));
    const execute:Executor=async(command)=>{
      const input=readJson<any>(command[command.indexOf("--input")+1]),batch_id=input.execution_id+"-native-123-0";
      assert.deepEqual(input.requests.map((request:any)=>request.embedding_model),["minilm-multilingual","e5-small-multilingual"]);
      const rows=input.requests.map((request:any,index:number)=>{
        const original=localRecord().record as any;
        const identity=models[treatment==="swapped"&&index===1?"minilm-multilingual":request.embedding_model];
        return {request_id:request.request_id,record:{...original,batch_id,run_id:batch_id+"--"+request.request_id,case_id:input.case_id,question:base.question,
          dataset:{...original.dataset,corpus_sha256:data.corpus_sha256,as_of:data.as_of},config:request.config,request_filters:{},
          outcome:{...original.outcome,query:base.question,config:request.config.retrieval,corpus_identity:{...original.outcome.corpus_identity,embedding:identity}}}};
      });
      writeFileSync(command[command.indexOf("--output")+1],rows.map((row:any)=>canonicalJson(row)).join("\n")+"\n");
      const pins={...models};if(treatment==="missing")delete pins["e5-small-multilingual"];
      writeFileSync(command[command.indexOf("--embedding-manifest")+1],JSON.stringify({schema_version:1,execution_id:input.execution_id,models:pins}));
      return completed;
    };
    const prepared=prepareBenchmarkBatch({schema_version:1,execution_id:"fresh-model-fixture",tests},join(root,"mixed-models.json"),execute);
    if(treatment!=="matching") await assert.rejects(prepared);
    else{
      const manifest=await prepared;
      assert.equal(Object.keys(manifest.records).length,2);
      const identities=readJson<any>(manifest.embedding_manifest!.path).models;
      assert.equal(identities["minilm-multilingual"].query_prefix,"");
      assert.equal(identities["e5-small-multilingual"].query_prefix,"query: ");
      assert.equal(identities["e5-small-multilingual"].document_prefix,"passage: ");
    }
  });
}
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
