//! Local benchmark plans and durable executions. Existing runners own all scoring.
use super::*;
use axum::{Extension, extract::Query};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{File, OpenOptions},
    io::Write,
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, OpenOptionsExt},
    },
    path::{Path as FilePath, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{process::Command, sync::watch};

const MAX_SNAPSHOT: u64 = 64 * 1024 * 1024;
const MAX_LOG: u64 = 16 * 1024 * 1024;
const MAX_QUEUED: usize = 3;

fn failure(status: StatusCode, code: &str, message: &str) -> ApiError {
    ApiError {
        status,
        body: json!({"code":code,"error":message}),
        retry_after: None,
    }
}
fn storage_error() -> ApiError {
    failure(
        StatusCode::SERVICE_UNAVAILABLE,
        "benchmark_storage",
        "Benchmarkopslag is niet beschikbaar. Controleer de lokale opslag en herstart.",
    )
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn request_id(input: &mut Value) -> Result<Option<String>, ApiError> {
    let Some(value) = input
        .as_object_mut()
        .and_then(|input| input.remove("request_id"))
    else {
        return Ok(None);
    };
    let Some(id) = value.as_str().filter(|id| {
        !id.is_empty()
            && id.len() <= 96
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    }) else {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "benchmark_request_id",
            "Deze startopdracht heeft geen geldige identificatie.",
        ));
    };
    Ok(Some(id.into()))
}
fn previous_request(
    book: &Book,
    id: Option<&str>,
    input: &Value,
) -> Result<Option<Value>, ApiError> {
    let Some(id) = id else { return Ok(None) };
    let Some(run) = book.runs.values().find(|run| run["request_id"] == id) else {
        return Ok(None);
    };
    if run["request_payload"] != *input {
        return Err(failure(
            StatusCode::CONFLICT,
            "benchmark_request_changed",
            "Deze startopdracht hoort al bij een andere selectie. Start een nieuwe benchmark.",
        ));
    }
    Ok(Some(run.clone()))
}
fn identifier() -> Result<String, ApiError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| storage_error())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn active(status: &Value) -> bool {
    matches!(status.as_str(), Some("queued" | "running" | "cancelling"))
}
fn read_json(path: &FilePath) -> Result<Value, ApiError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| storage_error())?;
    if !metadata.is_file() || metadata.len() > MAX_SNAPSHOT {
        return Err(storage_error());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|_| storage_error())?)
        .map_err(|_| storage_error())
}
fn write_new(path: &FilePath, value: &Value) -> Result<(), ApiError> {
    let bytes = serde_json::to_vec(value).map_err(|_| storage_error())?;
    if bytes.len() as u64 > MAX_SNAPSHOT {
        return Err(storage_error());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| storage_error())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| storage_error())
}
fn persist(directory: &FilePath, value: &Value) -> Result<(), ApiError> {
    let id = value["id"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or_else(storage_error)?;
    let temporary = directory.join(format!(".{id}-{}.tmp", identifier()?));
    write_new(&temporary, value)?;
    std::fs::rename(&temporary, directory.join(format!("{id}.json")))
        .map_err(|_| storage_error())?;
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| storage_error())
}
fn checkpoint(path: &FilePath, value: &Value) -> Result<(), ApiError> {
    let directory = path.parent().ok_or_else(storage_error)?;
    let temporary = directory.join(format!(".checkpoint-{}.tmp", identifier()?));
    write_new(&temporary, value)?;
    std::fs::rename(temporary, path).map_err(|_| storage_error())?;
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| storage_error())
}

#[derive(Default)]
struct Book {
    runs: BTreeMap<String, Value>,
    cancellations: BTreeMap<String, watch::Sender<bool>>,
}
pub(super) struct Benchmarks {
    root: PathBuf,
    directory: PathBuf,
    cache: PathBuf,
    allowed: Vec<String>,
    book: Mutex<Book>,
    capacity: Arc<Semaphore>,
    lock: Option<File>,
    shutting_down: AtomicBool,
    runner: Option<ResponsesRunner>,
}
impl Benchmarks {
    pub(super) fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let directory = std::env::var_os("COA_BENCHMARK_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("evals/benchmark/results/local"));
        let cache = std::env::var_os("COA_RAG_MODEL_CACHE")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join(".model-cache"));
        Self::open(root, directory, cache)
    }
    pub(super) fn with_runner(runner: Option<ResponsesRunner>) -> Self {
        let mut store = Self::new();
        store.runner = runner;
        store
    }
    pub(super) fn open(root: PathBuf, directory: PathBuf, cache: PathBuf) -> Self {
        let port = std::env::var("COA_PORT").unwrap_or_else(|_| "8766".into());
        let mut instance = Self {
            root,
            directory,
            cache,
            allowed: vec![
                format!("http://127.0.0.1:{port}"),
                format!("http://localhost:{port}"),
            ],
            book: Mutex::new(Book::default()),
            capacity: Arc::new(Semaphore::new(1)),
            lock: None,
            shutting_down: AtomicBool::new(false),
            runner: None,
        };
        if let Ok((lock, book)) = instance.restore() {
            instance.lock = Some(lock);
            instance.book = Mutex::new(book);
        }
        instance
    }
    fn restore(&self) -> Result<(File, Book), ApiError> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.directory)
            .map_err(|_| storage_error())?;
        let lock_path = self.directory.join(".lock");
        if std::fs::symlink_metadata(&lock_path)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(storage_error());
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(lock_path)
            .map_err(|_| storage_error())?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(storage_error());
        }
        let mut book = Book::default();
        for entry in std::fs::read_dir(&self.directory).map_err(|_| storage_error())? {
            let entry = entry.map_err(|_| storage_error())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".json").filter(|id| valid_id(id)) else {
                continue;
            };
            let mut value = read_json(&entry.path())?;
            if value["schema_version"] != 1 || value["id"] != id || !value["plan"].is_object() {
                return Err(storage_error());
            }
            if active(&value["status"]) {
                merge_progress(&mut value, &self.directory.join(id).join("progress.json"));
                finish_snapshot(
                    &mut value,
                    "interrupted",
                    Some("De server is herstart. Deze uitvoering wordt niet automatisch hervat."),
                );
                persist(&self.directory, &value)?;
            }
            book.runs.insert(id.into(), value);
        }
        Ok((lock, book))
    }
    fn check(&self, peer: SocketAddr, headers: &HeaderMap, mutating: bool) -> Result<(), ApiError> {
        super::eval_jobs::require_local(peer, headers)?;
        if mutating {
            super::eval_jobs::require_origin(headers, &self.allowed)?;
        }
        let host = headers
            .get("host")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if !self
            .allowed
            .iter()
            .any(|origin| origin.strip_prefix("http://") == Some(host))
        {
            return Err(failure(
                StatusCode::FORBIDDEN,
                "benchmark_host",
                "Open de benchmark rechtstreeks op deze computer.",
            ));
        }
        Ok(())
    }
    fn locked(&self) -> Result<std::sync::MutexGuard<'_, Book>, ApiError> {
        if self.lock.is_none() {
            return Err(storage_error());
        }
        self.book.lock().map_err(|_| storage_error())
    }
    fn get(&self, id: &str) -> Result<Value, ApiError> {
        let mut value = self.locked()?.runs.get(id).cloned().ok_or_else(|| {
            failure(
                StatusCode::NOT_FOUND,
                "benchmark_not_found",
                "Deze benchmark bestaat niet.",
            )
        })?;
        super::benchmark_sources::enrich(&mut value);
        enrich_expected_sources(&mut value);
        Ok(value)
    }
    fn update(&self, id: &str, update: impl FnOnce(&mut Value)) -> Result<Value, ApiError> {
        let mut book = self.locked()?;
        let old = book.runs.get(id).ok_or_else(|| {
            failure(
                StatusCode::NOT_FOUND,
                "benchmark_not_found",
                "Deze benchmark bestaat niet.",
            )
        })?;
        let mut snapshot = old.clone();
        update(&mut snapshot);
        if snapshot == *old {
            return Ok(snapshot);
        }
        snapshot["updated_at"] = json!(now());
        persist(&self.directory, &snapshot)?;
        book.runs.insert(id.into(), snapshot.clone());
        Ok(snapshot)
    }
    fn command(&self) -> Command {
        let mut command = Command::new("node");
        command
            .arg(self.root.join("evals/benchmark/adapter.ts"))
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .process_group(0);
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("COA_PROMPTFOO_") {
                command.env_remove(key);
            }
        }
        for key in [
            "OPENAI_API_KEY",
            "COA_OPENAI_API_KEY_FILE",
            "COA_DEMO_BUDGET_FILE",
            "COA_RESPONSES_TEST_URL",
            "COA_RESPONSES_TEST_TIMEOUT_MS",
        ] {
            command.env_remove(key);
        }
        if let Ok(binary) = std::env::current_exe() {
            command.env("COA_RAG_BINARY", binary);
        }
        command.env("COA_RAG_MODEL_CACHE", &self.cache).env(
            "COA_BENCHMARK_SQLITE",
            if cfg!(feature = "sqlite") { "1" } else { "0" },
        );
        command.env(
            "COA_BENCHMARK_RIG_READY",
            if self.runner.is_some() { "1" } else { "0" },
        );
        command
    }
    async fn adapter(&self, mode: &str, input: Option<&Value>) -> Result<Value, ApiError> {
        let input_path = if let Some(input) = input {
            if self.lock.is_none() {
                return Err(storage_error());
            }
            let path = self
                .directory
                .join(format!(".request-{}.json", identifier()?));
            write_new(&path, input)?;
            Some(path)
        } else {
            None
        };
        let mut command = self.command();
        command.arg(mode);
        if let Some(path) = &input_path {
            command.arg(path);
        }
        let result = tokio::time::timeout(Duration::from_secs(60), command.output()).await;
        if let Some(path) = input_path {
            let _ = std::fs::remove_file(path);
        }
        let output=result.map_err(|_|failure(StatusCode::REQUEST_TIMEOUT,"benchmark_plan_timeout","De benchmark kon niet op tijd worden gepland."))?.map_err(|_|failure(StatusCode::SERVICE_UNAVAILABLE,"benchmark_runtime","Installeer Node.js en de evaluatieafhankelijkheden om benchmarks te gebruiken."))?;
        if !output.status.success() || output.stdout.len() > 8 * 1024 * 1024 {
            return Err(failure(
                StatusCode::BAD_REQUEST,
                "benchmark_selection",
                "De selectie kon niet worden gepland. Controleer vraagsets, mogelijkheden en limieten.",
            ));
        }
        serde_json::from_slice(&output.stdout).map_err(|_| {
            failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "benchmark_format",
                "De benchmarkplanner gaf geen leesbaar resultaat.",
            )
        })
    }
    pub(super) async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        {
            let book = self
                .book
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for sender in book.cancellations.values() {
                let _ = sender.send(true);
            }
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if self
                .book
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .cancellations
                .is_empty()
                || Instant::now() >= deadline
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

pub(super) async fn catalog(
    Extension(jobs): Extension<Arc<Benchmarks>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    jobs.check(peer, &headers, false)?;
    let mut value = jobs.adapter("catalog", None).await?;
    value["can_run"] = json!(jobs.lock.is_some());
    Ok(Json(value))
}
pub(super) async fn plan(
    Extension(jobs): Extension<Arc<Benchmarks>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    jobs.check(peer, &headers, true)?;
    Ok(Json(jobs.adapter("plan", Some(&input)).await?))
}
pub(super) async fn question_plan(
    Extension(jobs): Extension<Arc<Benchmarks>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    jobs.check(peer, &headers, true)?;
    Ok(Json(jobs.adapter("question-plan", Some(&input)).await?))
}
pub(super) async fn question_start(
    Extension(jobs): Extension<Arc<Benchmarks>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(mut input): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    jobs.check(peer, &headers, true)?;
    let request = request_id(&mut input)?.ok_or_else(|| {
        failure(
            StatusCode::BAD_REQUEST,
            "benchmark_request_id",
            "Start deze benchmark met een nieuwe startopdracht.",
        )
    })?;
    if let Some(existing) = previous_request(&*jobs.locked()?, Some(&request), &input)? {
        return Ok((StatusCode::OK, Json(existing)));
    }
    let plan = jobs.adapter("question-plan", Some(&input)).await?;
    start_planned(jobs, plan, Some(request), input).await
}
pub(super) async fn list(
    Extension(jobs): Extension<Arc<Benchmarks>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    jobs.check(peer, &headers, false)?;
    let mut values: Vec<_> = jobs
        .locked()?
        .runs
        .values()
        .map(|value| {
            let mut summary: Value = [
                "schema_version",
                "id",
                "created_at",
                "updated_at",
                "status",
                "plan",
                "progress",
                "groups",
                "error",
            ]
            .into_iter()
            .map(|field| (field.to_string(), value[field].clone()))
            .collect();
            summary["result_available"] =
                json!(!value["result"]["rows"].as_array().is_none_or(Vec::is_empty));
            summary["result"] = json!({"rows":[],"sources":{}});
            summary
        })
        .collect();
    values.sort_by_key(|value| std::cmp::Reverse(value["created_at"].as_u64().unwrap_or(0)));
    Ok(Json(json!({"runs":values})))
}
pub(super) async fn get(
    Extension(jobs): Extension<Arc<Benchmarks>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    jobs.check(peer, &headers, false)?;
    Ok(Json(jobs.get(&id)?))
}
pub(super) async fn start(
    Extension(jobs): Extension<Arc<Benchmarks>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(mut input): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    jobs.check(peer, &headers, true)?;
    let request = request_id(&mut input)?;
    if let Some(existing) = previous_request(&*jobs.locked()?, request.as_deref(), &input)? {
        return Ok((StatusCode::OK, Json(existing)));
    }
    if jobs.shutting_down.load(Ordering::Acquire) {
        return Err(failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "benchmark_stopping",
            "De lokale server wordt gestopt.",
        ));
    }
    let plan = jobs.adapter("plan", Some(&input)).await?;
    start_planned(jobs, plan, request, input).await
}
async fn start_planned(
    jobs: Arc<Benchmarks>,
    plan: Value,
    request: Option<String>,
    input: Value,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if plan["can_start"] != true {
        return Err(failure(
            StatusCode::CONFLICT,
            "benchmark_blocked",
            "Geen geselecteerde proef kan worden uitgevoerd. Bekijk de blokkades in het runplan.",
        ));
    }
    let id = identifier()?;
    let (sender, cancel) = watch::channel(false);
    let snapshot = {
        let mut book = jobs.locked()?;
        if let Some(existing) = previous_request(&book, request.as_deref(), &input)? {
            return Ok((StatusCode::OK, Json(existing)));
        }
        if jobs.shutting_down.load(Ordering::Acquire) {
            return Err(failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "benchmark_stopping",
                "De lokale server wordt gestopt.",
            ));
        }
        if book
            .runs
            .values()
            .filter(|value| active(&value["status"]))
            .count()
            >= MAX_QUEUED
        {
            return Err(failure(
                StatusCode::TOO_MANY_REQUESTS,
                "benchmark_queue",
                "De wachtrij bevat al drie benchmarks. Wacht tot een uitvoering klaar is.",
            ));
        }
        let groups: Vec<_> = plan["groups"]
            .as_array()
            .ok_or_else(storage_error)?
            .iter()
            .map(|group| {
                let mut group = group.clone();
                group["status"] = json!(if group["block_reason"].is_null() {
                    "queued"
                } else {
                    "not_run"
                });
                group["completed"] = json!(0);
                group["error"] = Value::Null;
                group
            })
            .collect();
        let snapshot = json!({"schema_version":1,"id":id,"request_id":request,"request_payload":input,"created_at":now(),"updated_at":now(),"status":"queued","plan":plan,"progress":{"completed":0,"total":plan["totals"]["executions"]},"groups":groups,"result":{"rows":[],"sources":{}},"error":null});
        persist(&jobs.directory, &snapshot)?;
        book.runs.insert(id.clone(), snapshot.clone());
        book.cancellations.insert(id.clone(), sender);
        snapshot
    };
    tokio::spawn(worker(jobs, id, cancel));
    Ok((StatusCode::ACCEPTED, Json(snapshot)))
}
pub(super) async fn cancel(
    Extension(jobs): Extension<Arc<Benchmarks>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    jobs.check(peer, &headers, true)?;
    let mut book = jobs.locked()?;
    let mut snapshot = book.runs.get(&id).cloned().ok_or_else(|| {
        failure(
            StatusCode::NOT_FOUND,
            "benchmark_not_found",
            "Deze benchmark bestaat niet.",
        )
    })?;
    if !active(&snapshot["status"]) {
        return Ok(Json(snapshot));
    }
    if snapshot["status"] == "queued" {
        finish_snapshot(&mut snapshot, "cancelled", None);
    } else {
        snapshot["status"] = json!("cancelling");
        snapshot["updated_at"] = json!(now());
    }
    persist(&jobs.directory, &snapshot)?;
    book.runs.insert(id.clone(), snapshot.clone());
    if let Some(sender) = book.cancellations.get(&id) {
        let _ = sender.send(true);
    }
    Ok(Json(snapshot))
}

fn merge_progress(snapshot: &mut Value, path: &FilePath) {
    let Ok(progress) = read_json(path) else {
        return;
    };
    if progress["result"]["rows"].is_array() && progress["result"]["sources"].is_object() {
        for field in ["result", "progress"] {
            if progress[field].is_object() {
                snapshot[field] = progress[field].clone();
            }
        }
        if let (Some(updates), Some(groups)) = (
            progress["groups"].as_array(),
            snapshot["groups"].as_array_mut(),
        ) {
            for update in updates {
                if let Some(group) = groups.iter_mut().find(|group| group["id"] == update["id"]) {
                    for field in ["status", "completed", "error"] {
                        if update.get(field).is_some() {
                            group[field] = update[field].clone();
                        }
                    }
                }
            }
        }
    }
}
// Protected reference IDs are resolved only for inspection after execution.
// The existing calls/hits and the original found flags remain unchanged.
fn enrich_expected_sources(snapshot: &mut Value) {
    use meedoen_retrieval::corpus::CorpusId;
    let corpora: Vec<_> = [
        CorpusId::BaselineFive,
        CorpusId::ExpandedTen,
        CorpusId::DemoTwelve,
    ]
    .into_iter()
    .map(|corpus| {
        (
            corpus,
            corpus.sha256(),
            corpus
                .sources()
                .unwrap_or_default()
                .into_iter()
                .flat_map(|source| source.sections)
                .collect::<Vec<_>>(),
        )
    })
    .collect();
    let mut additions = BTreeMap::new();
    for row in snapshot["result"]["rows"].as_array().into_iter().flatten() {
        let corpus = match row["dataset"].as_str() {
            Some("demo-12-20261118" | "regression-12-20261118") => CorpusId::DemoTwelve,
            Some("expanded-10-20261105" | "strengthened-10-20261106") => CorpusId::ExpandedTen,
            Some("legacy" | "legacy-heldout" | "independent-20261103" | "garden") => {
                CorpusId::BaselineFive
            }
            _ => continue,
        };
        let Some((_, hash, sections)) = corpora.iter().find(|(id, _, _)| *id == corpus) else {
            continue;
        };
        let group = snapshot["plan"]["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|group| group["id"] == row["group_id"]);
        if group.is_none_or(|group| group["identity"]["corpus_sha256"] != *hash) {
            continue;
        }
        for reference in row["goals"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|goal| goal["alternatives"].as_array().into_iter().flatten())
            .flat_map(|alternative| alternative.as_array().into_iter().flatten())
        {
            if let Some(section) = sections.iter().find(|section| {
                section.source_id == reference["source_id"] && section.id == reference["section_id"]
            }) {
                additions.insert(
                    format!("expected:{hash}:{}:{}", section.source_id, section.id),
                    serde_json::to_value(section).unwrap_or(Value::Null),
                );
            }
        }
    }
    if let Some(sources) = snapshot["result"]["sources"].as_object_mut() {
        sources.extend(additions);
    }
}
fn finish_snapshot(snapshot: &mut Value, status: &str, error: Option<&str>) {
    let incomplete = status == "completed"
        && snapshot["groups"].as_array().is_none_or(|groups| {
            groups
                .iter()
                .any(|group| group["block_reason"].is_null() && group["status"] != "completed")
        });
    let status = if incomplete { "failed" } else { status };
    let error = error.or(if incomplete {
        Some("Niet alle proeven konden worden uitgevoerd. Afgeronde resultaten blijven bewaard.")
    } else {
        None
    });
    snapshot["status"] = json!(status);
    snapshot["updated_at"] = json!(now());
    snapshot["error"] = error.map_or(Value::Null, |error| json!(error));
    if let Some(groups) = snapshot["groups"].as_array_mut() {
        for group in groups {
            if matches!(
                group["status"].as_str(),
                Some("queued" | "running" | "preparing")
            ) {
                group["status"] = json!(if group["completed"].as_u64().unwrap_or(0) > 0 {
                    status
                } else {
                    "not_run"
                });
            }
        }
    }
}
async fn execute(
    jobs: &Benchmarks,
    id: &str,
    cancel: &mut watch::Receiver<bool>,
) -> Result<&'static str, ApiError> {
    let snapshot = jobs.get(id)?;
    let started = Instant::now();
    let has_models = snapshot["plan"]["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|group| group["kind"] == "model" && group["block_reason"].is_null());
    let seconds = if has_models {
        snapshot["plan"]["selection"]["authorization"]["max_seconds"]
            .as_u64()
            .ok_or_else(storage_error)?
    } else {
        18_000
    };
    let directory = jobs.directory.join(id);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)
        .map_err(|_| storage_error())?;
    let input = directory.join("input.json");
    write_new(
        &input,
        &json!({"selection":snapshot["plan"]["selection"],"plan":snapshot["plan"]}),
    )?;
    let stdout = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join("stdout.log"))
        .map_err(|_| storage_error())?;
    let stderr = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join("stderr.log"))
        .map_err(|_| storage_error())?;
    let mut command = jobs.command();
    command
        .arg("execute")
        .arg(input)
        .arg(&directory)
        .stdout(stdout)
        .stderr(stderr);
    let mut child = command.spawn().map_err(|_| {
        failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "benchmark_runtime",
            "De benchmarkrunner kon niet worden gestart.",
        )
    })?;
    let pid = child.id().ok_or_else(storage_error)?;
    let mut ticks = tokio::time::interval(Duration::from_millis(500));
    let timeout = tokio::time::sleep(Duration::from_secs(seconds));
    tokio::pin!(timeout);
    let status = loop {
        tokio::select! {
            result=child.wait()=>{break result.map_err(|_|storage_error())?;},
            _=cancel.changed()=>{super::eval_jobs::stop(&mut child,pid).await;return Ok("cancelled");},
            _=&mut timeout=>{super::eval_jobs::stop(&mut child,pid).await;return Err(failure(StatusCode::REQUEST_TIMEOUT,"benchmark_timeout","De benchmark is gestopt na het maximale uitvoeringsvenster."));},
            _=ticks.tick()=>{
                if ["stdout.log","stderr.log"].iter().any(|name|std::fs::metadata(directory.join(name)).is_ok_and(|metadata|metadata.len()>MAX_LOG)) {
                    super::eval_jobs::stop(&mut child,pid).await;
                    return Err(failure(StatusCode::SERVICE_UNAVAILABLE,"benchmark_output_limit","De benchmark is gestopt omdat de lokale uitvoerlimiet is bereikt."));
                }
                if jobs.update(id,|value|merge_progress(value,&directory.join("progress.json"))).is_err() {
                    super::eval_jobs::stop(&mut child,pid).await;
                    return Err(storage_error());
                }
            }
        }
    };
    if *cancel.borrow() {
        return Ok("cancelled");
    }
    if !status.success() {
        return Err(failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "benchmark_execution",
            "De benchmark kon niet volledig worden uitgevoerd. Afgeronde resultaten blijven bewaard.",
        ));
    }
    execute_rig_groups(jobs, id, cancel, started, seconds).await
}

fn merge_rig(
    progress: &mut Value,
    group: &Value,
    partial: &Value,
    status: &str,
    error: Option<&str>,
) {
    if let Some(rows) = partial["rows"].as_array() {
        if let Some(existing) = progress["result"]["rows"].as_array_mut() {
            existing.retain(|row| row["group_id"] != group["id"]);
            existing.extend(rows.iter().cloned());
        }
        if let (Some(sources), Some(existing)) = (
            partial["sources"].as_object(),
            progress["result"]["sources"].as_object_mut(),
        ) {
            existing.extend(sources.clone());
        }
    }
    let completed = progress["result"]["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row["group_id"] == group["id"])
        .count();
    if let Some(state) = progress["groups"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .find(|state| state["id"] == group["id"])
    {
        state["status"] = json!(status);
        state["completed"] = json!(completed);
        state["error"] = error.map_or(Value::Null, |error| json!(error));
    }
    progress["progress"]["completed"] =
        json!(progress["result"]["rows"].as_array().map_or(0, Vec::len));
    if let Some(error) = error {
        progress["error"] = json!(error);
    }
}
async fn execute_rig_groups(
    jobs: &Benchmarks,
    id: &str,
    cancel: &mut watch::Receiver<bool>,
    started: Instant,
    seconds: u64,
) -> Result<&'static str, ApiError> {
    let snapshot = jobs.get(id)?;
    let directory = jobs.directory.join(id);
    let progress_path = directory.join("progress.json");
    let mut progress = read_json(&progress_path)?;
    let groups = snapshot["plan"]["groups"]
        .as_array()
        .ok_or_else(storage_error)?;
    for group in groups
        .iter()
        .filter(|group| group["suite"] == "assistant-rig" && group["block_reason"].is_null())
    {
        if *cancel.borrow() {
            return Ok("cancelled");
        }
        if groups.iter().any(|planned| {
            planned["kind"] == "model"
                && progress["groups"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|state| state["id"] == planned["id"] && state["status"] == "failed")
        }) {
            return Err(failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "benchmark_model_stopped",
                "Volgende modelproeven zijn niet uitgevoerd na een eerdere uitvoeringsfout.",
            ));
        }
        let remaining = seconds.saturating_sub(started.elapsed().as_secs());
        if remaining == 0 {
            return Err(failure(
                StatusCode::REQUEST_TIMEOUT,
                "benchmark_timeout",
                "Het toegestane uitvoeringsvenster is verstreken.",
            ));
        }
        let mut selection = snapshot["plan"]["selection"].clone();
        selection["authorization"]["max_seconds"] = json!(remaining);
        let group_id = group["id"].as_str().ok_or_else(storage_error)?;
        let name = meedoen_retrieval::manifest::hash(group_id.as_bytes());
        let output = directory.join(format!("rig-{}", &name[..16]));
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&output)
            .map_err(|_| storage_error())?;
        merge_rig(&mut progress, group, &json!({}), "running", None);
        checkpoint(&progress_path, &progress)?;
        let result = {
            let future = super::benchmark_rig::execute_group(
                group,
                &selection,
                jobs.runner.clone(),
                &output,
                cancel,
            );
            tokio::pin!(future);
            let mut ticks = tokio::time::interval(Duration::from_millis(500));
            let deadline = tokio::time::sleep(Duration::from_secs(remaining));
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    result=&mut future=>break result,
                    _=&mut deadline=>break Err("Het toegestane uitvoeringsvenster is verstreken.".into()),
                    _=ticks.tick()=>{
                        if let Ok(partial)=read_json(&output.join("rig-progress.json")) {
                            merge_rig(&mut progress,group,&partial,"running",None);
                            checkpoint(&progress_path,&progress)?;
                            jobs.update(id,|snapshot|merge_progress(snapshot,&progress_path))?;
                        }
                    }
                }
            }
        };
        let partial = match &result {
            Ok(value) => value.clone(),
            Err(_) => read_json(&output.join("rig-progress.json")).unwrap_or(json!({})),
        };
        let cancelled = *cancel.borrow() || partial["status"] == "cancelled";
        let failed = result.is_err() || partial["status"] == "failed";
        let status = if cancelled {
            "cancelled"
        } else if failed {
            "failed"
        } else {
            "completed"
        };
        merge_rig(
            &mut progress,
            group,
            &partial,
            status,
            if failed {
                Some(
                    "De actuele assistentproef kon niet worden afgerond. Afgeronde resultaten blijven bewaard.",
                )
            } else {
                None
            },
        );
        checkpoint(&progress_path, &progress)?;
        jobs.update(id, |snapshot| merge_progress(snapshot, &progress_path))?;
        if cancelled {
            return Ok("cancelled");
        }
        if failed {
            return Err(failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "benchmark_rig_execution",
                "De actuele assistentproef kon niet worden afgerond. Afgeronde resultaten blijven bewaard.",
            ));
        }
    }
    Ok("completed")
}
async fn worker(jobs: Arc<Benchmarks>, id: String, mut cancel: watch::Receiver<bool>) {
    let Ok(_permit) = jobs.capacity.clone().acquire_owned().await else {
        return;
    };
    if *cancel.borrow() {
        let _ = jobs.update(&id, |value| finish_snapshot(value, "cancelled", None));
        if let Ok(mut book) = jobs.locked() {
            book.cancellations.remove(&id);
        }
        return;
    }
    if jobs
        .update(&id, |value| value["status"] = json!("running"))
        .is_err()
    {
        return;
    }
    let result = execute(&jobs, &id, &mut cancel).await;
    let (status, error) = match &result {
        Ok(status) => (*status, None),
        Err(error) => ("failed", error.body["error"].as_str()),
    };
    let _ = jobs.update(&id, |value| {
        merge_progress(value, &jobs.directory.join(&id).join("progress.json"));
        finish_snapshot(value, status, error);
    });
    if let Ok(mut book) = jobs.locked() {
        book.cancellations.remove(&id);
    }
}

#[derive(Deserialize)]
pub(super) struct Comparison {
    run: String,
    baseline: String,
    configuration: Option<String>,
    baseline_configuration: Option<String>,
}
fn semantic(row: &Value) -> Value {
    let metrics: Value = [
        "covered_goals",
        "target_goals",
        "full_bytes",
        "compact_bytes",
        "full_payload_bytes",
        "compact_payload_bytes",
    ]
    .into_iter()
    .filter_map(|field| {
        row["metrics"]
            .get(field)
            .map(|value| (field.to_string(), value.clone()))
    })
    .collect();
    let goals: Vec<_> = row["goals"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|goal| json!([goal["id"], goal["covered"]]))
        .collect();
    let calls: Vec<_> = row["calls"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|call| json!([call["query"], call["hits"]]))
        .collect();
    let assertions: Vec<_> = row["assertions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|check| json!([check["reason"], check["pass"], check["score"]]))
        .collect();
    json!({"status":row["status"],"source_complete":row["source_complete"],"goals":goals,"metrics":metrics,"answer":row["answer"],"calls":calls,"assertions":assertions})
}
#[cfg(test)]
fn comparison(run: &Value, baseline: &Value) -> Value {
    compare_selected(run, baseline, None, None)
}
fn compare_selected(
    run: &Value,
    baseline: &Value,
    configuration: Option<&str>,
    baseline_configuration: Option<&str>,
) -> Value {
    let identities = |value: &Value| {
        value["plan"]["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|group| {
                let mut identity = group["identity"].clone();
                if let Some(identity) = identity.as_object_mut() {
                    identity.remove("runtime_sha256");
                }
                (group["id"].as_str().unwrap_or("").to_string(), identity)
            })
            .collect::<BTreeMap<_, _>>()
    };
    let current_identity = identities(run);
    let baseline_identity = identities(baseline);
    let shared_groups: BTreeSet<_> = current_identity
        .keys()
        .filter(|key| baseline_identity.contains_key(*key))
        .cloned()
        .collect();
    if shared_groups.is_empty()
        || shared_groups.iter().any(|key| {
            current_identity[key] != baseline_identity[key] || !current_identity[key].is_object()
        })
    {
        return json!({"compatible":false,"reason":"Deze uitvoeringen hebben geen gedeelde proeven met dezelfde vragen, bronnen, criteria en beoordelaarversie.","run_id":run["id"],"baseline_id":baseline["id"],"pairs":[],"sources":{},"coverage":{"shared_cases":0}});
    }
    let select = |value: &Value, selected: Option<&str>| {
        value["result"]["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| {
                shared_groups.contains(row["group_id"].as_str().unwrap_or(""))
                    && selected.is_none_or(|id| row["configuration_id"] == id)
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    let current_rows = select(run, configuration);
    let baseline_rows = select(baseline, baseline_configuration);
    let case_key = |row: &Value| {
        format!(
            "{}:{}",
            row["group_id"].as_str().unwrap_or(""),
            row["case_id"].as_str().unwrap_or("")
        )
    };
    let current_cases: BTreeSet<_> = current_rows.iter().map(&case_key).collect();
    let baseline_cases: BTreeSet<_> = baseline_rows.iter().map(&case_key).collect();
    let shared_cases: BTreeSet<_> = current_cases
        .intersection(&baseline_cases)
        .cloned()
        .collect();
    let mut by_question: BTreeMap<String, (Vec<Value>, Vec<Value>)> = BTreeMap::new();
    for (index, rows) in [(0, current_rows), (1, baseline_rows)] {
        for row in rows {
            if !shared_cases.contains(&case_key(&row)) {
                continue;
            }
            let key = format!("{}:{}", case_key(&row), row["repeat"].as_u64().unwrap_or(1));
            let pair = by_question.entry(key).or_default();
            if index == 0 {
                pair.0.push(row);
            } else {
                pair.1.push(row);
            }
        }
    }
    let pair = |key: &str, current: Option<Value>, baseline: Option<Value>| {
        let row = current.as_ref().or(baseline.as_ref()).unwrap();
        json!({"key":key,"case_id":row["case_id"],"question":row["question"],"configuration_id":row["configuration_id"],"baseline_configuration_id":baseline.as_ref().map(|row|row["configuration_id"].clone()),"changed":current.as_ref().map(semantic)!=baseline.as_ref().map(semantic),"current":current,"baseline":baseline})
    };
    let mut pairs = Vec::new();
    for (key, (current, baseline)) in by_question {
        if current.len() == 1 && baseline.len() == 1 {
            pairs.push(pair(
                &key,
                current.into_iter().next(),
                baseline.into_iter().next(),
            ));
        } else {
            let mut configurations: BTreeMap<String, (Option<Value>, Option<Value>)> =
                BTreeMap::new();
            for (index, rows) in [(0, current), (1, baseline)] {
                for row in rows {
                    let id = row["configuration_id"].as_str().unwrap_or("").to_string();
                    let values = configurations.entry(id).or_default();
                    if index == 0 {
                        values.0 = Some(row);
                    } else {
                        values.1 = Some(row);
                    }
                }
            }
            for (configuration, (current, baseline)) in configurations {
                pairs.push(pair(&format!("{key}:{configuration}"), current, baseline));
            }
        }
    }
    let mut sources = baseline["result"]["sources"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    sources.extend(
        run["result"]["sources"]
            .as_object()
            .cloned()
            .unwrap_or_default(),
    );
    json!({"compatible":true,"reason":null,"run_id":run["id"],"baseline_id":baseline["id"],"pairs":pairs,"sources":sources,"coverage":{"current_cases":current_cases.len(),"baseline_cases":baseline_cases.len(),"shared_cases":shared_cases.len(),"current_only":current_cases.len()-shared_cases.len(),"baseline_only":baseline_cases.len()-shared_cases.len()}})
}
pub(super) async fn compare(
    Extension(jobs): Extension<Arc<Benchmarks>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(input): Query<Comparison>,
) -> Result<Json<Value>, ApiError> {
    jobs.check(peer, &headers, false)?;
    Ok(Json(compare_selected(
        &jobs.get(&input.run)?,
        &jobs.get(&input.baseline)?,
        input.configuration.as_deref(),
        input.baseline_configuration.as_deref(),
    )))
}

#[derive(Deserialize)]
pub(super) struct Discussion {
    baseline: Option<String>,
}
pub(super) async fn discussion(
    Extension(jobs): Extension<Arc<Benchmarks>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(input): Query<Discussion>,
) -> Result<Json<Value>, ApiError> {
    jobs.check(peer, &headers, false)?;
    let run = jobs.get(&id)?;
    let baseline = input.baseline.map(|id| jobs.get(&id)).transpose()?;
    let comparison = baseline
        .as_ref()
        .map(|baseline| compare_selected(&run, baseline, None, None));
    let root = jobs.root.clone();
    let directory = jobs.directory.join(&id);
    let value = tokio::task::spawn_blocking(move || {
        super::benchmark_report::write(
            &root,
            &directory,
            &run,
            baseline.as_ref(),
            comparison.as_ref(),
        )
    })
    .await
    .map_err(|_| storage_error())?
    .map_err(|_| {
        failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "benchmark_report",
            "Het lokale discussierapport kon niet worden opgeslagen.",
        )
    })?;
    Ok(Json(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("coa-benchmark-{}", identifier().unwrap()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    fn snapshot(id: &str, configuration: &str, cases: &[&str]) -> Value {
        let rows:Vec<_>=cases.iter().map(|case|json!({"group_id":"retrieval:demo","comparison_key":format!("{case}:{configuration}:1"),"case_id":case,"question":case,"configuration_id":configuration,"repeat":1,"status":"passed","source_complete":true,"metrics":{"covered_goals":1,"target_goals":1},"goals":[],"calls":[],"answer":null})).collect();
        json!({"schema_version":1,"id":id,"status":"running","created_at":1,"updated_at":1,"plan":{"groups":[{"id":"retrieval:demo","identity":{"corpus":"twelve","questions":"q1","criteria":"c1","scorer":"s1"}}]},"groups":[{"id":"retrieval:demo","status":"running","completed":0}],"progress":{"completed":0,"total":rows.len()},"result":{"rows":rows,"sources":{}},"error":null})
    }
    #[tokio::test]
    async fn concurrent_start_retries_share_one_persisted_execution() {
        let directory = directory();
        let jobs = Arc::new(Benchmarks::open(
            directory.clone(),
            directory.clone(),
            directory.clone(),
        ));
        let input = json!({"dataset":"regression-12-20261118","case_id":"IND26-01","repeats":2});
        let plan = json!({"can_start":true,"groups":[],"totals":{"executions":0},"selection":{}});
        let (first, second) = tokio::join!(
            start_planned(
                jobs.clone(),
                plan.clone(),
                Some("one-click".into()),
                input.clone()
            ),
            start_planned(jobs.clone(), plan, Some("one-click".into()), input)
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first.0, StatusCode::ACCEPTED);
        assert_eq!(second.0, StatusCode::OK);
        assert_eq!(first.1.0["id"], second.1.0["id"]);
        assert_eq!(jobs.locked().unwrap().runs.len(), 1);
        jobs.shutdown().await;
        drop(jobs);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    async fn question_retry_after_restart_returns_same_job_without_planning_or_execution() {
        let directory = directory();
        let id = "0123456789abcdef0123456789abcdef";
        let input = json!({"dataset":"demo-12-20261118","case_id":"P01","repeats":2});
        let mut value = snapshot(id, "dense", &["P01"]);
        value["request_id"] = json!("deliberate-click-1");
        value["request_payload"] = input.clone();
        persist(&directory, &value).unwrap();
        let jobs = Arc::new(Benchmarks::open(
            directory.clone(),
            directory.clone(),
            directory.clone(),
        ));
        let mut headers = HeaderMap::new();
        headers.insert("host", "127.0.0.1:8766".parse().unwrap());
        headers.insert("origin", "http://127.0.0.1:8766".parse().unwrap());
        let mut retry = input;
        retry["request_id"] = json!("deliberate-click-1");
        let response = start(
            Extension(jobs.clone()),
            ConnectInfo("127.0.0.1:1234".parse().unwrap()),
            headers.clone(),
            Json(retry.clone()),
        )
        .await;
        assert!(
            response.is_ok(),
            "an existing durable request must be resolved without an adapter"
        );
        let (status, Json(returned)) = response.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(returned["id"], id);
        assert_eq!(returned["status"], "interrupted");
        retry["case_id"] = json!("T05");
        let changed = start(
            Extension(jobs.clone()),
            ConnectInfo("127.0.0.1:1234".parse().unwrap()),
            headers,
            Json(retry),
        )
        .await;
        assert!(matches!(
            changed,
            Err(ApiError {
                status: StatusCode::CONFLICT,
                ..
            })
        ));
        assert_eq!(jobs.locked().unwrap().runs.len(), 1);
        drop(jobs);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn restart_preserves_completed_rows_without_restarting_work() {
        let directory = directory();
        let id = "0123456789abcdef0123456789abcdef";
        let value = snapshot(id, "bm25", &["P01"]);
        persist(&directory, &value).unwrap();
        let store = Benchmarks::open(directory.clone(), directory.clone(), directory.clone());
        let recovered = store.get(id).unwrap();
        assert_eq!(recovered["status"], "interrupted");
        assert_eq!(recovered["result"]["rows"].as_array().unwrap().len(), 1);
        assert!(store.book.lock().unwrap().cancellations.is_empty());
        let second = Benchmarks::open(directory.clone(), directory.clone(), directory.clone());
        assert!(
            second.locked().is_err(),
            "a second server must not own the same execution store"
        );
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn different_approaches_pair_the_same_question() {
        let current = snapshot("current", "dense", &["P01"]);
        let baseline = snapshot("baseline", "bm25", &["P01"]);
        let result = comparison(&current, &baseline);
        assert_eq!(result["compatible"], true);
        assert_eq!(result["pairs"].as_array().unwrap().len(), 1);
        assert_eq!(result["pairs"][0]["current"]["configuration_id"], "dense");
        assert_eq!(result["pairs"][0]["baseline"]["configuration_id"], "bm25");
    }
    #[test]
    fn comparison_reports_coverage_and_only_pairs_shared_questions() {
        let current = snapshot("current", "bm25", &["P01", "P02", "P03"]);
        let baseline = snapshot("baseline", "bm25", &["P03", "P04"]);
        let result = comparison(&current, &baseline);
        assert_eq!(result["pairs"].as_array().unwrap().len(), 1);
        assert_eq!(result["coverage"]["current_cases"], 3);
        assert_eq!(result["coverage"]["baseline_cases"], 2);
        assert_eq!(result["coverage"]["shared_cases"], 1);
    }
    #[test]
    fn comparison_refuses_changed_sources_and_ignores_elapsed_time() {
        let current = snapshot("current", "bm25", &["P01"]);
        let mut baseline = current.clone();
        baseline["result"]["rows"][0]["metrics"]["retrieval_ms"] = json!(999);
        assert_eq!(
            comparison(&current, &baseline)["pairs"][0]["changed"],
            false
        );
        baseline["plan"]["groups"][0]["identity"]["corpus"] = json!("five");
        assert_eq!(comparison(&current, &baseline)["compatible"], false);
    }
    #[test]
    fn runtime_revisions_are_comparable_variants_but_scorer_revisions_are_not() {
        let mut current = snapshot("current", "bm25", &["P01"]);
        current["plan"]["groups"][0]["identity"]["runtime_sha256"] = json!("new-binary");
        let mut baseline = current.clone();
        baseline["plan"]["groups"][0]["identity"]["runtime_sha256"] = json!("old-binary");
        assert_eq!(comparison(&current, &baseline)["compatible"], true);
        baseline["plan"]["groups"][0]["identity"]["scorer"] = json!("changed-grader");
        assert_eq!(comparison(&current, &baseline)["compatible"], false);
    }
    #[test]
    fn missed_expectations_keep_canonical_text_without_becoming_retrieved_hits() {
        let directory = directory();
        let store = Benchmarks::open(directory.clone(), directory.clone(), directory.clone());
        let id = "0123456789abcdef0123456789abcdef";
        let corpus = meedoen_retrieval::corpus::CorpusId::DemoTwelve;
        let section = corpus.sources().unwrap()[10].sections[0].clone();
        let mut value = snapshot(id, "bm25", &["DEMO12-11"]);
        value["plan"]["groups"][0]["identity"]["corpus_sha256"] = json!(corpus.sha256());
        value["result"]["rows"][0]["dataset"] = json!("demo-12-20261118");
        value["result"]["rows"][0]["goals"] = json!([{"alternatives":[[{"source_id":section.source_id,"section_id":section.id,"found":false}]]}]);
        store.book.lock().unwrap().runs.insert(id.into(), value);
        let public = store.get(id).unwrap();
        assert!(
            public["result"]["sources"]
                .as_object()
                .unwrap()
                .values()
                .any(|source| source["text"] == section.text)
        );
        assert_eq!(
            public["result"]["rows"][0]["goals"][0]["alternatives"][0][0]["found"],
            false
        );
        assert!(
            public["result"]["rows"][0]["calls"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn failed_or_missing_execution_output_never_becomes_a_completed_benchmark() {
        for status in ["failed", "queued"] {
            let mut value = snapshot("current", "bm25", &["P01"]);
            value["groups"][0]["status"] = json!(status);
            finish_snapshot(&mut value, "completed", None);
            assert_eq!(value["status"], "failed");
            assert!(value["error"].is_string());
        }
        let mut value = snapshot("current", "bm25", &["P01"]);
        value["groups"][0]["status"] = json!("completed");
        value["result"]["rows"][0]["status"] = json!("failed");
        finish_snapshot(&mut value, "completed", None);
        assert_eq!(
            value["status"], "completed",
            "a failed source assertion is a valid evaluation outcome"
        );
    }
    #[tokio::test]
    async fn graceful_shutdown_stops_owned_worker_and_its_detached_child() {
        let root = directory();
        let script = root.join("evals/benchmark/adapter.ts");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script,r#"import {spawn} from 'node:child_process';
import fs from 'node:fs';import path from 'node:path';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
fs.writeFileSync(path.join(process.argv[4],'child.pid'),String(child.pid));
setInterval(()=>{},1000);"#).unwrap();
        let jobs = Arc::new(Benchmarks::open(
            root.clone(),
            root.join("results"),
            root.join("cache"),
        ));
        let id = "0123456789abcdef0123456789abcdef";
        let mut value = snapshot(id, "bm25", &["P01"]);
        value["status"] = json!("queued");
        let (sender, receiver) = watch::channel(false);
        {
            let mut book = jobs.locked().unwrap();
            book.runs.insert(id.into(), value);
            book.cancellations.insert(id.into(), sender.clone());
        }
        let handle = tokio::spawn(worker(jobs.clone(), id.into(), receiver));
        let pidfile = root.join("results").join(id).join("child.pid");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pidfile.is_file() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let ready = pidfile.is_file();
        jobs.shutdown().await;
        let acknowledged = jobs.shutting_down.load(Ordering::Acquire);
        let stopped = jobs.get(id).unwrap()["status"] == "cancelled";
        // Cleanup also when the missing shutdown implementation fails this test.
        let _ = sender.send(true);
        tokio::time::timeout(Duration::from_secs(12), handle)
            .await
            .unwrap()
            .unwrap();
        let detached = std::fs::read_to_string(&pidfile).unwrap_or_default();
        let process = Command::new("ps")
            .args(["-o", "stat=", "-p", detached.trim()])
            .output()
            .await
            .unwrap();
        let state = String::from_utf8_lossy(&process.stdout);
        let child_stopped = state.trim().is_empty() || state.contains(['Z', 'X']);
        drop(jobs);
        std::fs::remove_dir_all(root).unwrap();
        assert!(
            ready && acknowledged && stopped && child_stopped,
            "server stop must cancel and reap its owned process tree"
        );
    }
}
