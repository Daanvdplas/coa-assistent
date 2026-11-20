export function outcome(row) {
  if (!row) return "not_run";
  if (["error", "failed_execution"].includes(row.status)) return "error";
  if (
    [
      "not_run",
      "cancelled",
      "interrupted",
      "queued",
      "running",
      "preparing",
      "retrieved_ungraded",
    ].includes(row.status)
  )
    return row.status;
  if (
    ["assistant", "assistant-rig", "compact", "compact-live"].includes(
      row.suite,
    )
  )
    return ["passed", "failed"].includes(row.status) ? row.status : "unknown";
  if (row.source_complete === null)
    return row.metrics?.source_quality_applicable === false
      ? "not_applicable"
      : "unknown";
  if (typeof row.source_complete === "boolean")
    return row.source_complete ? "passed" : "failed";
  if (["passed", "failed", "unknown", "not_applicable"].includes(row.status))
    return row.status;
  return "unknown";
}

export const labels = {
  passed: "Compleet",
  failed: "Bronnen ontbreken",
  error: "Uitvoeringsfout",
  not_run: "Niet uitgevoerd",
  not_applicable: "N.v.t.",
  unknown: "Onbekend",
  queued: "In wachtrij",
  running: "Bezig",
  preparing: "Voorbereiden",
  retrieved_ungraded: "Nog niet beoordeeld",
  cancelled: "Gestopt",
  cancelling: "Stoppen…",
  interrupted: "Onderbroken",
  completed: "Afgerond",
};

export function executionStatus(status) {
  return status === "failed" ? "Uitvoeringsfout" : labels[status] || status;
}

export function sourceCoverageText(row) {
  if (!row) return "Niet uitgevoerd";
  if (outcome(row) === "error") return "Uitvoeringsfout";
  const coverage = row.required_source_coverage;
  if (!coverage || coverage.unit !== "sections") return "Onbekend";
  if (coverage.applicable === false) return "N.v.t.";
  if (coverage.total === 0) return "N.v.t.";
  if (
    !Number.isInteger(coverage.found) ||
    !Number.isInteger(coverage.total) ||
    coverage.found < 0 ||
    coverage.found > coverage.total
  )
    return "Onbekend";
  return `${coverage.found}/${coverage.total}`;
}

export function questionStartRequest(storage, selection) {
  const key = "coa-benchmark-question-v1:" + JSON.stringify(selection);
  let id = storage.getItem(key);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    id = crypto.randomUUID();
    storage.setItem(key, id);
  }
  return { key, payload: { ...selection, request_id: id } };
}
export function selectedDatasets(catalog, value) {
  if (value === "__current__") return [...catalog.default_selection.datasets];
  if (value === "__all__") return catalog.datasets.map((item) => item.id);
  return [value];
}

export function eligibleMean(rows, field, expectedCount) {
  if (
    !rows.length ||
    !Number.isInteger(expectedCount) ||
    rows.length !== expectedCount
  )
    return null;
  if (
    rows.some(
      (row) =>
        outcome(row) !== "passed" ||
        row.latency_eligible === false ||
        (row.suite === "assistant" && row.answer_quality === "not_assessed"),
    )
  )
    return null;
  const values = rows.map((row) => row[field] ?? row.metrics?.[field]);
  if (values.some((value) => !Number.isFinite(value))) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function metricText(row) {
  const status = outcome(row);
  if (
    ["assistant", "assistant-rig"].includes(row?.suite) &&
    ["passed", "failed"].includes(status) &&
    row.assertions?.length
  ) {
    return `${row.assertions.filter((check) => check.pass === true).length}/${row.assertions.length} controles`;
  }
  if (["passed", "failed"].includes(status)) {
    const metrics = row.metrics || {};
    if (
      Number.isFinite(metrics.covered_goals) &&
      Number.isFinite(metrics.target_goals) &&
      metrics.target_goals > 0
    )
      return `${metrics.covered_goals}/${metrics.target_goals}`;
  }
  return labels[status] || status;
}

export function summarize(rows) {
  const result = {
    passed: 0,
    failed: 0,
    error: 0,
    unknown: 0,
    not_applicable: 0,
    not_run: 0,
    total: rows.length,
  };
  for (const row of rows) {
    const status = outcome(row);
    result[status] = (result[status] || 0) + 1;
  }
  return result;
}

function signature(rows) {
  return rows
    .slice()
    .sort((a, b) => (a.repeat || 1) - (b.repeat || 1))
    .map((row) =>
      JSON.stringify([
        row.repeat || 1,
        row.status,
        outcome(row),
        row.metrics?.covered_goals,
        row.metrics?.target_goals,
        (row.goals || []).map((goal) => [goal.id, goal.covered]),
        row.answer || row.output?.answer || null,
        (row.calls || []).map((call) => [
          call.query,
          (call.hits || []).map((hit) =>
            typeof hit === "string"
              ? hit
              : [hit.source_id, hit.section_id || hit.id, hit.text],
          ),
        ]),
        (row.assertions || []).map((check) => [
          check.reason,
          check.pass,
          check.score,
        ]),
        [
          row.metrics?.full_bytes,
          row.metrics?.compact_bytes,
          row.metrics?.full_payload_bytes,
          row.metrics?.compact_payload_bytes,
        ],
      ]),
    )
    .join("|");
}

export function matrixCases(rows, configurationIds, filter = "all") {
  const cases = new Map();
  for (const row of rows) {
    if (!cases.has(row.case_id))
      cases.set(row.case_id, {
        id: row.case_id,
        question: row.question || row.case_id,
        rows: [],
      });
    cases.get(row.case_id).rows.push(row);
  }
  return [...cases.values()].filter((item) => {
    if (filter === "failures")
      return item.rows.some((row) => outcome(row) === "failed");
    if (filter === "errors")
      return item.rows.some((row) => outcome(row) === "error");
    if (filter === "differences")
      return (
        new Set(
          configurationIds.map((id) =>
            signature(item.rows.filter((row) => row.configuration_id === id)),
          ),
        ).size > 1
      );
    return true;
  });
}

export function configurationLabel(configuration, catalog = {}) {
  const name = (list, id) => list?.find((item) => item.id === id)?.label || id;
  return [
    name(catalog.methods, configuration.method),
    configuration.method !== "bm25" &&
      name(catalog.embedding_models, configuration.embedding_model),
    name(catalog.profiles, configuration.profile),
    configuration.arm,
  ]
    .filter(Boolean)
    .join(" · ");
}
