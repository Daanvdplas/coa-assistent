/** Build synthetic browser fixtures without model calls or measured quality claims.
 * node evals/rag/tests/report_ui_fixture.ts /tmp/coa-report-ui
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const unsafe = "</script><script>window.reportInjected=true</script>&\u2028";
const section = {
  source_id: "ACT-TUIN-001",
  id: "S2",
  source_title: "Tuinieren",
  heading: "Wanneer",
  source_date: "2026-10-20",
  text: "Dinsdag 10–12. " + unsafe,
};
interface Options {
  dataset?: string;
  scenario?: "baseline" | "activity_expansion" | "filtered_expansion";
  top_k?: number;
  minimum?: number;
  action?: string;
  minimum_activities?: number | null;
}
function row(
  case_id: string,
  covered: number,
  target: number,
  {
    dataset = "legacy",
    scenario = "baseline",
    top_k = 3,
    minimum = 2,
    action = "answer_with_sources",
    minimum_activities = null,
  }: Options = {},
) {
  const config = {
    method: "dense",
    top_k,
    candidate_k: 30,
    context_token_limit: 1200,
    selection: scenario === "baseline" ? "sections" : "activity_expansion",
    apply_filters: scenario === "filtered_expansion",
    mmr: null,
  };
  const facts = Array.from({ length: target }, (_, i) => ({
    criterion: {
      id: `F${i}`,
      description: `Verwacht bewijsdoel ${i}`,
      evidence_alternatives: [
        [{ source_id: "ACT-TUIN-001", section_id: `S${i + 2}` }],
      ],
    },
    covered: i < covered ? true : (false as boolean | null),
    missing_by_alternative:
      i < covered
        ? []
        : [[{ source_id: "ACT-TUIN-001", section_id: `S${i + 2}` }]],
  }));
  const hits = [
    "S1",
    ...Array.from({ length: covered }, (_, i) => `S${i + 2}`),
  ].map((id) => ({
    section: { ...section, id },
    inclusion: "search",
    scores: null,
  }));
  return {
    record: {
      run_id: `${dataset}-${case_id}-${scenario}`,
      case_id,
      question:
        (target ? "Waar en wanneer tuinieren? " : "Zijn er plaatsen? ") +
        unsafe,
      kind: target ? "multiple_facts" : "missing_information",
      execution_status: "completed",
      execution_kind: "fixture",
      config_id: `dense_documents_sections_${scenario}`,
      config: { profile: "documents_sections", retrieval: config },
      error: null as string | null,
      outcome: { hits, estimated_context_tokens: 40, filters: null } as {
        hits: typeof hits;
        estimated_context_tokens: number;
        filters: null;
      } | null,
      preparation: {
        model_load_ms: null,
        document_embedding_ms: null,
        storage_sync_ms: null,
        storage_load_ms: null,
        preparation_id: null,
        document_cache_hits: 0,
        document_cache_misses: 0,
        actual_profile: "documents_sections" as string | null,
      },
      timings: {
        query_embedding_ms: null,
        query_embedding_cache_hit: null,
        retrieval_ms: null,
      },
      dataset: { corpus_sha256: "source-sha" },
      request_filters: null,
    },
    record_sha256: String(case_id.length).repeat(64),
    assessments: [
      {
        kind: "deterministic",
        deterministic: {
          expected_facts: facts,
          required_unknowns: target ? [] : ["Actuele plaatsen zijn onbekend"],
          conditions: [],
          hard_checks: [
            {
              id: "canonical_evidence",
              passed: true,
              detail: "Brontekst intact",
            },
          ],
          metrics: [],
        },
      },
    ],
    task_metrics: {
      complete_goal_set: target ? covered === target : null,
      covered_goals: target ? covered : null,
      target_goals: target,
      partial_goal_coverage: target ? covered / target : null,
      first_goal_support_reciprocal_rank: target ? 0.5 : null,
      minimum_required_sections: minimum,
      section_capacity_limit: scenario === "baseline" ? top_k : null,
      minimum_required_activities: minimum_activities,
      seed_activity_capacity_limit: scenario !== "baseline" ? top_k : null,
      goal_set_exceeds_capacity:
        scenario === "baseline"
          ? minimum > top_k
          : minimum_activities !== null
            ? minimum_activities > top_k
            : null,
      unknown_obligations: target ? 0 : 1,
      answer_review: "not_generated",
      not_applicable_reason: target ? null : "No labelled source target",
    },
    dataset_info: {
      id: dataset,
      provenance:
        dataset === "legacy"
          ? "previously_seen_regression"
          : "agent_authored_and_independently_agent_reviewed_not_human",
      limitation:
        dataset === "legacy"
          ? "Existing development/regression cases; previously seen comparison questions are not a new held-out benchmark"
          : "Prospectively frozen AI-authored and AI-reviewed questions on the same five known documents; not human calibration or unseen-corpus/intent generalization",
      freeze_sha256: dataset !== "legacy" ? "frozen-sha" : null,
    },
    scenario: {
      id: scenario,
      label: {
        baseline: "Basis · 3 passages",
        activity_expansion: "Hele activiteit",
        filtered_expansion: "Hele activiteit + vraagfilters",
      }[scenario],
      filter_effect:
        scenario === "filtered_expansion" ? "no_filters_requested" : "disabled",
      query_inputs_sha256: null,
    },
    reference_metadata: {
      expected_action: action,
      fact_roles: target ? { F0: "unknown" } : {},
      origin: "Agentreferentie, apart gecontroleerd",
    },
  };
}
export function buildReportFixture(output: string): void {
  mkdirSync(output, { recursive: true });
  const rows = [
    row("T01", 2, 2),
    row("T02", 0, 2),
    row("T05", 1, 4, { minimum: 4 }),
    row("P05", 0, 0, { minimum: 0, action: "state_unknown" }),
    row("NO_MATCH", 0, 2, { action: "no_match_in_known_corpus" }),
    row("CLARIFY", 0, 0, { minimum: 0, action: "ask_which_activity" }),
    row("N01", 2, 2, { dataset: "independent-20261103" }),
    row("N01", 2, 2, {
      dataset: "independent-20261103",
      scenario: "activity_expansion",
    }),
    row("N01", 2, 2, {
      dataset: "independent-20261103",
      scenario: "filtered_expansion",
    }),
    row("N02", 1, 5, {
      dataset: "independent-20261103",
      scenario: "activity_expansion",
      minimum: 5,
      minimum_activities: 5,
    }),
  ];
  for (const [id, status] of [
    ["STATUS_UNSUPPORTED", "unsupported"],
    ["STATUS_FAILED", "failed"],
    ["STATUS_ZERO", "completed"],
  ]) {
    const example = row(id, 0, 2, { dataset: "qa-status" });
    example.record.config.profile = "sqlite_sections";
    example.record.config_id = "dense_sqlite_sections_baseline";
    example.record.preparation.actual_profile =
      status === "completed" ? "sqlite_sections" : null;
    example.record.execution_status = status;
    example.record.question = "Stored English question must stay unchanged";
    example.dataset_info.provenance = "unknown_external_reference";
    example.dataset_info.limitation =
      "Unknown external limitation must stay in technical metadata";
    if (status !== "completed") {
      example.record.outcome = null;
      example.record.error =
        status === "unsupported"
          ? "QA unsupported build"
          : "QA execution failed";
      example.task_metrics.complete_goal_set = null;
      example.task_metrics.covered_goals = null;
      example.task_metrics.partial_goal_coverage = null;
      example.task_metrics.first_goal_support_reciprocal_rank = null;
      for (const fact of example.assessments[0].deterministic.expected_facts)
        fact.covered = null;
    }
    rows.push(example);
  }
  const data = {
    schema_version: 1,
    artifact_id: "qa-report-ui-only-v1",
    assessor_version: "retrieval-deterministic-v2",
    record_hash_policy: "exact-jsonl-bytes-v1",
    task_metrics_version: "retrieval-task-metrics-v1",
    shared_preparations: [],
    rows,
  };
  const html = readFileSync(join(ROOT, "evals/rag/src/report.html"), "utf8")
    .replace("__REPORT_STYLE__", () =>
      readFileSync(join(ROOT, "evals/rag/src/report.css"), "utf8"),
    )
    .replace("__REPORT_SCRIPT__", () =>
      readFileSync(join(ROOT, "evals/rag/src/report.js"), "utf8"),
    );
  const serialize = (value: unknown) =>
    JSON.stringify(value).replace(
      /[&<>\u2028\u2029]/g,
      (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
    );
  writeFileSync(
    join(output, "fixture.html"),
    html.replace("__REPORT_DATA__", () => serialize(data)),
  );
  writeFileSync(
    join(output, "empty.html"),
    html.replace("__REPORT_DATA__", () => serialize({ ...data, rows: [] })),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv[2])
    throw new Error("Usage: report_ui_fixture.ts OUTPUT_DIRECTORY");
  buildReportFixture(resolve(process.argv[2]));
  console.log(resolve(process.argv[2]));
}
