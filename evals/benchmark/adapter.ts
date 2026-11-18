/** Canonical evaluation plans and adapters for the local benchmark workbench. */
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
interface Variables {
  dataset: string;
  case_id: string;
  question: string;
  [key: string]: unknown;
}
interface CanonicalCase {
  vars: Variables;
  metadata: Record<string, unknown>;
}
const canonical = require("../rag/promptfoo/cases.cjs") as {
  buildConfig: (env: Record<string, string>) => {
    tests: CanonicalCase[];
  };
  questions: (dataset: string) => Variables[];
};
const DEMO = "demo-12-20261118";
const REGRESSION = "regression-12-20261118";
const methods = [
  { id: "dense", label: "Op betekenis" },
  { id: "bm25", label: "Op woorden" },
  { id: "hybrid_rrf", label: "Combinatie op volgorde" },
  { id: "hybrid_weighted", label: "Gewogen combinatie" },
];
const profiles = [
  { id: "documents_sections", label: "Bestanden · secties" },
  { id: "documents_activities", label: "Bestanden · activiteiten" },
  { id: "sqlite_sections", label: "SQLite · secties" },
  { id: "sqlite_activities", label: "SQLite · activiteiten" },
];
const encoders = [
  { id: "minilm-multilingual", label: "MiniLM meertalig", suites: ["browser"] },
  {
    id: "e5-small-multilingual",
    label: "E5 Small meertalig",
    suites: ["browser"],
  },
];
const arms = [
  { id: "agentic_dense", label: "Gericht verderzoeken" },
  { id: "full_context", label: "Alle context" },
  { id: "dense_once", label: "Eenmaal betekenis" },
  { id: "bm25", label: "Eenmaal woorden" },
];
interface Suite {
  id: string;
  label: string;
  family: "retrieval" | "assistant" | "transport";
  kind: "local" | "model";
  datasets: string[];
  unit?: "provider_attempts" | "codex_sessions";
}
const shared = [
  "legacy",
  "independent-20261103",
  "expanded-10-20261105",
  "strengthened-10-20261106",
  DEMO,
  REGRESSION,
];
const suites: Suite[] = [
  {
    id: "retrieval",
    label: "Bronretrieval",
    family: "retrieval",
    kind: "local",
    datasets: shared,
  },
  {
    id: "quality",
    label: "Contextkwaliteit",
    family: "retrieval",
    kind: "local",
    datasets: ["legacy", "independent-20261103", DEMO, REGRESSION],
  },
  {
    id: "browser",
    label: "Drie bronproeven",
    family: "retrieval",
    kind: "local",
    datasets: [DEMO],
  },
  {
    id: "garden",
    label: "Tuinregressie",
    family: "retrieval",
    kind: "local",
    datasets: ["garden"],
  },
  {
    id: "agentic",
    label: "Gericht verderzoeken",
    family: "retrieval",
    kind: "model",
    datasets: ["legacy", "independent-20261103", DEMO],
  },
  {
    id: "models",
    label: "Sol/Luna-vergelijking",
    family: "retrieval",
    kind: "model",
    datasets: ["strengthened-10-20261106"],
  },
  {
    id: "compact",
    label: "Compacte bronoverdracht · replay",
    family: "transport",
    kind: "local",
    datasets: ["legacy"],
  },
  {
    id: "compact-live",
    label: "Compacte bronoverdracht · modellen",
    family: "transport",
    kind: "model",
    datasets: ["legacy"],
  },
  {
    id: "assistant",
    label: "Gehele assistent · Codex",
    family: "assistant",
    kind: "model",
    datasets: [...shared, "legacy-heldout"],
  },
  {id:"assistant-rig",label:"COA-assistent · Responses/Rig",family:"assistant",kind:"model",unit:"provider_attempts",datasets:[DEMO,REGRESSION]},
];
export interface Authorization {
  confirmed: boolean;
  max_sessions?: number;
  max_attempts?: number;
  max_seconds: number;
}
export interface Selection {
  datasets: string[];
  suites: string[];
  methods: string[];
  profiles: string[];
  embedding_models: string[];
  case_ids: string[];
  assistant_arms: string[];
  repeats: number;
  authorization?: Authorization;
  model_phase: "pilot" | "remaining";
}
export interface Configuration {
  id: string;
  label: string;
  configuration: Record<string, unknown>;
}
export interface Group {
  id: string;
  suite: string;
  dataset: string;
  label: string;
  family: Suite["family"];
  kind: Suite["kind"];
  block_reason: string | null;
  case_count: number;
  configuration_count: number;
  execution_count: number;
  identity: Record<string, string>;
  configurations: Configuration[];
  unit?: string;
  max_provider_attempts?: number;
}
export interface Plan {
  schema_version: number;
  selection: Selection;
  groups: Group[];
  totals: {
    local: number;
    model: number;
    blocked: number;
    executions: number;
    provider_attempts: number;
    model_sessions: number;
  };
  can_start: boolean;
}
function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
function read(path: string) {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}
function fileHash(path: string) {
  return existsSync(path) ? digest(readFileSync(path)) : "unavailable";
}
function questionPath(dataset: string) {
  return dataset === "garden"
    ? "evals/rag/datasets/garden/questions.json"
    : `evals/shared/datasets/${dataset === "legacy-heldout" ? "legacy" : dataset}/${dataset === "legacy-heldout" ? "heldout-questions.json" : "questions.json"}`;
}
function expectationPath(dataset: string) {
  return dataset === "garden"
    ? "evals/rag/datasets/garden/expectations.json"
    : `evals/shared/datasets/${dataset === "legacy-heldout" ? "legacy" : dataset}/${dataset === "legacy-heldout" ? "heldout-expectations.json" : "expectations.json"}`;
}
function inputs(dataset: string): Variables[] {
  return dataset === "legacy-heldout"
    ? read(questionPath(dataset)).cases.map(
        (r: { id: string; question: string }) => ({
          dataset,
          case_id: r.id,
          question: r.question,
        }),
      )
    : canonical.questions(dataset);
}
function runtime() {
  return resolve(
    process.env.COA_RAG_BINARY || join(ROOT, "target/debug/meedoen-retrieval"),
  );
}
const datasetLabels: Record<string, string> = {
  legacy: "Oorspronkelijke vragen · vijf documenten",
  "legacy-heldout": "Oorspronkelijke vergelijkingsvragen · vijf documenten",
  "independent-20261103": "Onafhankelijke vragen · vijf documenten",
  "expanded-10-20261105": "Uitgebreid aanbod · tien documenten",
  "strengthened-10-20261106": "Aangescherpte vragen · tien documenten",
  [DEMO]: "Huidig aanbod · twaalf documenten",
  [REGRESSION]: "Alle passende opties · twaalf documenten",
  garden: "Tuinregressie · vijf documenten",
};
export function catalog() {
  return {
    schema_version: 1,
    datasets: [
      DEMO,
      ...shared.filter((d) => d !== DEMO),
      "legacy-heldout",
      "garden",
    ].map((id) => ({
      id,
      label: datasetLabels[id],
      document_count: [DEMO,REGRESSION].includes(id) ? 12 : id.includes("-10-") ? 10 : 5,
      case_count: inputs(id).length,
      cases: inputs(id).map((r) => ({ id: r.case_id, question: r.question })),
      suites: suites.filter((s) => s.datasets.includes(id)).map((s) => s.id),
    })),
    suites: suites.map((s) => ({ ...s, unit:s.kind==="model"?(s.unit??"codex_sessions"):"local_executions", available: true, block_reason: null })),
  methods: [...methods, {id:"keyword_overlap",label:"Woordoverlap · tuinregressie",suites:["garden"]}],
    profiles,
    embedding_models: encoders,
    assistant_arms: arms,
    default_selection: {
      datasets: [DEMO,REGRESSION],
      suites: ["retrieval", "quality"],
      methods: [],
      profiles:
        process.env.COA_BENCHMARK_SQLITE === "0"
          ? ["documents_sections", "documents_activities"]
          : [],
      embedding_models: [],
      case_ids: [],
      assistant_arms: [],
      repeats: 1,
      model_phase: "pilot",
    },
    limits: { max_rows: 5000, max_repeats: 3 },
  };
}
function strings(
  value: unknown,
  name: string,
  allowed: string[] | null,
  fallback: string[] = [],
): string[] {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string") ||
    new Set(value).size !== value.length ||
    value.length > 300
  )
    throw Error(`Ongeldige selectie: ${name}.`);
  if (allowed && value.some((v) => !allowed.includes(v)))
    throw Error(`Onbekende keuze: ${name}.`);
  return value;
}
export function selection(input: unknown): Selection {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("Kies een benchmarkselectie.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (k) =>
        ![
          "datasets",
          "suites",
          "methods",
          "profiles",
          "embedding_models",
          "case_ids",
          "assistant_arms",
          "repeats",
          "authorization",
          "model_phase",
        ].includes(k),
    )
  )
    throw Error("Onbekende benchmarkinstelling.");
  const result: Selection = {
    datasets: strings(value.datasets, "vraagsets", Object.keys(datasetLabels), [
      DEMO,REGRESSION,
    ]),
    suites: strings(
      value.suites,
      "proeven",
      suites.map((s) => s.id),
      ["retrieval", "quality"],
    ),
    methods: strings(value.methods, "zoekmethoden", [
      ...methods.map((m) => m.id),
      "keyword_overlap",
    ]),
    profiles: strings(
      value.profiles,
      "profielen",
      profiles.map((p) => p.id),
    ),
    embedding_models: strings(
      value.embedding_models,
      "embeddingmodellen",
      encoders.map((e) => e.id),
    ),
    case_ids: strings(value.case_ids, "vragen", null),
    assistant_arms: strings(
      value.assistant_arms,
      "assistentaanpakken",
      arms.map((a) => a.id),
    ),
    repeats: value.repeats === undefined ? 1 : Number(value.repeats),
    model_phase:
      value.model_phase === undefined
        ? "pilot"
        : (value.model_phase as Selection["model_phase"]),
  };
  if (!result.datasets.length) result.datasets = Object.keys(datasetLabels);
  if (
    !result.suites.length ||
    !Number.isInteger(result.repeats) ||
    result.repeats < 1 ||
    result.repeats > 3 ||
    !["pilot", "remaining"].includes(result.model_phase)
  )
    throw Error("Kies vraagsets en proeven met één tot drie herhalingen.");
  if (
    result.case_ids.some(
      (id) =>
        !result.datasets.some((d) => inputs(d).some((r) => r.case_id === id)),
    )
  )
    throw Error("Een vraag hoort niet bij de gekozen vraagsets.");
  if (value.authorization !== undefined) {
    const a = value.authorization as Authorization;
    if (
      !a ||
      typeof a !== "object" ||
      a.confirmed !== true ||
      (a.max_sessions===undefined && a.max_attempts===undefined) ||
      (a.max_sessions!==undefined && (!Number.isInteger(a.max_sessions)||a.max_sessions<1||a.max_sessions>200)) ||
      (a.max_attempts!==undefined && (!Number.isInteger(a.max_attempts)||a.max_attempts<1||a.max_attempts>1000)) ||
      !Number.isInteger(a.max_seconds) ||
      a.max_seconds < 1 ||
      a.max_seconds > 14400
    )
      throw Error(
        "Modelgebruik vereist expliciete toestemming en positieve sessie- en tijdlimieten.",
      );
    result.authorization = {
      confirmed: true,
      max_sessions: a.max_sessions,
      max_attempts: a.max_attempts,
      max_seconds: a.max_seconds,
    };
  }
  return result;
}
function config(vars: Variables): Record<string, unknown> {
  const keys = [
    "mode",
    "model",
    "method",
    "profile",
    "top_k",
    "candidate_k",
    "context_token_limit",
    "selection",
    "apply_filters",
    "mmr",
    "rrf_k",
    "vector_weight",
    "mmr_lambda",
    "payload_mode",
    "embedding_model",
    "arm",
  ];
  const result = Object.fromEntries(
    keys.filter((k) => vars[k] !== undefined).map((k) => [k, vars[k]]),
  );
  if (!["codex", "compact-live", "assistant", "responses_rig"].includes(String(vars.mode)))
    delete result.model;
  if (vars.method === "bm25" || vars.method === "keyword_overlap")
    delete result.embedding_model;
  return result;
}
function configurationId(vars: Variables) {
  return digest(JSON.stringify(config(vars))).slice(0, 20);
}
function configLabel(c: Record<string, unknown>) {
  if (c.arm) return arms.find((a) => a.id === c.arm)?.label || String(c.arm);
  return [
    methods.find((m) => m.id === c.method)?.label || c.method,
    profiles.find((p) => p.id === c.profile)?.label,
    c.embedding_model
      ? encoders.find((e) => e.id === c.embedding_model)?.label
      : null,
    c.top_k ? `k${c.top_k}` : null,
    c.selection === "activity_expansion" ? "Activiteit uitbreiden" : null,
    c.apply_filters ? "Filters" : null,
    c.payload_mode,
    c.mode === "codex" ? c.model : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
function testsFor(s: Suite, dataset: string, sel: Selection): CanonicalCase[] {
  if (!s.datasets.includes(dataset)) return [];
  if(s.id==="assistant-rig") return inputs(dataset).flatMap(row=>(sel.methods.length?sel.methods:["dense","bm25"]).filter(method=>["dense","bm25"].includes(method)).map(method=>({vars:{...row,mode:"responses_rig",model:"gpt-6.1-sol",method,profile:"documents_sections",top_k:3},metadata:{}}))).filter(test=>!sel.case_ids.length||sel.case_ids.includes(test.vars.case_id));
  if (s.id === "assistant") {
    let rows = inputs(dataset);
    if (dataset === "legacy")
      rows = rows.filter((r) => !r.case_id.startsWith("T"));
    return rows
      .flatMap((r) =>
        (sel.assistant_arms.length
          ? sel.assistant_arms
          : arms.map((a) => a.id)
        ).map((arm) => ({
          vars: { ...r, mode: "assistant", arm, model: "gpt-6.1-sol" },
          metadata: {},
        })),
      )
      .filter(
        (t) => !sel.case_ids.length || sel.case_ids.includes(t.vars.case_id),
      );
  }
  if (s.id === "browser") {
    const browser = {
      "garden-time-location": "P01",
      "indoor-tuesday": "T02",
      "two-activities": "T05",
    };
    return Object.keys(browser)
      .flatMap((id) =>
        (sel.methods.length ? sel.methods : methods.map((m) => m.id))
          .filter((m) => m !== "keyword_overlap")
          .flatMap((method) =>
            (method === "bm25"
              ? ["minilm-multilingual"]
              : sel.embedding_models.length
                ? sel.embedding_models
                : encoders.map((e) => e.id)
            ).flatMap(
              (encoder) =>
                canonical.buildConfig({
                  COA_PROMPTFOO_SUITE: "browser",
                  COA_PROMPTFOO_EVAL_ID: id,
                  COA_PROMPTFOO_METHODS: method,
                  COA_PROMPTFOO_EMBEDDING_MODEL: encoder,
                }).tests,
            ),
          ),
      )
      .filter(
        (t) => !sel.case_ids.length || sel.case_ids.includes(t.vars.case_id),
      )
      .filter(
        (t) =>
          !sel.profiles.length || sel.profiles.includes(String(t.vars.profile)),
      );
  }
  const env: Record<string, string> = { COA_PROMPTFOO_SUITE: s.id };
  if (s.id === "models") {
    env.COA_PROMPTFOO_PHASE = "plan";
  } else {
    if (s.id !== "garden") env.COA_PROMPTFOO_DATASET = dataset;
    if (sel.methods.length) env.COA_PROMPTFOO_METHODS = sel.methods.join(",");
    if (sel.profiles.length)
      env.COA_PROMPTFOO_PROFILES = sel.profiles.join(",");
    if (sel.case_ids.length) env.COA_PROMPTFOO_CASES = sel.case_ids.join(",");
  }
  try {
    const tests = canonical.buildConfig(env).tests;
    return s.id === "models"
      ? tests.filter((t) =>
          sel.model_phase === "pilot"
            ? Number(t.vars.slot) <= 4
            : Number(t.vars.slot) > 4,
        )
      : tests;
  } catch (e) {
    if (String(e).includes("No matching existing tests")) return [];
    throw e;
  }
}
function identity(s: Suite, dataset: string, tests: CanonicalCase[]) {
  const q = read(questionPath(dataset));
  const questionFiles = [
    questionPath(dataset),
    ...(dataset === "legacy"
      ? ["evals/shared/datasets/legacy/heldout-questions.json"]
      : []),
  ];
  const criteriaFiles = [
    expectationPath(dataset),
    ...(dataset === "legacy"
      ? ["evals/shared/datasets/legacy/heldout-expectations.json"]
      : []),
  ];
  return {
    dataset,
    corpus_sha256:
      q.corpus_sha256 ||
      (dataset === "garden"
        ? read("evals/shared/datasets/legacy/questions.json").corpus_sha256
        : digest(JSON.stringify(q.sources || dataset))),
    questions_sha256: digest(
      questionFiles.map((p) => fileHash(join(ROOT, p))).join(":"),
    ),
    criteria_sha256: digest(
      criteriaFiles.map((p) => fileHash(join(ROOT, p))).join(":"),
    ),
    scorer_sha256: digest(
      (s.id === "assistant-rig"
        ? ["src/web/benchmark_rig.rs"]
        : s.id === "assistant"
        ? [
            "evals/coa-assistent/src/metrics.rs",
            "evals/coa-assistent/src/dataset.rs",
          ]
        : [
            "evals/rag/promptfoo/assertions.ts",
            "evals/rag/promptfoo/regrade_inputs.ts",
            "evals/rag/src/assessment.rs",
            "evals/rag/src/agent_assessment.rs",
            "evals/rag/src/legacy.rs",
          ]
      )
        .map((p) => fileHash(join(ROOT, p)))
        .join(":"),
    ),
    runtime_sha256: fileHash(runtime()),
    protocol: s.id,
    protocol_phase:
      s.id === "models" ? "fixed-interleaved-model-protocol" : "canonical-v1",
  };
}
export function plan(input: unknown): Plan {
  const sel = selection(input),
    groups: Group[] = [];
  for (const sid of sel.suites) {
    const s = suites.find((s) => s.id === sid)!;
    for (const dataset of sel.datasets) {
      if (!s.datasets.includes(dataset)) continue;
      const tests = testsFor(s, dataset, sel);
      if (!tests.length) continue;
      const configurations = [
        ...new Map(
          tests.map((t) => {
            const c = config(t.vars);
            return [
              configurationId(t.vars),
              {
                id: configurationId(t.vars),
                label: configLabel(c),
                configuration: c,
              },
            ] as const;
          }),
        ).values(),
      ];
      let block: string | null = null;
      if (s.kind === "model" && (!sel.authorization || (s.id==="assistant-rig" ? !sel.authorization.max_attempts : !sel.authorization.max_sessions)))
        block =
          "Modelgebruik vereist expliciete toestemming en een positieve sessie- en tijdlimiet.";
      if (
        s.id === "models" &&
        sel.authorization &&
        ((sel.authorization.max_sessions ?? 0) > 60 ||
          sel.authorization.max_seconds > 7200)
      )
        block =
          "De vaste modelproef staat maximaal zestig sessies (60) en 7200 seconden toe.";
      if (
        s.id === "models" &&
        (sel.case_ids.length ||
          sel.methods.length ||
          sel.profiles.length ||
          sel.repeats !== 1)
      )
        block =
          "De modelproef behoudt haar vaste vier-pilot/56-vervolgprotocol; geen filters of extra herhalingen.";
      if (
        s.id === "models" &&
        sel.model_phase === "remaining" &&
        (!process.env.COA_BENCHMARK_MODEL_LEDGER ||
          !process.env.COA_BENCHMARK_MODEL_APPROVAL)
      )
        block =
          "Vervolg vereist het bestaande pilotledger en onafhankelijke pilotgoedkeuring op de server.";
      const count = tests.length * (s.id === "models" ? 1 : sel.repeats);
      if(s.id==="assistant-rig" && sel.authorization?.max_attempts!==undefined && sel.authorization.max_attempts<count*5) block=`Deze selectie kan maximaal ${count*5} providerpogingen gebruiken; kies minder vragen, methoden of herhalingen of geef expliciet die limiet.`;
      if(s.id==="assistant-rig" && process.env.COA_BENCHMARK_RIG_READY!=="1") block="Stel de huidige Responses-assistent in met een eigen sleutelbestand en een expliciet goedgekeurd pogingbudget.";
      if (s.id === "assistant" && count > 40)
        block =
          "De bestaande assistentproef laat maximaal veertig generaties toe; kies minder vragen, aanpakken of herhalingen.";
      if (
        !block &&
        process.env.COA_BENCHMARK_SQLITE === "0" &&
        configurations.some((c) =>
          String(c.configuration.profile).startsWith("sqlite_"),
        )
      )
        block =
          "Bouw de evaluatiebinary met SQLite of kies bestanden als profiel.";
      if (!block && !existsSync(runtime()))
        block = "Bouw eerst de lokale evaluatiebinary.";
      if (
        !block &&
        !existsSync(join(ROOT, "node_modules/promptfoo/package.json")) &&
        !["assistant","assistant-rig"].includes(s.id)
      )
        block = "Installeer de evaluatietools met npm ci.";
      groups.push({
        id: `${sid}:${dataset}`,
        suite: sid,
        dataset,
        label: s.label,
        family: s.family,
        kind: s.kind,
        block_reason: block,
        case_count: new Set(tests.map((t) => t.vars.case_id)).size,
        configuration_count: configurations.length,
        execution_count: count,
        identity: identity(s, dataset, tests),
        configurations,
        unit:s.id==="assistant-rig"?"provider_attempts":s.kind==="model"?"codex_sessions":"local_executions",
        ...(s.id==="assistant-rig"?{max_provider_attempts:count*5}:{}),
      });
    }
  }
  if (!groups.length)
    throw Error("Deze combinatie bevat geen ondersteunde proeven.");
  const totals = groups.reduce(
    (t, g) => ({
      ...t,
      [g.kind === "local" ? "local" : "model"]:
        t[g.kind === "local" ? "local" : "model"] + g.execution_count,
      blocked: t.blocked + (g.block_reason ? g.execution_count : 0),
      executions: t.executions + g.execution_count,
      provider_attempts: t.provider_attempts + (g.suite === "assistant-rig" ? g.execution_count * 5 : 0),
      model_sessions: t.model_sessions + (g.kind === "model" && g.suite !== "assistant-rig" ? g.execution_count : 0),
    }),
    { local: 0, model: 0, blocked: 0, executions: 0, provider_attempts: 0, model_sessions: 0 },
  );
  if (totals.executions > 5000)
    throw Error(
      "De selectie bevat meer dan 5000 uitvoeringen; kies minder combinaties.",
    );
  if (sel.authorization?.max_sessions!==undefined && groups.filter(g=>g.kind==="model"&&g.suite!=="assistant-rig").reduce((n,g)=>n+g.execution_count,0) > sel.authorization.max_sessions)
    for (const g of groups.filter((g) => g.kind === "model" && g.suite!=="assistant-rig"))
      g.block_reason =
        "De modelselectie overschrijdt de toegestane sessielimiet; verklein de selectie of pas de expliciete toestemming aan.";
  if (sel.authorization?.max_attempts !== undefined && totals.provider_attempts > sel.authorization.max_attempts)
    for (const group of groups.filter(group => group.suite === "assistant-rig"))
      group.block_reason = `Deze volledige selectie kan maximaal ${totals.provider_attempts} providerpogingen gebruiken; de toestemming geldt voor alle vraagsets en herhalingen samen.`;
  if (
    groups
      .filter((g) => g.suite === "assistant")
      .reduce((n, g) => n + g.execution_count, 0) > 40
  )
    for (const g of groups.filter((g) => g.suite === "assistant"))
      g.block_reason =
        "De gedeelde assistentproef laat in totaal maximaal veertig generaties toe; kies minder vraagsets, vragen, aanpakken of herhalingen.";
  totals.blocked = groups
    .filter((g) => g.block_reason)
    .reduce((n, g) => n + g.execution_count, 0);
  return {
    schema_version: 1,
    selection: sel,
    groups,
    totals,
    can_start: groups.some((g) => !g.block_reason),
  };
}
export interface Progress {
  groups: {
    id: string;
    status: string;
    completed: number;
    error: string | null;
  }[];
  result: {
    rows: Record<string, any>[];
    sources: Record<string, unknown>;
  };
  progress: {
    completed: number;
    total: number;
  };
  error: string | null;
}
export type Executor = (
  command: string[],
  environment: NodeJS.ProcessEnv,
) => Promise<number>;
function durable(path: string, value: unknown) {
  const temporary = path + ".tmp";
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith("COA_PROMPTFOO_") ||
      [
        "OPENAI_API_KEY",
        "COA_OPENAI_API_KEY_FILE",
        "COA_RESPONSES_TEST_URL",
        "OPENAI_BASE_URL",
        "OPENAI_API_BASE",
        "ORQ_API_KEY",
        "ORQ_API_KEY_FILE",
      ].includes(key)
    )
      delete env[key];
  return env;
}
async function subprocess(
  command: string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: ROOT,
      env: environment,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
}
function addRows(
  progress: Progress,
  group: Group,
  rows: Record<string, any>[],
  sources: Record<string, unknown>,
  repeat: number,
) {
  for (const row of rows) {
    const actualRepeat=group.suite==="models"?row.trial:repeat;
    if(!Number.isInteger(actualRepeat)||actualRepeat<1||actualRepeat>3)throw Error("De modelherhaling ontbreekt of is ongeldig.");
    const vars = {
      ...row.configuration,
      dataset: row.dataset,
      case_id: row.case_id,
      question: row.question,
    } as Variables;
    const id = configurationId(vars);
    const known =
      group.configurations.find((c) => c.id === id) ||
      group.configurations.find((c) =>
        Object.entries(row.configuration || {}).every(
          ([k, v]) => c.configuration[k] === v,
        ),
      );
    if (!known)
      throw Error(
        "De uitvoering gebruikte een configuratie buiten het vastgelegde plan.",
      );
    progress.result.rows.push({
      ...row,
      group_id: group.id,
      configuration_id: known.id,
      repeat:actualRepeat,
      comparison_key: `${group.id}:${row.case_id}:${known.id}:${actualRepeat}`,
    });
  }
  Object.assign(progress.result.sources, sources);
  const state = progress.groups.find((g) => g.id === group.id)!;
  state.completed = progress.result.rows.filter(
    (r) => r.group_id === group.id,
  ).length;
  progress.progress.completed = progress.result.rows.length;
}
async function rag(
  group: Group,
  sel: Selection,
  output: string,
  progress: Progress,
  checkpoint: () => void,
  executor: Executor,
) {
  // The canonical CLI owns the exact matrix and scoring. Checkpoint each question;
  // model-comparison phases remain one indivisible frozen schedule.
  const tests = testsFor(
    suites.find((s) => s.id === group.suite)!,
    group.dataset,
    sel,
  );
  const chunks =
    group.suite === "models"
      ? [undefined]
      : [...new Set(tests.map((t) => t.vars.case_id))];
  const browser = group.suite === "browser";
  const repetitions = group.suite === "models" ? 1 : sel.repeats;
  // Keep the existing JavaScript projection rather than introducing a second scorer.
  const { project } = await import(
    new URL("../rag/scripts/export_promptfoo_results.mjs", import.meta.url).href
  );
  for (let repeat = 1; repeat <= repetitions; repeat++)
    for (const caseId of chunks) {
      const variants = browser
        ? tests.filter((t) => t.vars.case_id === caseId)
        : [undefined];
      for (const variant of variants) {
        const part = join(
          output,
          `${group.suite}-${digest(group.dataset).slice(0, 6)}-${progress.result.rows.length}-${repeat}`,
        );
        mkdirSync(part, { recursive: true, mode: 0o700 });
        const command = [
          process.execPath,
          join(ROOT, "evals/rag/scripts/run_promptfoo.mjs"),
          "--suite",
          group.suite,
          "--binary",
          runtime(),
          "--no-publish",
          "--output-dir",
          part,
        ];
        if (group.suite !== "models" && group.suite !== "garden")
          command.push("--dataset", group.dataset);
        if (group.suite !== "models" && caseId) command.push("--cases", caseId);
        if (browser) {
          command.push(
            "--eval-id",
            String(variant!.vars.browser_eval_id),
            "--methods",
            String(variant!.vars.method),
            "--embedding-model",
            String(variant!.vars.embedding_model),
          );
        } else if (group.suite !== "models") {
          if (sel.methods.length)
            command.push("--methods", sel.methods.join(","));
          if (sel.profiles.length)
            command.push("--profiles", sel.profiles.join(","));
        }
        if (group.kind === "model") {
          const auth = sel.authorization!;
          let ledger = join(output, "codex-ledger.json");
          if (group.suite === "models")
            ledger =
              sel.model_phase === "remaining"
                ? process.env.COA_BENCHMARK_MODEL_LEDGER!
                : join(output, "models-ledger.json");
          command.push(
            "--live",
            "--ledger",
            ledger,
            "--max-generations",
            String(auth.max_sessions),
            "--max-seconds",
            String(auth.max_seconds),
          );
          if (group.suite === "models") {
            command.push("--phase", sel.model_phase);
            if (sel.model_phase === "remaining")
              command.push(
                "--approval",
                process.env.COA_BENCHMARK_MODEL_APPROVAL!,
              );
          }
        }
        const code = await executor(command, childEnvironment());
        const raw = join(part, group.suite + ".json");
        if (!existsSync(raw) || ![0, 100].includes(code))
          throw Error(
            "De evaluatie kon niet worden afgerond; lokale details zijn bewaard.",
          );
        const rawResult=JSON.parse(readFileSync(raw,"utf8"));
        const view = project(rawResult);
        if(group.suite==="models")for(let index=0;index<view.evaluations[0].rows.length;index++)view.evaluations[0].rows[index].trial=rawResult.results.results[index].testCase?.vars?.trial??rawResult.results.results[index].vars?.trial;
        if (variant)
          for (const row of view.evaluations[0].rows)
            row.configuration = {
              ...row.configuration,
              embedding_model:
                variant.vars.method === "bm25"
                  ? undefined
                  : variant.vars.embedding_model,
            };
        addRows(
          progress,
          group,
          view.evaluations[0].rows,
          view.sources,
          repeat,
        );
        checkpoint();
        if (
          group.kind === "model" &&
          view.evaluations[0].rows.some(
            (r: Record<string, unknown>) => r.status === "error",
          )
        )
          throw Error(
            "De modeluitvoering is gestopt na een onzekere of mislukte uitvoering.",
          );
      }
    }
}
function assistantRows(records: Record<string, any>[], group: Group) {
  const sources: Record<string, unknown> = {};
  const key = (section: Record<string, any>) => {
    const safe = Object.fromEntries(
      ["source_id", "source_title", "source_date", "id", "heading", "text"]
        .filter((k) => typeof section[k] === "string")
        .map((k) => [k, section[k]]),
    );
    if (Object.keys(safe).length !== 6) return null;
    const id = `${safe.source_id}:${safe.id}:${digest(JSON.stringify(safe)).slice(0, 12)}`;
    sources[id] = safe;
    return id;
  };
  const labels = read(expectationPath(group.dataset));
  const rows = records.map((record) => {
    const configuration = {
      mode: "assistant",
      arm: record.arm,
      model: record.manifest?.model || "gpt-6.1-sol",
    };
    const checks = record.metrics?.hard_checks || [];
    const metric = (id: string) =>
      record.metrics?.metrics?.find(
        (m: Record<string, unknown>) => m.id === id,
      );
    const coverage = metric("offered_fact_coverage");
    const complete =
      coverage && coverage.denominator > 0
        ? coverage.numerator === coverage.denominator
        : null;
    const references = new Set(
      (record.offered_sections || []).map(
        (s: Record<string, unknown>) => `${s.source_id}:${s.id}`,
      ),
    );
    const criteria = labels.cases.find(
      (r: Record<string, unknown>) => r.case_id === record.case_id,
    );
    const goals = (criteria?.facts || [])
      .filter((f: Record<string, any>) => f.evidence_alternatives?.length)
      .map((f: Record<string, any>) => ({
        id: f.id,
        description: f.description,
        covered: f.evidence_alternatives.some(
          (alt: Record<string, unknown>[]) =>
            alt.every((ref) =>
              references.has(`${ref.source_id}:${ref.section_id}`),
            ),
        ),
        alternatives: f.evidence_alternatives.map(
          (alt: Record<string, unknown>[]) =>
            alt.map((ref) => ({
              ...ref,
              found: references.has(`${ref.source_id}:${ref.section_id}`),
            })),
        ),
      }));
    const calls = record.retrieval_steps?.length
      ? record.retrieval_steps.map(
          (step: Record<string, any>, index: number) => ({
            index: index + 1,
            query: step.query,
            hits: (step.hits || [])
              .map((h: Record<string, any>) => key(h.section || h))
              .filter(Boolean),
            status: "completed",
          }),
        )
      : [
          {
            index: 1,
            query: record.question,
            hits: (record.offered_sections || []).map(key).filter(Boolean),
            status: record.execution_status,
          },
        ];
    return {
      id: record.run_id,
      native_run_id: record.run_id,
      dataset: group.dataset,
      case_id: record.case_id,
      question: record.question,
      suite: "assistant",
      provider: "Codex · " + String(record.arm),
      configuration,
      status:
        record.execution_status !== "completed"
          ? "error"
          : record.metrics?.hard_checks_passed === true
            ? "passed"
            : "failed",
      reason:
        record.execution_status === "completed"
          ? "Inhoudelijke antwoordkwaliteit is nog niet beoordeeld."
          : "De assistentuitvoering kon niet worden afgerond.",
      assertions: checks.map((c: Record<string, any>) => ({
        pass: c.passed === true,
        score: c.passed ? 1 : 0,
        reason: String(c.id),
      })),
      source_complete: complete,
      goals,
      metrics: {
        target_goals: goals.length,
        covered_goals: goals.filter((g: Record<string, unknown>) => g.covered)
          .length,
        source_quality_applicable: complete !== null,
        search_calls: metric("search_calls")?.value ?? null,
        input_tokens: record.usage?.input_tokens ?? null,
        output_tokens: record.usage?.output_tokens ?? null,
      },
      answer: record.answer?.text ?? null,
      calls,
      retrieval_ms: null,
      promptfoo_ms: null,
      native_elapsed_ms: record.elapsed_ms ?? null,
      answer_quality: "not_assessed",
    };
  });
  return { rows, sources };
}
async function assistant(
  group: Group,
  sel: Selection,
  output: string,
  progress: Progress,
  checkpoint: () => void,
  executor: Executor,
) {
  const tests = testsFor(
      suites.find((s) => s.id === "assistant")!,
      group.dataset,
      sel,
    ),
    caseIds = [...new Set(tests.map((t) => t.vars.case_id))],
    selectedArms = sel.assistant_arms.length
      ? sel.assistant_arms
      : arms.map((a) => a.id);
  for (let repeat = 1; repeat <= sel.repeats; repeat++) {
    const path = join(
      output,
      `assistant-${digest(group.dataset).slice(0, 8)}-${repeat}.jsonl`,
    );
    const auth = sel.authorization!;
    const command = [
      runtime(),
      "experiment",
      "run",
      "--live",
      "--questions",
      join(ROOT, questionPath(group.dataset)),
      "--expectations",
      join(ROOT, expectationPath(group.dataset)),
      "--cases",
      caseIds.join(","),
      "--arms",
      selectedArms.join(","),
      "--output",
      path,
      "--ledger",
      join(output, "assistant-ledger.json"),
      "--max-cases",
      String(caseIds.length),
      "--max-generations",
      String(Math.min(auth.max_sessions!, 40)),
      "--max-judgements",
      "0",
      "--max-seconds",
      String(auth.max_seconds),
    ];
    const code = await executor(command, childEnvironment());
    if (!existsSync(path))
      throw Error("De assistentproef stopte zonder leesbare uitvoer.");
    const records = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const view = assistantRows(records, group);
    addRows(progress, group, view.rows, view.sources, repeat);
    checkpoint();
    if (code !== 0 || view.rows.some((r) => r.status === "error"))
      throw Error(
        "De assistentproef is gestopt; bewaarde resultaten blijven beschikbaar.",
      );
  }
}
export async function execute(
  input: unknown,
  output: string,
  expected?: Plan,
  executor: Executor = subprocess,
): Promise<Progress> {
  const current = plan(input);
  if (expected) {
    const identities = (p: Plan) =>
      p.groups.map((g) => ({
        id: g.id,
        identity: g.identity,
        configurations: g.configurations,
        execution_count: g.execution_count,
      }));
    if (
      !isDeepStrictEqual(identities(current), identities(expected))
    )
      throw Error(
        "De bron-, criteria- of runtime-identiteit is gewijzigd; maak een nieuw plan.",
      );
  }
  if (!current.can_start)
    throw Error("Geen uitvoerbare proeven in deze selectie.");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const statePath = join(output, "progress.json");
  if (existsSync(statePath))
    throw Error("Een bestaande uitvoering wordt niet overschreven.");
  const progress: Progress = {
    groups: current.groups.map((g) => ({
      id: g.id,
      status: g.block_reason ? "not_run" : "queued",
      completed: 0,
      error: g.block_reason,
    })),
    result: { rows: [], sources: {} },
    progress: { completed: 0, total: current.totals.executions },
    error: null,
  };
  const checkpoint = () => durable(statePath, progress);
  checkpoint();
  let modelsStopped = false;
  for (const group of current.groups) {
    const state = progress.groups.find((g) => g.id === group.id)!;
    if (group.block_reason) continue;
    // The web worker executes this group inline with the exact current Runner,
    // its existing attempt ledger and cancellation future. Node never creates a
    // second provider client or imports protected criteria into generation.
    if(group.suite==="assistant-rig") continue;
    if (group.kind === "model" && modelsStopped) {
      state.status = "not_run";
      state.error = "Niet uitgevoerd na een eerdere onzekere modeluitvoering.";
      checkpoint();
      continue;
    }
    state.status = "running";
    checkpoint();
    try {
      if (group.suite === "assistant")
        await assistant(
          group,
          current.selection,
          output,
          progress,
          checkpoint,
          executor,
        );
      else
        await rag(
          group,
          current.selection,
          output,
          progress,
          checkpoint,
          executor,
        );
      state.status = "completed";
    } catch {
      state.status = "failed";
      state.error =
        "Deze proef kon niet worden afgerond; lokale details en afgeronde resultaten zijn bewaard.";
      progress.error ??= state.error;
      if (group.kind === "model") modelsStopped = true;
    }
    checkpoint();
  }
  return progress;
}
async function main() {
  const command = process.argv[2];
  if (command === "catalog") process.stdout.write(JSON.stringify(catalog()));
  else if (command === "plan")
    process.stdout.write(
      JSON.stringify(plan(JSON.parse(readFileSync(process.argv[3], "utf8")))),
    );
  else if (command === "execute") {
    const input = JSON.parse(readFileSync(process.argv[3], "utf8"));
    await execute(
      input.selection ?? input,
      resolve(process.argv[4]),
      input.plan,
    );
  } else throw Error("Onbekende benchmarkopdracht.");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    process.stderr.write(
      error instanceof Error ? error.message : "Benchmark mislukt.",
    );
    process.exitCode = 1;
  });
