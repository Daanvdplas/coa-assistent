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
  let benchmarkStarting = false;
  const localOnly = 'Zoektests kun je alleen lokaal starten.';
  const canRun = () => catalog?.can_run === true;
  const methodFor = id => catalog.methods.find(item => item.id === id);
  const modelName = id => catalog.embedding_models.find(item => item.id === id)?.label || id;
  async function request(url, options) {
    if (!['GET', 'HEAD'].includes((options?.method || 'GET').toUpperCase()) && !canRun()) throw new Error(localOnly);
    const response = await fetch(url, { cache: 'no-store', ...options });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('De server gaf geen leesbaar resultaat.'); }
    if (!response.ok) throw new Error(typeof payload.error?.message === 'string' ? payload.error.message : typeof payload.error === 'string' ? payload.error : 'De zoektest is nu niet beschikbaar. Probeer het later opnieuw.');
    return payload;
  }
  function state(card, text, type = '') {
    card.status.textContent = text;
    card.status.dataset.status = type;
  }
  function controls() {
    for (const card of cards) {
      const usesEmbeddings = methodFor(card.method.value)?.uses_embeddings === true;
      card.method.disabled = Boolean(active);
      card.model.disabled = Boolean(active) || !usesEmbeddings;
      card.start.disabled = !canRun() || Boolean(active) || (usesEmbeddings && !catalog.embedding_models.some(model => model.available));
      card.stop.disabled = !canRun() || card.cancelling === true;
      card.benchmark.disabled = !canRun() || Boolean(active) || benchmarkStarting || !card.evaluation.dataset || !card.evaluation.case_id;
      card.modelLabel.textContent = usesEmbeddings ? 'Embeddingmodel' : 'Embeddingmodel (niet gebruikt)';
    }
  }
  function sourceLabel(ref) {
    return [ref.source_title || ref.source_id, ref.heading || ref.section_id || ref.id].filter(Boolean).join(' · ');
  }
  const referenceKey=ref=>ref.source_id+':'+(ref.section_id || ref.id);
  function clearPresentation(card) {
    card.results.replaceChildren();
    for (const view of card.sourceViews.values()) {
      view.state.textContent='';view.content.classList.remove('eval-source-found');
    }
    state(card,'');
  }
  function selectionChanged(card) {
    if (active)return;
    const choice={method:card.method.value,embedding_model:card.model.value};
    if (choice.method!==card.choice.method || choice.embedding_model!==card.choice.embedding_model) clearPresentation(card);
    card.choice=choice;
    controls();
  }
  function expected(card, evaluation) {
    const section=node('section',null,'eval-expectations');
    section.append(node('h3','Verwachte bronstukken'));
    const goals=node('ul',null,'eval-goals');
    card.sourceViews=new Map();
    for (const goal of evaluation.expected_goals || []) {
      const item=node('li');item.dataset.goalId=goal.id;
      const content=node('div',null,'eval-goal-content');
      const alternatives=goal.alternatives || [];
      for (const [index,option] of alternatives.entries()) {
        if (index) content.append(node('p','of','eval-source-or'));
        for (const ref of option) {
          const key=referenceKey(ref);
          if (card.sourceViews.has(key)) {
            if (alternatives.length>1) content.append(node('p',sourceLabel(ref),'eval-goal-source'));
            continue;
          }
          const source=node('div',null,'eval-source'),heading=node('h4',sourceLabel(ref),'eval-goal-source'),status=node('span','','eval-source-state');
          heading.append(status);source.append(heading,node('blockquote',ref.text,'eval-goal-fragment'));content.append(source);
          card.sourceViews.set(key,{content:source,state:status});
        }
      }
      if(content.children.length){item.append(content);goals.append(item);}
      const references=new Set();
      for (const option of alternatives) for (const ref of option) {
        const key=referenceKey(ref);references.add(key);card.references.set(key,ref);
      }
      card.goalReferences.set(goal.id,references);
    }
    section.append(goals);
    return section;
  }
  function renderResult(card, run) {
    if (!run.result || !Array.isArray(run.result.rows) || run.result.rows.length!==1 || !run.result.sources) throw new Error('De uitvoering bevat geen controleerbare bronresultaten.');
    const row=run.result.rows[0];
    card.results.replaceChildren();
    if (row.status==='error') {
      failed(card,row.reason || 'De lokale broncontrole kon niet worden afgerond.');
      return;
    }
    const applicable=row.metrics?.source_quality_applicable===true && row.source_complete!==null;
    const matched=new Set();
    if (applicable) {
      const goals=new Map((row.goals || []).map(goal=>[goal.id,goal]));
      if (goals.size!==card.goalReferences.size) throw new Error('De broncontrole hoort niet bij de verwachte bronstukken.');
      for (const [id,references] of card.goalReferences) {
        const goal=goals.get(id);
        if (typeof goal?.covered!=='boolean') throw new Error('De broncontrole mist een verwachte bronstatus.');
        for (const option of goal.alternatives || []) for (const ref of option) {
          const key=referenceKey(ref);
          if (ref.found===true && references.has(key)) matched.add(key);
        }
      }
    }
    const verified=new Set(),seen=new Set();
    const hits=node('ol',null,'eval-hits');
    for (const call of row.calls || []) {
      for (const key of call.hits || []) {
        const source=run.result.sources[key];
        if (!source) throw new Error('Een gevonden bronstuk ontbreekt in het resultaat.');
        const identity=referenceKey(source);
        if (seen.has(identity))continue;
        seen.add(identity);
        const item=node('li');item.dataset.sourceId=source.source_id;item.dataset.sectionId=source.id;
        const details=node('details');
        const summary=node('summary');summary.append(node('span',sourceLabel(source),'eval-hit-title'));
        const expected=card.references.get(referenceKey(source));
        if (matched.has(referenceKey(source)) && expected && ['source_id','source_title','source_date','heading','text'].every(field=>source[field]===expected[field])) {
          verified.add(identity);continue;
        }
        details.append(summary,node('blockquote',source.text,'source-text'));
        item.append(details);hits.append(item);
      }
    }
    for(const [key,view] of card.sourceViews){
      view.state.textContent=applicable?(verified.has(key)?'Gevonden':'Ontbreekt'):'';
      view.content.classList.toggle('eval-source-found',applicable&&verified.has(key));
    }
    if (hits.children.length) card.results.append(node('h3','Andere gevonden bronstukken'),hits);
    else if (!seen.size) card.results.append(node('p','Geen bronstukken gevonden.'));
    const coverage=row.required_source_coverage;
    const known=coverage?.unit==='sections'&&Number.isInteger(coverage.found)&&Number.isInteger(coverage.total)&&coverage.found>=0&&coverage.found<=coverage.total;
    const score=node('p',coverage?.applicable===false||coverage?.total===0?'N.v.t.':known?`${coverage.found}/${coverage.total} bronsecties gevonden`:'Bronsecties: onbekend','eval-score');
    if(applicable&&known&&(coverage.found!==row.metrics.covered_goals||coverage.total!==row.metrics.target_goals))card.results.append(node('p',`${row.metrics.covered_goals}/${row.metrics.target_goals} bewijsdoelen compleet`,'eval-goal-score'));
    score.dataset.status=applicable?(row.source_complete?'complete':'incomplete'):'unassessed';
    score.setAttribute('role','status');card.results.append(score);
  }
  function failed(card, message) {
    clearPresentation(card);
    state(card,'Uitvoeringsfout: '+message,'error');
    card.results.replaceChildren();
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
        card.status.textContent='';renderResult(card, run);release(card);return;
      }
      if (run.status === 'cancelled') {
        state(card,'Geannuleerd');card.results.replaceChildren();release(card);return;
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
    if (!canRun() || active) return;
    const selection = { eval_id: card.evaluation.id, method: card.method.value, embedding_model: card.model.value };
    clearPresentation(card);active = card; controls(); state(card, 'Bezig'); card.status.textContent = 'Zoektest starten…'; card.results.replaceChildren(); card.results.setAttribute('aria-busy', 'true');
    try {
      if (!sessionId) {
        const session = await request('/api/session', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seen_question_ids:[]})});
        if (typeof session.session_id !== 'string' || !session.session_id) throw new Error('Er kon geen lokale sessie worden gestart.');
        sessionId = session.session_id;
      }
      const run = await request('/api/evals/rag/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-id':sessionId }, body: JSON.stringify(selection) });
      if (typeof run.run_id !== 'string' || run.eval_id !== card.evaluation.id) throw new Error('De server gaf geen geldige uitvoering terug.');
      card.runId=run.run_id;card.selection=selection;card.stop.hidden=false;card.stop.disabled=!canRun();
      await poll(card, run.run_id, selection);
    } catch (error) { failed(card, error.message); release(card); }
  }
  async function stop(card) {
    if (!canRun() || active!==card || !card.runId || card.cancelling)return;
    card.cancelling=true;card.stop.disabled=true;clearTimeout(card.timer);card.status.textContent='Zoektest stoppen…';
    try {
      await request('/api/evals/rag/runs/'+encodeURIComponent(card.runId),{method:'DELETE',headers:{'x-session-id':sessionId}});
      card.cancelling=false;await poll(card,card.runId,card.selection);
    } catch(error) {
      card.cancelling=false;card.stop.disabled=!canRun();card.status.textContent=error.message+' Controleer opnieuw of de test nog loopt.';
      card.timer=setTimeout(()=>poll(card,card.runId,card.selection),750);
    }
  }
  async function benchmark(card) {
    if (!canRun() || active || benchmarkStarting || !card.evaluation.dataset || !card.evaluation.case_id) return;
    benchmarkStarting=true;controls();byId('eval-catalog-status').textContent='Benchmark starten…';
    try {
      const {questionStartRequest}=await import('/assets/benchmark-model.js');
      const action=questionStartRequest(window.sessionStorage,{dataset:card.evaluation.dataset,case_id:card.evaluation.case_id,mode:'rag',repeats:2});
      const run=await request('/api/benchmarks/questions/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action.payload)});
      if(typeof run.id!=='string'||!run.id)throw new Error('De server gaf geen geldige benchmark terug.');
      sessionStorage.removeItem(action.key);window.location.assign('/benchmark/?run='+encodeURIComponent(run.id));
    }catch(error){benchmarkStarting=false;controls();byId('eval-catalog-status').textContent=error.message;}
  }
  function makeCard(evaluation) {
    const details = node('details', null, 'search-eval-card'); details.id = 'eval-' + evaluation.id;
    const summary = node('summary'); const title = node('span', evaluation.question, 'eval-card-title'); summary.append(title);
    const body = node('div', null, 'eval-card-body');
    const card = { details, evaluation, goalReferences: new Map(), references: new Map() };
    card.benchmark=node('button','Benchmark','eval-benchmark');card.benchmark.type='button';card.benchmark.disabled=true;
    card.benchmark.setAttribute('aria-label','Benchmark: '+evaluation.question);
    card.benchmark.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();benchmark(card);});
    summary.append(card.benchmark);
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
    card.choice={method:card.method.value,embedding_model:card.model.value};
    card.method.addEventListener('change',()=>selectionChanged(card));
    card.model.addEventListener('change',()=>selectionChanged(card));
    card.start = node('button', 'Start test', 'eval-start'); card.start.type = 'button'; card.start.disabled = true; card.start.addEventListener('click', () => start(card));
    card.stop=node('button','Stop test','eval-stop');card.stop.type='button';card.stop.hidden=true;card.stop.disabled=true;card.stop.addEventListener('click',()=>stop(card));
    const buttons=node('div',null,'eval-run-buttons');buttons.append(card.start,card.stop);
    card.status = node('p', '', 'eval-status'); card.status.setAttribute('role', 'status');
    card.results = node('section', null, 'eval-results'); card.results.setAttribute('aria-label', 'Resultaat van ' + evaluation.question);
    body.append(form, buttons, card.status, card.results); details.append(summary, body); cards.push(card); return details;
  }
  async function load() {
    if (catalog) { catalog.can_run = false; controls(); }
    byId('eval-catalog-retry').hidden = true;
    byId('eval-catalog-status').textContent = 'Zoektests laden…';
    try {
      const loaded = await request('/api/evals/rag/catalog');
      if (loaded.schema_version !== 1 || !Array.isArray(loaded.evals) || !loaded.evals.length || !Array.isArray(loaded.methods) || !loaded.methods.length || !Array.isArray(loaded.embedding_models) || !loaded.embedding_models.length) throw new Error('De zoektests zijn nu niet beschikbaar.');
      catalog = loaded;
      cards.length = 0; list.replaceChildren(...catalog.evals.map(makeCard)); controls();
      byId('eval-catalog-status').textContent = canRun() ? '' : localOnly;
    } catch (error) { byId('eval-catalog-status').textContent = error.message; byId('eval-catalog-retry').hidden = false; }
  }
  let archiveLoaded=false;
  byId('saved-evaluations')?.addEventListener('toggle',event=>{
    if (!event.target.open || archiveLoaded)return;
    archiveLoaded=true;
    for (const src of ['/assets/results.js?v=20261116-sources','/assets/promptfoo-results.js?v=20261116-sources']) {
      const script=document.createElement('script');script.src=src;script.async=false;document.head.append(script);
    }
  });
  byId('eval-catalog-retry').addEventListener('click', load);
  window.addEventListener('pageshow',event=>{if(event.persisted&&benchmarkStarting){benchmarkStarting=false;controls();byId('eval-catalog-status').textContent='';}});
  await load();
})();
