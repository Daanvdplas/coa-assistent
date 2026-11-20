"use strict";
// Browser IDs select frozen inputs; this module never reads protected labels.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "../../..");
const DATASETS = ["demo-12-20261118", "regression-12-20261118"];
const ALIASES = Object.freeze({
  "garden-time-location": "P01",
  "indoor-tuesday": "T02",
  "two-activities": "T05",
});
const PRESETS = Object.freeze({
  standard: Object.freeze({ top_k: 5, selection: "sections" }),
  "dense-k3-sections": Object.freeze({
    top_k: 3,
    selection: "sections",
    method: "dense",
    embedding_model: "e5-small-multilingual",
  }),
  "dense-k3-activity-expansion": Object.freeze({
    top_k: 3,
    selection: "activity_expansion",
    method: "dense",
    embedding_model: "e5-small-multilingual",
  }),
});
function frozenQuestions(dataset) {
  if (!DATASETS.includes(dataset) && dataset !== "legacy")
    throw new Error("Unknown browser dataset");
  const relative = `evals/shared/datasets/${dataset}/questions.json`;
  const bytes = fs.readFileSync(path.join(ROOT, relative));
  const pins = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data-pins.json")),
  ).files;
  if (
    pins[relative] !== crypto.createHash("sha256").update(bytes).digest("hex")
  )
    throw new Error(`Frozen browser questions changed: ${relative}`);
  return JSON.parse(bytes);
}
function binding(id, dataset, caseId, title) {
  const questions = frozenQuestions(dataset);
  const row = questions.cases.find((item) => item.id === caseId);
  if (!row) throw new Error("Unknown frozen browser case");
  return {
    id,
    dataset,
    case_id: caseId,
    question: row.question,
    corpus_sha256: questions.corpus_sha256,
    as_of: questions.as_of,
    dataset_version: questions.dataset_version,
    ...(title ? { title } : {}),
  };
}
function publicBrowserCases() {
  const selection = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "evals/shared/selections/rag-quality-12-20261120.json"),
    ),
  );
  if (
    selection.schema_version !== 1 ||
    selection.corpus_id !== "demo-twelve" ||
    !Array.isArray(selection.cases)
  )
    throw new Error("Invalid browser selection manifest");
  const ids = new Set();
  const rows = selection.cases.map((row) => {
    if (
      typeof row.id !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(row.id) ||
      Object.hasOwn(ALIASES, row.id) ||
      ids.has(row.id) ||
      !DATASETS.includes(row.dataset_id)
    )
      throw new Error("Invalid or duplicate public browser case");
    ids.add(row.id);
    const result = binding(row.id, row.dataset_id, row.case_id, row.title);
    if (
      result.corpus_sha256 !== selection.corpus_sha256 ||
      result.as_of !== selection.reference_date
    )
      throw new Error(
        "Browser selection has a different corpus or reference date",
      );
    return result;
  });
  return [
    ...rows,
    binding("two-activities", DATASETS[0], "T05", "Twee activiteiten plannen"),
  ];
}
function activeBrowserCases() {
  return DATASETS.flatMap((dataset) =>
    frozenQuestions(dataset).cases.map((row) =>
      binding(`case:${dataset}:${row.id}`, dataset, row.id),
    ),
  );
}
function resolveBrowserCase(id) {
  if (typeof id !== "string") throw new Error("Unknown browser case ID");
  if (Object.hasOwn(ALIASES, id)) return binding(id, DATASETS[0], ALIASES[id]);
  const parts = id.split(":");
  if (parts.length === 3 && parts[0] === "case" && DATASETS.includes(parts[1]))
    return binding(id, parts[1], parts[2]);
  const selected = publicBrowserCases().find((row) => row.id === id);
  if (!selected) throw new Error("Unknown browser case ID");
  return selected;
}
function resolveLegacyBrowserCase(id) {
  if (!Object.hasOwn(ALIASES, id))
    throw new Error("Unknown historical browser alias");
  // Existing five-source fixtures keep their own question/corpus identity.
  const questions = frozenQuestions("legacy");
  const caseId = ALIASES[id];
  if (caseId.startsWith("T")) {
    const relative = "evals/shared/datasets/legacy/heldout-questions.json";
    const bytes = fs.readFileSync(path.join(ROOT, relative));
    const pins = JSON.parse(
      fs.readFileSync(path.join(__dirname, "data-pins.json")),
    ).files;
    if (
      pins[relative] !== crypto.createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error("Historical browser questions changed");
    const heldout = JSON.parse(bytes);
    const row = heldout.cases.find((item) => item.id === caseId);
    if (!row || heldout.corpus_sha256 !== questions.corpus_sha256)
      throw new Error("Historical browser case mismatch");
    return {
      id,
      dataset: "legacy",
      case_id: caseId,
      question: row.question,
      corpus_sha256: heldout.corpus_sha256,
      as_of: heldout.as_of,
      dataset_version: heldout.dataset_version,
    };
  }
  return binding(id, "legacy", caseId);
}
function browserPreset(id = "standard") {
  if (!Object.hasOwn(PRESETS, id)) throw new Error("Unknown browser preset");
  return {
    profile: "documents_sections",
    candidate_k: 30,
    context_token_limit: 1200,
    apply_filters: false,
    mmr: false,
    rrf_k: 60,
    vector_weight: 0.7,
    mmr_lambda: 0.7,
    ...PRESETS[id],
  };
}
module.exports = {
  resolveBrowserCase,
  resolveLegacyBrowserCase,
  publicBrowserCases,
  activeBrowserCases,
  browserCaseIds: () => publicBrowserCases().map((row) => row.id),
  browserPreset,
};
