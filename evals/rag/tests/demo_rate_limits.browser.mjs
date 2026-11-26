// Run with COA_PLAYWRIGHT_CORE=/path/to/playwright-core and COA_CHROME=/path/to/chrome.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { after, before } from "node:test";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.COA_PLAYWRIGHT_CORE || "playwright-core");
const site = new URL("../../../static/", import.meta.url);
const start = new Date("2026-11-24T10:00:00Z");
let browser;

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.COA_CHROME, headless: true });
});
after(async () => { await browser?.close(); });

async function submitQuestion(t, code, retrySeconds, retryHeader, completionError) {
  const page = await browser.newPage();
  t.after(() => page.close());
  page.setDefaultTimeout(5000);
  await page.clock.setFixedTime(start);
  await page.route("**/*", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ path: new URL("index.html", site).pathname });
    if (path.startsWith("/assets/")) {
      return route.fulfill({ path: new URL(path.replace("/assets/", "site/"), site).pathname });
    }
    if (path === "/api/source") {
      return route.fulfill({ json: { sources: [], runtime_ready: true } });
    }
    if (path === "/api/session") {
      return route.fulfill({ json: { session_id: "local-test", summary: { runs: [] } } });
    }
    if (path === "/api/runs/r-1-1" && completionError) {
      return route.fulfill({ json: { id: "r-1-1", status: "failed", error: completionError } });
    }
    if (path === "/api/runs") {
      if (completionError) return route.fulfill({ json: { id: "r-1-1", status: "pending" } });
      return route.fulfill({
        status: 429,
        headers: retryHeader === undefined ? {} : { "Retry-After": retryHeader },
        json: { error: "Vraag tijdelijk geblokkeerd.", code, retry_after_seconds: retrySeconds },
      });
    }
    return route.abort();
  });
  await page.goto("http://coa.test/");
  await page.locator("#question").fill("Welke activiteit past bij mij?");
  await page.getByRole("button", { name: "Zoek een antwoord" }).click();
  await page.locator(completionError ? "#answer.error" : "#status.error").waitFor({ state: "visible" });
  return page;
}

async function selectEnglish(page) {
  await page.locator("#language-trigger").click();
  await page.getByRole("button", { name: "English" }).click();
}

test("the demo accepts a question without offering a choice of search method", async t => {
  const page = await submitQuestion(t, "demo_rate_limit", 30);
  assert.equal(await page.locator("#form").getByRole("combobox").count(), 0);
});

test("network limit rounds up and shows the remaining time after switching languages", async t => {
  const page = await submitQuestion(t, "ip_rate_limit", 61);
  const status = page.getByRole("status");
  assert.equal(await status.textContent(), "Vanaf jouw netwerk zijn net veel vragen gesteld. Je kunt over 2 minuten weer verder.");
  await page.clock.setFixedTime(new Date(start.getTime() + 1000));
  await selectEnglish(page);
  assert.equal(await status.textContent(), "There have been several questions from your network. You can try again in 1 minute.");
});

test("demo limit can show the wait from Retry-After in seconds", async t => {
  const page = await submitQuestion(t, "demo_rate_limit", undefined, "2");
  const status = page.getByRole("status");
  assert.equal(await status.textContent(), "Het is even druk bij de demo. Probeer het over 2 seconden nog eens.");
  await page.clock.setFixedTime(new Date(start.getTime() + 1000));
  await selectEnglish(page);
  assert.equal(await status.textContent(), "The demo is busy right now. Try again in 1 second.");
});

test("demo limit with no usable wait asks the visitor to try again shortly", async t => {
  const page = await submitQuestion(t, "demo_rate_limit", "unknown", "-1");
  const status = page.getByRole("status");
  assert.equal(await status.textContent(), "Het is even druk bij de demo. Probeer het zo nog eens.");
  await selectEnglish(page);
  assert.equal(await status.textContent(), "The demo is busy right now. Try again in a moment.");
});

test("legacy hourly rejections keep their existing message", async t => {
  const page = await submitQuestion(t, "rate_limit", 60, "60");
  assert.equal(await page.getByRole("status").textContent(), "Je hebt de limiet voor vragen bereikt. Wacht even en probeer het later opnieuw.");
});

test("enforced project spending stops show a specific bilingual message without promising a retry", async t => {
  const page = await submitQuestion(t, undefined, undefined, undefined, "budget: De uitgavenlimiet van de demo is bereikt.");
  assert.equal(await page.locator("#answer").textContent(), "De demo kan tijdelijk geen vragen beantwoorden. Je kunt de activiteiten wel bekijken.");
  assert.equal(await page.locator("#status").textContent(), "");
  await selectEnglish(page);
  assert.equal(await page.locator("#answer").textContent(), "The demo is temporarily unable to answer questions. You can still browse the activities.");
  assert.equal(await page.locator("#status").textContent(), "");
});

test("other provider failures keep the existing general retry message", async t => {
  const page = await submitQuestion(t, undefined, undefined, undefined, "runtime: De antwoordservice heeft tijdelijk geen capaciteit of tegoed.");
  assert.equal(await page.locator("#answer").textContent(), "De antwoordservice kon de vraag niet afronden. Probeer het later opnieuw.");
  assert.equal(await page.getByRole("status").textContent(), "Er is geen antwoord beschikbaar. Je kunt de vraag opnieuw indienen.");
});
