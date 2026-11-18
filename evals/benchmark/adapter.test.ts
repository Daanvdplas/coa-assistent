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
                  record: { outcome: { hits: [] } },
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
      },
      dir,
      undefined,
      executor,
    );
    assert.equal(count, 1);
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
