import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
process.env.COA_RAG_BINARY ??= "/usr/bin/true";
function expectedBrowserSettings(command: string[]) {
  const index = command.indexOf("--browser-preset");
  const preset = index < 0 ? "standard" : command[index + 1];
  return { top_k: preset === "standard" ? 5 : 3, selection: preset === "dense-k3-activity-expansion" ? "activity_expansion" : "sections" };
}
const adapter = new URL("./adapter.ts", import.meta.url);
function cli(command: string, input?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "coa-benchmark-adapter-test-"));
  try {
    const path = join(dir, "selection.json");
    if (input) writeFileSync(path, JSON.stringify(input));
    const result = spawnSync(
      process.execPath,
      [adapter.pathname, command, ...(input ? [path] : [])],
      {
        encoding: "utf8",
        env: { ...process.env, COA_RAG_BINARY: "/usr/bin/true" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("twelve-document canonical plan includes 272 retrieval and 408 context rows", () => {
  const p = cli("plan", {
    datasets: ["demo-12-20261118"],
    suites: ["retrieval", "quality"],
  });
  assert.deepEqual(
    p.groups.map((g: any) => [g.suite, g.execution_count]),
    [
      ["retrieval", 272],
      ["quality", 408],
    ],
  );
  assert.equal(p.totals.local, 680);
  assert.ok(
    p.groups.every(
      (g: any) =>
        g.identity.corpus_sha256 &&
        g.identity.questions_sha256 &&
        g.identity.criteria_sha256,
    ),
  );
});
test("browser plans nine distinct configurations for all seventeen demo cases without redundant BM25 encoders", () => {
  const p = cli("plan", {
    datasets: ["demo-12-20261118"],
    suites: ["browser"],
  });
  assert.equal(p.totals.local, 17 * 9);
  assert.equal(p.groups[0].configuration_count, 9);
  assert.equal(
    p.groups[0].configurations.filter(
      (c: any) => c.configuration.method === "bm25",
    ).length,
    1,
  );
});
test("model sessions need explicit positive authorization", () => {
  const p = cli("plan", {
    datasets: ["demo-12-20261118"],
    suites: ["agentic"],
    case_ids: ["DEMO12-11"],
    methods: ["bm25"],
  });
  assert.equal(p.totals.model, 1);
  assert.match(p.groups[0].block_reason, /toestemming|limiet/i);
  assert.equal(p.can_start, false);
});
test("catalog includes all runners and source-bound case selectors", () => {
  const c = cli("catalog");
  assert.deepEqual(
    c.suites.map((s: any) => s.id).sort(),
    [
      "garden",
      "retrieval",
      "quality",
      "agentic",
      "models",
      "compact",
      "compact-live",
      "browser",
      "assistant",
      "assistant-rig",
    ].sort(),
  );
  const d = c.datasets.find((d: any) => d.id === "demo-12-20261118");
  assert.equal(d.cases.length, 17);
  assert.equal(c.assistant_arms.length, 4);
});
test("execution checkpoints real runner projections and keeps source failures as outcomes", async () => {
  const module = (await import("./adapter.ts")) as any;
  assert.equal(
    typeof module.execute,
    "function",
    "The execution adapter must exist",
  );
  const dir = mkdtempSync(join(tmpdir(), "coa-benchmark-execute-test-"));
  try {
    let count = 0;
    const executor = async (
      command: string[],
      environment: NodeJS.ProcessEnv,
    ) => {
      count++;
      assert.ok(command.some((v) => v.endsWith("run_promptfoo.mjs")));
      assert.ok(command.includes("--no-publish"));
      assert.equal(environment.OPENAI_API_KEY, undefined);
      const output = command[command.indexOf("--output-dir") + 1];
      const raw = {
        evalId: "test-run",
        results: {
          results: [
            {
              testCase: {
                vars: {
                  dataset: "demo-12-20261118",
                  case_id: "DEMO12-11",
                  question: "Vraag",
                  method: "bm25",
                  profile: "documents_sections",
                  top_k: 3,
                },
              },
              response: {
                output: JSON.stringify({
                  status: "completed",
                  record: { run_id: `fresh-native-${count}`, outcome: { hits: [] } },
                }),
              },
              gradingResult: {
                pass: false,
                componentResults: [
                  {
                    pass: false,
                    metadata: {
                      source_metrics: {
                        source_quality_applicable: true,
                        target_goals: 1,
                        covered_goals: 0,
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      };
      writeFileSync(join(output, "retrieval.json"), JSON.stringify(raw));
      return 100;
    };
    const progress = await module.execute(
      {
        datasets: ["demo-12-20261118"],
        suites: ["retrieval"],
        methods: ["bm25"],
        profiles: ["documents_sections"],
        case_ids: ["DEMO12-11"],
        repeats: 2,
      },
      dir,
      undefined,
      executor,
    );
    assert.equal(count, 2);
    assert.deepEqual(progress.result.rows.map((row:any)=>row.repeat),[1,2]);
    assert.equal(new Set(progress.result.rows.map((row:any)=>row.native_run_id)).size,2);
    assert.equal(new Set(progress.result.rows.map((row:any)=>row.comparison_key)).size,2);
    assert.equal(progress.groups[0].status, "completed");
    assert.equal(progress.result.rows[0].status, "failed");
    assert.equal(progress.result.rows[0].source_complete, false);
    assert.ok(progress.result.rows[0].comparison_key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("authorization cannot execute against changed immutable plan identity", async () => {
  const module = (await import("./adapter.ts")) as any;
  assert.equal(typeof module.execute, "function");
  const input = {
    datasets: ["demo-12-20261118"],
    suites: ["retrieval"],
    methods: ["bm25"],
    profiles: ["documents_sections"],
    case_ids: ["DEMO12-11"],
  };
  const expected = module.plan(input);
  expected.groups[0].identity.corpus_sha256 = "changed";
  const dir = mkdtempSync(join(tmpdir(), "coa-benchmark-identity-test-"));
  try {
    await assert.rejects(
      module.execute(input, dir, expected, async () => {
        throw Error("must not execute");
      }),
      /gewijzigd|identiteit/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("immutable plans survive Rust JSON object-key ordering", async () => {
  const module = await import("./adapter.ts");
  const input = {datasets:["demo-12-20261118"],suites:["retrieval"],methods:["bm25"],profiles:["documents_sections"],case_ids:["DEMO12-11"]};
  const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,sorted(value)])) : value;
  const expected=sorted(module.plan(input));
  const dir=mkdtempSync(join(tmpdir(),"coa-benchmark-rust-plan-"));
  let calls=0;
  try {
    await module.execute(input,dir,expected,async()=>{calls++;return 1;});
    assert.equal(calls,1,"semantic equality must permit the actual runner");
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("native assistant forty-session ceiling applies across datasets together", () => {
  const p = cli("plan", {
    datasets: ["demo-12-20261118", "legacy-heldout"],
    suites: ["assistant"],
    assistant_arms: ["dense_once", "bm25"],
    authorization: { confirmed: true, max_sessions: 100, max_seconds: 600 },
  });
  assert.equal(p.totals.model, 46);
  assert.ok(p.groups.every((g: any) => /veertig/.test(g.block_reason || "")));
});
test("model pilot rejects limits outside its existing sixty-session protocol", () => {
  const p = cli("plan", {
    datasets: ["strengthened-10-20261106"],
    suites: ["models"],
    authorization: { confirmed: true, max_sessions: 100, max_seconds: 10000 },
  });
  assert.match(p.groups[0].block_reason || "", /zestig|60/);
});
test("runtime errors remain explicit in final orchestration progress", async () => {
  const module = await import("./adapter.ts");
  const dir = mkdtempSync(join(tmpdir(), "coa-benchmark-error-test-"));
  try {
    const p = await module.execute(
      {
        datasets: ["demo-12-20261118"],
        suites: ["retrieval"],
        methods: ["bm25"],
        profiles: ["documents_sections"],
        case_ids: ["DEMO12-11"],
      },
      dir,
      undefined,
      async () => 1,
    );
    assert.equal(p.groups[0].status, "failed");
    assert.ok(p.error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("different case and configuration selections retain the same comparison identity", async () => {
  const { plan } = await import("./adapter.ts");
  const a = plan({
    datasets: ["demo-12-20261118"],
    suites: ["retrieval"],
    methods: ["bm25"],
    case_ids: ["DEMO12-11"],
  });
  const b = plan({
    datasets: ["demo-12-20261118"],
    suites: ["retrieval"],
    methods: ["dense"],
    case_ids: ["DEMO12-12"],
  });
  assert.deepEqual(a.groups[0].identity, b.groups[0].identity);
});
test("all-local expands valid preserved corpora instead of applying twelve docs to frozen protocols", () => {
  const p = cli("plan", {
    datasets: [],
    suites: ["garden", "retrieval", "quality", "compact"],
    methods: [],
    profiles: [],
  });
  assert.equal(p.totals.local, 2299);
  assert.equal(
    p.groups.find((g: any) => g.suite === "garden").dataset,
    "garden",
  );
  assert.equal(
    p.groups.find((g: any) => g.suite === "compact").dataset,
    "legacy",
  );
  assert.equal(
    p.groups
      .filter((g: any) => g.dataset === "demo-12-20261118")
      .reduce((n: number, g: any) => n + g.execution_count, 0),
    680,
  );
});
test("browser E5 and MiniLM results remain bound to distinct configurations", async () => {
  const module = await import("./adapter.ts");
  const dir = mkdtempSync(join(tmpdir(), "coa-benchmark-encoders-test-"));
  try {
    const p = await module.execute(
      {
        datasets: ["demo-12-20261118"],
        suites: ["browser"],
        methods: ["dense"],
        case_ids: ["P01"],
      },
      dir,
      undefined,
      async (command) => {
        const part = command[command.indexOf("--output-dir") + 1];
        writeFileSync(
          join(part, "browser.json"),
          JSON.stringify({
            evalId: "test-encoder",
            results: {
              results: [
                {
                  testCase: {
                    vars: {
                      dataset: "demo-12-20261118",
                      case_id: "P01",
                      question: "Vraag",
                      mode: "local",
                      method: "dense",
                      profile: "documents_sections",
                      ...expectedBrowserSettings(command),
                    },
                  },
                  response: {
                    output: JSON.stringify({
                      status: "completed",
                      record: { outcome: { hits: [] } },
                    }),
                  },
                  gradingResult: { pass: true },
                },
              ],
            },
          }),
        );
        return 0;
      },
    );
    assert.equal(new Set(p.result.rows.map((r) => r.configuration_id)).size, 4);
    assert.deepEqual(
      p.result.rows.map((r) => r.configuration.embedding_model),
      ["minilm-multilingual", "e5-small-multilingual", "e5-small-multilingual", "e5-small-multilingual"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("fixed model trials retain distinct repetition and comparison identities",async()=>{
  const {execute}=await import('./adapter.ts');
  const dir=mkdtempSync(join(tmpdir(),'coa-benchmark-model-trials-'));
  try{
    const progress=await execute({datasets:['strengthened-10-20261106'],suites:['models'],authorization:{confirmed:true,max_sessions:60,max_seconds:7200}},dir,undefined,async(command)=>{
      const output=command[command.indexOf('--output-dir')+1];
      const results=[['gpt-6.1-sol',1],['gpt-6.1-sol',2],['gpt-6.1-sol',3],['gpt-6-luna',1]].map(([model,trial])=>({testCase:{vars:{dataset:'strengthened-10-20261106',case_id:'RAG26-01',question:'Vraag',mode:'codex',model,trial,method:'dense',profile:'documents_sections',top_k:3}},response:{output:JSON.stringify({status:'completed',record:{}})},gradingResult:{pass:true}}));
      writeFileSync(join(output,'models.json'),JSON.stringify({evalId:'trial-fixture',results:{results}}));return 0;
    });
    assert.deepEqual(progress.result.rows.filter(row=>row.configuration.model==='gpt-6.1-sol').map(row=>row.repeat),[1,2,3]);
    assert.equal(new Set(progress.result.rows.map(row=>row.comparison_key)).size,4);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("question plan runs one current question twice across every distinct local variant", () => {
  const p = cli("question-plan", {dataset:"demo-12-20261118",case_id:"P01"});
  assert.deepEqual(p.selection.case_ids,["P01"]);
  assert.equal(p.selection.repeats,2);
  assert.deepEqual(p.groups.map((g:any)=>[g.suite,g.configuration_count,g.execution_count]),[["quality",24,48],["browser",9,18]]);
  assert.equal(p.totals.local,66);
  assert.equal(p.totals.model,0);
});
test("one question shares one native preparation and grading batch per fresh repetition", async () => {
  const { execute, questionPlan } = await import("./adapter.ts");
  const { buildConfig } = createRequire(import.meta.url)("../rag/promptfoo/cases.cjs");
  const planned = questionPlan({dataset:"demo-12-20261118",case_id:"RAG26-06"});
  const dir = mkdtempSync(join(tmpdir(), "coa-question-batch-"));
  const calls: string[][] = [];
  try {
    const progress = await execute(planned.selection, dir, planned, async command => {
      calls.push(command);
      const output = command[command.indexOf("--output-dir") + 1];
      const suiteIndex = command.indexOf("--suite");
      const suite = suiteIndex < 0 ? "benchmark" : command[suiteIndex + 1];
      let tests: any[];
      if (suite === "benchmark") {
        tests = JSON.parse(readFileSync(command[command.indexOf("--input") + 1], "utf8")).tests;
      } else {
        const env: Record<string, string> = {COA_PROMPTFOO_SUITE:suite};
        for (const [flag, key] of Object.entries({"--dataset":"DATASET","--cases":"CASES","--methods":"METHODS","--eval-id":"EVAL_ID","--embedding-model":"EMBEDDING_MODEL","--browser-preset":"BROWSER_PRESET"})) {
          const index = command.indexOf(flag);
          if (index >= 0) env["COA_PROMPTFOO_" + key] = command[index + 1];
        }
        tests = buildConfig(env).tests;
      }
      writeFileSync(join(output, suite + ".json"), JSON.stringify({evalId:`fresh-batch-${calls.length}`,results:{results:tests.map((test,index)=>({
        testCase:test,
        response:{output:JSON.stringify({status:"completed",record:{run_id:`fresh-native-${calls.length}-${index}`,outcome:{hits:[]}}})},
        gradingResult:{pass:false,componentResults:[{pass:false,metadata:{source_metrics:{source_quality_applicable:true,target_goals:1,covered_goals:0}}}]}
      }))}}));
      return 100;
    });
    assert.equal(calls.length,2,"one shared batch per repetition replaces twenty runner chains");
    assert.ok(calls.every(command=>command.some(arg=>arg.endsWith("run_local_batch.ts"))));
    assert.notEqual(calls[0][calls[0].indexOf("--output-dir")+1],calls[1][calls[1].indexOf("--output-dir")+1]);
    assert.equal(progress.result.rows.length,66);
    assert.deepEqual(progress.groups.map(group=>[group.status,group.completed]),[["completed",48],["completed",18]]);
    assert.equal(new Set(progress.result.rows.map(row=>row.comparison_key)).size,66);
    assert.equal(new Set(progress.result.rows.map(row=>row.native_run_id)).size,66);
    assert.deepEqual(progress.result.rows.filter(row=>row.repeat===1&&row.group_id===planned.groups[1].id).map(row=>row.configuration.embedding_model),[
      "minilm-multilingual","e5-small-multilingual",undefined,"minilm-multilingual","e5-small-multilingual","minilm-multilingual","e5-small-multilingual","e5-small-multilingual","e5-small-multilingual"
    ]);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("a shared batch preserves one failed variant as unknown while grading every other variant",async()=>{
  const {execute,questionPlan}=await import("./adapter.ts");
  const planned=questionPlan({dataset:"regression-12-20261118",case_id:"IND26-01",repeats:1});
  const dir=mkdtempSync(join(tmpdir(),"coa-batch-error-row-"));
  try{
    const progress=await execute(planned.selection,dir,planned,async command=>{
      const input=JSON.parse(readFileSync(command[command.indexOf("--input")+1],"utf8"));
      const output=command[command.indexOf("--output-dir")+1];
      writeFileSync(join(output,"benchmark.json"),JSON.stringify({evalId:"mixed-technical-outcomes",results:{results:input.tests.map((test:any,index:number)=>({
        testCase:test,
        response:index===25?{error:"Native execution status: failed",metadata:{native_run_id:`actual-${index}`}}:{output:JSON.stringify({status:"completed",record:{run_id:`actual-${index}`,outcome:{hits:[]}}})},
        gradingResult:{pass:false,componentResults:[{pass:false,metadata:{source_metrics:{source_quality_applicable:true,target_goals:10,covered_goals:0}}}]}
      }))}}));
      return 100;
    });
    assert.equal(progress.result.rows.length,33);
    assert.equal(new Set(progress.result.rows.map(row=>row.comparison_key)).size,33);
    const failed=progress.result.rows.filter(row=>row.status==="error");
    assert.equal(failed.length,1);
    assert.equal(failed[0].source_complete,null);
    assert.equal(failed[0].native_run_id,"actual-25");
    assert.equal(failed[0].metrics.covered_goals,null);
    assert.deepEqual(failed[0].calls,[]);
    assert.equal(progress.groups[0].status,"completed");
    assert.equal(progress.groups[1].status,"failed");
    assert.ok(progress.error);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("complete-list question has thirty-three variants bound only to that frozen question", () => {
  const p=cli("question-plan",{dataset:"regression-12-20261118",case_id:"IND26-01",repeats:3});
  assert.equal(p.groups.length,2);
  assert.deepEqual(p.groups.map((g:any)=>g.configuration_count),[24,9]);
  assert.equal(p.totals.local,99);
});
test("question picker exposes current eighteen questions with explicit corpus identities",()=>{
  const c=cli("catalog");assert.equal(c.questions.length,18);
  assert.ok(c.questions.every((q:any)=>q.dataset&&q.id&&q.question&&q.corpus_sha256));
});

test("single-question assistant planning keeps two methods and requires explicit attempts",()=>{
 const p=cli("question-plan",{dataset:"regression-12-20261118",case_id:"IND26-01",mode:"assistant"});
 assert.equal(p.can_start,false);assert.equal(p.totals.model,4);assert.equal(p.totals.provider_attempts,20);assert.equal(p.totals.model_sessions,0);
 assert.deepEqual(p.groups.map((g:any)=>g.suite),["assistant-rig"]);
});
test("duplicate question wording keeps distinguishable titles and exact case identities",()=>{
 const c=cli("catalog");const rows=c.questions.filter((q:any)=>["P01","RAG26-01"].includes(q.id));
 assert.equal(rows.length,2);assert.equal(rows[0].question,rows[1].question);assert.notEqual(rows[0].title,rows[1].title);
});

test("configuration labels explain search-result limits and expansion units",()=>{
 const p=cli("question-plan",{dataset:"regression-12-20261118",case_id:"IND26-01"});
 const configs=p.groups[0].configurations;
 assert.ok(configs.every((c:any)=>!/(?:^| · )k[36](?: · |$)/.test(c.label)));
 assert.ok(configs.some((c:any)=>c.label.includes("Maximaal 6 secties")));
 assert.ok(configs.some((c:any)=>String(c.configuration.profile).endsWith("_activities")&&c.label.includes("Maximaal 3 secties")));
 assert.ok(configs.some((c:any)=>c.label.includes("Eerst 3 secties · activiteitcontext uitbreiden")));
});

test("question plans retain canonical file-only variants when SQLite is absent",async()=>{
 const original=process.env.COA_BENCHMARK_SQLITE;process.env.COA_BENCHMARK_SQLITE="0";
 try { const {questionPlan}=await import("./adapter.ts"); const p=questionPlan({dataset:"regression-12-20261118",case_id:"IND26-01"});
 assert.equal(p.totals.local,50);assert.ok(p.groups[0].configurations.every(c=>!String(c.configuration.profile).startsWith("sqlite_")));
 } finally {if(original===undefined)delete process.env.COA_BENCHMARK_SQLITE;else process.env.COA_BENCHMARK_SQLITE=original;}
});

test("one browser encoder failure remains an explicit unknown result while independent variants and repeats continue", async () => {
  const { execute } = await import("./adapter.ts");
  const dir = mkdtempSync(join(tmpdir(), "coa-browser-error-isolation-"));
  const observed: { method: string; encoder: string }[] = [];
  try {
    const progress = await execute(
      {
        datasets: ["demo-12-20261118"],
        suites: ["browser"],
        methods: ["dense", "bm25"],
        case_ids: ["P01"],
        repeats: 2,
      },
      dir,
      undefined,
      async (command) => {
        const output = command[command.indexOf("--output-dir") + 1];
        const method = command[command.indexOf("--methods") + 1];
        const encoder = command[command.indexOf("--embedding-model") + 1];
        observed.push({ method, encoder });
        if (observed.length === 2) {
          writeFileSync(
            join(output, "preparation-error.json"),
            JSON.stringify({
              schema_version: 1,
              code: "onnx_model_compile_io",
              message:
                "Het ONNX-model kon niet worden gecompileerd (I/O-fout).",
              stage: "local_preparation",
              native_run_id: "failed-native-attempt",
            }),
          );
          return 1;
        }
        writeFileSync(
          join(output, "browser.json"),
          JSON.stringify({
            evalId: "independent-browser-" + observed.length,
            results: {
              results: [
                {
                  testCase: {
                    vars: {
                      dataset: "demo-12-20261118",
                      case_id: "P01",
                      question: "Vraag",
                      mode: "local",
                      method,
                      profile: "documents_sections",
                      ...expectedBrowserSettings(command),
                    },
                  },
                  response: {
                    output: JSON.stringify({
                      status: "completed",
                      record: {
                        run_id: "native-" + observed.length,
                        outcome: { hits: [] },
                      },
                    }),
                  },
                  gradingResult: {
                    pass: false,
                    componentResults: [
                      {
                        pass: false,
                        metadata: {
                          source_metrics: {
                            source_quality_applicable: true,
                            target_goals: 2,
                            covered_goals: 0,
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        );
        return 100;
      },
    );
    assert.equal(
      observed.length,
      10,
      "planned attempts continue exactly once without retries",
    );
    assert.equal(progress.result.rows.length, 10);
    assert.equal(progress.groups[0].status, "failed");
    assert.match(progress.groups[0].error || "", /ONNX/);
    assert.equal(
      new Set(progress.result.rows.map((row) => row.comparison_key)).size,
      10,
    );
    const errors = progress.result.rows.filter((row) => row.status === "error");
    assert.equal(errors.length, 1);
    const failed = errors[0];
    assert.equal(failed.repeat, 1);
    assert.equal(failed.configuration.embedding_model, "e5-small-multilingual");
    assert.equal(failed.source_complete, null);
    assert.equal(failed.metrics.covered_goals, null);
    assert.equal(failed.metrics.search_calls, null);
    assert.equal(failed.error.code, "onnx_model_compile_io");
    assert.match(failed.reason, /ONNX/);
    assert.equal(failed.native_run_id, "failed-native-attempt");
    assert.ok(
      progress.result.rows.some(
        (row) => row.repeat === 1 && row.configuration.method === "bm25",
      ),
    );
    assert.ok(
      progress.result.rows.some(
        (row) =>
          row.repeat === 2 &&
          row.configuration.embedding_model === "minilm-multilingual",
      ),
    );
    assert.deepEqual(failed.assertions, []);
    assert.deepEqual(failed.calls, []);
    assert.ok(progress.error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog names the pinned MiniLM protocol encoder separately from measured row identity", () => {
  const c = cli("catalog");
  for (const id of ["retrieval", "quality"])
    assert.equal(
      c.suites.find((s: any) => s.id === id).embedding_model,
      "minilm-multilingual",
    );
});

test("a failed model attempt still stops later model groups without retries", async () => {
  const { execute } = await import("./adapter.ts");
  const dir = mkdtempSync(join(tmpdir(), "coa-model-stop-preserved-"));
  let attempts = 0;
  try {
    const progress = await execute(
      {
        datasets: ["legacy", "independent-20261103"],
        suites: ["agentic"],
        methods: ["bm25"],
        authorization: { confirmed: true, max_sessions: 10, max_seconds: 300 },
      },
      dir,
      undefined,
      async () => {
        attempts++;
        return 1;
      },
    );
    assert.equal(attempts, 1);
    assert.equal(progress.groups[0].status, "failed");
    assert.equal(progress.groups[1].status, "not_run");
    assert.equal(progress.result.rows.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every active question plans 33 canonical configurations including two matched E5 k3 probes", async () => {
  const { questionPlan, catalog } = await import("./adapter.ts");
  for (const question of catalog().questions) {
    const p = questionPlan({
      dataset: question.dataset,
      case_id: question.id,
      repeats: 1,
    });
    assert.equal(p.totals.local, 33, question.id);
    const browser = p.groups.find((g) => g.suite === "browser")!;
    assert.equal(browser.configuration_count, 9, question.id);
    const presets = browser.configurations.filter(
      (c) =>
        c.configuration.embedding_model === "e5-small-multilingual" &&
        c.configuration.method === "dense" &&
        c.configuration.top_k === 3,
    );
    assert.equal(presets.length, 2);
    assert.deepEqual(presets.map((c) => c.configuration.selection).sort(), [
      "activity_expansion",
      "sections",
    ]);
  }
});
test("top-k labels consistently describe section limits regardless of storage record layout", async () => {
  const { plan } = await import("./adapter.ts");
  const p = plan({
    datasets: ["demo-12-20261118"],
    suites: ["quality"],
    methods: ["dense"],
  });
  const activity = p.groups[0].configurations.find(
    (c) =>
      c.configuration.profile === "documents_activities" &&
      c.configuration.top_k === 3,
  )!;
  assert.match(activity.label, /Maximaal 3 secties/);
  assert.doesNotMatch(activity.label, /Maximaal 3 activiteiten/);
});

test("labels distinguish historic criteria and describe expansion without promising full activity context", async () => {
  const { catalog, questionPlan } = await import("./adapter.ts");
  const questions = catalog().questions;
  assert.ok(
    questions
      .find((q) => q.id === "P01")!
      .title.includes("Historische criteria"),
  );
  assert.ok(
    questions
      .find((q) => q.id === "RAG26-01")!
      .title.includes("Kwaliteitseval"),
  );
  const expanded = questionPlan({
    dataset: "demo-12-20261118",
    case_id: "RAG26-01",
    repeats: 1,
  })
    .groups.flatMap((g) => g.configurations)
    .filter((c) => c.configuration.selection === "activity_expansion");
  assert.ok(expanded.length > 0);
  assert.ok(
    expanded.every(
      (c) =>
        c.label.includes("activiteitcontext uitbreiden") &&
        !c.label.includes("hele activiteit"),
    ),
  );
});
