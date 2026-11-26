//! Opt-in, source-only paired context selection experiment. No answer model is used.
use super::{
    dataset::DatasetIdentity,
    embedding_models::ModelChoice,
    preparation::{PreparationOptions, PreparationSession},
    types::{ExecutionKind, ExecutionStatus, RetrievalRecord, RunConfig},
};
use crate::{
    retrieval::{RetrievalConfig, RetrievalRequest, SearchMethod, SelectionMode},
    storage::StorageProfile,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{File, OpenOptions},
    io::Write,
    path::{Component, Path},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    schema_version: u32,
    execution_id: String,
    reference_date: String,
    corpora: BTreeMap<String, CorpusInput>,
    cases: Vec<CaseInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CorpusInput {
    corpus_sha256: String,
    documents: Vec<DocumentInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentInput {
    path: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CaseInput {
    id: String,
    question: String,
    corpus_id: String,
}

#[derive(Serialize)]
struct Envelope {
    policy_id: &'static str,
    input_sha256: String,
    record: RetrievalRecord,
}

fn read_documents(root: &Path, corpus: &CorpusInput) -> Result<Vec<String>, String> {
    if corpus.documents.len() != 12 {
        return Err("Context selection requires twelve source documents per corpus".into());
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut documents = Vec::new();
    let mut paths = BTreeSet::new();
    for document in &corpus.documents {
        let relative = Path::new(&document.path);
        if relative.extension().and_then(|value| value.to_str()) != Some("md")
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
            || !paths.insert(relative)
        {
            return Err("Source paths must be distinct relative Markdown files".into());
        }
        let path = root
            .join(relative)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !path.starts_with(&root) {
            return Err("Source path escapes the selected source root".into());
        }
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        if crate::manifest::hash(&bytes) != document.sha256 {
            return Err("Source document differs from its pinned hash".into());
        }
        documents.push(String::from_utf8(bytes).map_err(|error| error.to_string())?);
    }
    if crate::manifest::hash(documents.join("\n---document---\n").as_bytes())
        != corpus.corpus_sha256
    {
        return Err("Source corpus differs from its pinned hash".into());
    }
    let texts: Vec<_> = documents.iter().map(String::as_str).collect();
    let parsed = crate::source::parse_sources(&texts)?;
    if parsed.len() != 12 || parsed.iter().any(|source| source.sections.len() != 6) {
        return Err("Context selection requires twelve canonical six-section activities".into());
    }
    Ok(documents)
}

pub(crate) fn run(
    input_path: &Path,
    output: &Path,
    model_cache: &Path,
    source_root: &Path,
) -> Result<serde_json::Value, String> {
    let started = Instant::now();
    let bytes = std::fs::read(input_path).map_err(|error| error.to_string())?;
    let input: Input = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid source-only context-selection input: {error}"))?;
    let input_sha256 = crate::manifest::hash(&bytes);
    let mut ids = BTreeSet::new();
    if input.schema_version != 1
        || input.cases.len() != 20
        || input.corpora.is_empty()
        || input.corpora.len() > 9
        || input.execution_id.is_empty()
        || input.execution_id.len() > 128
        || !input
            .execution_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        || input.cases.iter().any(|case| {
            case.id.is_empty()
                || !ids.insert(&case.id)
                || !input.corpora.contains_key(&case.corpus_id)
        })
    {
        return Err(
            "Context selection requires twenty distinct cases bound to source-only corpora".into(),
        );
    }
    crate::source::validate_date(&input.reference_date)?;
    for case in &input.cases {
        if crate::validate_query(&case.question)? != case.question {
            return Err("Experiment questions must preserve their exact validated input".into());
        }
    }
    let documents: BTreeMap<_, _> = input
        .corpora
        .iter()
        .map(|(id, corpus)| read_documents(source_root, corpus).map(|documents| (id, documents)))
        .collect::<Result<_, _>>()?;
    if !ModelChoice::MiniLm.cached(model_cache) {
        return Err(
            "Context selection requires the existing local MiniLM cache; downloads are not enabled"
                .into(),
        );
    }
    let mut output_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|error| error.to_string())?;
    output_file.sync_all().map_err(|error| error.to_string())?;
    let parent = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    File::open(parent)
        .and_then(|parent| parent.sync_all())
        .map_err(|error| error.to_string())?;
    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?;
    let batch_id = format!(
        "{}-native-{}-{}",
        input.execution_id,
        std::process::id(),
        created.as_nanos()
    );
    let mut completed = 0;
    let mut failed = 0;
    let mut encoder = None;
    let active = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    for (corpus_id, documents) in documents {
        let mut session = PreparationSession::for_documents(
            &PreparationOptions {
                model_cache: model_cache.into(),
                sqlite_dir: std::env::temp_dir().join("coa-context-selection-unused-sqlite"),
                embedding_model: ModelChoice::MiniLm,
            },
            &documents,
        )?;
        encoder = Some(session.embedding_identity()?);
        let preparation_id = format!("{batch_id}-{corpus_id}");
        let mut prepared =
            session.prepare(StorageProfile::DocumentsSections, true, &preparation_id)?;
        for case in input
            .cases
            .iter()
            .filter(|case| &case.corpus_id == corpus_id)
        {
            let request = RetrievalRequest {
                query: case.question.clone(),
                filters: Default::default(),
            };
            let mut pending = Vec::new();
            for (policy_id, selection, top_k) in [
                ("baseline", SelectionMode::ActivityExpansion, 3),
                ("activity_balanced", SelectionMode::ActivityBalanced, 6),
            ] {
                let config = RunConfig {
                    profile: StorageProfile::DocumentsSections,
                    retrieval: RetrievalConfig {
                        method: SearchMethod::HybridWeighted,
                        selection,
                        top_k,
                        ..Default::default()
                    },
                };
                let query = session.query(&mut prepared, &request, &config);
                pending.push((policy_id, config, query));
            }
            let mut shared = session.shared(&format!("{preparation_id}-after-{}", case.id));
            shared.interpretation.push_str(" This cumulative snapshot is captured after query-vector preparation for this pair. Its identity is pair-specific; document work can overlap earlier snapshots and must not be summed.");
            let attempts = std::thread::scope(|scope| {
                let handles: Vec<_> = pending
                    .into_iter()
                    .map(|(policy, config, query)| {
                        let corpus = &prepared.corpus;
                        let active = &active;
                        let peak = &peak;
                        scope.spawn(move || {
                            let attempt = match query {
                                Ok(query) => query.finish_with(|request, vector| {
                                    let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                                    peak.fetch_max(count, Ordering::SeqCst);
                                    let result = crate::retrieval::retrieve(
                                        corpus,
                                        request,
                                        &config.retrieval,
                                        vector,
                                    );
                                    active.fetch_sub(1, Ordering::SeqCst);
                                    result
                                }),
                                Err(attempt) => *attempt,
                            };
                            (policy, config, attempt)
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|handle| {
                        handle
                            .join()
                            .map_err(|_| "Context selection worker panicked".to_owned())
                    })
                    .collect::<Result<Vec<_>, _>>()
            })?;
            for (policy_id, config, attempt) in attempts {
                let mut record = RetrievalRecord {
                    schema_version: 1,
                    batch_id: batch_id.clone(),
                    run_id: format!("{batch_id}--{}--{policy_id}", case.id),
                    created_at_unix_ms: created.as_millis() as u64,
                    case_id: case.id.clone(),
                    family: "context-selection".into(),
                    split: "frozen-development-and-controls".into(),
                    kind: "source-only-retrieval".into(),
                    question: case.question.clone(),
                    config_id: super::catalog::config_id(&config)?,
                    config,
                    request_filters: Default::default(),
                    query_inputs_sha256: None,
                    execution_kind: ExecutionKind::LocalMeasured,
                    execution_status: ExecutionStatus::Failed,
                    dataset: DatasetIdentity {
                        questions_sha256: input_sha256.clone(),
                        corpus_sha256: input.corpora[corpus_id].corpus_sha256.clone(),
                        as_of: input.reference_date.clone(),
                        dataset_versions: vec!["context-selection-controls-20261123".into()],
                        limitation: "Known regression questions and independently AI-reviewed frozen source controls; source coverage only, not answer quality or human validation".into(),
                    },
                    preparation: prepared.record.clone(),
                    shared_preparation: Some(shared.clone()),
                    outcome: None,
                    timings: attempt.timings,
                    error: None,
                };
                match attempt.outcome {
                    Ok(outcome) => {
                        record.outcome = Some(outcome);
                        record.execution_status = ExecutionStatus::Completed;
                        completed += 1;
                    }
                    Err(error) => {
                        record.error = Some(error);
                        failed += 1;
                    }
                }
                super::records::validate_record(&record)?;
                serde_json::to_writer(
                    &mut output_file,
                    &Envelope {
                        policy_id,
                        input_sha256: input_sha256.clone(),
                        record,
                    },
                )
                .map_err(|error| error.to_string())?;
                output_file
                    .write_all(b"\n")
                    .and_then(|_| output_file.sync_data())
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(
        serde_json::json!({"schema_version":1,"input_sha256":input_sha256,"batch_id":batch_id,"planned_rows":40,"completed":completed,"failed":failed,"embedding_identity":encoder,"document_embedding_chunk_size":super::preparation::DOCUMENT_EMBEDDING_CHUNK_SIZE,"max_concurrent_searches":2,"observed_peak_rankings":peak.load(Ordering::SeqCst),"native_batch_elapsed_ms":started.elapsed().as_secs_f64()*1000.0,"codex_calls":0,"ai_judge_calls":0}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_only_schema_rejects_gold_inside_cases_and_corpora() {
        let base = serde_json::json!({"schema_version":1,"execution_id":"unit","reference_date":"2026-11-13","corpora":{"current":{"corpus_sha256":"test","documents":[]}},"cases":[{"id":"case","question":"Welke activiteit?","corpus_id":"current"}]});
        assert!(serde_json::from_value::<Input>(base.clone()).is_ok());
        for (pointer, value) in [
            (
                "/cases/0",
                serde_json::json!({"id":"case","question":"Welke activiteit?","corpus_id":"current","required_sources":["A:S1"]}),
            ),
            (
                "/corpora/current",
                serde_json::json!({"corpus_sha256":"test","documents":[],"expected_source_plans":[]}),
            ),
        ] {
            let mut changed = base.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(serde_json::from_value::<Input>(changed).is_err());
        }
    }

    #[test]
    fn pinned_documents_reject_changed_bytes_and_unsafe_paths_before_embedding() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../shared/datasets/context-selection-controls-20261123/manifest.json"
        ))
        .unwrap();
        let selected = manifest["corpora"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap();
        let mut corpus = CorpusInput {
            corpus_sha256: selected["corpus_sha256"].as_str().unwrap().into(),
            documents: selected["documents"]
                .as_array()
                .unwrap()
                .iter()
                .map(|document| DocumentInput {
                    path: document["path"].as_str().unwrap().into(),
                    sha256: document["sha256"].as_str().unwrap().into(),
                })
                .collect(),
        };
        assert_eq!(
            read_documents(Path::new(env!("CARGO_MANIFEST_DIR")), &corpus)
                .unwrap()
                .len(),
            12
        );
        corpus.documents[0].sha256 = "0".repeat(64);
        assert!(
            read_documents(Path::new(env!("CARGO_MANIFEST_DIR")), &corpus)
                .unwrap_err()
                .contains("pinned hash")
        );
        corpus.documents[0].path = "../secret.md".into();
        assert!(
            read_documents(Path::new(env!("CARGO_MANIFEST_DIR")), &corpus)
                .unwrap_err()
                .contains("relative Markdown")
        );
    }
}
