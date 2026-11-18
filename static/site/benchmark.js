import {
  outcome,
  labels,
  metricText,
  summarize,
  matrixCases,
  configurationLabel,
  executionStatus,
  selectedDatasets,
  eligibleMean,
} from "./benchmark-model.js";

const byId = (id) => document.getElementById(id);
const state = {
  catalog: null,
  plan: null,
  runs: [],
  run: null,
  baseline: null,
  comparison: null,
  planSequence: 0,
  poll: null,
  matrix: null,
};
const planner = byId("benchmark-planner"),
  startButton = byId("start-benchmark");
const active = (run) =>
  ["queued", "running", "preparing", "cancelling"].includes(run?.status);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (text, action, className) => {
  const node = el("button", text, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
};
async function request(path, options = {}) {
  const response = await fetch("/api/benchmarks/" + path, {
    cache: "no-store",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("De server gaf geen leesbaar resultaat.");
  }
  if (!response.ok)
    throw new Error(
      data.error?.message ||
        data.error ||
        "De benchmark kon niet worden geladen.",
    );
  return data;
}
const post = (path, data) =>
  request(path, { method: "POST", body: JSON.stringify(data) });
function message(id, text = "", error = false) {
  byId(id).textContent = text;
  byId(id).classList.toggle("benchmark-error", error);
}
function option(select, value, text) {
  const node = el("option", text);
  node.value = value;
  select.append(node);
}
const checked = (id) =>
  [...byId(id).querySelectorAll("input:checked")].map((input) => input.value);
function optional(id) {
  const inputs = [...byId(id).querySelectorAll("input")],
    values = inputs
      .filter((input) => input.checked)
      .map((input) => input.value);
  if (inputs.length && !values.length)
    throw new Error(
      "Selecteer minstens één optie bij " +
        byId(id)
          .closest("fieldset")
          .querySelector("legend")
          .textContent.toLowerCase() +
        ".",
    );
  return values.length === inputs.length ? [] : values;
}
function choice(container, item, selected = true, note = "") {
  const label = el("label", null, "benchmark-choice"),
    input = el("input"),
    text = el("span", item.label || item.question || item.id);
  input.type = "checkbox";
  input.value = item.id;
  input.checked = selected;
  if (note) text.append(el("small", note));
  label.append(input, text);
  container.append(label);
}
function datasets() {
  return selectedDatasets(state.catalog, byId("benchmark-dataset").value);
}
function selection() {
  const suites = checked("benchmark-suites"),
    repeats = Number(byId("benchmark-repeats").value);
  if (!suites.length) throw new Error("Selecteer minstens één evaluatie.");
  if (
    !Number.isInteger(repeats) ||
    repeats < 1 ||
    repeats > state.catalog.limits.max_repeats
  )
    throw new Error("Kies een geldig aantal herhalingen.");
  const value = {
    datasets: datasets(),
    suites,
    methods: optional("benchmark-methods"),
    profiles: optional("benchmark-profiles"),
    embedding_models: optional("benchmark-embeddings"),
    case_ids: optional("benchmark-cases"),
    repeats,
  };
  if (state.catalog.assistant_arms?.length)
    value.assistant_arms = optional("benchmark-arms");
  if (!byId("model-authorization").hidden && byId("allow-models").checked) {
    const kinds = modelKinds();
    const sessions = Number(byId("model-sessions").value),
      attempts = Number(byId("model-attempts").value),
      seconds = Number(byId("model-seconds").value);
    if (!Number.isInteger(seconds) || seconds < 1)
      throw new Error("Vul een positieve uitvoeringsduur in.");
    if (kinds.codex && (!Number.isInteger(sessions) || sessions < 1))
      throw new Error("Vul een positieve sessielimiet in.");
    if (kinds.rig && (!Number.isInteger(attempts) || attempts < 1))
      throw new Error("Vul een positieve modelpoginglimiet in.");
    value.authorization = {
      confirmed: true,
      max_seconds: seconds,
    };
    if (kinds.codex) value.authorization.max_sessions = sessions;
    if (kinds.rig) value.authorization.max_attempts = attempts;
  }
  if (suites.includes("models")) value.model_phase = byId("model-phase").value;
  return value;
}
function modelKinds() {
  const selected = checked("benchmark-suites"),
    models = state.catalog.suites.filter(
      (item) => selected.includes(item.id) && item.kind === "model",
    );
  return {
    codex: models.some((item) => item.unit !== "provider_attempts"),
    rig: models.some((item) => item.unit === "provider_attempts"),
  };
}
function modelControls() {
  const suites = checked("benchmark-suites");
  byId("model-authorization").hidden = !state.catalog.suites.some(
    (item) => suites.includes(item.id) && item.kind === "model",
  );
  byId("model-limits").hidden = !byId("allow-models").checked;
  const kinds = modelKinds();
  byId("model-sessions-field").hidden = !kinds.codex;
  byId("model-attempts-field").hidden = !kinds.rig;
  byId("model-costs").textContent = kinds.codex
    ? "Een Codexsessie kan meerdere modelverzoeken gebruiken. Kosten onbekend."
    : "Kosten onbekend.";
  byId("model-phase-field").hidden = !suites.includes("models");
  byId("assistant-options").hidden =
    !suites.includes("assistant") || !state.catalog.assistant_arms?.length;
  byId("embedding-options").hidden = !suites.includes("browser");
}
function populateCases() {
  const container = byId("benchmark-cases");
  container.replaceChildren();
  const selected = state.catalog.datasets.filter((item) =>
    datasets().includes(item.id),
  );
  const ids = selected.flatMap((item) =>
    (item.cases || []).map((item) => item.id),
  );
  if (new Set(ids).size !== ids.length) {
    byId("case-options").hidden = true;
    return;
  }
  const cases = new Map();
  for (const dataset of state.catalog.datasets.filter((item) =>
    datasets().includes(item.id),
  ))
    for (const item of dataset.cases || [])
      if (!cases.has(item.id)) cases.set(item.id, item);
  const counts = new Map();
  for (const item of cases.values())
    counts.set(item.question, (counts.get(item.question) || 0) + 1);
  for (const item of cases.values())
    choice(container, {
      ...item,
      label:
        counts.get(item.question) > 1
          ? `${item.id} · ${item.question}`
          : item.question || item.label || item.id,
    });
  byId("case-options").hidden = !cases.size;
}
function populateSuites(preserve = false) {
  const selected = preserve
      ? checked("benchmark-suites")
      : state.catalog.default_selection.suites,
    container = byId("benchmark-suites");
  container.replaceChildren();
  for (const [family, label] of [
    ["retrieval", "RAG"],
    ["assistant", "COA-assistent"],
    ["transport", "Technische controles"],
  ]) {
    const suites = state.catalog.suites.filter(
      (suite) =>
        suite.family === family &&
        suite.datasets.some((id) => datasets().includes(id)),
    );
    if (!suites.length) continue;
    const group = el("div", null, "benchmark-suite-family"),
      choices = el("div", null, "benchmark-choices");
    group.append(el("h3", label));
    for (const suite of suites)
      choice(
        choices,
        suite,
        selected.includes(suite.id),
        suite.block_reason || "",
      );
    group.append(choices);
    container.append(group);
  }
  byId("select-assistant").textContent = container.querySelector(
    'input[value="assistant-rig"]',
  )
    ? "Alle actuele assistent-evals"
    : "Alle assistent-evals";
  modelControls();
}
function populatePlanner() {
  const catalog = state.catalog,
    select = byId("benchmark-dataset");
  select.replaceChildren();
  if (catalog.default_selection.datasets.length > 1)
    option(select, "__current__", "Actueel aanbod · twaalf documenten");
  for (const item of catalog.datasets) option(select, item.id, item.label);
  option(select, "__all__", "Alle vraagsets");
  select.value =
    catalog.default_selection.datasets.length > 1
      ? "__current__"
      : catalog.default_selection.datasets[0];
  for (const [id, items, field] of [
    ["benchmark-methods", catalog.methods, "methods"],
    ["benchmark-profiles", catalog.profiles, "profiles"],
    ["benchmark-embeddings", catalog.embedding_models, "embedding_models"],
    ["benchmark-arms", catalog.assistant_arms || [], "assistant_arms"],
  ]) {
    byId(id).replaceChildren();
    const defaults = catalog.default_selection[field] || [];
    for (const item of items)
      choice(byId(id), item, !defaults.length || defaults.includes(item.id));
  }
  byId("benchmark-repeats").max = catalog.limits.max_repeats;
  byId("benchmark-repeats").value = catalog.default_selection.repeats;
  populateSuites();
  populateCases();
}
let planTimer;
function schedulePlan() {
  clearTimeout(planTimer);
  startButton.disabled = true;
  state.plan = null;
  modelControls();
  const sequence = ++state.planSequence;
  message("plan-status", "Plan berekenen…");
  planTimer = setTimeout(() => loadPlan(sequence), 150);
}
async function loadPlan(sequence) {
  try {
    const plan = await post("plan", selection());
    if (sequence !== state.planSequence) return;
    state.plan = plan;
    renderPlan(plan);
    startButton.disabled = plan.can_start !== true;
    message(
      "plan-status",
      plan.can_start ? "" : "Geen uitvoerbare proeven in deze selectie.",
    );
  } catch (error) {
    if (sequence !== state.planSequence) return;
    byId("benchmark-plan").replaceChildren();
    message("plan-status", error.message, true);
  }
}
function table(headers, className = "") {
  const scroll = el("div", null, "benchmark-table-scroll"),
    node = el("table", null, "benchmark-table " + className),
    head = el("thead"),
    row = el("tr"),
    body = el("tbody");
  scroll.tabIndex = 0;
  for (const title of headers) {
    const column = el("th", title);
    column.scope = "col";
    row.append(column);
  }
  head.append(row);
  node.append(head, body);
  scroll.append(node);
  return { scroll, table: node, body };
}
function renderPlan(plan) {
  const container = byId("benchmark-plan"),
    totals = plan.totals;
  container.replaceChildren();
  const counts = [`${totals.local} lokale uitvoeringen`];
  if (
    Number.isFinite(totals.model_sessions) &&
    Number.isFinite(totals.provider_attempts)
  ) {
    counts.push(`${totals.model_sessions} Codexsessies`);
    if (totals.provider_attempts)
      counts.push(`maximaal ${totals.provider_attempts} Rig-modelpogingen`);
  } else
    counts.push(
      `${totals.model} ${modelKinds().rig ? "modeluitvoeringen" : "modelsessies"}`,
    );
  if (totals.blocked) counts.push(`${totals.blocked} niet uitvoerbaar`);
  container.append(el("p", counts.join(" · "), "benchmark-plan-summary"));
  const view = table(
    [
      "Evaluatie",
      "Vraagset",
      "Vragen",
      "Varianten",
      "Uitvoeringen",
      "Beschikbaarheid",
    ],
    "benchmark-plan-table",
  );
  for (const group of plan.groups) {
    const row = el("tr"),
      suite = state.catalog.suites.find((item) => item.id === group.suite),
      dataset = state.catalog.datasets.find(
        (item) => item.id === group.dataset,
      );
    for (const value of [
      suite?.label || group.label,
      dataset?.label || group.dataset,
      group.case_count,
      group.configuration_count,
      group.execution_count,
      group.block_reason || "Uitvoerbaar",
    ])
      row.append(el("td", value));
    if (group.block_reason) row.className = "benchmark-blocked";
    view.body.append(row);
  }
  container.append(view.scroll);
}
function openPlanner() {
  planner.hidden = false;
  byId("new-benchmark").hidden = true;
  byId("close-planner").hidden = !state.runs.length;
  schedulePlan();
}
function closePlanner() {
  planner.hidden = true;
  byId("new-benchmark").hidden = false;
}
function dateLabel(run) {
  const date = new Date(run.created_at),
    value = Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat("nl-NL", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(date)
      : run.id;
  return value + " · " + executionStatus(run.status);
}
function storeRun(run) {
  const index = state.runs.findIndex((item) => item.id === run.id);
  if (index < 0) state.runs.unshift(run);
  else state.runs[index] = run;
}
function historyControls() {
  byId("benchmark-history").hidden = !state.runs.length;
  for (const [id, value] of [
    ["benchmark-run", state.run?.id],
    ["benchmark-baseline", state.baseline?.id],
  ]) {
    const select = byId(id);
    select.replaceChildren();
    if (id === "benchmark-baseline") option(select, "", "Geen referentie");
    for (const run of state.runs)
      if (id !== "benchmark-baseline" || run.id !== state.run?.id)
        option(select, run.id, dateLabel(run));
    select.value = value || "";
  }
}
async function chooseRun(id) {
  const sequence = (state.runSequence = (state.runSequence || 0) + 1);
  clearTimeout(state.poll);
  state.matrix = null;
  state.comparison = null;
  state.baseline = null;
  message("comparison-status");
  message("handoff-status");
  byId("handoff-fallback").hidden = true;
  state.run = null;
  byId("benchmark-groups").replaceChildren();
  message("run-status", "Uitvoering laden…");
  try {
    const run = await request("runs/" + encodeURIComponent(id));
    if (sequence !== state.runSequence) return;
    state.run = run;
    storeRun(state.run);
    historyControls();
    renderRun();
    pollRun();
  } catch (error) {
    message("run-status", error.message, true);
  }
}
function pollRun() {
  clearTimeout(state.poll);
  if (!active(state.run)) return;
  state.poll = setTimeout(async () => {
    const id = state.run?.id;
    try {
      const run = await request("runs/" + encodeURIComponent(id));
      if (state.run?.id !== id) return;
      const changed = fingerprint(state.run) !== fingerprint(run);
      state.run = run;
      storeRun(run);
      if (changed) {
        historyControls();
        renderRun();
      }
      pollRun();
    } catch {
      message(
        "run-status",
        "Status onbekend. Haal de uitvoering opnieuw op.",
        true,
      );
      byId("retry-benchmarks").hidden = false;
    }
  }, 1000);
}
function duration(rows, field, expectedCount) {
  const value = eligibleMean(rows, field, expectedCount);
  if (value === null) return "—";
  return (
    new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1 }).format(value) +
    " ms"
  );
}
function payloadBytes(rows, compact) {
  const values = rows
    .map((row) =>
      compact
        ? (row.metrics?.compact_payload_bytes ?? row.metrics?.compact_bytes)
        : (row.metrics?.full_payload_bytes ?? row.metrics?.full_bytes),
    )
    .filter(Number.isFinite);
  return values.length
    ? new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 }).format(
        values.reduce((a, b) => a + b, 0) / values.length,
      )
    : "—";
}
const groupRows = (run, group) =>
  (run?.result?.rows || []).filter((row) => row.group_id === group.id);
const fingerprint = (run) =>
  JSON.stringify([
    run?.status,
    run?.progress,
    run?.groups?.map((group) => [
      group.id,
      group.status,
      group.completed,
      group.error,
    ]),
  ]);
function sharedCases(group) {
  if (!state.comparison?.compatible) return null;
  return new Set(
    state.comparison.pairs
      .filter(
        (pair) =>
          (pair.current?.group_id || pair.baseline?.group_id) === group.id,
      )
      .map((pair) => pair.case_id),
  );
}
function renderRun() {
  const run = state.run;
  if (!run) return;
  const focused = document.activeElement;
  const focusId = focused?.id;
  const focusKey = focused?.dataset.cellKey;
  const focusClose = focused?.hasAttribute("data-evidence-close");
  const scrollPositions = [
    ...byId("benchmark-groups").querySelectorAll(".benchmark-table-scroll"),
  ].map((node) => node.scrollLeft);
  const scrollTop = window.scrollY;
  message(
    "run-status",
    `${executionStatus(run.status)} · ${run.progress.completed} van ${run.progress.total} afgerond${run.error ? " · " + run.error : ""}`,
    run.status === "failed",
  );
  byId("stop-benchmark").hidden = !active(run);
  byId("stop-benchmark").disabled = run.status === "cancelling";
  const container = byId("benchmark-groups");
  container.replaceChildren();
  for (const [family, label] of [
    ["retrieval", "Bronzoeken"],
    ["assistant", "Gehele assistent"],
    ["transport", "Technische controles"],
  ]) {
    const groups = run.groups.filter((group) => group.family === family);
    if (!groups.length) continue;
    const section = el("section", null, "benchmark-family");
    section.append(el("h2", label));
    for (const group of groups) section.append(renderGroup(group));
    container.append(section);
  }
  queueMicrotask(() => {
    const target = focusClose
      ? container.querySelector("[data-evidence-close]")
      : focusKey
        ? [...container.querySelectorAll("[data-cell-key]")].find(
            (node) => node.dataset.cellKey === focusKey,
          )
        : focusId
          ? byId(focusId)
          : null;
    target?.focus({ preventScroll: true });
    container
      .querySelectorAll(".benchmark-table-scroll")
      .forEach((node, index) => {
        node.scrollLeft = scrollPositions[index] || 0;
      });
    if (state.matrix?.selected)
      window.scrollTo({ top: scrollTop, behavior: "auto" });
  });
}
function renderGroup(group) {
  const section = el("section", null, "benchmark-group");
  section.dataset.group = group.id;
  const datasetLabel = state.catalog.datasets.find(
    (item) => item.id === group.dataset,
  )?.label;
  section.append(
    el(
      "h3",
      datasetLabel && !group.label.includes(datasetLabel)
        ? group.label + " · " + datasetLabel
        : group.label,
    ),
  );
  if (group.block_reason || group.error)
    section.append(
      el(
        "p",
        group.error || group.block_reason,
        group.error ? "benchmark-error" : "benchmark-blocked",
      ),
    );
  const rows = groupRows(state.run, group),
    shared = sharedCases(group),
    hasBaseline = shared?.size > 0,
    headers = [
      "Configuratie",
      "Volledig bronbewijs",
      "Uitvoeringsfouten",
      "Gem. zoektijd",
    ];
  if (group.suite === "assistant") headers[1] = "Alle harde controles";
  if (group.suite === "assistant-rig")
    headers[1] =
      group.dataset === "regression-12-20261118"
        ? "Vaste antwoordchecks"
        : "Alle harde controles";
  if (group.family === "assistant") headers[3] = "Gem. uitvoertijd";
  if (group.family === "transport")
    headers.splice(
      1,
      3,
      "Geslaagde evalgevallen",
      "Gem. volledig (bytes)",
      "Gem. compact (bytes)",
      "Uitvoeringsfouten",
    );
  const view = table(headers);
  const summaries = group.configurations.map((config) => ({
    config,
    run: state.run,
    reference: false,
  }));
  if (hasBaseline) {
    const baselineGroup = state.baseline.groups.find(
      (item) => item.id === group.id,
    );
    for (const config of baselineGroup?.configurations || [])
      summaries.push({ config, run: state.baseline, reference: true });
  }
  for (const { config, run, reference } of summaries) {
    const matches = groupRows(run, group).filter(
        (row) =>
          row.configuration_id === config.id &&
          (!hasBaseline || shared.has(row.case_id)),
      ),
      summary = summarize(matches),
      scored = summary.passed + summary.failed,
      row = el("tr");
    row.append(
      el(
        "td",
        (reference ? "Referentie · " : "") +
          (config.label ||
            configurationLabel(config.configuration, state.catalog)),
        "benchmark-config-name",
      ),
    );
    let value = scored
      ? `${summary.passed}/${scored}`
      : group.block_reason
        ? "Niet uitgevoerd"
        : executionStatus(group.status) || "Niet uitgevoerd";
    if (summary.not_applicable) value += ` · ${summary.not_applicable} n.v.t.`;
    if (summary.unknown) value += ` · ${summary.unknown} onbekend`;
    if (!hasBaseline) {
      const planned = group.execution_count / group.configuration_count;
      const unexecuted =
        Math.max(0, Math.ceil(planned) - matches.length) +
        (summary.not_run || 0) +
        (summary.cancelled || 0) +
        (summary.interrupted || 0);
      if (unexecuted) {
        const pending =
          ["queued", "running"].includes(run.status) && !group.block_reason;
        const coverage = `${unexecuted} ${pending ? "wachtend" : "niet uitgevoerd"}`;
        value = matches.length ? value + " · " + coverage : coverage;
      }
    }
    row.append(el("td", value, "numeric"));
    if (group.family === "transport")
      row.append(
        el("td", payloadBytes(matches, false), "numeric"),
        el("td", payloadBytes(matches, true), "numeric"),
        el("td", summary.error, "numeric"),
      );
    else
      row.append(
        el("td", summary.error, "numeric"),
        el(
          "td",
          duration(
            matches,
            group.family === "assistant" ? "native_elapsed_ms" : "retrieval_ms",
            (() => {
              const planned = run.groups.find((item) => item.id === group.id);
              return planned?.execution_count / planned?.configuration_count;
            })(),
          ),
          "numeric",
        ),
      );
    view.body.append(row);
  }
  section.append(view.scroll);
  if (rows.length) {
    const action = button(
      state.matrix?.groupId === group.id ? "Sluit vragen" : "Bekijk vragen",
      () => {
        state.matrix =
          state.matrix?.groupId === group.id
            ? null
            : { groupId: group.id, filter: "all" };
        renderRun();
        if (state.matrix)
          byId("matrix-filter-" + group.id)?.focus({ preventScroll: true });
      },
      "benchmark-group-action",
    );
    action.setAttribute(
      "aria-expanded",
      String(state.matrix?.groupId === group.id),
    );
    section.append(action);
    if (state.matrix?.groupId === group.id) section.append(renderMatrix(group));
  }
  return section;
}
function matrixColumns(group) {
  const columns = group.configurations.map((config) => ({
    id: "current:" + config.id,
    configurationId: config.id,
    config,
    run: state.run,
    label: config.label,
  }));
  if (sharedCases(group)?.size) {
    const reference = state.baseline.groups.find(
      (item) => item.id === group.id,
    );
    for (const config of reference?.configurations || [])
      columns.push({
        id: "baseline:" + config.id,
        configurationId: config.id,
        config,
        run: state.baseline,
        label: "Referentie · " + config.label,
      });
  }
  return columns;
}
function selectedColumns(group) {
  const columns = matrixColumns(group);
  if (state.matrix.all) return columns;
  const first =
    columns.find((column) => column.id === state.matrix.first) || columns[0];
  const preferred =
    columns.find(
      (column) =>
        column.id.startsWith("baseline:") &&
        column.configurationId === first?.configurationId,
    ) ||
    columns.find((column) => column.id.startsWith("baseline:")) ||
    columns.find(
      (column) =>
        column.config.configuration?.method !==
        first?.config.configuration?.method,
    ) ||
    columns.find((column) => column.id !== first?.id);
  const second =
    state.matrix.second === undefined
      ? preferred
      : columns.find(
          (column) =>
            column.id === state.matrix.second && column.id !== first?.id,
        );
  return [first, second].filter(Boolean);
}
function renderMatrix(group) {
  const panel = el("div", null, "benchmark-matrix-panel"),
    toolbar = el("div", null, "benchmark-matrix-toolbar"),
    field = el("div", null, "benchmark-field"),
    label = el("label", "Toon vragen"),
    filter = el("select");
  toolbar.append(el("h3", "Vragen vergelijken"));
  filter.id = "matrix-filter-" + group.id;
  label.htmlFor = filter.id;
  for (const [value, text] of [
    ["all", "Alle"],
    ["differences", "Verschillen"],
    ["failures", "Missers"],
    ["errors", "Uitvoeringsfouten"],
  ])
    option(filter, value, text);
  filter.value = state.matrix.filter;
  filter.addEventListener("change", () => {
    state.matrix.filter = filter.value;
    state.matrix.selected = null;
    panel.replaceWith(renderMatrix(group));
    byId(filter.id)?.focus({ preventScroll: true });
  });
  field.append(label, filter);
  toolbar.append(field);
  panel.append(toolbar);
  const allColumns = matrixColumns(group);
  if (allColumns.length > 1) {
    const controls = el("div", null, "benchmark-column-controls");
    if (!state.matrix.all) {
      const visible = selectedColumns(group);
      for (const [id, title, current] of [
        ["first", "Eerste configuratie", visible[0]?.id],
        ["second", "Tweede configuratie", visible[1]?.id],
      ]) {
        const field = el("div", null, "benchmark-field"),
          label = el("label", title),
          select = el("select");
        select.id = `matrix-${id}-${group.id}`;
        label.htmlFor = select.id;
        if (id === "second") option(select, "", "Geen tweede configuratie");
        for (const column of allColumns)
          option(select, column.id, column.label);
        select.value = current || "";
        select.addEventListener("change", () => {
          state.matrix[id] = select.value;
          state.matrix.selected = null;
          panel.replaceWith(renderMatrix(group));
          byId(select.id)?.focus({ preventScroll: true });
        });
        field.append(label, select);
        controls.append(field);
      }
    }
    controls.append(
      button(
        state.matrix.all
          ? "Selecteer twee configuraties"
          : "Alle configuraties",
        () => {
          state.matrix.all = !state.matrix.all;
          state.matrix.selected = null;
          panel.replaceWith(renderMatrix(group));
        },
      ),
    );
    panel.append(controls);
  }
  const columns = selectedColumns(group),
    rows = columns.flatMap((column) =>
      groupRows(column.run, group)
        .filter((row) => row.configuration_id === column.configurationId)
        .map((row) => ({ ...row, original: row, configuration_id: column.id })),
    ),
    cases = matrixCases(
      rows,
      columns.map((column) => column.id),
      filter.value,
    ).filter(
      (item) =>
        !state.comparison?.compatible ||
        !sharedCases(group)?.size ||
        sharedCases(group).has(item.id),
    );
  if (!cases.length) {
    panel.append(el("p", "Geen vragen in deze selectie."));
    return panel;
  }
  const view = table(
    ["Vraag", ...columns.map((column) => column.label)],
    "benchmark-matrix",
  );
  view.scroll.setAttribute(
    "aria-label",
    "Vergelijking van vragen en configuraties",
  );
  for (const item of cases) {
    const tr = el("tr");
    tr.dataset.case = item.id;
    const question = el("th", item.question);
    question.scope = "row";
    tr.append(question);
    for (const column of columns) {
      const cell = el("td"),
        content = el("div", null, "benchmark-cell"),
        matches = item.rows
          .filter((row) => row.configuration_id === column.id)
          .sort((a, b) => a.repeat - b.repeat);
      if (!matches.length) content.append(el("span", "Niet uitgevoerd"));
      for (const match of matches) {
        if (matches.length > 1)
          content.append(
            el("span", "Herhaling " + match.repeat, "benchmark-repeat"),
          );
        const key = `${item.id}:${column.id}:${match.repeat}`,
          action = button(metricText(match), () => {
            const wasOpen = action.getAttribute("aria-expanded") === "true";
            view.body.querySelector(".benchmark-evidence-row")?.remove();
            view.body
              .querySelectorAll("button[aria-expanded=true]")
              .forEach((node) => node.setAttribute("aria-expanded", "false"));
            state.matrix.selected = wasOpen ? null : key;
            if (wasOpen) return;
            action.setAttribute("aria-expanded", "true");
            const detail = el("tr", null, "benchmark-evidence-row"),
              body = el("td");
            body.colSpan = columns.length + 1;
            body.append(
              renderEvidence(item, columns, match.repeat, () => {
                detail.remove();
                state.matrix.selected = null;
                action.setAttribute("aria-expanded", "false");
                action.focus({ preventScroll: true });
              }),
            );
            detail.append(body);
            tr.after(detail);
          });
        action.dataset.outcome = outcome(match);
        action.dataset.cellKey = key;
        action.setAttribute(
          "aria-label",
          `${item.id} · ${column.label} · ${matches.length > 1 ? "Herhaling " + match.repeat + " · " : ""}${metricText(match)}`,
        );
        action.setAttribute("aria-expanded", "false");
        if (state.matrix.selected === key)
          queueMicrotask(() => {
            if (state.matrix?.selected === key && action.isConnected)
              action.click();
          });
        content.append(action);
      }
      cell.append(content);
      tr.append(cell);
    }
    view.body.append(tr);
  }
  panel.append(view.scroll);
  return panel;
}
const refKey = (ref) => ref.source_id + ":" + (ref.section_id || ref.id);
const hydrate = (ref, records) => {
  for (const { column } of records) {
    const source = Object.values(column.run.result.sources || {}).find(
      (item) => refKey(item) === refKey(ref),
    );
    if (source) return { ...source, ...ref };
  }
  return ref;
};
const sourceLabel = (ref) =>
  [ref.source_title || ref.source_id, ref.heading || ref.section_id || ref.id]
    .filter(Boolean)
    .join(" · ");
function renderEvidence(item, columns, repeat, close) {
  const assistant =
    item.rows.some((row) =>
      ["assistant", "assistant-rig"].includes(row.suite),
    ) ||
    columns.some((column) => column.config.configuration?.mode === "assistant");
  const section = el("section", null, "benchmark-evidence"),
    heading = el("div", null, "benchmark-evidence-heading");
  const closeButton = button("Sluit broncontrole", close);
  closeButton.dataset.evidenceClose = "";
  heading.append(
    el("h3", assistant ? "Assistentcontrole" : "Broncontrole"),
    closeButton,
  );
  section.append(heading);
  const records = columns.map((column) => ({
      column,
      row: item.rows.find(
        (row) =>
          row.configuration_id === column.id && (row.repeat || 1) === repeat,
      )?.original,
    })),
    goals = new Map(),
    expectedKeys = new Set();
  for (const { row } of records)
    for (const goal of row?.goals || [])
      if (!goals.has(goal.id)) goals.set(goal.id, goal);
  const uniqueGoals = new Map();
  for (const goal of goals.values()) {
    const key = goal.alternatives?.length
      ? JSON.stringify(
          goal.alternatives
            .map((alternative) => alternative.map(refKey).sort())
            .sort(),
        )
      : goal.id;
    if (uniqueGoals.has(key)) uniqueGoals.get(key).ids.push(goal.id);
    else uniqueGoals.set(key, { ...goal, ids: [goal.id] });
  }
  if (goals.size) {
    const view = table(
      ["Verwachte bron", ...columns.map((column) => column.label)],
      "benchmark-evidence-table",
    );
    for (const goal of uniqueGoals.values()) {
      const tr = el("tr"),
        expectation = el("th");
      expectation.scope = "row";
      const alternatives = goal.alternatives || [];
      if (alternatives.length > 1)
        expectation.append(el("p", goal.description, "benchmark-source-title"));
      for (const [index, alternative] of alternatives.entries()) {
        if (alternatives.length > 1)
          expectation.append(
            el("p", "Optie " + (index + 1), "benchmark-repeat"),
          );
        for (const original of alternative) {
          const ref = hydrate(original, records);
          expectedKeys.add(refKey(ref));
          expectation.append(
            el("p", sourceLabel(ref), "benchmark-source-title"),
          );
          if (ref.text)
            expectation.append(
              el("blockquote", ref.text, "benchmark-source-text"),
            );
        }
      }
      tr.append(expectation);
      for (const { row } of records) {
        const matches = goal.ids.map((id) =>
            row?.goals?.find((value) => value.id === id),
          ),
          actual = {
            covered: matches.some((value) => value?.covered === false)
              ? false
              : matches.every((value) => value?.covered === true)
                ? true
                : undefined,
          },
          text = !row
            ? "Niet uitgevoerd"
            : outcome(row) === "error"
              ? "Uitvoeringsfout"
              : actual?.covered === true
                ? assistant
                  ? "Aangeboden"
                  : "Gevonden"
                : actual?.covered === false
                  ? "Ontbreekt"
                  : "Onbekend",
          td = el("td", text);
        td.dataset.outcome = actual?.covered === false ? "failed" : "";
        tr.append(td);
      }
      view.body.append(tr);
    }
    section.append(view.scroll);
  }
  const additional = new Map(),
    foundByColumn = new Map();
  for (const { column, row } of records) {
    const found = new Set(),
      sources = column.run.result.sources || {};
    for (const call of row?.calls || [])
      for (const hit of call.hits || []) {
        const ref = typeof hit === "string" ? sources[hit] : hit;
        if (ref && !expectedKeys.has(refKey(ref))) {
          additional.set(refKey(ref), ref);
          found.add(refKey(ref));
        }
      }
    foundByColumn.set(column.id, found);
  }
  if (additional.size) {
    const view = table([
      goals.size ? "Overige gevonden bron" : "Gevonden bron",
      ...columns.map((column) => column.label),
    ]);
    for (const [key, ref] of additional) {
      const tr = el("tr"),
        source = el("th");
      source.append(
        el("p", sourceLabel(ref), "benchmark-source-title"),
        el("blockquote", ref.text || "", "benchmark-source-text"),
      );
      tr.append(source);
      for (const { column, row } of records)
        tr.append(
          el(
            "td",
            !row
              ? "Niet uitgevoerd"
              : foundByColumn.get(column.id).has(key)
                ? assistant
                  ? "Aangeboden"
                  : "Gevonden"
                : "Niet opgehaald",
          ),
        );
      view.body.append(tr);
    }
    section.append(view.scroll);
  }
  for (const { column, row } of records) {
    if (!row) continue;
    const answer = row.answer || row.output?.answer;
    if (answer || outcome(row) === "error" || (!goals.size && row.reason)) {
      const detail = el("div");
      if (columns.length > 1) detail.append(el("h3", column.label));
      if (outcome(row) === "error")
        detail.append(
          el(
            "p",
            row.reason || "De uitvoering kon niet worden afgerond.",
            "benchmark-error",
          ),
        );
      if (answer) detail.append(el("p", answer, "benchmark-answer"));
      if (!goals.size && row.reason && !assistant)
        detail.append(el("p", row.reason));
      section.append(detail);
    }
  }
  if (assistant) {
    const rig = records.some(
      ({ row }) =>
        row?.answer_quality === "deterministic_case_specific_not_human",
    );
    if (records.some(({ row }) => row?.answer_quality === "not_assessed"))
      section.append(el("p", "Antwoordkwaliteit: niet beoordeeld."));
    const checkNames = {
      execution_completed: "Uitvoering afgerond",
      live_trace: "Volledig uitvoeringsspoor",
      artifact_integrity: "Geldige resultaatgegevens",
      canonical_evidence: "Bronnen komen overeen",
      retrieval_trace: "Zoekacties komen overeen",
    };
    const ids = [
      ...new Set(
        records.flatMap(({ row }) =>
          (row?.assertions || []).map((check) => check.reason),
        ),
      ),
    ];
    if (ids.length) {
      const checks = table([
        rig ? "Vaste antwoordcheck" : "Harde controle",
        ...columns.map((column) => column.label),
      ]);
      for (const id of ids) {
        const tr = el("tr");
        tr.append(el("th", checkNames[id] || id));
        for (const { row } of records) {
          const check = row?.assertions?.find((item) => item.reason === id);
          tr.append(
            el("td", !check ? "Onbekend" : check.pass ? "Geslaagd" : "Mislukt"),
          );
        }
        checks.body.append(tr);
      }
      section.append(checks.scroll);
    }
  }
  if (
    !goals.size &&
    !records.some(
      (item) => item.row?.reason || item.row?.answer || item.row?.calls?.length,
    )
  )
    section.append(el("p", "Geen broncontrole beschikbaar."));
  const timingField = assistant ? "native_elapsed_ms" : "retrieval_ms";
  const measured = records.map(
    ({ row }) => row?.[timingField] ?? row?.metrics?.[timingField],
  );
  if (measured.some(Number.isFinite)) {
    let body = section.querySelector("table tbody");
    if (!body) {
      const times = table(["Meting", ...columns.map((column) => column.label)]);
      body = times.body;
      section.append(times.scroll);
    }
    const tr = el("tr"),
      label = el(
        "th",
        assistant ? "Gemeten uitvoertijd (ms)" : "Gemeten zoektijd (ms)",
      );
    label.scope = "row";
    tr.append(label);
    for (const value of measured) {
      const td = el(
        "td",
        Number.isFinite(value)
          ? new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 3 }).format(
              value,
            )
          : "—",
      );
      if (Number.isFinite(value)) td.title = String(value) + " ms";
      tr.append(td);
    }
    body.append(tr);
  }
  return section;
}
async function loadComparison() {
  const id = byId("benchmark-baseline").value;
  state.baseline = null;
  state.comparison = null;
  state.matrix = null;
  message("comparison-status");
  message("handoff-status");
  byId("handoff-fallback").hidden = true;
  if (!id) {
    renderRun();
    return;
  }
  const runId = state.run.id;
  try {
    const [comparison, baseline] = await Promise.all([
      request(
        `compare?run=${encodeURIComponent(runId)}&baseline=${encodeURIComponent(id)}`,
      ),
      request("runs/" + encodeURIComponent(id)),
    ]);
    if (state.run.id !== runId || byId("benchmark-baseline").value !== id)
      return;
    if (!comparison.compatible)
      message(
        "comparison-status",
        comparison.reason ||
          "Deze uitvoeringen zijn niet rechtstreeks vergelijkbaar.",
        true,
      );
    else {
      state.baseline = baseline;
      state.comparison = comparison;
      if (comparison.coverage) {
        const coverage = comparison.coverage;
        message(
          "comparison-status",
          `${coverage.shared_cases} gedeeld${coverage.shared_cases === 1 ? " evalgeval" : "e evalgevallen"} · ${coverage.current_only} alleen in uitvoering · ${coverage.baseline_only} alleen in referentie`,
        );
      }
    }
    renderRun();
  } catch (error) {
    message("comparison-status", error.message, true);
  }
}
async function load() {
  byId("retry-benchmarks").hidden = true;
  try {
    const [catalog, history] = await Promise.all([
      request("catalog"),
      request("runs"),
    ]);
    if (
      !Array.isArray(catalog.datasets) ||
      !Array.isArray(catalog.suites) ||
      !Array.isArray(history.runs)
    )
      throw new Error("De benchmarkcatalogus heeft een onbekend formaat.");
    state.catalog = catalog;
    state.runs = history.runs;
    populatePlanner();
    message("page-status");
    if (state.runs.length) {
      await chooseRun(state.run?.id || state.runs[0].id);
      closePlanner();
    } else openPlanner();
    historyControls();
  } catch (error) {
    message("page-status", error.message, true);
    byId("retry-benchmarks").hidden = false;
  }
}
byId("benchmark-dataset").addEventListener("change", () => {
  populateSuites(true);
  populateCases();
  schedulePlan();
});
planner.addEventListener("change", (event) => {
  if (event.target.id !== "benchmark-dataset" && event.target.type !== "number")
    schedulePlan();
});
planner.addEventListener("input", (event) => {
  if (event.target.type === "number") schedulePlan();
});
byId("new-benchmark").addEventListener("click", () => {
  openPlanner();
  byId("benchmark-dataset").focus();
});
byId("close-planner").addEventListener("click", () => {
  closePlanner();
  byId("new-benchmark").focus();
});
byId("select-local").addEventListener("click", () => {
  for (const input of byId("benchmark-suites").querySelectorAll("input"))
    input.checked =
      state.catalog.suites.find((suite) => suite.id === input.value)?.kind ===
      "local";
  schedulePlan();
});
for (const [id, family] of [
  ["select-rag", "retrieval"],
  ["select-assistant", "assistant"],
])
  byId(id).addEventListener("click", () => {
    const currentAssistant =
      id === "select-assistant" &&
      byId("benchmark-suites").querySelector('input[value="assistant-rig"]');
    for (const input of byId("benchmark-suites").querySelectorAll("input"))
      input.checked = currentAssistant
        ? input.value === "assistant-rig"
        : state.catalog.suites.find((suite) => suite.id === input.value)
            ?.family === family;
    schedulePlan();
  });
byId("select-all").addEventListener("click", () => {
  byId("benchmark-suites")
    .querySelectorAll("input")
    .forEach((input) => {
      input.checked = true;
    });
  schedulePlan();
});
byId("select-cases").addEventListener("click", () => {
  byId("benchmark-cases")
    .querySelectorAll("input")
    .forEach((input) => {
      input.checked = true;
    });
  schedulePlan();
});
byId("benchmark-run").addEventListener("change", (event) =>
  chooseRun(event.target.value),
);
byId("benchmark-baseline").addEventListener("change", loadComparison);
byId("retry-benchmarks").addEventListener("click", load);
byId("discuss-benchmark").addEventListener("click", async () => {
  if (!state.run) return;
  const button = byId("discuss-benchmark");
  button.disabled = true;
  message("handoff-status");
  try {
    const runId = state.run.id,
      query = state.baseline
        ? "?baseline=" + encodeURIComponent(state.baseline.id)
        : "";
    const handoff = await request(
      "runs/" + encodeURIComponent(runId) + "/discussion" + query,
    );
    if (state.run?.id !== runId) return;
    if (
      typeof handoff.prompt !== "string" ||
      !handoff.prompt ||
      typeof handoff.report_path !== "string"
    )
      throw new Error("De overdracht bevat geen lokaal bespreekrapport.");
    const transfer =
      typeof handoff.command === "string" && handoff.command
        ? handoff.command
        : handoff.prompt;
    const terminal = transfer === handoff.command;
    byId("handoff-fallback").querySelector("label").textContent = terminal
      ? "Terminalcommando"
      : "Overdracht naar Codex";
    byId("codex-handoff").value = transfer;
    try {
      await navigator.clipboard.writeText(transfer);
      message(
        "handoff-status",
        terminal ? "Terminalcommando gekopieerd." : "Overdracht gekopieerd.",
      );
    } catch {
      byId("handoff-fallback").hidden = false;
      byId("codex-handoff").focus();
      byId("codex-handoff").select();
      message("handoff-status", "Kopiëren kon niet automatisch.");
    }
  } catch (error) {
    message("handoff-status", error.message, true);
  } finally {
    button.disabled = false;
  }
});
planner.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (startButton.disabled || state.plan?.can_start !== true) return;
  startButton.disabled = true;
  try {
    const run = await post("runs", selection());
    state.run = run;
    state.matrix = null;
    state.baseline = null;
    state.comparison = null;
    storeRun(run);
    closePlanner();
    historyControls();
    renderRun();
    pollRun();
    byId("benchmark-run").focus();
  } catch (error) {
    message("plan-status", error.message, true);
    startButton.disabled = false;
  }
});
byId("stop-benchmark").addEventListener("click", async () => {
  if (!active(state.run)) return;
  byId("stop-benchmark").disabled = true;
  const id = state.run.id;
  try {
    const run = await request("runs/" + encodeURIComponent(id), {
      method: "DELETE",
    });
    if (state.run.id !== id) return;
    state.run = run;
    storeRun(run);
    historyControls();
    renderRun();
    pollRun();
  } catch (error) {
    message("run-status", error.message, true);
    byId("stop-benchmark").disabled = false;
  }
});
load();
