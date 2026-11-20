/** One selected question: shared native retrieval, then the unchanged promptfoo grader. */
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { prepareBenchmarkBatch } from "../rag/promptfoo/prepare.ts";
import type { PrepareRequest } from "../rag/promptfoo/prepare.ts";
import { childEnvironment, ROOT } from "../rag/promptfoo/provider.ts";
import type { Executor } from "../rag/promptfoo/provider.ts";
import { parseJson, runCancellable } from "../rag/scripts/model_trials.ts";
import { writeNew } from "../rag/promptfoo/json.ts";

export async function runLocalBatch(
  request: PrepareRequest,
  output: string,
  binary: string,
  execute: Executor = runCancellable,
): Promise<number> {
  mkdirSync(output, {recursive:true,mode:0o700});
  const env=childEnvironment();
  for(const key of Object.keys(env)) if(key.startsWith("COA_PROMPTFOO_")) delete env[key];
  delete env.COA_RESPONSES_TEST_URL;
  Object.assign(env,{
    COA_DISABLE_DOTENV:"1",COA_RAG_BINARY:resolve(binary),
    COA_PROMPTFOO_ARTIFACT_DIR:resolve(output),COA_PROMPTFOO_EXECUTION_ID:request.execution_id,
    PROMPTFOO_CONFIG_DIR:join(output,"promptfoo-home"),PROMPTFOO_DISABLE_TELEMETRY:"1",
    PROMPTFOO_DISABLE_SHARING:"1",PROMPTFOO_DISABLE_UPDATE:"1",PROMPTFOO_SELF_HOSTED:"1",
    TOKENIZERS_PARALLELISM:"false",RAYON_NUM_THREADS:"2",
  });
  // This worker has its own process; the existing provider/preparer use these bindings.
  for(const key of Object.keys(process.env)) if(key.startsWith("COA_PROMPTFOO_")) delete process.env[key];
  Object.assign(process.env,env);
  const prepared=join(output,"benchmark-prepared.json");
  const manifest=await prepareBenchmarkBatch(request,prepared,execute);
  env.COA_PROMPTFOO_PREPARED=prepared;
  env.COA_PROMPTFOO_EMBEDDING_MANIFEST=manifest.embedding_manifest!.path;
  env.COA_PROMPTFOO_EMBEDDING_MANIFEST_SHA256=manifest.embedding_manifest!.sha256;
  const config=join(output,"benchmark-config.json");
  writeNew(config,{
    description:"COA single-question local benchmark",
    prompts:["{{question}}"],
    providers:[{id:"file://"+join(ROOT,"evals/rag/promptfoo/provider.ts"),label:"coa-benchmark-runtime",config:{}}],
    tests:request.tests,
    defaultTest:{assert:[{type:"javascript",value:"file://"+join(ROOT,"evals/rag/promptfoo/assertions.ts")+":getAssert"}]},
    evaluateOptions:{maxConcurrency:1,maxRetries:0,cache:false},
    commandLineOptions:{maxConcurrency:1,maxRetries:0,cache:false},
  });
  const packageInfo=parseJson<{bin:string|{promptfoo:string}}>(readFileSync(join(ROOT,"node_modules/promptfoo/package.json"),"utf8"));
  const entry=typeof packageInfo.bin==="string"?packageInfo.bin:packageInfo.bin.promptfoo;
  const rawPath=join(output,"benchmark.json");
  const result=await execute([process.execPath,join(ROOT,"node_modules/promptfoo",entry),"eval","-c",config,
    "--no-cache","--max-concurrency","1","--no-share","--no-table","-o",rawPath],env,3600,ROOT);
  if(![0,100].includes(result.returncode)) throw new Error("The benchmark grader could not complete; native captures are preserved");
  const raw=parseJson<{evalId:string;results:{results:unknown[]}}>(readFileSync(rawPath,"utf8"));
  if(typeof raw.evalId!=="string"||!Array.isArray(raw.results?.results)||raw.results.results.length!==request.tests.length)
    throw new Error("The benchmark grader returned missing or duplicate variant results");
  writeNew(join(output,"benchmark-summary.json"),{schema_version:1,execution_id:request.execution_id,
    evalId:raw.evalId,result_count:raw.results.results.length,exit_code:result.returncode});
  return result.returncode;
}

async function main() {
  const {values}=parseArgs({options:{input:{type:"string"},"output-dir":{type:"string"},binary:{type:"string"}}});
  if(!values.input||!values["output-dir"]||!values.binary) throw new Error("Expected --input, --output-dir and --binary");
  process.exitCode=await runLocalBatch(parseJson<PrepareRequest>(readFileSync(values.input,"utf8")),resolve(values["output-dir"]),resolve(values.binary));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{process.stderr.write((error instanceof Error ? error.stack??error.message : "The local benchmark batch could not complete")+"\n");process.exitCode=1;});
