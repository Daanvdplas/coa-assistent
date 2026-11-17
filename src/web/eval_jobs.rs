//! Bounded local retrieval evaluations; no answer-model execution route.
use super::*;
use axum::Extension;
use meedoen_retrieval::retrieval_lab::embedding_models::ModelChoice;
use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path as FilePath, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{process::Command, sync::watch};

const TIMEOUT: Duration = Duration::from_secs(300);
const WINDOW: Duration = Duration::from_secs(3600);
const MAX_LOG: u64 = 1024 * 1024;
const EVALS: [(&str, &str, &str); 3] = [
    (
        "garden-time-location",
        "P01",
        "Tijd en locatie van tuinieren",
    ),
    ("indoor-tuesday", "T02", "Binnen op dinsdag"),
    ("two-activities", "T05", "Twee activiteiten plannen"),
];

fn reject(status: StatusCode, code: &str, message: &str) -> ApiError {
    ApiError {
        status,
        body: json!({"code":code,"error":message}),
        retry_after: None,
    }
}
fn require_origin(headers: &HeaderMap, allowed: &[String]) -> Result<(), ApiError> {
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let valid = allowed.iter().any(|value| value == origin)
        && origin
            .parse::<axum::http::Uri>()
            .ok()
            .and_then(|uri| uri.authority().map(|value| value.as_str().to_string()))
            .as_deref()
            == Some(host);
    if valid {
        Ok(())
    } else {
        Err(reject(
            StatusCode::FORBIDDEN,
            "eval_origin",
            "Start de zoektest vanaf de eigen evaluatiepagina.",
        ))
    }
}
fn require_local(peer: SocketAddr, headers: &HeaderMap) -> Result<(), ApiError> {
    if !peer.ip().is_loopback()
        || [
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-real-ip",
        ]
        .iter()
        .any(|name| headers.contains_key(*name))
    {
        Err(reject(
            StatusCode::FORBIDDEN,
            "eval_local_only",
            "Start deze lokale zoektest rechtstreeks op deze computer, zonder doorstuurproxy.",
        ))
    } else {
        Ok(())
    }
}
fn owner(app: &App, headers: &HeaderMap) -> Result<String, ApiError> {
    let owner = headers
        .get("x-session-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 100)
        .ok_or_else(|| error("Start eerst een testsessie."))?
        .to_owned();
    locked(app)?.summary(&owner).map_err(error)?;
    Ok(owner)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Start {
    eval_id: String,
    method: String,
    embedding_model: String,
}
impl Start {
    fn validate(&self) -> Result<(), ApiError> {
        if !EVALS.iter().any(|row| row.0 == self.eval_id)
            || !["dense", "bm25", "hybrid_rrf", "hybrid_weighted"].contains(&self.method.as_str())
            || self.embedding_model.parse::<ModelChoice>().is_err()
        {
            return Err(reject(
                StatusCode::BAD_REQUEST,
                "eval_selection",
                "Kies een bestaande zoektest, zoekmethode en embeddingmodel.",
            ));
        }
        Ok(())
    }
}
struct Entry {
    owner: String,
    snapshot: Value,
    cancel: watch::Sender<bool>,
    created: Instant,
}
#[derive(Default)]
struct Book {
    entries: BTreeMap<String, Entry>,
    active: Option<String>,
    visitors: BTreeMap<IpAddr, VecDeque<Instant>>,
}
pub(super) struct EvalJobs {
    book: Mutex<Book>,
    root: PathBuf,
    cache: PathBuf,
    allowed: Vec<String>,
}
impl EvalJobs {
    pub(super) fn new() -> Self {
        let port = std::env::var("COA_PORT").unwrap_or_else(|_| "8766".into());
        let allowed = vec![
            format!("http://127.0.0.1:{port}"),
            format!("http://localhost:{port}"),
        ];

        Self {
            book: Mutex::new(Book::default()),
            root: FilePath::new(env!("CARGO_MANIFEST_DIR")).into(),
            cache: std::env::var_os("COA_RAG_MODEL_CACHE")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::current_dir()
                        .unwrap_or_default()
                        .join(".model-cache")
                }),
            allowed,
        }
    }
    fn get(&self, owner: &str, id: &str) -> Result<Value, ApiError> {
        let book = self
            .book
            .lock()
            .map_err(|_| error("Zoektests zijn tijdelijk niet beschikbaar."))?;
        book.entries
            .get(id)
            .filter(|entry| entry.owner == owner)
            .map(|entry| entry.snapshot.clone())
            .ok_or_else(|| {
                reject(
                    StatusCode::NOT_FOUND,
                    "eval_not_found",
                    "Deze zoektest bestaat niet in deze sessie.",
                )
            })
    }
    fn update(&self, id: &str, status: &str, result: Option<Value>, failure: Option<(&str, &str)>) {
        if let Ok(mut book) = self.book.lock()
            && let Some(entry) = book.entries.get_mut(id)
        {
            entry.snapshot["status"] = json!(status);
            if let Some(result) = result {
                let identity = result["rows"][0]["embedding_identity"].clone();
                entry.snapshot["embedding_identity"] = identity.clone();
                entry.snapshot["embedding_model"] = if identity.is_object() {
                    entry.snapshot["requested_embedding_model"].clone()
                } else {
                    Value::Null
                };
                entry.snapshot["corpus_identity"] = result["rows"][0]["corpus_identity"].clone();
                entry.snapshot["result"] = result;
            }
            if let Some((code, message)) = failure {
                entry.snapshot["error"] = json!({"code":code,"message":message});
            }
            if matches!(status, "completed" | "failed" | "cancelled") {
                entry.snapshot["progress"] = json!({"completed":1,"total":1});
                book.active = None;
            }
        }
    }
    fn reserve(
        &self,
        owner: &str,
        ip: IpAddr,
        input: &Start,
    ) -> Result<(String, watch::Receiver<bool>), ApiError> {
        input.validate()?;
        let mut book = self
            .book
            .lock()
            .map_err(|_| error("Zoektests zijn tijdelijk niet beschikbaar."))?;
        let now = Instant::now();
        book.entries.retain(|_, entry| {
            now.duration_since(entry.created) < Duration::from_secs(1800)
                || matches!(
                    entry.snapshot["status"].as_str(),
                    Some("preparing" | "running")
                )
        });
        book.visitors.retain(|_, times| {
            while times
                .front()
                .is_some_and(|time| now.duration_since(*time) >= WINDOW)
            {
                times.pop_front();
            }
            !times.is_empty()
        });
        if book.active.is_some() {
            return Err(reject(
                StatusCode::TOO_MANY_REQUESTS,
                "eval_busy",
                "Er draait al een zoektest. Probeer het na afloop opnieuw.",
            ));
        }
        if book
            .visitors
            .get(&ip)
            .is_some_and(|times| times.len() >= 60)
            || (book.visitors.len() >= 1024 && !book.visitors.contains_key(&ip))
        {
            return Err(reject(
                StatusCode::TOO_MANY_REQUESTS,
                "eval_rate_limit",
                "Dit netwerk kan maximaal zestig zoektests per uur starten.",
            ));
        }
        if book.visitors.get(&ip).is_some_and(|times| {
            times
                .iter()
                .filter(|time| now.duration_since(**time) < Duration::from_secs(60))
                .count()
                >= 5
        }) {
            let mut failure = reject(
                StatusCode::TOO_MANY_REQUESTS,
                "eval_burst_limit",
                "Je kunt maximaal vijf lokale zoektests per minuut starten. Wacht even en probeer opnieuw.",
            );
            failure.retry_after = Some(60);
            return Err(failure);
        }
        if book.entries.len() >= 20
            && let Some(oldest) = book
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.created)
                .map(|(id, _)| id.clone())
        {
            book.entries.remove(&oldest);
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| error("De zoektest kon niet worden gestart."))?;
        let id = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let (tx, rx) = watch::channel(false);
        let snapshot = json!({"run_id":id,"eval_id":input.eval_id,"method":input.method,"requested_embedding_model":input.embedding_model,"embedding_model":null,"embedding_identity":null,"status":"preparing","progress":{"completed":0,"total":1}});
        book.entries.insert(
            id.clone(),
            Entry {
                owner: owner.into(),
                snapshot,
                cancel: tx,
                created: now,
            },
        );
        book.active = Some(id.clone());
        book.visitors.entry(ip).or_default().push_back(now);
        Ok((id, rx))
    }
}

pub(super) async fn catalog(
    Extension(jobs): Extension<Arc<EvalJobs>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Json<Value> {
    let can_run = require_local(peer, &headers).is_ok();
    let questions = serde_json::from_str::<Value>(include_str!(
        "../../evals/shared/datasets/legacy/questions.json"
    ))
    .unwrap();
    let heldout = serde_json::from_str::<Value>(include_str!(
        "../../evals/shared/datasets/legacy/heldout-questions.json"
    ))
    .unwrap();
    let labels = serde_json::from_str::<Value>(include_str!(
        "../../evals/shared/datasets/legacy/expectations.json"
    ))
    .unwrap();
    let heldout_labels = serde_json::from_str::<Value>(include_str!(
        "../../evals/shared/datasets/legacy/heldout-expectations.json"
    ))
    .unwrap();
    let sources = meedoen_retrieval::corpus::CorpusId::BaselineFive
        .sources()
        .unwrap();
    let evaluations:Vec<_>=EVALS.iter().map(|(id,case,title)| {
        let question=questions["cases"].as_array().unwrap().iter().chain(heldout["cases"].as_array().unwrap()).find(|row|row["id"]==*case).unwrap();
        let criteria=labels["cases"].as_array().unwrap().iter().chain(heldout_labels["cases"].as_array().unwrap()).find(|row|row["case_id"]==*case).unwrap();
        let goals:Vec<_>=criteria["facts"].as_array().unwrap().iter().filter(|fact|fact["evidence_alternatives"].as_array().is_some_and(|value|!value.is_empty())).map(|fact| {
            let alternatives:Vec<Vec<Value>>=fact["evidence_alternatives"].as_array().unwrap().iter().map(|option|option.as_array().unwrap().iter().map(|reference| {
                let source=sources.iter().find(|source|source.id==reference["source_id"].as_str().unwrap()).unwrap();
                let section=source.sections.iter().find(|section|section.id==reference["section_id"].as_str().unwrap()).unwrap();
                json!({"source_id":source.id,"section_id":section.id,"source_title":source.title,"source_date":source.date,"heading":section.heading,"text":section.text})
            }).collect()).collect();
            json!({"id":fact["id"],"description":fact["description"],"alternatives":alternatives})
        }).collect();
        json!({"id":id,"title":title,"question":question["question"],"description":"Een vaste vraag op vijf fictieve activiteiten. Hetzelfde corpus en dezelfde bronverwachtingen voor iedere vergelijking.","question_count":1,"top_k":5,"context_token_limit":1200,"corpus":{"document_count":5,"section_count":30,"as_of":"2026-10-20"},"expected_goals":goals})
    }).collect();
    let models:Vec<_>=ModelChoice::all().iter().map(|model|json!({"id":model.id(),"label":model.spec().label,"repository":model.spec().repository,"dimensions":model.spec().dimensions,"available":true,"cached":model.cached(&jobs.cache)})).collect();
    Json(
        json!({"schema_version":1,"can_run":can_run,"evals":evaluations,"methods":[{"id":"dense","label":"Op betekenis","uses_embeddings":true},{"id":"bm25","label":"Op woorden","uses_embeddings":false},{"id":"hybrid_rrf","label":"Combinatie op volgorde","uses_embeddings":true},{"id":"hybrid_weighted","label":"Gewogen combinatie","uses_embeddings":true}],"embedding_models":models,"default_method":"dense","default_embedding_model":"minilm-multilingual"}),
    )
}
pub(super) async fn start(
    State(app): State<App>,
    Extension(jobs): Extension<Arc<EvalJobs>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<Start>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    require_local(peer, &headers)?;
    require_origin(&headers, &jobs.allowed)?;
    let owner = owner(&app, &headers)?;
    let ip = visitor_ip(&app, &headers, peer)?;
    let (id, cancel) = jobs.reserve(&owner, ip, &input)?;
    let snapshot = jobs.get(&owner, &id)?;
    tokio::spawn(worker(jobs, id, input, cancel));
    Ok((StatusCode::ACCEPTED, Json(snapshot)))
}
pub(super) async fn get(
    State(app): State<App>,
    Extension(jobs): Extension<Arc<EvalJobs>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(jobs.get(&owner(&app, &headers)?, &id)?))
}
pub(super) async fn cancel(
    State(app): State<App>,
    Extension(jobs): Extension<Arc<EvalJobs>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_local(peer, &headers)?;
    require_origin(&headers, &jobs.allowed)?;
    let owner = owner(&app, &headers)?;
    let snapshot = jobs.get(&owner, &id)?;
    let book = jobs
        .book
        .lock()
        .map_err(|_| error("Zoektests zijn tijdelijk niet beschikbaar."))?;
    if let Some(entry) = book.entries.get(&id) {
        let _ = entry.cancel.send(true);
    }
    Ok(Json(snapshot))
}

#[derive(Clone)]
struct OwnedProcess {
    pid: i32,
    parent: i32,
    started: String,
    running: bool,
}
fn processes() -> Vec<OwnedProcess> {
    let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,lstart=,stat="])
        .output()
    else {
        return vec![];
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let values: Vec<_> = line.split_whitespace().collect();
            if values.len() < 8 {
                return None;
            }
            Some(OwnedProcess {
                pid: values[0].parse().ok()?,
                parent: values[1].parse().ok()?,
                started: values[2..7].join(" "),
                running: !values[7].contains(['Z', 'X']),
            })
        })
        .collect()
}
fn descendants(root: u32) -> Vec<OwnedProcess> {
    let all = processes();
    let mut ids = vec![root as i32];
    let mut next = 0;
    while next < ids.len() {
        let parent = ids[next];
        for process in &all {
            if process.parent == parent && !ids.contains(&process.pid) {
                ids.push(process.pid);
            }
        }
        next += 1;
    }
    all.into_iter()
        .filter(|process| ids.contains(&process.pid))
        .collect()
}
fn still_owned(process: &OwnedProcess, current: &[OwnedProcess]) -> bool {
    current.iter().any(|actual| {
        actual.pid == process.pid && actual.started == process.started && actual.running
    })
}
async fn stop(child: &mut tokio::process::Child, pid: u32) {
    let owned = descendants(pid);
    let current = processes();
    for process in owned
        .iter()
        .rev()
        .filter(|process| still_owned(process, &current))
    {
        unsafe {
            libc::kill(process.pid, libc::SIGINT);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        let current = processes();
        if !owned.iter().any(|process| still_owned(process, &current)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let current = processes();
    for process in owned
        .iter()
        .rev()
        .filter(|process| still_owned(process, &current))
    {
        unsafe {
            libc::kill(process.pid, libc::SIGKILL);
        }
    }
    // Await the outer worker too, even if it exited before a detached descendant.
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline
        && owned
            .iter()
            .any(|process| still_owned(process, &processes()))
    {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
async fn worker(jobs: Arc<EvalJobs>, id: String, input: Start, mut cancel: watch::Receiver<bool>) {
    let result = execute(&jobs, &id, &input, &mut cancel).await;
    match result {
        Ok(Some(value)) => jobs.update(&id, "completed", Some(value), None),
        Ok(None) => jobs.update(&id, "cancelled", None, None),
        Err(code) => jobs.update(
            &id,
            "failed",
            None,
            Some((
                code,
                if code == "eval_timeout" {
                    "De zoektest duurde te lang en is gestopt."
                } else {
                    "De lokale zoektest kon niet worden afgerond. Probeer opnieuw."
                },
            )),
        ),
    }
}
async fn execute(
    jobs: &EvalJobs,
    id: &str,
    input: &Start,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<Value>, &'static str> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let directory = jobs.root.join("evals/rag/results/local/browser").join(id);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)
        .map_err(|_| "eval_storage")?;
    let out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join("stdout.log"))
        .map_err(|_| "eval_storage")?;
    let err = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join("stderr.log"))
        .map_err(|_| "eval_storage")?;
    let binary = std::env::current_exe().map_err(|_| "eval_runtime")?;
    let mut command = Command::new("node");
    command
        .arg(jobs.root.join("evals/rag/scripts/run_promptfoo.mjs"))
        .args([
            "--suite",
            "browser",
            "--eval-id",
            &input.eval_id,
            "--methods",
            &input.method,
            "--embedding-model",
            &input.embedding_model,
            "--no-publish",
            "--binary",
        ])
        .arg(binary)
        .arg("--model-cache")
        .arg(&jobs.cache)
        .arg("--output-dir")
        .arg(&directory)
        .current_dir(&jobs.root)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .kill_on_drop(true)
        .process_group(0);
    for key in [
        "OPENAI_API_KEY",
        "COA_OPENAI_API_KEY_FILE",
        "COA_RESPONSES_TEST_URL",
        "COA_PROMPTFOO_ALLOW_CODEX",
        "COA_PROMPTFOO_LEDGER",
        "COA_PROMPTFOO_PHASE",
        "COA_PROMPTFOO_CASES",
        "COA_PROMPTFOO_MODELS",
        "COA_PROMPTFOO_DATASET",
        "COA_PROMPTFOO_PROFILES",
        "COA_PROMPTFOO_REPEATS",
        "COA_PROMPTFOO_EMBEDDING_MANIFEST",
        "COA_PROMPTFOO_EMBEDDING_MANIFEST_SHA256",
    ] {
        command.env_remove(key);
    }
    let mut child = command.spawn().map_err(|_| "eval_runtime")?;
    let pid = child.id().ok_or("eval_runtime")?;
    let timeout = tokio::time::sleep(TIMEOUT);
    tokio::pin!(timeout);
    let mut ticks = tokio::time::interval(Duration::from_millis(150));
    let status = loop {
        tokio::select! {
            result=child.wait()=>{break result.map_err(|_|"eval_runtime")?;},
            _=cancel.changed()=>{stop(&mut child,pid).await;return Ok(None);},
            _=&mut timeout=>{stop(&mut child,pid).await;return Err("eval_timeout");},
            _=ticks.tick()=>{
                if ["stdout.log","stderr.log"].iter().any(|name|std::fs::metadata(directory.join(name)).is_ok_and(|metadata|metadata.len()>MAX_LOG)){stop(&mut child,pid).await;return Err("eval_output_limit");}
                if directory.join("browser-prepared.json").is_file(){jobs.update(id,"running",None,None);}
            }
        }
    };
    if *cancel.borrow() {
        return Ok(None);
    }
    if ![Some(0), Some(100)].contains(&status.code()) {
        return Err("eval_runtime");
    }
    let path = directory.join("browser-view.json");
    if std::fs::metadata(&path).map_err(|_| "eval_output")?.len() > 2 * MAX_LOG {
        return Err("eval_output_limit");
    }
    let value: Value = serde_json::from_slice(&std::fs::read(path).map_err(|_| "eval_output")?)
        .map_err(|_| "eval_output")?;
    let rows = value["rows"].as_array().ok_or("eval_output")?;
    let expected = EVALS.iter().find(|row| row.0 == input.eval_id).unwrap();
    if rows.len() != 1
        || rows[0]["case_id"] != expected.1
        || rows[0]["dataset"] != "legacy"
        || rows[0]["configuration"]["method"] != input.method
        || !matches!(rows[0]["status"].as_str(), Some("passed" | "failed"))
        || !rows[0]["source_complete"].is_boolean()
    {
        return Err("eval_integrity");
    }
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_fixed_local_selections_reserve_work_and_results_remain_owner_scoped() {
        let jobs = EvalJobs::new();
        let ip = "127.0.0.1".parse().unwrap();
        let input = Start {
            eval_id: "garden-time-location".into(),
            method: "bm25".into(),
            embedding_model: "minilm-multilingual".into(),
        };
        let mut invalid = input.clone();
        invalid.eval_id = "models".into();
        assert!(jobs.reserve("alice", ip, &invalid).is_err());
        invalid = input.clone();
        invalid.embedding_model = "gpt-6.1-sol".into();
        assert!(jobs.reserve("alice", ip, &invalid).is_err());
        assert!(jobs.book.lock().unwrap().entries.is_empty());
        let (id, _cancel) = jobs.reserve("alice", ip, &input).unwrap();
        assert_eq!(jobs.get("alice", &id).unwrap()["status"], "preparing");
        assert_eq!(
            jobs.get("bob", &id).unwrap_err().status,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            jobs.reserve("bob", ip, &input).unwrap_err().status,
            StatusCode::TOO_MANY_REQUESTS
        );
        jobs.update(&id, "cancelled", None, None);
        assert!(jobs.reserve("bob", ip, &input).is_ok());
        assert!(serde_json::from_value::<Start>(json!({"eval_id":"garden-time-location","method":"bm25","embedding_model":"minilm-multilingual","command":"codex"})).is_err());
    }

    #[test]
    fn completed_quick_jobs_still_count_toward_the_bounded_network_rate() {
        let jobs = EvalJobs::new();
        let ip = "127.0.0.1".parse().unwrap();
        let input = Start {
            eval_id: "garden-time-location".into(),
            method: "bm25".into(),
            embedding_model: "e5-small-multilingual".into(),
        };
        for _ in 0..12 {
            for _ in 0..5 {
                let (id, _) = jobs.reserve("alice", ip, &input).unwrap();
                jobs.update(&id, "completed", None, None);
            }
            for time in jobs.book.lock().unwrap().visitors.get_mut(&ip).unwrap() {
                *time = Instant::now() - Duration::from_secs(61);
            }
        }
        assert_eq!(
            jobs.reserve("new-session", ip, &input).unwrap_err().body["code"],
            "eval_rate_limit"
        );
    }

    #[tokio::test]
    async fn cancellation_reaps_a_detached_child_when_its_parent_exits_first() {
        let directory = std::env::temp_dir().join(format!(
            "coa-eval-cancel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let pidfile = directory.join("child.pid");
        let script = r#"const {spawn}=require('node:child_process');
const fs=require('node:fs');
const child=spawn(process.execPath,['-e',"process.on('SIGINT',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);"#;
        let mut child = Command::new("node")
            .args(["-e", script])
            .arg(&pidfile)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let mut canary = Command::new("sleep").arg("60").spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pidfile.is_file() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let detached = std::fs::read_to_string(&pidfile)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let root = child.id().unwrap();
        stop(&mut child, root).await;
        let still_alive = processes()
            .iter()
            .any(|process| process.pid == detached && process.running);
        if still_alive {
            unsafe {
                libc::kill(detached, libc::SIGKILL);
            }
        }
        assert!(
            canary.try_wait().unwrap().is_none(),
            "Unrelated processes must remain untouched"
        );
        canary.kill().await.unwrap();
        let _ = canary.wait().await;
        std::fs::remove_dir_all(directory).unwrap();
        assert!(
            !still_alive,
            "Detached inference child must be stopped even when the outer worker exits on SIGINT"
        );
    }

    #[test]
    fn proxied_or_remote_requests_never_authorize_local_evaluation_work() {
        let mut headers = HeaderMap::new();
        let local = "127.0.0.1:12345".parse().unwrap();
        assert!(require_local(local, &headers).is_ok());
        assert!(require_local("203.0.113.9:12345".parse().unwrap(), &headers).is_err());
        for name in [
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-real-ip",
        ] {
            headers.insert(name, "127.0.0.1".parse().unwrap());
            assert!(require_local(local, &headers).is_err());
            headers.remove(name);
        }
    }
    #[test]
    fn a_short_burst_is_limited_before_the_hourly_allowance_is_exhausted() {
        let jobs = EvalJobs::new();
        let ip = "127.0.0.1".parse().unwrap();
        let input = Start {
            eval_id: "garden-time-location".into(),
            method: "bm25".into(),
            embedding_model: "minilm-multilingual".into(),
        };
        for _ in 0..5 {
            let (id, _) = jobs.reserve("alice", ip, &input).unwrap();
            jobs.update(&id, "completed", None, None);
        }
        assert_eq!(
            jobs.reserve("alice", ip, &input).unwrap_err().body["code"],
            "eval_burst_limit"
        );
    }

    #[test]
    fn evaluation_starts_require_the_actual_allowed_browser_origin_and_host() {
        let allowed = vec!["http://127.0.0.1:8789".to_string()];
        let mut headers = HeaderMap::new();
        headers.insert("host", "127.0.0.1:8789".parse().unwrap());
        headers.insert("origin", "https://untrusted.invalid".parse().unwrap());
        assert!(
            require_origin(&headers, &allowed).is_err(),
            "Foreign sites must not start local evaluation work"
        );
        headers.insert("origin", "http://127.0.0.1:8789".parse().unwrap());
        assert!(require_origin(&headers, &allowed).is_ok());
        headers.insert("host", "untrusted.invalid".parse().unwrap());
        assert!(require_origin(&headers, &allowed).is_err());
        headers.remove("origin");
        assert!(require_origin(&headers, &allowed).is_err());
    }
}
