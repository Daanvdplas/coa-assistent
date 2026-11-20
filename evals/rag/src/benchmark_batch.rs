//! One question execution: shared preparation, individually measured searches.
use super::{
    dataset,
    embedding_models::ModelChoice,
    preparation::{PreparationOptions, PreparationSession, PreparedSearch, SearchAttempt},
    types::{
        ExecutionKind, ExecutionStatus, RetrievalRecord, RetrievalTimings, RunConfig,
        SharedPreparation,
    },
};
use crate::{
    retrieval::{
        PreparedCorpus, RetrievalConfig, RetrievalOutcome, RetrievalRequest, SearchMethod,
    },
    storage::StorageProfile,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};

/// Operator-only bound for benchmark searches; never changes retrieval settings.
pub fn search_worker_limit() -> Result<usize, String> {
    match std::env::var("COA_BENCHMARK_SEARCH_WORKERS") {
        Err(std::env::VarError::NotPresent) => Ok(2),
        Ok(value) => match value.as_str() {
            "1" => Ok(1),
            "2" => Ok(2),
            "4" => Ok(4),
            _ => Err("COA_BENCHMARK_SEARCH_WORKERS must be 1, 2 or 4".into()),
        },
        Err(_) => Err("COA_BENCHMARK_SEARCH_WORKERS must be 1, 2 or 4".into()),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BatchInput {
    schema_version: u32,
    execution_id: String,
    dataset: String,
    case_id: String,
    requests: Vec<BatchRequest>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchRequest {
    request_id: String,
    embedding_model: Option<String>,
    config: RunConfig,
}

#[derive(Serialize)]
struct Envelope {
    request_id: String,
    record: RetrievalRecord,
}

pub(crate) struct BatchOptions {
    pub output: PathBuf,
    pub embedding_manifest: PathBuf,
    pub model_cache: PathBuf,
    pub sqlite_dir: PathBuf,
}

struct ProfileState {
    profile: StorageProfile,
    prepared: Result<PreparedSearch, String>,
    corpus: Option<Arc<PreparedCorpus>>,
}

struct ModelState {
    session: PreparationSession,
    profiles: Vec<ProfileState>,
    shared: SharedPreparation,
}

fn model_key(request: &BatchRequest) -> &str {
    request.embedding_model.as_deref().unwrap_or("bm25")
}

fn write_envelope(output: &Mutex<File>, envelope: &Envelope) -> Result<(), String> {
    super::records::validate_record(&envelope.record)?;
    let mut file = output.lock().map_err(|_| "Batch output lock failed")?;
    serde_json::to_writer(&mut *file, envelope).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.sync_data().map_err(|error| error.to_string())
}

pub(crate) fn run(input: BatchInput, options: &BatchOptions) -> Result<serde_json::Value, String> {
    run_with_search(input, options, &crate::retrieval::retrieve)
}

fn run_with_search(
    input: BatchInput,
    options: &BatchOptions,
    search: &(
         impl Fn(
        &PreparedCorpus,
        &RetrievalRequest,
        &RetrievalConfig,
        Option<&[f32]>,
    ) -> Result<RetrievalOutcome, String>
         + Sync
     ),
) -> Result<serde_json::Value, String> {
    let batch_started = Instant::now();
    let search_limit = search_worker_limit()?;
    if input.schema_version != 1
        || input.requests.is_empty()
        || input.requests.len() > 64
        || input.execution_id.is_empty()
        || input.execution_id.len() > 128
        || !input
            .execution_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        || ![dataset::DEMO_ID, dataset::REGRESSION_ID].contains(&input.dataset.as_str())
    {
        return Err("Invalid single-question benchmark batch".into());
    }
    let dataset = dataset::load(&input.dataset)?;
    let case = dataset
        .catalog
        .cases
        .iter()
        .find(|case| case.id == input.case_id)
        .ok_or("Unknown benchmark batch question")?;
    let filters = dataset
        .query_inputs
        .get(&case.id)
        .cloned()
        .unwrap_or_default();
    let mut ids = BTreeSet::new();
    for request in &input.requests {
        if request.request_id.len() != 64
            || !request
                .request_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !ids.insert(&request.request_id)
            || !request.config.profile.supported()
        {
            return Err("Invalid, duplicate or unsupported benchmark request".into());
        }
        crate::retrieval::validate_config(&request.config.retrieval, &filters)?;
        match (
            request.config.retrieval.method,
            request.embedding_model.as_deref(),
        ) {
            (SearchMethod::Bm25, None) => {}
            (SearchMethod::Bm25, Some(_)) | (_, None) => {
                return Err("Benchmark encoder differs from search method".into());
            }
            (_, Some(model)) => {
                model.parse::<ModelChoice>()?;
            }
        }
    }
    if options.output.exists() || options.embedding_manifest.exists() || options.sqlite_dir.exists()
    {
        return Err("Choose new benchmark output, manifest and storage paths".into());
    }
    let output = Arc::new(Mutex::new(
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&options.output)
            .map_err(|error| error.to_string())?,
    ));
    if let Some(parent) = options.output.parent() {
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
    }
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let batch_id = format!(
        "{}-native-{}-{}",
        input.execution_id,
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let mut states = BTreeMap::<String, Result<ModelState, String>>::new();
    let mut models = BTreeMap::new();
    let mut prepared_profiles = 0;
    for request in &input.requests {
        let key = model_key(request);
        if states.contains_key(key) {
            continue;
        }
        let state = (|| {
            let choice = request
                .embedding_model
                .as_deref()
                .map(str::parse::<ModelChoice>)
                .transpose()?
                .unwrap_or_default();
            let mut session = PreparationSession::for_corpus(
                &PreparationOptions {
                    model_cache: options.model_cache.clone(),
                    sqlite_dir: options.sqlite_dir.join(key),
                    embedding_model: choice,
                },
                dataset.corpus(),
            )?;
            if request.embedding_model.is_some() {
                models.insert(key.to_owned(), session.embedding_identity()?);
            }
            let mut profiles = Vec::new();
            for selected in input
                .requests
                .iter()
                .filter(|selected| model_key(selected) == key)
            {
                if profiles
                    .iter()
                    .any(|state: &ProfileState| state.profile == selected.config.profile)
                {
                    continue;
                }
                prepared_profiles += 1;
                let prepared = session.prepare(
                    selected.config.profile,
                    selected.embedding_model.is_some(),
                    &format!("{batch_id}-{key}"),
                );
                let corpus = prepared
                    .as_ref()
                    .ok()
                    .map(|prepared| Arc::new(prepared.corpus.clone()));
                profiles.push(ProfileState {
                    profile: selected.config.profile,
                    prepared,
                    corpus,
                });
            }
            let mut shared = session.shared(&format!("{batch_id}-{key}"));
            shared.interpretation.push_str(" This is the immutable preparation snapshot before variant queries; query inference and cache hits are measured separately in each row.");
            Ok(ModelState {
                session,
                profiles,
                shared,
            })
        })();
        states.insert(key.to_owned(), state);
    }
    let mut manifest = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&options.embedding_manifest)
        .map_err(|error| error.to_string())?;
    serde_json::to_writer(
        &mut manifest,
        &serde_json::json!({"schema_version":1,"execution_id":input.execution_id,"models":models}),
    )
    .map_err(|error| error.to_string())?;
    manifest.sync_all().map_err(|error| error.to_string())?;
    if let Some(parent) = options.embedding_manifest.parent() {
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
    }

    let active = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let ranking_active = AtomicUsize::new(0);
    let ranking_peak = AtomicUsize::new(0);
    let records = std::thread::scope(|scope| -> Result<Vec<Envelope>, String> {
        let mut pending = VecDeque::new();
        let mut records = Vec::new();
        for request in &input.requests {
            if pending.len() == search_limit {
                let handle: std::thread::ScopedJoinHandle<'_, Result<Envelope, String>> =
                    pending.pop_front().unwrap();
                records.push(
                    handle
                        .join()
                        .map_err(|_| "Benchmark search worker panicked")??,
                );
            }
            let mut envelope = Envelope {
                request_id: request.request_id.clone(),
                record: RetrievalRecord {
                    schema_version: 1,
                    batch_id: batch_id.clone(),
                    run_id: format!("{batch_id}--{}", request.request_id),
                    created_at_unix_ms: created,
                    case_id: case.id.clone(),
                    family: case.family.clone(),
                    split: case.split.clone(),
                    kind: case.kind.clone(),
                    question: case.question.clone(),
                    config_id: super::catalog::config_id(&request.config)?,
                    config: request.config.clone(),
                    request_filters: filters.clone(),
                    query_inputs_sha256: dataset.query_inputs_sha256.clone(),
                    execution_kind: ExecutionKind::LocalMeasured,
                    execution_status: ExecutionStatus::Failed,
                    dataset: dataset.catalog.identity.clone(),
                    preparation: Default::default(),
                    shared_preparation: None,
                    outcome: None,
                    timings: RetrievalTimings::default(),
                    error: None,
                },
            };
            let query = (|| {
                let state = states
                    .get_mut(model_key(request))
                    .unwrap()
                    .as_mut()
                    .map_err(|error| error.clone())?;
                let profile = state
                    .profiles
                    .iter_mut()
                    .find(|profile| profile.profile == request.config.profile)
                    .unwrap();
                let prepared = profile.prepared.as_mut().map_err(|error| error.clone())?;
                envelope.record.preparation = prepared.record.clone();
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                let query = state.session.query(
                    prepared,
                    &RetrievalRequest {
                        query: case.question.clone(),
                        filters: filters.clone(),
                    },
                    &request.config,
                );
                envelope.record.shared_preparation = Some(state.shared.clone());
                Ok::<_, String>((query, Arc::clone(profile.corpus.as_ref().unwrap())))
            })();
            let (query, corpus) = match query {
                Ok((Ok(query), corpus)) => (query, corpus),
                other => {
                    match other {
                        Ok((Err(attempt), _)) => {
                            active.fetch_sub(1, Ordering::SeqCst);
                            apply_attempt(&mut envelope.record, *attempt);
                        }
                        Err(error) => {
                            envelope.record.error = Some(format!("Preparation failed: {error}"))
                        }
                        _ => unreachable!(),
                    }
                    write_envelope(&output, &envelope)?;
                    records.push(envelope);
                    continue;
                }
            };
            let output = Arc::clone(&output);
            let active = &active;
            let ranking_active = &ranking_active;
            let ranking_peak = &ranking_peak;
            pending.push_back(scope.spawn(move || {
                let attempt = query.finish_with(|query, vector| {
                    let count = ranking_active.fetch_add(1, Ordering::SeqCst) + 1;
                    ranking_peak.fetch_max(count, Ordering::SeqCst);
                    let outcome = search(&corpus, query, &envelope.record.config.retrieval, vector);
                    ranking_active.fetch_sub(1, Ordering::SeqCst);
                    outcome
                });
                apply_attempt(&mut envelope.record, attempt);
                active.fetch_sub(1, Ordering::SeqCst);
                write_envelope(&output, &envelope)?;
                Ok(envelope)
            }));
        }
        for handle in pending {
            records.push(
                handle
                    .join()
                    .map_err(|_| "Benchmark search worker panicked")??,
            );
        }
        Ok(records)
    })?;
    let completed = records
        .iter()
        .filter(|row| row.record.execution_status == ExecutionStatus::Completed)
        .count();
    Ok(
        serde_json::json!({"schema_version":1,"execution_id":input.execution_id,"batch_id":batch_id,"planned_rows":input.requests.len(),"completed":completed,"failed":records.len()-completed,"max_concurrent_searches":search_limit,"observed_peak_searches":peak.load(Ordering::SeqCst),"observed_peak_rankings":ranking_peak.load(Ordering::SeqCst),"native_batch_elapsed_ms":batch_started.elapsed().as_secs_f64()*1000.0,"prepared_profiles":prepared_profiles,"codex_calls":0,"ai_judge_calls":0}),
    )
}

fn apply_attempt(record: &mut RetrievalRecord, attempt: SearchAttempt) {
    record.timings = attempt.timings;
    match attempt.outcome {
        Ok(outcome) => {
            record.outcome = Some(outcome);
            record.execution_status = ExecutionStatus::Completed;
        }
        Err(error) => record.error = Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn fixture() -> (BatchInput, BatchOptions, PathBuf) {
        static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);
        let base = std::env::temp_dir().join(format!(
            "coa-batch-worker-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&base).unwrap();
        let input = BatchInput {
            schema_version: 1,
            execution_id: "worker-unit".into(),
            dataset: dataset::DEMO_ID.into(),
            case_id: "RAG26-01".into(),
            requests: [3, 6, 3, 6]
                .into_iter()
                .enumerate()
                .map(|(index, top_k)| BatchRequest {
                    request_id: format!("{index:064x}"),
                    embedding_model: None,
                    config: RunConfig {
                        profile: StorageProfile::DocumentsSections,
                        retrieval: RetrievalConfig {
                            method: SearchMethod::Bm25,
                            top_k,
                            ..Default::default()
                        },
                    },
                })
                .collect(),
        };
        let options = BatchOptions {
            output: base.join("native.jsonl"),
            embedding_manifest: base.join("models.json"),
            model_cache: base.join("NO_MODEL"),
            sqlite_dir: base.join("fresh-store"),
        };
        (input, options, base)
    }

    #[test]
    fn real_rankings_overlap_with_a_two_search_ceiling() {
        let (input, options, base) = fixture();
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let shared = Mutex::new(());
        let changed = std::sync::Condvar::new();
        let result = run_with_search(input, &options, &|corpus, query, config, vector| {
            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(count, Ordering::SeqCst);
            changed.notify_all();
            let guard = shared.lock().unwrap();
            let _ = changed
                .wait_timeout_while(guard, Duration::from_millis(150), |_| {
                    active.load(Ordering::SeqCst) < 2
                })
                .unwrap();
            let outcome = crate::retrieval::retrieve(corpus, query, config, vector);
            active.fetch_sub(1, Ordering::SeqCst);
            outcome
        })
        .unwrap();
        assert_eq!(result["completed"], 4);
        assert_eq!(
            peak.load(Ordering::SeqCst),
            2,
            "Actual retrieval calls must overlap without exceeding two concurrent searches"
        );
        assert_eq!(result["observed_peak_searches"], 2);
        assert_eq!(result["prepared_profiles"], 1);
        assert!(!options.model_cache.exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_completed_search_is_durable_while_another_search_is_still_running() {
        let (mut input, options, base) = fixture();
        input.requests.truncate(2);
        let observed = std::sync::atomic::AtomicBool::new(false);
        run_with_search(input, &options, &|corpus, query, config, vector| {
            if config.top_k == 6 {
                let deadline = Instant::now() + Duration::from_millis(300);
                while Instant::now() < deadline {
                    if std::fs::read_to_string(&options.output)
                        .unwrap()
                        .lines()
                        .any(|line| serde_json::from_str::<serde_json::Value>(line).is_ok())
                    {
                        observed.store(true, Ordering::SeqCst);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
            crate::retrieval::retrieve(corpus, query, config, vector)
        })
        .unwrap();
        assert!(
            observed.load(Ordering::SeqCst),
            "The completed first search must reach JSONL before the second search finishes"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn duplicate_or_foreign_requests_are_rejected_before_preparation_or_output() {
        for invalid in ["duplicate", "foreign", "model", "unknown-field"] {
            let (mut input, options, base) = fixture();
            match invalid {
                "duplicate" => input.requests[1].request_id = input.requests[0].request_id.clone(),
                "foreign" => input.case_id = "IND26-01".into(),
                "model" => input.requests[0].embedding_model = Some("e5-small-multilingual".into()),
                "unknown-field" => {
                    assert!(serde_json::from_value::<BatchInput>(serde_json::json!({"schema_version":1,"execution_id":"abc","dataset":dataset::DEMO_ID,"case_id":"RAG26-01","requests":[],"expected":"must never reach search"})).is_err());
                    std::fs::remove_dir_all(base).unwrap();
                    continue;
                }
                _ => unreachable!(),
            }
            assert!(run(input, &options).is_err());
            assert!(!options.output.exists());
            assert!(!options.embedding_manifest.exists());
            assert!(!options.model_cache.exists());
            assert!(!options.sqlite_dir.exists());
            std::fs::remove_dir_all(base).unwrap();
        }
    }

    #[test]
    fn operator_worker_limits_bound_searches_and_reject_invalid_before_output() {
        for (value, expected) in [
            ("1", "1"),
            ("2", "2"),
            ("4", "4"),
            ("3", "invalid"),
            ("8", "invalid"),
            ("0", "invalid"),
            ("", "invalid"),
        ] {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "retrieval_lab::benchmark_batch::tests::operator_worker_limit_child",
                    "--nocapture",
                ])
                .env("COA_BENCHMARK_SEARCH_WORKERS", value)
                .env("COA_TEST_EXPECTED_SEARCH_WORKERS", expected)
                .status()
                .unwrap();
            assert!(
                status.success(),
                "Configured worker limit {value:?} must be applied or rejected before preparation"
            );
        }
    }

    #[test]
    fn operator_worker_limit_child() {
        let Ok(expected) = std::env::var("COA_TEST_EXPECTED_SEARCH_WORKERS") else {
            return;
        };
        let (input, options, base) = fixture();
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let signal = std::sync::Condvar::new();
        let shared = Mutex::new(());
        let result = run_with_search(input, &options, &|corpus, query, config, vector| {
            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(count, Ordering::SeqCst);
            signal.notify_all();
            let expected_count = expected.parse::<usize>().unwrap_or(1);
            let _ = signal
                .wait_timeout_while(shared.lock().unwrap(), Duration::from_millis(150), |_| {
                    active.load(Ordering::SeqCst) < expected_count
                })
                .unwrap();
            let outcome = crate::retrieval::retrieve(corpus, query, config, vector);
            active.fetch_sub(1, Ordering::SeqCst);
            outcome
        });
        if expected == "invalid" {
            assert!(
                result.is_err(),
                "An unsupported worker limit must fail closed"
            );
            assert!(!options.output.exists());
            assert!(!options.embedding_manifest.exists());
            assert!(!options.sqlite_dir.exists());
        } else {
            let result = result.unwrap();
            let expected = expected.parse::<usize>().unwrap();
            assert_eq!(result["max_concurrent_searches"], expected);
            assert_eq!(result["observed_peak_rankings"], expected);
            assert_eq!(
                peak.load(Ordering::SeqCst),
                expected,
                "Actual retrieve callbacks must use the configured ceiling"
            );
            assert_eq!(result["completed"], 4);
            assert!(!options.model_cache.exists());
        }
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn native_batch_elapsed_clock_includes_durable_captures_without_summing_queries() {
        let (input, options, base) = fixture();
        let started = Instant::now();
        let result = run(input, &options).unwrap();
        let outer_ms = started.elapsed().as_secs_f64() * 1000.0;
        let total = result["native_batch_elapsed_ms"]
            .as_f64()
            .expect("The native batch needs its own directly measured elapsed clock");
        let rows: Vec<serde_json::Value> = std::fs::read_to_string(&options.output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(rows.len(), 4);
        assert!(total.is_finite() && total > 0.0 && total <= outer_ms);
        for row in rows {
            assert!(row["record"]["timings"]["query_total_ms"].as_f64().unwrap() <= total);
        }
        std::fs::remove_dir_all(base).unwrap();
    }
}
