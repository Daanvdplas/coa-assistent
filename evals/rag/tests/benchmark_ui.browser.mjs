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
let server, browser, base;
const dataset = "demo-12-20261118";
const questions = Array.from({ length: 18 }, (_, i) => ({
  id:
    i === 0
      ? "P01"
      : i === 1
        ? "T02"
        : i === 2
          ? "T05"
          : i === 17
            ? "IND26-01"
            : "CASE-" + i,
  case_id:
    i === 0
      ? "P01"
      : i === 1
        ? "T02"
        : i === 2
          ? "T05"
          : i === 17
            ? "IND26-01"
            : "CASE-" + i,
  dataset,
  question:
    i === 0
      ? "Waar en wanneer kan ik tuinieren?"
      : i === 1
        ? "Welke activiteit kan binnen op dinsdag?"
        : i === 17
          ? "Welke twee activiteiten passen bij alle voorwaarden?"
          : "Vraag " + (i + 1) + "?",
  title:
    i === 0
      ? "Waar en wanneer kan ik tuinieren?"
      : i === 1
        ? "Welke activiteit kan binnen op dinsdag?"
        : i === 17
          ? "Welke twee activiteiten passen bij alle voorwaarden?"
          : "Vraag " + (i + 1) + "?",
  supported_modes: ["rag", "assistant"],
}));
const methods = [
  { id: "bm25", label: "Op woorden" },
  { id: "dense", label: "Op betekenis" },
  { id: "hybrid_rrf", label: "Combinatie op volgorde" },
];
const configurations = [
  {
    id: "bm25-3",
    label: "Op woorden · k3",
    configuration: { method: "bm25", profile: "documents_sections", top_k: 3 },
  },
  {
    id: "dense-3",
    label: "Op betekenis · k3",
    configuration: { method: "dense", profile: "documents_sections", top_k: 3 },
  },
  {
    id: "hybrid-6",
    label: "Combinatie · k6",
    configuration: {
      method: "hybrid_rrf",
      profile: "documents_sections",
      top_k: 6,
    },
  },
  {
    id: "activities",
    label: "Activiteiten · k3",
    configuration: {
      method: "bm25",
      profile: "documents_activities",
      top_k: 3,
    },
  },
  {
    id: "expand",
    label: "Uitbreiden · k3",
    configuration: {
      method: "dense",
      profile: "documents_sections",
      top_k: 3,
      context_mode: "activity_expand",
    },
  },
];
const catalog = {
  schema_version: 1,
  questions,
  methods,
  profiles: [
    { id: "documents_sections", label: "Bestanden · secties" },
    { id: "documents_activities", label: "Bestanden · activiteiten" },
  ],
  embedding_models: [],
  limits: { max_repeats: 3 },
  default_repeats: 2,
};
const expected = {
  source_id: "ACT-TUIN-001",
  id: "S2",
  section_id: "S2",
  source_title: "Tuinieren",
  heading: "Tijd",
  text: 'Dinsdag van 10.00 tot 12.00 uur. <img src=x onerror="window.injected=true">',
};
function runFor(input, id = "run-one") {
  const question = questions.find(
    (item) => item.dataset === input.dataset && item.case_id === input.case_id,
  );
  const group = {
    id: "quality:" + input.dataset,
    suite: "quality",
    dataset: input.dataset,
    label: "Bronzoeken",
    family: "retrieval",
    kind: "local",
    case_count: 1,
    configuration_count: configurations.length,
    execution_count: configurations.length * input.repeats,
    configurations,
    status: "completed",
    completed: configurations.length * input.repeats,
  };
  const rows = configurations.flatMap((config, index) =>
    Array.from({ length: input.repeats }, (_, i) => ({
      id: config.id + ":" + i,
      group_id: group.id,
      suite: "quality",
      dataset: input.dataset,
      case_id: input.case_id,
      question: question.question,
      configuration_id: config.id,
      repeat: i + 1,
      status: index === 0 ? "failed" : "passed",
      source_complete: index !== 0,
      configuration: config.configuration,
      required_source_coverage: {
        found: index === 0 ? (i === 0 ? 3 : 5) : 8,
        total: 8,
        unit: "sections",
        found_refs: index !== 0 || i === 1 ? [expected] : [],
        missing_refs: index === 0 && i === 0 ? [expected] : [],
        documents: { found: 1, total: 2 },
      },
      metrics: {
        covered_goals: 5,
        target_goals: 10,
        source_quality_applicable: true,
      },
      goals: [
        {
          id: "time",
          description: "Tijd",
          covered: index !== 0 || i === 1,
          alternatives: [[{ ...expected, found: index !== 0 || i === 1 }]],
        },
      ],
      calls: [
        {
          index: 1,
          query: question.question,
          hits: index !== 0 || i === 1 ? ["expected"] : [],
        },
      ],
      retrieval_ms: 4.609042,
      latency_eligible: index !== 0,
    })),
  );
  return {
    id,
    question,
    mode: input.mode || "rag",
    created_at: "2026-11-19T10:00:00Z",
    status: "completed",
    plan: {
      question,
      mode: input.mode || "rag",
      selection: {
        datasets: [input.dataset],
        case_ids: [input.case_id],
        repeats: input.repeats,
      },
      groups: [group],
      totals: { local: rows.length, model: 0, executions: rows.length },
      can_start: true,
    },
    progress: { completed: rows.length, total: rows.length },
    groups: [group],
    result: { rows, sources: { expected } },
  };
}
before(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const assets = {
      "/benchmark/": "static/site/benchmark.html",
      "/resultaten/": "evals/rag/site/results.html",
      "/assets/eval-runner.js": "evals/rag/site/eval-runner.js",
      "/assets/eval-runner.css": "evals/rag/site/eval-runner.css",
    };
    const file =
      assets[path] ||
      (path.startsWith("/assets/") ? "static/site/" + path.slice(8) : null);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    try {
      res.setHeader(
        "Content-Type",
        file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      res.end(await readFile(new URL(file, root)));
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
  pagePath = "/benchmark/",
  saved = false,
  mobile = false,
  uncertain = false,
  running = false,
} = {}) {
  const page = await browser.newPage({
    viewport: mobile
      ? { width: 375, height: 812 }
      : { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(6000);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text) => (window.copiedHandoff = text) },
    }),
  );
  const starts = [],
    mutations = [],
    created = new Map();
  let current = saved
      ? runFor({ dataset, case_id: "P01", mode: "rag", repeats: 2 })
      : null,
    firstLost = uncertain,
    cancelled = false;
  if (current && running) current.status = "running";
  await page.route("**/api/benchmarks/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET") mutations.push(path);
    if (path.endsWith("/catalog")) return route.fulfill({ json: catalog });
    if (path.endsWith("/questions/plan"))
      return route.fulfill({ json: runFor(request.postDataJSON()).plan });
    if (path.endsWith("/questions/start")) {
      const input = request.postDataJSON();
      starts.push(input);
      if (!created.has(input.request_id))
        created.set(input.request_id, runFor(input));
      current = created.get(input.request_id);
      if (running) current.status = "running";
      if (firstLost) {
        firstLost = false;
        return route.abort("failed");
      }
      return route.fulfill({ status: 202, json: current });
    }
    if (path.endsWith("/runs"))
      return route.fulfill({ json: { runs: current ? [current] : [] } });
    if (path.endsWith("/discussion"))
      return route.fulfill({
        json: {
          report_path: "/tmp/benchmark.md",
          prompt: "Lees /tmp/benchmark.md",
          command: "codex --cd '/tmp/project' 'Lees /tmp/benchmark.md'",
        },
      });
    if (path.endsWith("/runs/run-one")) {
      if (request.method() === "DELETE") {
        cancelled = true;
        current = { ...current, status: "cancelled" };
      }
      return route.fulfill({ json: current });
    }
    return route.fulfill({ status: 404, json: { error: "Onbekend" } });
  });
  const evals = questions
    .slice(0, 3)
    .map((question, i) => ({
      ...question,
      id: ["garden-time-location", "indoor-tuesday", "two-activities"][i],
      expected_goals: [
        { id: "time", description: "Tijd", alternatives: [[expected]] },
      ],
    }));
  await page.route("**/api/evals/rag/catalog", (route) =>
    route.fulfill({
      json: {
        schema_version: 1,
        can_run: true,
        evals,
        methods: [...methods.slice(0, 2)].map((method) => ({
          ...method,
          uses_embeddings: method.id !== "bm25",
        })),
        embedding_models: [{ id: "minilm", label: "MiniLM", available: true }],
        default_method: "bm25",
        default_embedding_model: "minilm",
      },
    }),
  );
  await page.goto(base + pagePath);
  return {
    page,
    starts,
    mutations,
    created,
    get current() {
      return current;
    },
    get cancelled() {
      return cancelled;
    },
  };
}
test("direct benchmark selects one question by title, defaults to two repetitions and starts only on click", async () => {
  const flow = await fixture();
  const { page } = flow;
  try {
    await page.getByLabel("Vraag", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Vraag", { exact: true }).locator("option").count(),
      18,
    );
    assert.equal(
      await page.getByLabel("Herhalingen", { exact: true }).inputValue(),
      "2",
    );
    assert.equal(flow.starts.length, 0);
    assert.deepEqual(flow.mutations, []);
    assert.equal(
      await page
        .getByRole("button", { name: /Alle (RAG|proeven|vragen)/ })
        .count(),
      0,
    );
    await page.getByLabel("Vraag", { exact: true }).selectOption("IND26-01");
    await page
      .getByRole("button", { name: "Start benchmark", exact: true })
      .click();
    await page.waitForURL("**/benchmark/?run=run-one");
    await page.locator(".benchmark-coverage").waitFor();
    assert.equal(flow.starts.length, 1);
    assert.equal(flow.starts[0].case_id, "IND26-01");
    assert.equal(flow.starts[0].repeats, 2);
    assert.equal(
      await page.getByLabel("Vraag", { exact: true }).inputValue(),
      "IND26-01",
    );
    await page.reload();
    await page.locator(".benchmark-coverage").waitFor();
    assert.equal(flow.starts.length, 1);
  } finally {
    await page.close();
  }
});
test("each Evals question deliberately starts its exact benchmark once before navigating", async () => {
  const flow = await fixture({ pagePath: "/resultaten/" });
  const { page } = flow;
  try {
    await page.locator(".eval-benchmark").first().waitFor();
    assert.equal(await page.locator(".eval-benchmark").count(), 3);
    assert.equal(await page.locator(".search-eval-card[open]").count(), 0);
    assert.equal(flow.starts.length, 0);
    await page.locator("#eval-indoor-tuesday .eval-benchmark").click();
    await page.waitForURL("**/benchmark/?run=run-one");
    await page.locator(".benchmark-coverage").waitFor();
    assert.equal(flow.starts.length, 1);
    assert.equal(flow.starts[0].dataset, dataset);
    assert.equal(flow.starts[0].case_id, "T02");
    assert.equal(flow.starts[0].repeats, 2);
    assert.equal(flow.starts[0].mode, "rag");
    await page.reload();
    await page.locator(".benchmark-coverage").waitFor();
    assert.equal(flow.starts.length, 1);
    await page.goBack();
    assert.equal(flow.starts.length, 1);
  } finally {
    await page.close();
  }
});
test("all variants show actual required source coverage for both repetitions, with one shared expectation", async () => {
  const { page } = await fixture({
    saved: true,
    pagePath: "/benchmark/?run=run-one",
  });
  try {
    await page.locator(".benchmark-coverage").waitFor();
    assert.equal(await page.locator(".benchmark-coverage thead th").count(), 6);
    assert.equal(
      await page.locator(".benchmark-coverage tbody>tr[data-repeat]").count(),
      2,
    );
    assert.match(await page.locator(".benchmark-coverage").innerText(), /3\/8/);
    assert.match(await page.locator(".benchmark-coverage").innerText(), /5\/8/);
    assert.match(
      await page.locator(".benchmark-coverage thead").innerText(),
      /Maximaal 3 activiteiten/,
    );
    assert.match(
      await page.locator(".benchmark-coverage thead").innerText(),
      /Eerst 3 secties.*hele activiteit/,
    );
    assert.doesNotMatch(
      await page.locator(".benchmark-coverage thead").innerText(),
      /\bk[36]\b/,
    );
    await page
      .getByRole("button", { name: /Herhaling 2.*Op woorden.*5\/8/ })
      .first()
      .click();
    assert.equal(
      await page
        .locator(".benchmark-evidence")
        .getByText(expected.text, { exact: true })
        .count(),
      1,
    );
    assert.match(
      await page.locator(".benchmark-evidence").innerText(),
      /Gevonden/,
    );
    assert.equal(await page.evaluate(() => window.injected === true), false);
  } finally {
    await page.close();
  }
});
test("a lost start response retries the same request id instead of creating a second run", async () => {
  const flow = await fixture({ uncertain: true });
  const { page } = flow;
  try {
    await page
      .getByRole("button", { name: "Start benchmark", exact: true })
      .click();
    await page.locator("#plan-status.benchmark-error").waitFor();
    await page
      .getByRole("button", { name: "Start benchmark", exact: true })
      .click();
    await page.waitForURL("**/benchmark/?run=run-one");
    assert.equal(flow.starts.length, 2);
    assert.equal(flow.created.size, 1);
    assert.equal(flow.starts[0].request_id, flow.starts[1].request_id);
  } finally {
    await page.close();
  }
});
test("mobile keeps the page bounded while all variant columns can be panned", async () => {
  const { page } = await fixture({
    saved: true,
    mobile: true,
    pagePath: "/benchmark/?run=run-one",
  });
  try {
    await page.locator(".benchmark-coverage").waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.equal(await page.locator(".benchmark-coverage thead th").count(), 6);
    assert.equal(
      await page
        .locator(".benchmark-table-scroll")
        .first()
        .evaluate((node) => node.scrollWidth > node.clientWidth),
      true,
    );
    await page
      .getByRole("button", { name: "Benchmark wijzigen", exact: true })
      .click();
    await page.getByLabel("Vraag", { exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .getByLabel("Onderdeel", { exact: true })
        .evaluate((node) => document.activeElement === node),
      true,
    );
  } finally {
    await page.close();
  }
});
test("stop and terminal handoff retain the selected question and never start another benchmark", async () => {
  const flow = await fixture({
    saved: true,
    running: true,
    pagePath: "/benchmark/?run=run-one",
  });
  const { page } = flow;
  try {
    await page
      .getByRole("button", { name: "Stop benchmark", exact: true })
      .click();
    await page
      .locator("#run-status")
      .getByText(/Gestopt/)
      .waitFor();
    assert.equal(flow.cancelled, true);
    await page
      .getByRole("button", { name: "Bespreek in Codex", exact: true })
      .click();
    await page
      .getByText("Terminalcommando gekopieerd.", { exact: true })
      .waitFor();
    assert.match(
      await page.evaluate(() => window.copiedHandoff),
      /^codex --cd /,
    );
    assert.equal(flow.starts.length, 0);
  } finally {
    await page.close();
  }
});
