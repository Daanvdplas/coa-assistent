// Run with COA_PLAYWRIGHT_CORE=/path/to/playwright-core (no dev-browser).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.COA_PLAYWRIGHT_CORE || "playwright-core",
);
const root = new URL("../../../", import.meta.url);
let browser, server, base;
const catalog = {
  datasets: [
    {
      id: "demo-12",
      label: "Twaalf activiteiten",
      document_count: 12,
      case_count: 2,
      suites: ["retrieval", "quality", "agentic"],
      cases: [
        { id: "P01", question: "Waar en wanneer?" },
        { id: "T02", question: "Wat kan binnen?" },
      ],
    },
  ],
  suites: [
    {
      id: "retrieval",
      label: "Bronzoeken",
      family: "retrieval",
      kind: "local",
      available: true,
      datasets: ["demo-12"],
    },
    {
      id: "quality",
      label: "Contextkwaliteit",
      family: "retrieval",
      kind: "local",
      available: true,
      datasets: ["demo-12"],
    },
    {
      id: "agentic",
      label: "Gericht verderzoeken",
      family: "assistant",
      kind: "model",
      available: false,
      block_reason: "Codex is niet ingesteld.",
      datasets: ["demo-12"],
    },
    {
      id: "assistant",
      label: "COA-assistent",
      family: "assistant",
      kind: "model",
      available: false,
      block_reason: "Modelgebruik is niet ingesteld.",
      datasets: ["demo-12"],
    },
  ],
  methods: [
    { id: "bm25", label: "Op woorden" },
    { id: "dense", label: "Op betekenis" },
  ],
  profiles: [{ id: "documents_sections", label: "Secties · bestanden" }],
  embedding_models: [],
  assistant_arms: [],
  default_selection: {
    datasets: ["demo-12"],
    suites: ["retrieval", "quality"],
    methods: [],
    profiles: [],
    embedding_models: [],
    case_ids: [],
    repeats: 1,
  },
  limits: { max_rows: 5000, max_repeats: 3 },
};
const config = {
  id: "bm25",
  label: "Op woorden",
  configuration: { method: "bm25" },
};
const group = {
  id: "g",
  suite: "retrieval",
  dataset: "demo-12",
  label: "Bronzoeken · Twaalf activiteiten",
  family: "retrieval",
  kind: "local",
  case_count: 2,
  configuration_count: 1,
  execution_count: 2,
  configurations: [config],
  block_reason: null,
};
const plan = {
  selection: catalog.default_selection,
  groups: [group],
  totals: { local: 2, model: 0, blocked: 0, executions: 2 },
  can_start: true,
};
const ref = {
  source_id: "ACT-TUIN-001",
  section_id: "S2",
  source_title: "Tuinieren",
  heading: "Tijd",
  text: 'Dinsdag van 10.00 tot 12.00 uur. <img src=x onerror="window.injected=true">',
};
const resultRow = (id, pass) => ({
  id,
  group_id: "g",
  configuration_id: "bm25",
  case_id: id,
  question: id === "P01" ? "Waar en wanneer?" : "Wat kan binnen?",
  repeat: 1,
  status: pass ? "passed" : "failed",
  source_complete: pass,
  configuration: { method: "bm25" },
  metrics: {
    covered_goals: pass ? 1 : 0,
    target_goals: 1,
    source_quality_applicable: true,
  },
  goals: [
    {
      id: "time",
      description: "Tijd",
      covered: pass,
      alternatives: [[{ ...ref, found: pass }]],
    },
  ],
  calls: [{ index: 1, query: "Waar en wanneer?", hits: pass ? ["time"] : [] }],
  reason: "",
  comparison_key: id,
});
const run = {
  id: "run-one",
  created_at: "2026-11-18T14:00:00Z",
  status: "completed",
  plan,
  progress: { completed: 2, total: 2 },
  groups: [{ ...group, status: "completed", completed: 2 }],
  result: {
    rows: [resultRow("P01", true), resultRow("T02", false)],
    sources: { time: { ...ref, id: "S2" } },
  },
};
before(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const asset =
      path === "/benchmark/"
        ? "static/site/benchmark.html"
        : path.startsWith("/assets/")
          ? "static/site/" + path.slice(8)
          : null;
    if (!asset) {
      res.writeHead(404).end();
      return;
    }
    try {
      res.setHeader(
        "Content-Type",
        asset.endsWith(".js")
          ? "text/javascript"
          : asset.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      res.end(await readFile(new URL(asset, root)));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath:
      process.env.COA_CHROME ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});
async function fixture({
  mobile = false,
  saved = false,
  slow = false,
  delayedCancel = false,
  progressive = false,
  rig = false,
  comparison = false,
  many = false,
  current = false,
  common = false,
  genericRig = false,
} = {}) {
  const page = await browser.newPage({
    viewport: mobile
      ? { width: 375, height: 812 }
      : { width: 1280, height: 900 },
  });
  page.setDefaultTimeout(5000);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text) => {
          window.copiedHandoff = text;
        },
      },
    }),
  );
  const starts = [];
  let stored = saved ? [run] : [],
    cancelled = false;
  const baseline = structuredClone(run);
  baseline.id = "baseline";
  baseline.groups[0].configurations = [
    { ...config, id: "dense", label: "Op betekenis" },
  ];
  baseline.result.rows = [resultRow("P01", false), resultRow("T03", true)].map(
    (row) => ({ ...row, configuration_id: "dense" }),
  );
  if (comparison) stored.push(baseline);
  if (many) {
    const extra = structuredClone(run);
    extra.groups[0].configurations = [
      config,
      { ...config, id: "dense", label: "Op betekenis" },
      { ...config, id: "hybrid", label: "Combinatie" },
    ];
    extra.result.rows = extra.groups[0].configurations.flatMap((config) =>
      run.result.rows.map((row) => ({ ...row, configuration_id: config.id })),
    );
    stored = [extra];
  }
  if (common) {
    stored=stored.map(value=>structuredClone(value));
    for (const value of stored) {
      value.result.sources.extra={source_id:"ACT-TUIN-001",id:"S1",source_title:"Tuinieren",heading:"Activiteit",text:"Een gedeeld aanvullend bronfragment."};
      for (const row of value.result.rows.filter(row=>row.case_id==="P01")) {
        row.goals.push({...structuredClone(row.goals[0]),id:"same-source-other-fact"});
        row.calls[0].hits.push("extra");
      }
    }
  }
  if (genericRig) {
    stored=stored.map(value=>structuredClone(value));
    for (const value of stored) {
      value.groups[0].suite="assistant-rig";
      value.groups[0].family="assistant";
      for (const row of value.result.rows) {
        row.suite="assistant-rig";
        row.answer_quality="not_assessed";
        row.assertions=[{reason:"Broncontrole",pass:true}];
      }
    }
  }
  await page.route("**/api/benchmarks/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path.endsWith("/catalog"))
      return route.fulfill({
        json: current ? {...catalog,datasets:[...catalog.datasets,{id:"regression-12",label:"Volledige opties",document_count:12,case_count:1,suites:["retrieval","quality"],cases:[{id:"IND26-01",question:"Welke activiteiten voldoen aan alle voorwaarden?"}]}],default_selection:{...catalog.default_selection,datasets:["demo-12","regression-12"]}} : rig
          ? {
              ...catalog,
              suites: [
                ...catalog.suites,
                {
                  id: "assistant-rig",
                  label: "COA-assistent via Rig",
                  family: "assistant",
                  kind: "model",
                  unit: "provider_attempts",
                  datasets: ["demo-12"],
                },
              ],
            }
          : catalog,
      });
    if (path.endsWith("/discussion"))
      return route.fulfill({
        json: {
          report_path: "/tmp/benchmark-run-one.md",
          prompt: "Bespreek de benchmark in /tmp/benchmark-run-one.md.",
          command: "codex --cd '/tmp/project' 'Lees /tmp/benchmark-run-one.md'",
        },
      });
    if (path.endsWith("/compare"))
      return route.fulfill({
        json: {
          compatible: true,
          coverage: {
            current_cases: 2,
            baseline_cases: 2,
            shared_cases: 1,
            current_only: 1,
            baseline_only: 1,
          },
          pairs: [
            {
              case_id: "P01",
              current: run.result.rows[0],
              baseline: baseline.result.rows[0],
            },
          ],
        },
      });
    if (path.endsWith("/baseline")) return route.fulfill({ json: baseline });
    if (path.endsWith("/plan"))
      return route.fulfill({
        json: { ...plan, selection: req.postDataJSON() },
      });
    if (path.endsWith("/runs") && req.method() === "GET")
      return route.fulfill({ json: { runs: stored } });
    if (path.endsWith("/runs") && req.method() === "POST") {
      starts.push(req.postDataJSON());
      stored = [{ ...run, status: slow ? "running" : "completed" }];
      if (progressive)
        stored = [
          {
            ...run,
            status: "running",
            progress: { completed: 1, total: 2 },
            result: { ...run.result, rows: [run.result.rows[0]] },
          },
        ];
      return route.fulfill({ status: 202, json: stored[0] });
    }
    if (path.endsWith("/run-one") && req.method() === "DELETE") {
      cancelled = true;
      stored = [{ ...run, status: delayedCancel ? "cancelling" : "cancelled" }];
      return route.fulfill({ json: stored[0] });
    }
    if (path.endsWith("/run-one") && cancelled && delayedCancel)
      stored = [{ ...run, status: "cancelled" }];
    if (path.endsWith("/run-one") && progressive) stored = [run];
    if (path.endsWith("/run-one"))
      return route.fulfill({ json: stored[0] || run });
    return route.fulfill({ status: 404, json: { error: "Onbekend" } });
  });
  await page.goto(base + "/benchmark/");
  return {
    page,
    starts,
    get cancelled() {
      return cancelled;
    },
  };
}
test("benchmark is independent from demo navigation and starts only after a reviewed plan", async () => {
  const flow = await fixture();
  const { page } = flow;
  try {
    await page
      .getByRole("heading", { name: "Benchmark", exact: true })
      .waitFor();
    assert.deepEqual(await page.locator("nav a").allTextContents(), [
      "Evals",
      "Benchmark",
    ]);
    await page
      .getByRole("button", { name: "Alle lokale proeven", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Start benchmark", exact: true })
      .waitFor({ state: "visible" });
    assert.equal(flow.starts.length, 0);
    await page
      .getByRole("button", { name: "Start benchmark", exact: true })
      .click();
    await page.getByLabel("Uitvoering", { exact: true }).waitFor();
    assert.equal(flow.starts.length, 1);
    await page.reload();
    await page.getByLabel("Uitvoering", { exact: true }).waitFor();
    assert.equal(flow.starts.length, 1);
    await page
      .getByRole("button", { name: "Bekijk vragen", exact: true })
      .click();
    await page.getByRole("button", { name: /P01.*1\/1/ }).click();
    assert.equal(
      await page
        .locator(".benchmark-evidence")
        .getByText(ref.text, { exact: true })
        .count(),
      1,
    );
    assert.equal(await page.evaluate(() => window.injected === true), false);
    await page
      .getByRole("button", { name: "Sluit broncontrole", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: /P01.*1\/1/ })
        .evaluate((el) => document.activeElement === el),
      true,
    );
    assert.equal(flow.starts.length, 1);
  } finally {
    await page.close();
  }
});
test("the current twelve-document profile keeps its regression independently selectable", async () => {
  const {page,starts}=await fixture({current:true});
  try {
    assert.equal(await page.getByLabel("Vraagset",{exact:true}).inputValue(),"__current__");
    await page.locator("#benchmark-settings > summary").click();
    assert.equal(await page.locator("#case-options").isVisible(),true);
    assert.equal(await page.locator("#benchmark-cases input").count(),3);
    await page.locator('#benchmark-cases input[value="P01"]').uncheck();
    await page.locator('#benchmark-cases input[value="T02"]').uncheck();
    await page.getByRole("button",{name:"Start benchmark",exact:true}).click();
    assert.deepEqual(starts[0].datasets,["demo-12","regression-12"]);
    assert.deepEqual(starts[0].case_ids,["IND26-01"]);
  } finally {await page.close();}
});
test("shared expected and additional passages appear only once when comparing configurations", async () => {
  const {page}=await fixture({saved:true,many:true,common:true});
  try {
    await page.getByRole("button",{name:"Bekijk vragen",exact:true}).click();
    await page.getByRole("button",{name:/P01.*1\/1/}).first().click();
    assert.equal(await page.locator(".benchmark-evidence blockquote").filter({hasText:"Een gedeeld aanvullend bronfragment."}).count(),1);
    assert.equal(await page.locator(".benchmark-evidence blockquote").filter({hasText:"Dinsdag van 10.00 tot 12.00 uur."}).count(),1);
  } finally {await page.close();}
});
test("generic current Rig source checks do not claim assessed answer quality", async () => {
  const {page}=await fixture({saved:true,genericRig:true});
  try {
    await page.getByRole("columnheader",{name:"Alle harde controles",exact:true}).waitFor();
    assert.equal(await page.getByRole("columnheader",{name:"Vaste antwoordchecks",exact:true}).count(),0);
    await page.getByRole("button",{name:"Bekijk vragen",exact:true}).click();
    await page.getByRole("button",{name:/P01.*controles/}).first().click();
    await page.getByText("Antwoordkwaliteit: niet beoordeeld.",{exact:true}).waitFor();
  } finally {await page.close();}
});

test("different configurations compare only shared cases and report coverage", async () => {
  const { page } = await fixture({ saved: true, comparison: true });
  try {
    await page
      .getByLabel("Vergelijk met", { exact: true })
      .selectOption("baseline");
    await page
      .locator("#comparison-status")
      .getByText(
        "1 gedeeld evalgeval · 1 alleen in uitvoering · 1 alleen in referentie",
        { exact: true },
      )
      .waitFor();
    assert.match(
      await page
        .locator(".benchmark-group>.benchmark-table-scroll")
        .first()
        .innerText(),
      /Referentie · Op betekenis/,
    );
    await page
      .getByRole("button", { name: "Bekijk vragen", exact: true })
      .click();
    assert.equal(
      await page.locator(".benchmark-matrix tbody>tr[data-case]").count(),
      1,
    );
    assert.deepEqual(
      await page.locator(".benchmark-matrix thead th").allTextContents(),
      ["Vraag", "Op woorden", "Referentie · Op betekenis"],
    );
    await page
      .getByLabel("Toon vragen", { exact: true })
      .selectOption("differences");
    assert.equal(
      await page.locator(".benchmark-matrix tbody>tr[data-case]").count(),
      1,
    );
  } finally {
    await page.close();
  }
});

test("a wide experiment opens with two selectable configurations before expanding all", async () => {
  const { page } = await fixture({ saved: true, many: true });
  try {
    await page
      .getByRole("button", { name: "Bekijk vragen", exact: true })
      .click();
    assert.equal(await page.locator(".benchmark-matrix thead th").count(), 3);
    await page
      .getByLabel("Tweede configuratie", { exact: true })
      .selectOption("current:hybrid");
    assert.match(
      await page.locator(".benchmark-matrix thead").innerText(),
      /Combinatie/,
    );
    await page
      .getByRole("button", { name: "Alle configuraties", exact: true })
      .click();
    assert.equal(await page.locator(".benchmark-matrix thead th").count(), 4);
  } finally {
    await page.close();
  }
});
test("small screens keep controls usable and only the comparison table scrolls", async () => {
  const { page } = await fixture({ mobile: true, saved: true });
  try {
    await page.getByLabel("Uitvoering", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Bekijk vragen", exact: true })
      .click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page
      .getByLabel("Toon vragen", { exact: true })
      .selectOption("failures");
    assert.equal(
      await page.locator(".benchmark-matrix tbody>tr[data-case]").count(),
      1,
    );
    await page
      .getByRole("button", { name: "Nieuwe benchmark", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Alle lokale proeven", exact: true })
        .isVisible(),
      true,
    );
  } finally {
    await page.close();
  }
});

test("RAG and the whole assistant have independent all-evals selections", async () => {
  const { page } = await fixture();
  try {
    await page
      .getByRole("button", { name: "Alle assistent-evals", exact: true })
      .click();
    assert.deepEqual(
      await page
        .locator("#benchmark-suites input:checked")
        .evaluateAll((nodes) => nodes.map((node) => node.value)),
      ["agentic", "assistant"],
    );
    await page
      .getByRole("button", { name: "Alle RAG-evals", exact: true })
      .click();
    assert.deepEqual(
      await page
        .locator("#benchmark-suites input:checked")
        .evaluateAll((nodes) => nodes.map((node) => node.value)),
      ["retrieval", "quality"],
    );
  } finally {
    await page.close();
  }
});

test("Codex handoff copies the path to a real discussion artifact supplied by the server", async () => {
  const { page } = await fixture({ saved: true });
  try {
    await page
      .getByRole("button", { name: "Bespreek in Codex", exact: true })
      .click();
    await page.getByText("Overdracht gekopieerd.", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.copiedHandoff),
      "codex --cd '/tmp/project' 'Lees /tmp/benchmark-run-one.md'",
    );
  } finally {
    await page.close();
  }
});

test("Rig asks for an explicit model-attempt bound without inventing Codex sessions", async () => {
  const { page, starts } = await fixture({ rig: true });
  try {
    await page.locator("#benchmark-suites input[value=retrieval]").uncheck();
    await page.locator("#benchmark-suites input[value=quality]").uncheck();
    await page.locator("#benchmark-suites input[value=assistant-rig]").check();
    await page.getByLabel("Modelgebruik toestaan", { exact: true }).check();
    await page
      .getByLabel("Maximaal aantal modelpogingen", { exact: true })
      .fill("10");
    await page
      .getByLabel("Maximale uitvoeringsduur (seconden)", { exact: true })
      .fill("60");
    assert.equal(
      await page
        .getByLabel("Maximaal aantal sessies", { exact: true })
        .isVisible(),
      false,
    );
    await page
      .getByRole("button", { name: "Start benchmark", exact: true })
      .click();
    await page.getByLabel("Uitvoering", { exact: true }).waitFor();
    assert.deepEqual(starts[0].authorization, {
      confirmed: true,
      max_attempts: 10,
      max_seconds: 60,
    });
  } finally {
    await page.close();
  }
});

test("new results retain the open evidence and keyboard focus while polling", async () => {
  const { page } = await fixture({ slow: true, progressive: true });
  try {
    await page
      .getByRole("button", { name: "Alle lokale proeven", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Start benchmark", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Bekijk vragen", exact: true })
      .click();
    await page.getByRole("button", { name: /P01.*1\/1/ }).click();
    await page
      .getByRole("button", { name: "Sluit broncontrole", exact: true })
      .focus();
    await page
      .getByText("Afgerond · 2 van 2 afgerond", { exact: true })
      .waitFor();
    assert.equal(await page.locator(".benchmark-evidence").isVisible(), true);
    assert.equal(
      await page
        .getByRole("button", { name: "Sluit broncontrole", exact: true })
        .evaluate((el) => document.activeElement === el),
      true,
    );
  } finally {
    await page.close();
  }
});
test("stopping preserves the run in history and never starts a replacement", async () => {
  const flow = await fixture({ slow: true, delayedCancel: true });
  const { page } = flow;
  try {
    await page
      .getByRole("button", { name: "Alle lokale proeven", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Start benchmark", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Stop benchmark", exact: true })
      .click();
    await page
      .getByText("Stoppen… · 2 van 2 afgerond", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Stop benchmark", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByText("Gestopt · 2 van 2 afgerond", { exact: true })
      .waitFor();
    assert.equal(flow.cancelled, true);
    assert.equal(flow.starts.length, 1);
  } finally {
    await page.close();
  }
});
