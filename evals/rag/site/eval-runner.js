'use strict';
(async () => {
  const byId = id => document.getElementById(id);
  const list = byId('search-eval-list');
  if (!list) return;
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined && text !== null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const cards = [];
  let catalog;
  let active = null;
  let sessionId = null;
  const methodFor = id => catalog.methods.find(item => item.id === id);
  const modelName = id => catalog.embedding_models.find(item => item.id === id)?.label || id;
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Intl.DateTimeFormat('nl-NL', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value + 'T00:00:00Z')) : 'Datum onbekend';
  const referenceKey = source => source.source_id + ':' + (source.section_id || source.id);
  async function request(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('De server gaf geen leesbaar resultaat.'); }
    if (!response.ok) throw new Error(typeof payload.error?.message === 'string' ? payload.error.message : typeof payload.error === 'string' ? payload.error : 'De zoektest is nu niet beschikbaar. Probeer het later opnieuw.');
    return payload;
  }
  function state(card, text, type = '') {
    card.state.textContent = text;
    card.state.dataset.status = type;
  }
  function controls() {
    for (const card of cards) {
      const usesEmbeddings = methodFor(card.method.value)?.uses_embeddings === true;
      card.method.disabled = Boolean(active);
      card.model.disabled = Boolean(active) || !usesEmbeddings;
      card.start.disabled = Boolean(active) || (usesEmbeddings && !catalog.embedding_models.some(model => model.available));
      card.modelLabel.textContent = usesEmbeddings ? 'Embeddingmodel' : 'Embeddingmodel (niet gebruikt)';
    }
  }
  function sourceLabel(ref) {
    return [ref.source_title || ref.source_id, ref.heading || ref.section_id || ref.id].filter(Boolean).join(' · ');
  }
  function expected(card, evaluation) {
    const section = node('section', null, 'eval-expectations');
    section.append(node('h3', 'Deze informatie verwachten we'));
    if (!evaluation.expected_goals?.length) {
      section.append(node('p', 'Er is geen positieve bronverwachting vastgelegd. Bronkwaliteit is voor deze vraag niet beoordeelbaar.'));
    } else {
      const goals = node('ul', null, 'eval-goals');
      for (const goal of evaluation.expected_goals) {
        const item = node('li'); item.append(node('p', goal.description, 'eval-goal-description'));
        goal.alternatives.forEach((option, index) => {
          if (goal.alternatives.length > 1) item.append(node('p', 'Optie ' + (index + 1), 'site-caption'));
          option.forEach(ref => {
            card.references.set(referenceKey(ref), ref);
            const details = node('details', null, 'eval-source-preview');
            details.append(node('summary', sourceLabel(ref)), node('p', 'Brondatum ' + date(ref.source_date), 'source-date'), node('blockquote', ref.text, 'source-text'));
            item.append(details);
          });
        });
        goals.append(item);
      }
      section.append(goals);
    }
    return section;
  }
  function provenance(card, run) {
    const details = node('details', null, 'eval-provenance'); details.append(node('summary', 'Over deze uitvoering'));
    const method = methodFor(run.method);
    const identity = run.embedding_identity;
    const actualModel = identity?.model_id || identity?.id || identity?.model_name || identity?.model;
    const actualSpec=catalog.embedding_models.find(model=>actualModel?.startsWith(model.repository+'@'));
    const used = method?.uses_embeddings === false ? 'Geen embeddings gebruikt' : actualSpec ? actualSpec.label : actualModel || 'Gebruikt embeddingmodel niet teruggegeven';
    card.results.append(node('p', [method?.label || run.method, used].filter(Boolean).join(' · '), 'eval-used-configuration'));
    details.append(node('p', 'Uitvoering ' + run.run_id, 'site-caption'));
    if (actualModel) details.append(node('p', 'Modelversie: ' + actualModel, 'eval-hash site-caption'));
    if (identity?.dimensions) details.append(node('p', identity.dimensions + ' dimensies', 'site-caption'));
    for (const [key, label] of [['source_sha256', 'Bronversie'], ['vectors_sha256', 'Indexversie']]) {
      if (run.corpus_identity?.[key]) details.append(node('p', label + ': ' + run.corpus_identity[key], 'eval-hash site-caption'));
    }
    return details;
  }
  function renderResult(card, run) {
    if (!run.result || !Array.isArray(run.result.rows) || !run.result.rows.length || !run.result.sources) throw new Error('De uitvoering bevat geen controleerbare bronresultaten.');
    const rows = run.result.rows;
    card.results.replaceChildren();
    const technical = rows.some(row => row.status === 'error');
    if (technical) {
      state(card, 'Uitvoeringsfout', 'error');
      card.results.append(node('h3', 'De bronkwaliteit is niet beoordeeld.'), node('p', 'De lokale uitvoering of broncontrole kon niet worden afgerond.'));
      return;
    }
    const runDetails=provenance(card,run);
    for (const row of rows) {
      const applicable = row.metrics?.source_quality_applicable === true && row.source_complete !== null;
      const complete = applicable && row.source_complete === true;
      const heading = !applicable ? 'Bronkwaliteit: niet beoordeelbaar (N/A)' : complete ? 'Bronset compleet' : 'Bronset onvolledig';
      state(card, !applicable ? 'Niet beoordeelbaar' : complete ? 'Bronnen compleet' : 'Bronnen onvolledig', !applicable ? '' : complete ? 'complete' : 'incomplete');
      card.results.append(node('h3', heading, 'eval-result-heading'));
      if (applicable) card.results.append(node('p', `${row.metrics.covered_goals} van ${row.metrics.target_goals} verwachte bronstukken gevonden.`));
      else card.results.append(node('p', 'Er staat voor deze vraag geen positieve bronset vast. Dit is geen geslaagde of gezakte broncontrole.'));
      if (Array.isArray(row.goals) && row.goals.length) {
        const goals = node('ul', null, 'eval-goal-results');
        row.goals.forEach(goal => {
          const item = node('li');
          item.append(node('p', (goal.covered ? 'Gevonden: ' : 'Niet gevonden: ') + goal.description, goal.covered ? 'eval-found' : 'eval-missing'));
          goal.alternatives.forEach((option, optionIndex) => {
            if (goal.alternatives.length > 1) item.append(node('p', 'Optie ' + (optionIndex + 1), 'site-caption'));
            option.forEach(ref => {
              const source = card.references.get(referenceKey(ref)) || ref;
              item.append(node('p', (ref.found ? 'Gevonden · ' : 'Niet gevonden · ') + sourceLabel(source), 'site-caption'));
            });
          });
          goals.append(item);
        });
        card.results.append(goals);
      }
      card.results.append(node('h3', 'Werkelijk gevonden bronstukken'));
      const hits = node('ol', null, 'eval-hits');
      for (const call of row.calls || []) {
        for (const key of call.hits || []) {
          const source = run.result.sources[key];
          if (!source) throw new Error('Een gevonden bronstuk ontbreekt in het resultaat.');
          const item = node('li');
          item.append(node('h4', sourceLabel(source)), node('p', 'Brondatum ' + date(source.source_date), 'source-date'), node('blockquote', source.text, 'source-text'));
          hits.append(item);
        }
      }
      if (hits.children.length) card.results.append(hits);
      else card.results.append(node('p', 'Er zijn geen bronstukken teruggegeven.'));
    }
    card.results.append(runDetails);
  }
  function failed(card, message) {
    state(card, 'Uitvoeringsfout', 'error');
    card.status.textContent = message;
    card.results.replaceChildren(node('p', 'Er volgt geen oordeel over de bronkwaliteit.'));
  }
  function release(card) {
    clearTimeout(card.timer);card.runId=null;card.stop.hidden=true;card.cancelling=false;
    active = null; card.results.setAttribute('aria-busy', 'false'); controls();
  }
  async function poll(card, runId, selection) {
    if (active!==card || card.runId!==runId || card.cancelling)return;
    clearTimeout(card.timer);
    let terminal = false;
    try {
      const run = await request('/api/evals/rag/runs/' + encodeURIComponent(runId), {headers:{'x-session-id':sessionId}});
      if (active!==card || card.runId!==runId || card.cancelling)return;
      terminal = ['completed','failed','cancelled'].includes(run.status);
      if (run.run_id !== runId || run.eval_id !== card.evaluation.id) throw new Error('De ontvangen uitvoering hoort niet bij deze test.');
      if (run.status === 'completed') {
        if (run.method !== selection.method || (methodFor(run.method)?.uses_embeddings && run.embedding_model !== selection.embedding_model)) throw new Error('De uitgevoerde zoekinstellingen wijken af van de gekozen instellingen.');
        if (methodFor(run.method)?.uses_embeddings) {
          const spec=catalog.embedding_models.find(model=>model.id===selection.embedding_model);
          const actual=run.embedding_identity;
          if (!spec?.repository || typeof actual?.model!=='string' || !actual.model.startsWith(spec.repository+'@') || !/^[0-9a-f]{40}$/.test(actual.model.slice(spec.repository.length+1)) || actual.dimensions!==spec.dimensions) throw new Error('Het werkelijk gebruikte embeddingmodel past niet bij deze uitvoering.');
        } else if (run.embedding_identity!==null || run.embedding_model!==null) throw new Error('Woordzoeken mag geen gebruikt embeddingmodel vermelden.');
        renderResult(card, run); card.status.textContent = 'Test afgerond.'; release(card); return;
      }
      if (run.status === 'cancelled') {
        state(card,'Geannuleerd');card.status.textContent='De zoektest is gestopt.';card.results.replaceChildren(node('p','Geen bronkwaliteitsscore: de uitvoering is geannuleerd.'));release(card);return;
      }
      if (run.status === 'failed') {
        failed(card, run.error?.message || 'De lokale zoektest kon niet worden uitgevoerd.'); release(card); return;
      }
      if (!['preparing', 'running'].includes(run.status)) throw new Error('De server gaf een onbekende uitvoeringsstatus.');
      card.status.textContent = run.status === 'preparing' ? methodFor(selection.method)?.uses_embeddings ? modelName(selection.embedding_model)+' en zoekindex voorbereiden…' : 'Zoekindex voorbereiden…' : 'Bronstukken zoeken en controleren…';
      if (Number.isInteger(run.progress?.completed) && Number.isInteger(run.progress?.total) && run.progress.total > 0) card.status.textContent += ` ${run.progress.completed} van ${run.progress.total} afgerond.`;
      card.timer=setTimeout(() => poll(card, runId, selection), 750);
    } catch (error) {
      if (terminal) { failed(card, error.message); release(card); return; }
      state(card, 'Status onbekend');
      card.status.textContent = error.message + ' De zoektest kan nog lopen. Haal de status opnieuw op.';
      const retry = node('button', 'Status opnieuw ophalen'); retry.type = 'button';
      retry.addEventListener('click', () => { retry.remove(); poll(card, runId, selection); }, { once: true });
      card.results.replaceChildren(retry);
    }
  }
  async function start(card) {
    if (active) return;
    const selection = { eval_id: card.evaluation.id, method: card.method.value, embedding_model: card.model.value };
    active = card; controls(); state(card, 'Bezig'); card.status.textContent = 'Zoektest starten…'; card.results.replaceChildren(); card.results.setAttribute('aria-busy', 'true');
    try {
      if (!sessionId) {
        const session = await request('/api/session', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seen_question_ids:[]})});
        if (typeof session.session_id !== 'string' || !session.session_id) throw new Error('Er kon geen lokale sessie worden gestart.');
        sessionId = session.session_id;
      }
      const run = await request('/api/evals/rag/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-id':sessionId }, body: JSON.stringify(selection) });
      if (typeof run.run_id !== 'string' || run.eval_id !== card.evaluation.id) throw new Error('De server gaf geen geldige uitvoering terug.');
      card.runId=run.run_id;card.selection=selection;card.stop.hidden=false;card.stop.disabled=false;
      await poll(card, run.run_id, selection);
    } catch (error) { failed(card, error.message); release(card); }
  }
  async function stop(card) {
    if (active!==card || !card.runId || card.cancelling)return;
    card.cancelling=true;card.stop.disabled=true;clearTimeout(card.timer);card.status.textContent='Zoektest stoppen…';
    try {
      await request('/api/evals/rag/runs/'+encodeURIComponent(card.runId),{method:'DELETE',headers:{'x-session-id':sessionId}});
      card.cancelling=false;await poll(card,card.runId,card.selection);
    } catch(error) {
      card.cancelling=false;card.stop.disabled=false;card.status.textContent=error.message+' Controleer opnieuw of de test nog loopt.';
      card.timer=setTimeout(()=>poll(card,card.runId,card.selection),750);
    }
  }
  function makeCard(evaluation) {
    const details = node('details', null, 'search-eval-card'); details.id = 'eval-' + evaluation.id;
    const summary = node('summary'); const title = node('span', evaluation.title, 'eval-card-title'); const badge = node('span', 'Nog niet uitgevoerd', 'eval-card-state'); summary.append(title, badge);
    const body = node('div', null, 'eval-card-body');
    body.append(node('p', evaluation.question, 'eval-question'));
    const card = { details, evaluation, state: badge, references: new Map() };
    body.append(expected(card, evaluation));
    const form = node('div', null, 'eval-controls');
    const methodId = details.id + '-method'; const modelId = details.id + '-embedding';
    card.method = node('select'); card.method.id = methodId;
    const availableMethods = Array.isArray(evaluation.methods) ? catalog.methods.filter(method => evaluation.methods.includes(method.id)) : catalog.methods;
    availableMethods.forEach(method => { const option = node('option', method.label); option.value = method.id; card.method.append(option); });
    card.method.value = availableMethods.some(method => method.id === catalog.default_method) ? catalog.default_method : availableMethods[0]?.id;
    card.model = node('select'); card.model.id = modelId;
    catalog.embedding_models.forEach(model => { const option = node('option', model.label + (model.available ? '' : ' · niet beschikbaar')); option.value = model.id; option.disabled = !model.available; card.model.append(option); });
    card.model.value = catalog.embedding_models.some(model => model.id === catalog.default_embedding_model && model.available) ? catalog.default_embedding_model : catalog.embedding_models.find(model => model.available)?.id || '';
    const methodLabel = node('label', 'Zoekmethode'); methodLabel.htmlFor = methodId;
    card.modelLabel = node('label', 'Embeddingmodel'); card.modelLabel.htmlFor = modelId;
    const methodField = node('div'); methodField.append(methodLabel, card.method); const modelField = node('div'); modelField.append(card.modelLabel, card.model); form.append(methodField, modelField);
    card.method.addEventListener('change', controls);
    card.start = node('button', 'Start test', 'eval-start'); card.start.type = 'button'; card.start.addEventListener('click', () => start(card));
    card.stop=node('button','Stop test','eval-stop');card.stop.type='button';card.stop.hidden=true;card.stop.addEventListener('click',()=>stop(card));
    const buttons=node('div',null,'eval-run-buttons');buttons.append(card.start,card.stop);
    card.status = node('p', '', 'eval-status'); card.status.setAttribute('role', 'status');
    card.results = node('section', null, 'eval-results'); card.results.setAttribute('aria-label', 'Resultaat van ' + evaluation.title);
    body.append(form, buttons, card.status, card.results); details.append(summary, body); cards.push(card); return details;
  }
  async function load() {
    byId('eval-catalog-retry').hidden = true;
    byId('eval-catalog-status').textContent = 'Zoektests laden…';
    try {
      catalog = await request('/api/evals/rag/catalog');
      if (catalog.schema_version !== 1 || !Array.isArray(catalog.evals) || catalog.evals.length !== 3 || !Array.isArray(catalog.methods) || !catalog.methods.length || !Array.isArray(catalog.embedding_models) || !catalog.embedding_models.length) throw new Error('De drie zoektests zijn nu niet beschikbaar.');
      cards.length = 0; list.replaceChildren(...catalog.evals.map(makeCard)); controls();
      byId('eval-catalog-status').textContent = '';
    } catch (error) { byId('eval-catalog-status').textContent = error.message; byId('eval-catalog-retry').hidden = false; }
  }
  let archiveLoaded=false;
  byId('saved-evaluations')?.addEventListener('toggle',event=>{
    if (!event.target.open || archiveLoaded)return;
    archiveLoaded=true;
    for (const src of ['/assets/results.js?v=20261109','/assets/promptfoo-results.js?v=20261113']) {
      const script=document.createElement('script');script.src=src;script.async=false;document.head.append(script);
    }
  });
  byId('eval-catalog-retry').addEventListener('click', load);
  await load();
})();
