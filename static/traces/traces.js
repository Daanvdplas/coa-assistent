'use strict';

const list = document.querySelector('#thread-list');
const table = document.querySelector('#thread-table');
const empty = document.querySelector('#empty');
const status = document.querySelector('#status');
const refresh = document.querySelector('#refresh');
const heading = document.querySelector('#detail-heading');
const download = document.querySelector('#download');
const runs = document.querySelector('#runs');
const dateFormat = new Intl.DateTimeFormat(undefined, {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
let selected = null;
let selection = 0;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function message(text, error = false) {
  status.textContent = text;
  status.hidden = !text;
  status.classList.toggle('error', error);
  status.setAttribute('role', error ? 'alert' : 'status');
}

async function get(path) {
  const response = await fetch(path, {cache:'no-store'});
  if (!response.ok) {
    let error = 'Trace data is unavailable.';
    try { error = (await response.json()).error || error; } catch {}
    throw new Error(error);
  }
  return response.json();
}

function duration(milliseconds) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function payload(label, value) {
  const details = element('details', undefined, 'payload');
  details.append(element('summary', label), element('pre', JSON.stringify(value, null, 2)));
  return details;
}

function eventView(event, started) {
  const item = element('li');
  const details = element('details', undefined, 'event');
  const summary = element('summary');
  summary.append(element('span', event.kind.replaceAll('_', ' ').replaceAll('.', ' · '), 'event-name'));
  const offset = element('span', `+${duration(Math.max(0, event.at_ms - started))}`, 'event-time');
  offset.title = 'Time since run started';
  summary.append(offset);
  if (event.elapsed_ms !== null && event.elapsed_ms !== undefined) {
    const elapsed = element('span', duration(event.elapsed_ms), 'event-time');
    elapsed.title = 'Step duration';
    summary.append(elapsed);
  }
  details.append(summary, element('pre', JSON.stringify(event.data, null, 2)));
  item.append(details);
  return item;
}

function runView(run, open) {
  const details = element('details', undefined, 'run');
  details.open = open;
  const summary = element('summary');
  summary.append(element('span', run.question, 'run-question'));
  let label = run.status;
  if (run.completed_at_ms !== null) label += ` · ${duration(Math.max(0, run.completed_at_ms - run.created_at_ms))}`;
  summary.append(element('span', label, ['failed', 'interrupted'].includes(run.status) ? 'run-status failed' : 'run-status'));
  const body = element('div', undefined, 'run-body');
  if (run.error) body.append(element('p', run.error, 'run-error'));
  body.append(payload('Context', run.context));
  if (run.result !== null) body.append(payload('Result', run.result));
  body.append(element('h3', 'Events'));
  if (run.events.length) {
    const events = element('ol', undefined, 'event-list');
    for (const event of run.events) events.append(eventView(event, run.created_at_ms));
    body.append(events);
  } else {
    body.append(element('p', 'No events recorded.'));
  }
  details.append(summary, body);
  return details;
}

async function loadThread(id, focus = false) {
  const current = ++selection;
  message('');
  try {
    const thread = await get(`/api/threads/${encodeURIComponent(id)}`);
    if (current !== selection) return;
    selected = id;
    for (const button of list.querySelectorAll('button')) {
      if (button.dataset.thread === id) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
    heading.textContent = `Thread ${id.replace(/^thread-/, '').slice(0, 8)}`;
    heading.title = id;
    download.href = `/api/threads/${encodeURIComponent(id)}/export`;
    download.hidden = false;
    const ordered = [...thread.traces].sort((a,b) => b.created_at_ms - a.created_at_ms);
    runs.replaceChildren(...ordered.map((run, index) => runView(run, index === 0)));
    if (focus) {
      heading.focus({preventScroll:true});
      if (window.matchMedia('(max-width:900px)').matches) heading.scrollIntoView({block:'start'});
    }
  } catch (error) {
    if (current === selection) message(error.message, true);
  }
}

async function loadThreads() {
  refresh.disabled = true;
  document.querySelector('main').setAttribute('aria-busy', 'true');
  message('');
  try {
    const threads = await get('/api/threads');
    list.replaceChildren();
    table.hidden = !threads.length;
    empty.hidden = !!threads.length;
    for (const thread of threads) {
      const row = element('tr');
      const question = element('td');
      const button = element('button', thread.latest_question, 'thread-button');
      button.type = 'button';
      button.dataset.thread = thread.id;
      if (thread.id === selected) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => loadThread(thread.id, true));
      question.append(button);
      const updated = element('td', dateFormat.format(thread.updated_at_ms));
      updated.title = new Date(thread.updated_at_ms).toLocaleString();
      const count = element('td', String(thread.trace_count));
      if (thread.failed_count) count.append(element('span', ` · ${thread.failed_count} failed`, 'failed'));
      row.append(question, updated, count);
      list.append(row);
    }
    if (selected && threads.some(thread => thread.id === selected)) await loadThread(selected);
    else if (selected) {
      selected = null;
      heading.textContent = 'Select a thread';
      heading.removeAttribute('title');
      download.hidden = true;
      runs.replaceChildren();
    }
  } catch (error) {
    message(error.message, true);
  } finally {
    refresh.disabled = false;
    document.querySelector('main').removeAttribute('aria-busy');
  }
}

refresh.addEventListener('click', loadThreads);
loadThreads();
