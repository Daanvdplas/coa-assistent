import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
process.env.COA_RAG_BINARY ??= "/usr/bin/true";
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
test("browser plans seven distinct configurations without redundant BM25 encoders", () => {
  const p = cli("plan", {
    datasets: ["demo-12-20261118"],
    suites: ["browser"],
  });
  assert.equal(p.totals.local, 21);
  assert.equal(p.groups[0].configuration_count, 7);
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
                      top_k: 5,
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
    assert.equal(new Set(p.result.rows.map((r) => r.configuration_id)).size, 2);
    assert.deepEqual(
      p.result.rows.map((r) => r.configuration.embedding_model),
      ["minilm-multilingual", "e5-small-multilingual"],
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
  assert.deepEqual(p.groups.map((g:any)=>[g.suite,g.configuration_count,g.execution_count]),[["quality",24,48],["browser",7,14]]);
  assert.equal(p.totals.local,62);
  assert.equal(p.totals.model,0);
});
test("complete-list question has twenty-four local variants and no unrelated browser questions", () => {
  const p=cli("question-plan",{dataset:"regression-12-20261118",case_id:"IND26-01",repeats:3});
  assert.equal(p.groups.length,1);
  assert.equal(p.groups[0].configuration_count,24);
  assert.equal(p.totals.local,72);
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
 assert.ok(configs.some((c:any)=>c.label.includes("Maximaal 3 activiteiten")));
 assert.ok(configs.some((c:any)=>c.label.includes("Eerst 3 secties · hele activiteit")));
});

test("question plans retain canonical file-only variants when SQLite is absent",async()=>{
 const original=process.env.COA_BENCHMARK_SQLITE;process.env.COA_BENCHMARK_SQLITE="0";
 try { const {questionPlan}=await import("./adapter.ts"); const p=questionPlan({dataset:"regression-12-20261118",case_id:"IND26-01"});
 assert.equal(p.totals.local,32);assert.ok(p.groups[0].configurations.every(c=>!String(c.configuration.profile).startsWith("sqlite_")));
 } finally {if(original===undefined)delete process.env.COA_BENCHMARK_SQLITE;else process.env.COA_BENCHMARK_SQLITE=original;}
});
