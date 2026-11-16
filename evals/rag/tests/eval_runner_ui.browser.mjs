// Run with COA_PLAYWRIGHT_CORE=/path/to/playwright-core (no dev-browser).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.COA_PLAYWRIGHT_CORE || 'playwright-core');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const assets = {
  '/resultaten/': 'evals/rag/site/results.html',
  '/assets/site.css': 'static/site/site.css',
  '/assets/eval-runner.js': 'evals/rag/site/eval-runner.js',
  '/assets/eval-runner.css': 'evals/rag/site/eval-runner.css',
  '/assets/promptfoo-results.js': 'evals/rag/site/promptfoo-results.js',
  '/assets/results.js': 'evals/rag/site/results.js',
  '/assets/language.js': 'static/site/language.js',
  '/assets/results.json': 'evals/rag/site/results.json',
};
let server, browser, base;
before(async () => {
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const path = assets[pathname];
      if (!path) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'text/html');
      response.end(await readFile(root + path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.COA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
});
after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });
const source = (id, text) => ({ source_id: 'ACT-TUIN-001', id, source_title: 'Tuinieren', heading: id === 'S2' ? 'Tijd' : 'Locatie', source_date: '2026-10-20', text });
const sources = { time: source('S2', 'Iedere dinsdag van 10.00 tot 12.00 uur.'), location: source('S3', 'Buurttuin De Linde. <script>window.sourceInjected=true</script>') };
const expectedSource = item => ({ ...item, section_id: item.id });
const goals = [
  { id: 'time', description: 'Wanneer de activiteit plaatsvindt', alternatives: [[expectedSource(sources.time)]] },
  { id: 'location', description: 'Waar de activiteit plaatsvindt', alternatives: [[expectedSource(sources.location)]] },
];
const catalog = {
  schema_version: 1,
  evals: ['garden-time-location', 'indoor-tuesday', 'two-activities'].map(id => ({ id, title: id === 'garden-time-location' ? 'Tijd en plaats' : id === 'indoor-tuesday' ? 'Een passende activiteit' : 'Meerdere bronstukken', question: `Vaste vraag ${id}?`, expected_goals: goals })),
  methods: [{ id: 'dense', label: 'Op betekenis', uses_embeddings: true }, { id: 'bm25', label: 'Op woorden', uses_embeddings: false }],
  embedding_models: [{ id: 'model-a', label: 'MiniLM A', repository:'fixture/model-a', dimensions:384, available: true }, { id: 'model-b', label: 'MiniLM B', repository:'fixture/model-b', dimensions:384, available: true }],
  default_method: 'dense', default_embedding_model: 'model-a', sources,
};
function completed(body, status = 'failed') {
  return { run_id: 'run-one', eval_id: body.eval_id, status: 'completed', method: body.method, embedding_model: body.embedding_model, embedding_identity: {model: 'fixture/'+body.embedding_model+'@'+'a'.repeat(40), dimensions: 384}, result: {
    sources, rows: [{ id: 'result-one', case_id: body.eval_id, question: `Vaste vraag ${body.eval_id}?`, status, source_complete: status === 'passed', goals: goals.map((goal, index) => ({...goal, covered: index === 0 || status === 'passed', alternatives: goal.alternatives.map(option => option.map(ref => ({source_id: ref.source_id, section_id: ref.section_id, found: index === 0 || status === 'passed'})))})), configuration: { method: body.method, embedding_model: body.embedding_model, top_k: 3 }, metrics: { covered_goals: status === 'passed' ? 2 : 1, target_goals: 2, source_quality_applicable: true }, calls: [{ index: 1, query: `Vaste vraag ${body.eval_id}?`, hits: status === 'passed' ? ['time', 'location'] : ['time'] }], reason: 'Bronkwaliteit op vaste bronverwachtingen.' }],
  } };
}
async function fixture(options = {}) {
  const page = await browser.newPage({ viewport: options.mobile ? { width: 375, height: 812 } : { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  const starts = []; const headers = []; let polls = 0; let sessions = 0; let cancelled = false;
  await page.route('**/api/session', route => { sessions++; return route.fulfill({json:{session_id:'test-session'}}); });
  await page.route('**/api/evals/rag', route => route.fulfill({ json: { schema_version: 1, source: 'promptfoo', sources: {}, evaluations: [] } }));
  await page.route('**/api/evals/rag/catalog', route => route.fulfill({ json: catalog }));
  await page.route('**/api/evals/rag/runs', async route => {
    headers.push(route.request().headers()['x-session-id']);
    const body = route.request().postDataJSON(); starts.push(body);
    await route.fulfill({ status: 202, json: { run_id: 'run-one', eval_id: body.eval_id, status: 'running', progress: { completed: 0, total: 1 } } });
  });
  await page.route('**/api/evals/rag/runs/run-one', async route => {
    headers.push(route.request().headers()['x-session-id']);
    if (route.request().method()==='DELETE') {cancelled=true;await route.fulfill({json:{run_id:'run-one',eval_id:starts.at(-1).eval_id,status:'cancelled'}});return;}
    polls++;
    if (cancelled) {await route.fulfill({json:{run_id:'run-one',eval_id:starts.at(-1).eval_id,status:'cancelled'}});return;}
    if (options.longRunning) {await route.fulfill({json:{run_id:'run-one',eval_id:starts.at(-1).eval_id,status:'preparing'}});return;}
    await route.fulfill({ json: options.result ? options.result(starts.at(-1)) : completed(starts.at(-1)) });
  });
  await page.goto(base + '/resultaten/');
  return { page, starts, headers, get cancelled() {return cancelled;}, get sessions() { return sessions; }, get polls() { return polls; } };
}
test('three collapsed tests only run on click and retain results after reopening', async () => {
  const flow = await fixture(); const { page, starts } = flow;
  try {
    await page.waitForSelector('.search-eval-card');
    assert.equal(await page.locator('.search-eval-card').count(), 3);
    assert.equal(await page.locator('.search-eval-card[open]').count(), 0);
    assert.equal(starts.length, 0); assert.equal(flow.sessions,0);
    const card = page.locator('#eval-garden-time-location');
    await card.locator('summary').first().click();
    assert.match(await card.innerText(), /Vaste vraag garden-time-location/);
    assert.match(await card.innerText(), /Wanneer de activiteit/);
    await card.getByLabel('Embeddingmodel').selectOption('model-b');
    await card.getByRole('button', { name: 'Start test', exact: true }).click();
    await card.locator('.eval-results').getByText(/onvolledig/i).first().waitFor();
    assert.ok(flow.headers.length>=2);assert.ok(flow.headers.every(header=>header==='test-session'));
    assert.deepEqual(starts, [{ eval_id: 'garden-time-location', method: 'dense', embedding_model: 'model-b' }]);
    assert.match(await card.locator('.eval-results').innerText(), /Gevonden/);
    assert.match(await card.locator('.eval-results').innerText(), /Niet gevonden/);
    assert.match(await card.locator('.eval-results').innerText(), /MiniLM B/);
    await card.locator('summary').first().click(); await card.locator('summary').first().click();
    assert.equal(starts.length, 1);
    assert.match(await card.locator('.eval-results').innerText(), /onvolledig/i);
    assert.equal(await page.evaluate(() => window.sourceInjected === true), false);
  } finally { await page.close(); }
});
test('word search marks the disabled embedding label; mobile retains every control', async () => {
  const { page, starts } = await fixture({ mobile: true });
  try {
    await page.waitForSelector('#eval-garden-time-location'); const card = page.locator('#eval-garden-time-location');
    await card.locator('summary').first().click();
    await card.getByLabel('Zoekmethode').selectOption('bm25');
    assert.equal(await card.getByLabel('Embeddingmodel').isDisabled(), true);
    assert.equal(await card.getByLabel('Embeddingmodel (niet gebruikt)', {exact:true}).count(), 1);
    assert.equal(starts.length, 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await card.getByRole('button', { name: 'Start test', exact: true }).isVisible(), true);
  } finally { await page.close(); }
});
test('targetless results remain unscored and execution errors never become source success', async () => {
  for (const executionError of [false, true]) {
    const { page } = await fixture({ result(body) {
      if (executionError) return { run_id: 'run-one', eval_id: body.eval_id, status: 'failed', error: 'De lokale zoektest kon niet worden uitgevoerd.' };
      const result = completed(body); const row = result.result.rows[0];
      row.source_complete = null; row.metrics = { covered_goals: 0, target_goals: 0, source_quality_applicable: false }; row.goals = [];
      return result;
    } });
    try {
      await page.waitForSelector('#eval-garden-time-location'); const card = page.locator('#eval-garden-time-location'); await card.locator('summary').first().click();
      await card.getByRole('button', { name: 'Start test', exact: true }).click();
      await card.locator('.eval-status').getByText(executionError ? /kon niet/ : /afgerond/i).waitFor();
      const text = await card.innerText();
      assert.match(text, executionError ? /Uitvoeringsfout/i : /niet beoordeelbaar|N\/A/i);
      assert.doesNotMatch(await card.locator('.eval-results').innerText(), /Bronset compleet/);
    } finally { await page.close(); }
  }
});

test('a missing or different actual embedding identity cannot produce a successful source result', async () => {
  for (const missing of [false,true]) {
    const flow=await fixture({result(body){const run=completed(body,'passed');run.embedding_identity=missing?null:{model:'fixture/model-a@'+'a'.repeat(40),dimensions:384};return run;}});
    try {
      const {page}=flow;await page.waitForSelector('#eval-garden-time-location');const card=page.locator('#eval-garden-time-location');await card.locator('summary').first().click();
      await card.getByLabel('Embeddingmodel').selectOption('model-b');await card.getByRole('button',{name:'Start test',exact:true}).click();
      await card.locator('.eval-card-state').getByText('Uitvoeringsfout',{exact:true}).waitFor();
      assert.doesNotMatch(await card.locator('.eval-results').innerText(),/Bronset compleet/);
    } finally {await flow.page.close();}
  }
});

test('stopping model preparation cancels only the current run and gives no source score', async () => {
  const flow=await fixture({longRunning:true});
  try {
    const {page}=flow;await page.waitForSelector('#eval-garden-time-location');const card=page.locator('#eval-garden-time-location');await card.locator('summary').first().click();
    await card.getByRole('button',{name:'Start test',exact:true}).click();await card.getByRole('button',{name:'Stop test',exact:true}).click();
    await card.locator('.eval-card-state').getByText('Geannuleerd',{exact:true}).waitFor();
    assert.equal(flow.cancelled,true);assert.equal(flow.starts.length,1);assert.doesNotMatch(await card.innerText(),/Uitvoeringsfout|Bronset compleet/);
    assert.equal(await card.getByRole('button',{name:'Start test',exact:true}).isEnabled(),true);
  } finally {await flow.page.close();}
});

test('historical run catalogs stay outside the three-test flow until the archive is opened',async()=>{
 const flow=await fixture();
 try {
  const {page}=flow;await page.waitForSelector('.search-eval-card');
  assert.equal(await page.locator('script[src^="/assets/promptfoo-results.js"]').count(),0);
  await page.locator('#saved-evaluations>summary').click();
  await page.locator('#rag-eval-status').getByText(/geen promptfoo-uitvoering/).waitFor();
  assert.equal(await page.locator('script[src^="/assets/promptfoo-results.js"]').count(),1);
  assert.equal(flow.starts.length,0);assert.equal(flow.sessions,0);
 } finally {await flow.page.close();}
});
