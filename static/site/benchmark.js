import {
  outcome,
  executionStatus,
  sourceCoverageText,
  questionStartRequest,
} from "./benchmark-model.js";
const byId = (id) => document.getElementById(id);
const state = {
  catalog: null,
  runs: [],
  run: null,
  poll: null,
  selected: null,
  runSequence: 0,
  busy: false,
  repeat: 1,
};
const active = (run) =>
  ["queued", "running", "preparing", "cancelling"].includes(run?.status);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className) {
  const node = el("button", text, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
function message(id, text = "", error = false) {
  byId(id).textContent = text;
  byId(id).classList.toggle("benchmark-error", error);
}
function option(select, value, text) {
  const node = el("option", text);
  node.value = value;
  select.append(node);
}
async function request(path, options = {}) {
  const response = await fetch("/api/benchmarks/" + path, {
    cache: "no-store",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error("De server gaf geen leesbaar resultaat.");
  }
  if (!response.ok)
    throw new Error(
      value.error?.message ||
        value.error ||
        "De benchmark kon niet worden geladen.",
    );
  return value;
}
function table(headers, className = "") {
  const scroll = el("div", null, "benchmark-table-scroll"),
    node = el("table", null, "benchmark-table " + className),
    head = el("thead"),
    row = el("tr"),
    body = el("tbody");
  scroll.tabIndex = 0;
  for (const title of headers) {
    const th = el("th", title);
    th.scope = "col";
    row.append(th);
  }
  head.append(row);
  node.append(head, body);
  scroll.append(node);
  return { scroll, table: node, body };
}
function questionForRun(run) {
  if (run?.question) return run.question;
  const selection = run?.plan?.selection;
  if (selection?.datasets?.length !== 1 || selection?.case_ids?.length !== 1)
    return null;
  return (
    state.catalog.questions.find(
      (question) =>
        question.dataset === selection.datasets[0] &&
        question.case_id === selection.case_ids[0],
    ) || null
  );
}
function runQuestions(run) {
  const values = new Map();
  for (const row of run.result?.rows || []) {
    const key = row.dataset + ":" + row.case_id;
    if (!values.has(key)) {
      const known = state.catalog.questions.find(
        (question) =>
          question.dataset === row.dataset && question.case_id === row.case_id,
      );
      values.set(key, {
        ...known,
        id: known?.id || key,
        dataset: row.dataset,
        case_id: row.case_id,
        question: row.question,
        title: known?.question === row.question ? known.title : row.question,
      });
    }
  }
  if (!values.size) {
    const single = questionForRun(run);
    if (single) values.set(single.dataset + ":" + single.case_id, single);
  }
  return [...values.values()];
}
function runMode(run) {
  return (
    run.mode ||
    run.plan?.mode ||
    (run.groups?.some((group) => group.family === "assistant")
      ? "assistant"
      : "rag")
  );
}
function selectedQuestion() {
  return state.catalog.questions.find(
    (question) => question.id === byId("benchmark-question").value,
  );
}
function modeControls() {
  byId("model-authorization").hidden =
    byId("benchmark-mode").value !== "assistant";
}
function selection(requireAuthorization = true) {
  const question = selectedQuestion(),
    repeats = Number(byId("benchmark-repeats").value),
    mode = byId("benchmark-mode").value;
  if (!question) throw new Error("Kies één vraag.");
  if (
    !Number.isInteger(repeats) ||
    repeats < 1 ||
    repeats > (state.catalog.limits?.max_repeats || 3)
  )
    throw new Error("Kies een geldig aantal herhalingen.");
  const selected = {
    dataset: question.dataset,
    case_id: question.case_id,
    mode,
    repeats,
  };
  if (
    mode === "assistant" &&
    (requireAuthorization || byId("allow-models").checked)
  ) {
    const attempts = Number(byId("model-attempts").value),
      seconds = Number(byId("model-seconds").value);
    if (
      !byId("allow-models").checked ||
      !Number.isInteger(attempts) ||
      attempts < 1 ||
      !Number.isInteger(seconds) ||
      seconds < 1
    )
      throw new Error(
        "Modelgebruik vereist toestemming en positieve poging- en tijdlimieten.",
      );
    selected.authorization = {
      confirmed: true,
      max_attempts: attempts,
      max_seconds: seconds,
    };
  }
  return selected;
}
function populateQuestions() {
  const select = byId("benchmark-question");
  select.replaceChildren();
  for (const question of state.catalog.questions)
    option(select, question.id, question.title || question.question);
  byId("benchmark-repeats").max = state.catalog.limits?.max_repeats || 3;
  byId("benchmark-repeats").value = 2;
  byId("start-benchmark").disabled = false;
  modeControls();
}
function showPlanner() {
  byId("benchmark-planner").hidden = false;
  byId("edit-benchmark").hidden = true;
  byId("benchmark-results").hidden = true;
  message("plan-status");
}
function storeRun(run) {
  const index = state.runs.findIndex((item) => item.id === run.id);
  if (index < 0) state.runs.unshift(run);
  else state.runs[index] = run;
}
function dateLabel(run) {
  const date = new Date(run.created_at);
  return (
    (Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat("nl-NL", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(date)
      : run.id) +
    " · " +
    executionStatus(run.status)
  );
}
function historyControls() {
  const select = byId("benchmark-run");
  select.replaceChildren();
  option(select, "", "Kies uitvoering");
  const runs = state.runs;
  for (const run of runs) {
    const question = questionForRun(run);
    option(
      select,
      run.id,
      (question ? question.title || question.question : "Opgeslagen meting") +
        " · " +
        dateLabel(run),
    );
  }
  select.value = state.run?.id || "";
  byId("benchmark-history").hidden = !runs.length;
}
async function chooseRun(id) {
  if (!id) return;
  const sequence = ++state.runSequence;
  clearTimeout(state.poll);
  message("page-status", "Uitvoering laden…");
  state.selected = null;
  state.repeat = 1;
  try {
    const run = await request("runs/" + encodeURIComponent(id));
    if (sequence !== state.runSequence) return;
    const choices = runQuestions(run),
      current = selectedQuestion(),
      question =
        choices.find(
          (item) =>
            item.dataset === current?.dataset &&
            item.case_id === current?.case_id,
        ) || choices[0];
    if (!question)
      throw new Error("Deze uitvoering bevat geen inspecteerbare vraag.");
    state.run = run;
    state.viewQuestion = question;
    state.historyScoped = choices.length > 1;
    storeRun(run);
    byId("benchmark-question").value = question.id;
    byId("benchmark-mode").value = runMode(run);
    byId("benchmark-repeats").value = run.plan.selection.repeats;
    modeControls();
    const historyQuestion = byId("history-question");
    historyQuestion.replaceChildren();
    for (const item of choices)
      option(
        historyQuestion,
        item.dataset + ":" + item.case_id,
        item.title || item.question,
      );
    historyQuestion.value = question.dataset + ":" + question.case_id;
    byId("history-question-field").hidden = choices.length < 2;
    byId("benchmark-planner").hidden = true;
    byId("edit-benchmark").hidden = false;
    message("page-status");
    message("handoff-status");
    byId("handoff-fallback").hidden = true;
    historyControls();
    renderRun();
    pollRun();
  } catch (error) {
    message("page-status", error.message, true);
    showPlanner();
  }
}
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
function pollRun() {
  clearTimeout(state.poll);
  if (!active(state.run)) return;
  state.poll = setTimeout(async () => {
    const id = state.run.id;
    try {
      const run = await request("runs/" + encodeURIComponent(id));
      if (state.run?.id !== id) return;
      const changed = fingerprint(run) !== fingerprint(state.run);
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
function variantLabel(config) {
  if (config.label && !/\bk\d+\b/.test(config.label)) return config.label;
  const value = config.configuration || {},
    name = (items, id) => items?.find((item) => item.id === id)?.label || id;
  const expanded =
    value.selection === "activity_expansion" ||
    value.context_mode === "activity_expand";
  const limit = value.top_k
    ? expanded
      ? `Eerst ${value.top_k} secties · hele activiteit`
      : `Maximaal ${value.top_k} ${String(value.profile).endsWith("_activities") ? "activiteiten" : "secties"}`
    : "";
  return [
    name(state.catalog.methods, value.method),
    value.method !== "bm25" &&
      name(state.catalog.embedding_models, value.embedding_model),
    name(state.catalog.profiles, value.profile),
    limit,
    value.apply_filters ? "Filters uit de vraag" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
function columnsFor(run) {
  return run.groups
    .filter(
      (group) =>
        !state.viewQuestion?.dataset ||
        group.dataset === state.viewQuestion.dataset,
    )
    .filter(
      (group) =>
        !state.historyScoped ||
        (run.result?.rows || []).some(
          (row) =>
            row.group_id === group.id &&
            row.case_id === state.viewQuestion.case_id,
        ),
    )
    .flatMap((group) =>
      group.configurations.map((config) => ({
        id: group.id + ":" + config.id,
        group,
        config,
        configurationId: config.id,
        run,
        label: variantLabel(config),
      })),
    );
}
function coverageState(row) {
  if (!row) return active(state.run) ? "Wachtend" : "Niet uitgevoerd";
  return sourceCoverageText(row);
}

function variantSettings(column, row) {
  const value = column.config.configuration || {},
    profile = String(value.profile || "");
  const name = (items, id) =>
    items?.find((item) => item.id === id)?.label || id;
  const wordSearch = ["bm25", "keyword_overlap"].includes(value.method);
  const identity = row?.embedding_identity?.model;
  const encoder =
    value.embedding_model ||
    state.catalog.suites?.find((suite) => suite.id === column.group.suite)
      ?.embedding_model ||
    state.catalog.default_embedding_model;
  return {
    method: name(state.catalog.methods, value.method) || "Onbekend",
    model: wordSearch
      ? "Niet gebruikt"
      : encoder
        ? name(state.catalog.embedding_models, encoder)
        : identity
          ? String(identity).split("@")[0].split("/").at(-1)
          : "Onbekend",
    storage: profile.startsWith("sqlite_")
      ? "SQLite"
      : profile.startsWith("documents_")
        ? "Bestanden"
        : "Onbekend",
    searches: profile.endsWith("_activities")
      ? "Activiteiten"
      : profile.endsWith("_sections")
        ? "Bronsecties"
        : "Onbekend",
    selection: Number.isInteger(value.top_k)
      ? `${value.top_k} ${profile.endsWith("_activities") ? "activiteiten" : "bronsecties"}`
      : "—",
    expansion:
      value.selection === "activity_expansion" ||
      value.context_mode === "activity_expand" ||
      profile.endsWith("_activities")
        ? "Ja"
        : "Nee",
    filters: value.apply_filters ? "Uit de vraag" : "Nee",
  };
}
function executionFor(row, column) {
  if (!row) {
    const waiting =
      active(state.run) &&
      !column.group.block_reason &&
      !["failed", "cancelled", "interrupted", "not_run"].includes(
        column.group.status,
      );
    return waiting ? "Wachtend" : "Niet uitgevoerd";
  }
  if (["error", "failed_execution"].includes(row.status))
    return "Uitvoeringsfout";
  if (["passed", "failed"].includes(row.status)) return "Afgerond";
  return executionStatus(row.status) || "Onbekend";
}
function retrievedActivities(row) {
  const actual = row?.actual_retrieval;
  if (!actual) return "Onbekend";
  if (actual.applicable === false) return "N.v.t.";
  return Number.isInteger(actual.activities) && actual.activities >= 0
    ? String(actual.activities)
    : "Onbekend";
}
function evidenceGoals(row) {
  const metrics = row?.metrics;
  if (!metrics) return "Onbekend";
  if (metrics.source_quality_applicable === false) return "N.v.t.";
  return Number.isInteger(metrics.covered_goals) &&
    Number.isInteger(metrics.target_goals) &&
    metrics.target_goals > 0
    ? `${metrics.covered_goals}/${metrics.target_goals}`
    : "Onbekend";
}
function chooseRepeat(repeat, focus = true) {
  state.repeat = repeat;
  state.selected = null;
  renderRun();
  if (focus)
    queueMicrotask(() =>
      byId(`repeat-tab-${state.run.id}-${repeat}`)?.focus({
        preventScroll: true,
      }),
    );
}
function renderRun() {
  const run = state.run;
  if (!run) return;
  const question = state.viewQuestion || questionForRun(run),
    columns = columnsFor(run).map((column, index) => ({
      ...column,
      label: "Variant " + (index + 1),
    })),
    repeats = run.plan.selection.repeats;
  state.repeat = Math.min(Math.max(state.repeat || 1, 1), repeats);
  const repeat = state.repeat;
  const focused = document.activeElement,
    focusedKey = focused?.dataset.cellKey,
    focusedClose = focused?.hasAttribute("data-evidence-close"),
    focusedTab = focused?.getAttribute("role") === "tab" ? focused.id : null;
  const scroll =
      byId("benchmark-variants").querySelector(".benchmark-table-scroll")
        ?.scrollLeft || 0,
    top = window.scrollY;
  byId("benchmark-results").hidden = false;
  byId("run-question").textContent = question.title || question.question;
  byId("run-context").textContent =
    (runMode(run) === "assistant" ? "COA-assistent" : "Bronzoeken") +
    ` · ${columns.length} varianten · ${repeats} herhalingen`;
  const groupErrors = [
    ...new Set(run.groups.map((group) => group.error).filter(Boolean)),
  ];
  message(
    "run-status",
    `${executionStatus(run.status)} · ${run.progress.completed} van ${run.progress.total} afgerond${run.error ? " · " + run.error : groupErrors.length ? " · " + groupErrors.join(" · ") : ""}`,
    run.status === "failed",
  );
  byId("stop-benchmark").hidden = !active(run);
  byId("stop-benchmark").disabled = run.status === "cancelling";
  const tabs = el("div", null, "benchmark-repeat-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Herhalingen");
  const panels = [];
  for (let index = 1; index <= repeats; index++) {
    const tab = button("Herhaling " + index, () => chooseRepeat(index));
    tab.id = `repeat-tab-${run.id}-${index}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(index === repeat));
    tab.tabIndex = index === repeat ? 0 : -1;
    tab.setAttribute("aria-controls", `repeat-panel-${run.id}-${index}`);
    tab.addEventListener("keydown", (event) => {
      const next =
        event.key === "ArrowRight"
          ? (index % repeats) + 1
          : event.key === "ArrowLeft"
            ? ((index + repeats - 2) % repeats) + 1
            : event.key === "Home"
              ? 1
              : event.key === "End"
                ? repeats
                : null;
      if (next !== null) {
        event.preventDefault();
        chooseRepeat(next);
      }
    });
    tabs.append(tab);
    const panel = el("section");
    panel.id = `repeat-panel-${run.id}-${index}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.hidden = index !== repeat;
    panels.push(panel);
  }
  const view = table(
    ["Eigenschap", ...columns.map((column) => column.label)],
    "benchmark-coverage",
  );
  view.scroll.setAttribute("aria-label", "Alle varianten naast elkaar");
  const measuredRows = run.result?.rows || [];
  const attempts = (run.result?.attempt_errors || []).filter(
    (attempt) =>
      !measuredRows.some(
        (row) =>
          row.group_id === attempt.group_id &&
          row.configuration_id === attempt.configuration_id &&
          (row.repeat || 1) === (attempt.repeat || 1),
      ),
  );
  const rows = [...measuredRows, ...attempts].filter(
    (row) =>
      row.case_id === question.case_id && row.dataset === question.dataset,
  );
  const records = columns.map((column) => ({
    column,
    row: rows.find(
      (row) =>
        row.group_id === column.group.id &&
        row.configuration_id === column.configurationId &&
        (row.repeat || 1) === repeat,
    ),
  }));
  const settings = records.map(({ column, row }) =>
    variantSettings(column, row),
  );
  const definitions = [
    ["method", "Zoekmethode", (_, index) => settings[index].method],
    ["model", "Zoekmodel", (_, index) => settings[index].model],
    ["storage", "Opslag", (_, index) => settings[index].storage],
    ["searches", "Zoekt in", (_, index) => settings[index].searches],
    [
      "selection",
      "Eerste selectie (max.)",
      (_, index) => settings[index].selection,
    ],
    [
      "expansion",
      "Hele activiteit meeleveren",
      (_, index) => settings[index].expansion,
    ],
    ...(settings.some((value) => value.filters !== "Nee")
      ? [["filters", "Filters", (_, index) => settings[index].filters]]
      : []),
    [
      "activities",
      "Opgehaalde activiteiten",
      (row) => (row ? retrievedActivities(row) : "—"),
    ],
    [
      "sources",
      "Benodigde bronsecties gevonden",
      (row) =>
        row && outcome(row) !== "error" ? sourceCoverageText(row) : "—",
    ],
    [
      "goals",
      "Bewijsdoelen gevonden",
      (row) => (row && outcome(row) !== "error" ? evidenceGoals(row) : "—"),
    ],
    [
      "timing",
      runMode(run) === "assistant"
        ? "Gemeten uitvoertijd (ms)"
        : "Gemeten zoektijd (ms)",
      (row) => {
        const value =
          row?.[
            runMode(run) === "assistant" ? "native_elapsed_ms" : "retrieval_ms"
          ];
        return Number.isFinite(value)
          ? new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 3 }).format(
              value,
            )
          : "—";
      },
    ],
    [
      "execution",
      "Uitvoeringstatus",
      (row, index) => executionFor(row, columns[index]),
    ],
  ];
  for (const [id, title, value] of definitions) {
    const tr = el("tr");
    tr.dataset.metric = id;
    if (id === "sources") tr.className = "benchmark-primary-metric";
    const header = el("th", title);
    header.scope = "row";
    tr.append(header);
    for (const [index, { column, row }] of records.entries()) {
      const cell = el("td"),
        text = value(row, index);
      if (id === "sources" && row) {
        const key = column.id + ":" + repeat,
          action = button(
            text,
            () => {
              const wasOpen = action.getAttribute("aria-expanded") === "true";
              view.body.querySelector(".benchmark-evidence-row")?.remove();
              view.body
                .querySelectorAll("button[aria-expanded=true]")
                .forEach((node) => node.setAttribute("aria-expanded", "false"));
              state.selected = wasOpen ? null : key;
              if (wasOpen) return;
              action.setAttribute("aria-expanded", "true");
              const detail = el("tr", null, "benchmark-evidence-row"),
                body = el("td");
              body.colSpan = columns.length + 1;
              const item = {
                rows: columns.flatMap((entry) =>
                  rows
                    .filter(
                      (record) =>
                        record.group_id === entry.group.id &&
                        record.configuration_id === entry.configurationId,
                    )
                    .map((record) => ({
                      ...record,
                      original: record,
                      configuration_id: entry.id,
                    })),
                ),
              };
              body.append(
                renderEvidence(item, columns, repeat, () => {
                  detail.remove();
                  state.selected = null;
                  action.setAttribute("aria-expanded", "false");
                  action.focus({ preventScroll: true });
                }),
              );
              detail.append(body);
              tr.after(detail);
            },
            "benchmark-coverage-value",
          );
        const coverage = row.required_source_coverage;
        action.dataset.cellKey = key;
        action.dataset.outcome =
          outcome(row) === "error"
            ? "error"
            : coverage?.applicable === true &&
                Number.isInteger(coverage.found) &&
                Number.isInteger(coverage.total)
              ? coverage.found === coverage.total
                ? "passed"
                : "failed"
              : "unknown";
        action.setAttribute(
          "aria-label",
          `Herhaling ${repeat} · ${column.label} · ${text} benodigde bronsecties`,
        );
        action.setAttribute("aria-expanded", "false");
        cell.append(action);
        if (state.selected === key)
          queueMicrotask(() => {
            if (state.selected === key && action.isConnected) action.click();
          });
      } else cell.append(el("span", text));
      if (id === "execution" && text === "Uitvoeringsfout")
        cell.className = "benchmark-error";
      tr.append(cell);
    }
    view.body.append(tr);
  }
  panels[repeat - 1].append(view.scroll);
  byId("benchmark-variants").replaceChildren(tabs, ...panels);
  queueMicrotask(() => {
    const container = byId("benchmark-variants"),
      target = focusedClose
        ? container.querySelector("[data-evidence-close]")
        : focusedKey
          ? [...container.querySelectorAll("[data-cell-key]")].find(
              (node) => node.dataset.cellKey === focusedKey,
            )
          : focusedTab
            ? byId(focusedTab)
            : null;
    target?.focus({ preventScroll: true });
    container.querySelector(".benchmark-table-scroll").scrollLeft = scroll;
    if (state.selected) window.scrollTo({ top, behavior: "auto" });
  });
}

async function start() {
  if (state.busy || byId("start-benchmark").disabled) return;
  state.busy = true;
  byId("start-benchmark").disabled = true;
  message("plan-status", "Benchmark starten…");
  try {
    const selected = selection(),
      plan = await request("questions/plan", {
        method: "POST",
        body: JSON.stringify(selected),
      });
    if (!plan.can_start)
      throw new Error(
        plan.groups
          ?.map((group) => group.block_reason)
          .filter(Boolean)
          .join(" · ") || "Deze benchmark kan nu niet worden uitgevoerd.",
      );
    const action = questionStartRequest(window.sessionStorage, selected);
    const run = await request("questions/start", {
      method: "POST",
      body: JSON.stringify(action.payload),
    });
    if (typeof run.id !== "string" || !run.id)
      throw new Error("De server gaf geen geldige uitvoering terug.");
    sessionStorage.removeItem(action.key);
    window.location.assign("/benchmark/?run=" + encodeURIComponent(run.id));
  } catch (error) {
    message("plan-status", error.message, true);
    state.busy = false;
    byId("start-benchmark").disabled = false;
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
      !Array.isArray(catalog.questions) ||
      !catalog.questions.length ||
      !Array.isArray(history.runs)
    )
      throw new Error("De evaluatievragen zijn niet beschikbaar.");
    state.catalog = catalog;
    state.runs = history.runs;
    populateQuestions();
    historyControls();
    message("page-status");
    const id = new URL(location.href).searchParams.get("run");
    if (id) await chooseRun(id);
    else showPlanner();
  } catch (error) {
    message("page-status", error.message, true);
    byId("retry-benchmarks").hidden = false;
  }
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
  const sourceRefs = records.flatMap(({ row }) => [
    ...(row?.required_source_coverage?.found_refs || []),
    ...(row?.required_source_coverage?.missing_refs || []),
  ]);
  if (sourceRefs.length) {
    for (const ref of sourceRefs)
      goals.set("source:" + refKey(ref), {
        id: "source:" + refKey(ref),
        source_ref: ref,
        alternatives: [[ref]],
      });
  } else
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
            covered: goal.source_ref
              ? row?.required_source_coverage?.found_refs?.some(
                  (ref) => refKey(ref) === refKey(goal.source_ref),
                )
                ? true
                : row?.required_source_coverage?.missing_refs?.some(
                      (ref) => refKey(ref) === refKey(goal.source_ref),
                    )
                  ? false
                  : undefined
              : matches.some((value) => value?.covered === false)
                ? false
                : matches.every((value) => value?.covered === true)
                  ? true
                  : undefined,
          },
          text = !row
            ? "Niet uitgevoerd"
            : outcome(row) === "error"
              ? "Uitvoeringsfout"
              : row.required_source_coverage?.applicable === false
                ? "N.v.t."
                : actual?.covered === true
                  ? assistant
                    ? "Aangeboden"
                    : "Gevonden"
                  : actual?.covered === false
                    ? "Ontbreekt"
                    : goal.source_ref &&
                        row.required_source_coverage?.has_alternatives
                      ? "Andere geldige optie"
                      : "Onbekend",
          td = el("td", text);
        td.dataset.outcome = actual?.covered === false ? "failed" : "";
        tr.append(td);
      }
      view.body.append(tr);
    }
    if (sourceRefs.length) {
      const tr = el("tr"),
        label = el("th", "Bewijsdoelen gevonden");
      label.scope = "row";
      tr.append(label);
      for (const { row } of records) {
        const metrics = row?.metrics;
        tr.append(
          el(
            "td",
            Number.isInteger(metrics?.covered_goals) &&
              Number.isInteger(metrics?.target_goals) &&
              metrics.target_goals > 0
              ? `${metrics.covered_goals}/${metrics.target_goals}`
              : "—",
          ),
        );
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
byId("benchmark-planner").addEventListener("submit", (event) => {
  event.preventDefault();
  start();
});
byId("benchmark-mode").addEventListener("change", modeControls);
byId("edit-benchmark").addEventListener("click", () => {
  showPlanner();
  byId("benchmark-question").focus();
});
byId("benchmark-run").addEventListener("change", (event) => {
  if (!event.target.value) return;
  history.replaceState(
    null,
    "",
    "/benchmark/?run=" + encodeURIComponent(event.target.value),
  );
  chooseRun(event.target.value);
});
byId("retry-benchmarks").addEventListener("click", load);
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
byId("discuss-benchmark").addEventListener("click", async () => {
  if (!state.run) return;
  const action = byId("discuss-benchmark");
  action.disabled = true;
  message("handoff-status");
  try {
    const id = state.run.id,
      handoff = await request("runs/" + encodeURIComponent(id) + "/discussion");
    if (state.run?.id !== id) return;
    const command =
      typeof handoff.command === "string" && handoff.command
        ? handoff.command
        : handoff.prompt;
    if (typeof command !== "string" || !handoff.report_path)
      throw new Error("De overdracht bevat geen lokaal bespreekrapport.");
    byId("codex-handoff").value = command;
    try {
      await navigator.clipboard.writeText(command);
      message("handoff-status", "Terminalcommando gekopieerd.");
    } catch {
      byId("handoff-fallback").hidden = false;
      byId("codex-handoff").focus();
      byId("codex-handoff").select();
      message("handoff-status", "Kopiëren kon niet automatisch.");
    }
  } catch (error) {
    message("handoff-status", error.message, true);
  } finally {
    action.disabled = false;
  }
});
load();
let planTimer,
  planSequence = 0;
function refreshPlan() {
  clearTimeout(planTimer);
  const sequence = ++planSequence;
  planTimer = setTimeout(async () => {
    if (state.busy) return;
    try {
      const selected = selection(false),
        plan = await request("questions/plan", {
          method: "POST",
          body: JSON.stringify(selected),
        });
      if (sequence !== planSequence || state.busy) return;
      const variants = plan.groups.reduce(
          (count, group) => count + group.configuration_count,
          0,
        ),
        blocks = [
          ...new Set(
            plan.groups.map((group) => group.block_reason).filter(Boolean),
          ),
        ];
      message(
        "plan-status",
        `${variants} varianten · ${selected.repeats} herhalingen${blocks.length ? " · " + blocks.join(" · ") : ""}`,
        !plan.can_start,
      );
      byId("start-benchmark").disabled = !plan.can_start;
    } catch (error) {
      if (sequence !== planSequence || state.busy) return;
      message("plan-status", error.message, true);
      byId("start-benchmark").disabled = true;
    }
  }, 150);
}
byId("benchmark-planner").addEventListener("change", (event) => {
  if (event.target.type !== "number") refreshPlan();
});
byId("benchmark-planner").addEventListener("input", (event) => {
  if (event.target.type === "number") refreshPlan();
});
byId("history-question").addEventListener("change", (event) => {
  const question = runQuestions(state.run).find(
    (item) => item.dataset + ":" + item.case_id === event.target.value,
  );
  if (!question) return;
  state.viewQuestion = question;
  state.selected = null;
  renderRun();
});
