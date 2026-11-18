use meedoen_retrieval::{
    corpus::CorpusId,
    retrieval_lab::{agent_run, catalog, dataset, reference::ExpectationsContext},
};
use std::process::Command;

#[test]
fn current_dataset_and_quality_plan_bind_seventeen_questions_to_twelve_sources() {
    let selected = dataset::load(dataset::DEMO_ID).unwrap();
    assert_eq!(selected.corpus(), CorpusId::DemoTwelve);
    assert_eq!(selected.catalog.cases.len(), 17);
    assert_eq!(selected.corpus().sources().unwrap().len(), 12);
    let quality = catalog::quality_plan(&selected).unwrap();
    assert_eq!(quality.planned_rows, 17 * 24);
    assert!(
        quality
            .configurations
            .iter()
            .all(|row| !row.config.retrieval.apply_filters)
    );
    let agentic = agent_run::plan_for_dataset(
        Some(dataset::DEMO_ID),
        &[],
        &catalog::METHODS,
        "gpt-6.1-sol",
    )
    .unwrap();
    assert_eq!(agentic.case_count, 17);
    assert_eq!(agentic.planned_sessions, 68);
    assert!(
        agentic
            .runs
            .iter()
            .all(|row| row.dataset.corpus_sha256 == CorpusId::DemoTwelve.sha256())
    );
    assert_eq!(
        dataset::load("legacy").unwrap().corpus(),
        CorpusId::BaselineFive
    );
    assert_eq!(
        dataset::load(dataset::STRENGTHENED_ID).unwrap().corpus(),
        CorpusId::ExpandedTen
    );
}

#[test]
fn new_source_expectations_accept_both_indoor_options_and_reject_old_trace_identity() {
    let context = ExpectationsContext::load(dataset::DEMO_ID).unwrap();
    assert_eq!(context.criteria.len(), 17);
    let alternatives = &context.criteria["T02"].facts[0].evidence_alternatives;
    assert_eq!(alternatives.len(), 2);
    for option in alternatives {
        assert_eq!(option.len(), 2);
        assert_eq!(option[0].source_id, option[1].source_id);
    }
    assert!(!context.criteria["DEMO12-14"].required_unknowns.is_empty());
    let historical = serde_json::from_str(include_str!(
        "../evals/rag/fixtures/regressions/t02-dense-search.json"
    ))
    .unwrap();
    assert!(context.validate_record(&historical).is_err());
}

#[test]
fn repeated_word_search_uses_all_twelve_documents_without_an_encoder_or_model() {
    let directory = std::env::temp_dir().join(format!(
        "coa-demo12-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let mut outcomes = Vec::new();
    for number in 0..2 {
        let output = directory.join(format!("run-{number}.jsonl"));
        let result = Command::new(env!("CARGO_BIN_EXE_meedoen-retrieval"))
            .args([
                "lab",
                "run",
                "--dataset",
                dataset::DEMO_ID,
                "--cases",
                "DEMO12-11,DEMO12-12",
                "--methods",
                "bm25",
                "--profiles",
                "documents_sections",
                "--top-k",
                "5",
                "--output",
            ])
            .arg(&output)
            .args(["--model-cache"])
            .arg(directory.join("absent-encoder"))
            .env("COA_CODEX_BIN", "/missing/runtime-must-not-run")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let rows: Vec<serde_json::Value> = std::fs::read_to_string(&output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(rows.len(), 2);
        for row in &rows {
            assert_eq!(
                row["dataset"]["corpus_sha256"],
                CorpusId::DemoTwelve.sha256()
            );
            assert_eq!(row["execution_status"], "completed");
            assert!(row["outcome"]["corpus_identity"]["embedding"].is_null());
            assert_eq!(row["outcome"]["work"]["lexical_sections_scored"], 72);
        }
        outcomes.push(
            rows.iter()
                .map(|row| row["outcome"].clone())
                .collect::<Vec<_>>(),
        );
    }
    assert_eq!(outcomes[0], outcomes[1]);
    assert!(!directory.join("absent-encoder").exists());
    std::fs::remove_dir_all(directory).unwrap();
}
