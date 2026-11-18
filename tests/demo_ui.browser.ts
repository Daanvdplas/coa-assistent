// Run with COA_PLAYWRIGHT_CORE=/path/to/playwright-core and COA_BROWSER=/path/to/chrome.
// Every API response is synthetic; no model calls are made.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.COA_PLAYWRIGHT_CORE || "playwright-core");
const root = fileURLToPath(new URL("../", import.meta.url));
const assets = new Map([
  ["/", "static/index.html"],
  ["/assets/site.css", "static/site/site.css"],
  ["/assets/language.js", "static/site/language.js"],
  ["/assets/demo.js", "static/site/demo.js"],
  ["/assets/coa-symbol.svg", "static/site/coa-symbol.svg"],
]);
const server = createServer(async (request, response) => {
  const path = assets.get(new URL(request.url || "/", "http://localhost").pathname);
  if (!path) { response.writeHead(404).end(); return; }
  const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".svg") ? "image/svg+xml" : "text/html";
  response.setHeader("Content-Type", type + "; charset=utf-8");
  response.end(await readFile(root + path));
});
let browser: any;
let base: string;
before(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: process.env.COA_BROWSER, headless: true });
});
after(async () => {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function answer(text: string, language = "nl", mobile = false) {
  const page = await browser.newPage({ viewport: { width: mobile ? 375 : 1280, height: 900 } });
  const run = { id: "fixture-run", status: "completed", context: { answer_language: language }, result: { answer: { text, citations: [], unknowns: [] }, tool_calls: [] } };
  await page.route("**/api/**", (route: any) => {
    const path = new URL(route.request().url()).pathname;
    const json = path === "/api/source" ? { runtime_ready: true, sources: [] }
      : path === "/api/session" ? { session_id: "fixture-session", runs: [] } : run;
    return route.fulfill({ json });
  });
  await page.addInitScript((language: string) => localStorage.setItem("coa-demo-language", language), language);
  await page.goto(base);
  await page.locator("#question").fill(language === "nl" ? "Zet de opties naast elkaar." : "Compare the options.");
  await page.locator("#form button[type=submit]").click();
  await page.locator("#result").waitFor({ state: "visible" });
  return page;
}

test("comparison answers become accessible tables without losing uncertainty or executing cell HTML", async () => {
  for (const language of ["nl", "en"]) {
    const caveat = language === "nl" ? "Andere opties zijn nog niet gecontroleerd." : "Other options have not been checked yet.";
    const page = await answer(`| Activiteit | Dag | Tijd | Wat je kunt doen |\n| --- | --- | --- | --- |\n| Fietsen repareren | Dinsdag | 14:00–16:00 | Fietsen nakijken |\n| Taalcafé | Woensdag | 14:00–15:30 | <img src=x onerror=window.injected=true> |\n\n${caveat}`, language, true);
    try {
      assert.equal(await page.locator("#answer table").count(), 1);
      assert.equal(await page.locator("#answer thead th").count(), 4);
      assert.equal(await page.locator("#answer tbody tr").count(), 2);
      assert.equal(await page.locator("#answer img").count(), 0);
      assert.equal(await page.evaluate(() => Boolean((window as any).injected)), false);
      assert.match(await page.locator("#answer").innerText(), /<img src=x onerror=window.injected=true>/);
      assert((await page.locator("#answer").innerText()).includes(caveat));
      assert.equal(await page.locator("#answer").getAttribute("lang"), language);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.locator("#answer .answer-table").focus();
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("answer-table")), true);
    } finally { await page.close(); }
  }
});

test("short lists use list items while malformed tables and ordinary text stay intact", async () => {
  const text = "Twee opties:\n- Fietsen repareren\n- Taalcafé\n\n| Activiteit | Tijd |\n| --- | --- |\n| Onvolledige rij |\n\n<svg onload=window.injected=true>";
  const page = await answer(text);
  try {
    assert.equal(await page.locator("#answer ul li").count(), 2);
    assert.equal(await page.locator("#answer table").count(), 0);
    const rendered = await page.locator("#answer").innerText();
    assert(rendered.includes("| Onvolledige rij |"));
    assert(rendered.includes("<svg onload=window.injected=true>"));
    assert.equal(await page.locator("#answer svg").count(), 0);
    assert.equal(await page.evaluate(() => Boolean((window as any).injected)), false);
  } finally { await page.close(); }
});
