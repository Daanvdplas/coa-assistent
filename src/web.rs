mod benchmark_attempts;
mod benchmark_capture;
mod benchmark_report;
mod benchmark_rig;
mod benchmark_sources;
mod benchmarks;
mod eval_jobs;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Redirect},
    routing::{get, post},
};
use meedoen_retrieval::{
    DemoSearchMethod, GUIDED_RETRIEVAL_VERSION, Index,
    codex::AnswerLanguage,
    demo_limits::{Blocked, DemoLimits, client_ip},
    responses::{ResponsesRunner, Search},
    runs::{RunStore, Verdict},
    traces::TraceStore,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
use tokio::sync::Semaphore;
type App = Arc<WebState>;
#[derive(Clone, Debug)]
struct ApiError {
    status: StatusCode,
    body: Value,
    retry_after: Option<u64>,
}
impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let mut response = (self.status, Json(self.body)).into_response();
        if let Some(seconds) = self.retry_after {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, seconds.into());
        }
        response
    }
}
struct Visitor {
    ip: IpAddr,
    session: String,
}
struct WebState {
    corpus: meedoen_retrieval::corpus::CorpusId,
    store: Mutex<RunStore>,
    traces: Option<TraceStore>,
    limits: Mutex<DemoLimits>,
    trusted_proxy: Option<IpAddr>,
    runner: Option<ResponsesRunner>,
    capacity: Arc<Semaphore>,
    runner_error: Option<String>,
    bundled_evaluations: bool,
    guided_retrieval_available: bool,
    manifest: Value,
    sources: Value,
    configuration: Value,
}
fn error(message: impl Into<String>) -> ApiError {
    let message = message.into();
    let status = if message.starts_with("Er draait al een vraag in deze sessie") {
        StatusCode::CONFLICT
    } else {
        StatusCode::BAD_REQUEST
    };
    ApiError {
        status,
        body: json!({"error":message}),
        retry_after: None,
    }
}
fn rate_error(blocked: Blocked) -> ApiError {
    ApiError {
        status: StatusCode::TOO_MANY_REQUESTS,
        body: json!({"error":blocked.message,"code":blocked.code,"retry_after_seconds":blocked.retry_after_seconds}),
        retry_after: Some(blocked.retry_after_seconds),
    }
}
fn visitor_ip(app: &App, headers: &HeaderMap, peer: SocketAddr) -> Result<IpAddr, ApiError> {
    let values = headers.get_all("x-real-ip");
    if app.trusted_proxy == Some(peer.ip()) && values.iter().count() != 1 {
        return Err(error("Ongeldig bezoekersadres van de proxy."));
    }
    client_ip(
        peer.ip(),
        app.trusted_proxy,
        headers
            .get("x-real-ip")
            .and_then(|value| value.to_str().ok()),
    )
    .map_err(error)
}
fn limits_locked(app: &App) -> Result<std::sync::MutexGuard<'_, DemoLimits>, ApiError> {
    app.limits
        .lock()
        .map_err(|_| error("De demo is tijdelijk niet beschikbaar."))
}
fn session(headers: &HeaderMap) -> Result<String, ApiError> {
    headers
        .get("x-test-session")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 100)
        .map(str::to_owned)
        .ok_or_else(|| error("Start eerst een testsessie."))
}
fn locked(app: &App) -> Result<std::sync::MutexGuard<'_, RunStore>, ApiError> {
    let mut store = app
        .store
        .lock()
        .map_err(|_| error("Lokale opslag niet beschikbaar; herstart de demo."))?;
    store.cleanup();
    Ok(store)
}
fn context(app: &App, top_k: usize, language: AnswerLanguage, method: DemoSearchMethod) -> Value {
    let mut configuration = app.configuration.clone();
    configuration["prompt_version"] = json!("responses-activity-v1");
    let mut snapshot = json!({"web_version":"activity-demo-responses-v1","answer_language":language,"retrieval_method":method,"sources":app.manifest["sources"],"as_of":app.manifest["as_of"],"retrieval_manifest":app.manifest,"model_configuration":configuration,"top_k":top_k});
    if method == DemoSearchMethod::Guided {
        snapshot["retrieval_policy"] = json!(GUIDED_RETRIEVAL_VERSION);
    }
    snapshot
}

fn require_retrieval_method(app: &App, method: DemoSearchMethod) -> Result<(), ApiError> {
    if method == DemoSearchMethod::Guided && !app.guided_retrieval_available {
        return Err(error("Gericht zoeken is niet ingeschakeld."));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionRequest {
    #[serde(default)]
    seen_question_ids: Vec<String>,
}
async fn new_session(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<SessionRequest>,
) -> Result<Json<Value>, ApiError> {
    let ip = visitor_ip(&app, &headers, peer)?;
    let mut limits = limits_locked(&app)?;
    let now = Instant::now();
    limits.check_session(ip, now).map_err(rate_error)?;
    let mut store = locked(&app)?;
    let id = store.session(&input.seen_question_ids).map_err(error)?;
    limits.record_session(ip, now);
    Ok(Json(
        json!({"session_id":id,"summary":store.summary(&id).map_err(error)?}),
    ))
}
async fn summary(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        locked(&app)?.summary(&session(&headers)?).map_err(error)?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunRequest {
    question: String,
    #[serde(default)]
    top_k: Option<usize>,
    #[serde(default)]
    answer_language: AnswerLanguage,
    #[serde(default)]
    retrieval_method: DemoSearchMethod,
}
fn start(
    app: App,
    visitor: Visitor,
    question: String,
    top_k: usize,
    parent: Option<String>,
    language: AnswerLanguage,
    method: DemoSearchMethod,
) -> Result<Json<Value>, ApiError> {
    require_retrieval_method(&app, method)?;
    let Visitor { ip, session } = visitor;
    let snapshot = context(&app, top_k, language, method);
    let mut limits = limits_locked(&app)?;
    let now = Instant::now();
    limits.check_run(ip, &session, now).map_err(rate_error)?;
    let permit = app.capacity.clone().try_acquire_owned().map_err(|_| ApiError {
        status: StatusCode::TOO_MANY_REQUESTS,
        body: json!({"error":"Er worden al tien vragen verwerkt. Probeer het straks opnieuw.","code":"capacity"}),
        retry_after: None,
    })?;
    let (run, thread_id) = {
        let mut store = locked(&app)?;
        let thread_id = store.thread_id(&session).map_err(error)?;
        let run = store
            .begin(&session, &question, top_k, snapshot.clone(), parent)
            .map_err(error)?;
        (run, thread_id)
    };
    let trace = match &app.traces {
        Some(traces) => match traces.begin(&thread_id, &run.id, &question, snapshot.clone()) {
            Ok(trace) => Some(trace),
            Err(message) => {
                let _ = locked(&app)?.complete(&session, &run.id, Err(message.clone()));
                return Err(error(message));
            }
        },
        None => None,
    };
    let visitor_permit = limits.record_run(ip, &session, now);
    drop(limits);
    let pending = json!(&run);
    let id = run.id.clone();
    tokio::spawn(async move {
        let _permit = permit;
        let _visitor_permit = visitor_permit;
        let result = if let Some(runner) = &app.runner {
            runner
                .run_traced(&question, top_k, app.corpus, language, method, trace.clone())
                .await
                .and_then(|result| {
                    let mut result = result;
                    let completed_calls = result["tool_calls"]
                        .as_array()
                        .ok_or("tool: Zoekmethode ontbreekt in het zoekresultaat")?;
                    let mut completed_calls = completed_calls.iter().filter(|call| call["status"] == "completed");
                    let first_call = completed_calls.next().ok_or("tool: Zoekmethode ontbreekt in het zoekresultaat")?;
                    let actual = first_call["result"]["retrieval_method"].clone();
                    if actual != snapshot["retrieval_method"] {
                        return Err("tool: Zoekmethode verschilt van de vastgelegde methode.".into());
                    }
                    if method == DemoSearchMethod::Guided {
                        let policy = &snapshot["retrieval_policy"];
                        if std::iter::once(first_call).chain(completed_calls).any(|call| &call["result"]["retrieval_policy"] != policy) {
                            return Err("tool: Zoekbeleid verschilt van het vastgelegde zoekbeleid.".into());
                        }
                        result["retrieval_policy"] = policy.clone();
                    }
                    result["retrieval_method"] = actual;
                    for key in ["sources", "as_of"] {
                        if result[key] != snapshot[key] {
                            return Err("tool: Broncontext verschilt van de vastgelegde bron.".into());
                        }
                    }
                    if result["manifest"] != snapshot["retrieval_manifest"] {
                        return Err("tool: Zoekindex is veranderd; deze run kan niet als dezelfde context worden opgeslagen.".into());
                    }
                    Ok(result)
                })
        } else {
            Err(app
                .runner_error
                .clone()
                .unwrap_or_else(|| "runtime: De antwoordservice is niet beschikbaar.".into()))
        };
        let result = if let Some(trace) = trace {
            match trace.complete(result.as_ref().map_err(String::as_str)) {
                Ok(()) => result,
                Err(error) => Err(error),
            }
        } else {
            result
        };
        if let Ok(mut store) = app.store.lock() {
            let _ = store.complete(&session, &id, result);
        }
    });
    Ok(Json(pending))
}
async fn run(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<RunRequest>,
) -> Result<Json<Value>, ApiError> {
    let ip = visitor_ip(&app, &headers, peer)?;
    start(
        app,
        Visitor {
            ip,
            session: session(&headers)?,
        },
        input.question,
        input.top_k.unwrap_or(3),
        None,
        input.answer_language,
        input.retrieval_method,
    )
}
async fn get_run(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!(
        locked(&app)?.get(&session(&headers)?, &id).map_err(error)?
    )))
}
async fn replay(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if app.runner.is_none() {
        return Err(error(
            "Opnieuw uitvoeren kan niet: de antwoordservice is nog niet ingesteld.",
        ));
    }
    let ip = visitor_ip(&app, &headers, peer)?;
    let session = session(&headers)?;
    let original = locked(&app)?.get(&session, &id).map_err(error)?;
    let language = serde_json::from_value(original.context["answer_language"].clone())
        .unwrap_or(AnswerLanguage::Nl);
    let method = serde_json::from_value(original.context["retrieval_method"].clone())
        .unwrap_or(DemoSearchMethod::Dense);
    require_retrieval_method(&app, method)?;
    let original = locked(&app)?
        .replay(
            &session,
            &id,
            &context(&app, original.top_k, language, method),
        )
        .map_err(error)?;
    start(
        app,
        Visitor { ip, session },
        original.question,
        original.top_k,
        Some(id),
        language,
        method,
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JudgementRequest {
    verdict: Verdict,
}
async fn judge(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<JudgementRequest>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!(
        locked(&app)?
            .judge(&session(&headers)?, &id, input.verdict)
            .map_err(error)?
    )))
}
async fn reveal(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        locked(&app)?
            .reveal(&session(&headers)?, &id)
            .map_err(error)?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiagnosisRequest {
    diagnosis: String,
}
async fn diagnose(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<DiagnosisRequest>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!(
        locked(&app)?
            .diagnose(&session(&headers)?, &id, &input.diagnosis)
            .map_err(error)?
    )))
}
async fn report(State(app): State<App>, headers: HeaderMap) -> Result<impl IntoResponse, ApiError> {
    let summary = locked(&app)?.summary(&session(&headers)?).map_err(error)?;
    let mut text = format!(
        "VIJF VRAGEN — LOKAAL TESTVERSLAG\nBronnen: {} · referentiedatum {}\n\n{} van 5 vragen beoordeeld. Goed: {} · aandacht nodig: {} · onzeker: {} · met voorkennis: {}.\nEerste oordelen blijven behouden. Dit is geen automatische kwaliteitsmeting.\n\n",
        app.manifest["sources"],
        app.manifest["as_of"],
        summary["judged"],
        summary["correct"],
        summary["attention"],
        summary["unsure"],
        summary["informed"]
    );
    for run in summary["runs"].as_array().unwrap() {
        text.push_str(&format!("RUN {}\nVraag: {}\nStatus: {}\nOorspronkelijk oordeel: {}\nProbleemcategorie: {}\nBronhash: {}\nModel: {}\nConfiguratie: {}\nAntwoord: {}\nFout: {}\n\n",run["id"],run["question"],run["status"],run["first_judgement"],run["diagnosis"],run["context"]["retrieval_manifest"]["source_sha256"],run["result"]["model"],run["context"]["model_configuration"],run["result"]["answer"]["text"],run["error"]));
    }
    Ok((
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=meedoen-testverslag.txt",
            ),
        ],
        text,
    ))
}
async fn response_policy(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = request.uri().path();
    let api = path.starts_with("/api/");
    let archive = path == "/api/evals/rag";
    let mut response = next.run(request).await;
    for (name, value) in [
        (
            header::CONTENT_SECURITY_POLICY,
            "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        ),
        (header::X_FRAME_OPTIONS, "DENY"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
    ] {
        response
            .headers_mut()
            .insert(name, axum::http::HeaderValue::from_static(value));
    }
    if api && (!archive || !response.headers().contains_key(header::CACHE_CONTROL)) {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-store"),
        );
    }
    response
}
const BUNDLED_EVALUATIONS: &[u8] = include_bytes!("../evals/rag/site/promptfoo-results.json");

fn bundled_rag_results() -> Result<Bytes, ApiError> {
    static ARCHIVE: OnceLock<Result<Bytes, ApiError>> = OnceLock::new();
    ARCHIVE
        .get_or_init(|| {
            let value = validate_rag_results(BUNDLED_EVALUATIONS)?;
            serde_json::to_vec(&value)
                .map(Bytes::from)
                .map_err(|_| error("Evaluatieresultaten kunnen niet worden gelezen."))
        })
        .clone()
}

async fn rag_evaluation_results(
    State(app): State<App>,
) -> Result<axum::response::Response, ApiError> {
    if app.bundled_evaluations {
        return Ok((
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CACHE_CONTROL, "public, max-age=300"),
            ],
            bundled_rag_results()?,
        )
            .into_response());
    }
    let results = tokio::task::spawn_blocking(|| {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("evals/rag/site/promptfoo-results.json");
        rag_results_from_path(&path)
    })
    .await
    .map_err(|_| error("Evaluatieresultaten zijn nog niet beschikbaar."))??;
    Ok(results.into_response())
}
fn rag_results_from_path(path: &std::path::Path) -> Result<Json<Value>, ApiError> {
    match std::fs::read(path) {
        Ok(bytes) => validate_rag_results(&bytes).map(Json),
        Err(cause)
            if matches!(
                cause.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            validate_rag_results(BUNDLED_EVALUATIONS).map(Json)
        }
        Err(_) => Err(error("Evaluatieresultaten zijn nog niet beschikbaar.")),
    }
}
fn validate_rag_results(bytes: &[u8]) -> Result<Value, ApiError> {
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(error("Evaluatieresultaten zijn te groot."));
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| error("Evaluatieresultaten kunnen niet worden gelezen."))?;
    if value["schema_version"] != 1
        || value["source"] != "promptfoo"
        || !value["evaluations"].is_array()
        || !value["sources"].is_object()
    {
        return Err(error("Evaluatieresultaten hebben een onbekend formaat."));
    }
    Ok(value)
}

#[cfg(test)]
fn router(app: App) -> Router {
    router_with_benchmarks(app, Arc::new(benchmarks::Benchmarks::new()))
}
fn router_with_benchmarks(app: App, benchmarks: Arc<benchmarks::Benchmarks>) -> Router {
    Router::new().route("/",get(||async{Html(include_str!("../static/index.html"))}))
 .route("/demo",get(||async{Redirect::permanent("/")}))
 .route("/demo/",get(||async{Redirect::permanent("/")}))
 .route("/resultaten/",get(||async{Html(include_str!("../evals/rag/site/results.html"))}))
 .route("/benchmark/",get(||async{Html(include_str!("../static/site/benchmark.html"))}))
 .route("/assets/benchmark.js",get(||async{([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../static/site/benchmark.js"))}))
 .route("/assets/benchmark-model.js",get(||async{([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../static/site/benchmark-model.js"))}))
 .route("/assets/benchmark.css",get(||async{([(header::CONTENT_TYPE,"text/css; charset=utf-8")],include_str!("../static/site/benchmark.css"))}))
 .route("/api/benchmarks/catalog",get(benchmarks::catalog))
 .route("/api/benchmarks/plan",post(benchmarks::plan))
 .route("/api/benchmarks/questions/plan",post(benchmarks::question_plan))
 .route("/api/benchmarks/questions/start",post(benchmarks::question_start))
 .route("/api/benchmarks/runs",get(benchmarks::list).post(benchmarks::start))
 .route("/api/benchmarks/runs/{id}",get(benchmarks::get).delete(benchmarks::cancel))
 .route("/api/benchmarks/runs/{id}/discussion",get(benchmarks::discussion))
 .route("/api/benchmarks/compare",get(benchmarks::compare))
 .route("/techniek/",get(||async{Html(include_str!("../static/site/technical.html"))}))
 .route("/assets/site.css",get(||async{([(header::CONTENT_TYPE,"text/css; charset=utf-8")],include_str!("../static/site/site.css"))}))
 .route("/assets/coa-symbol.svg",get(||async{([(header::CONTENT_TYPE,"image/svg+xml")],include_str!("../static/site/coa-symbol.svg"))}))
 .route("/assets/language.js",get(||async{([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../static/site/language.js"))}))
 .route("/assets/demo.js",get(||async{([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../static/site/demo.js"))}))
 .route("/api/evals/rag",get(rag_evaluation_results))
 .route("/api/evals/rag/catalog",get(eval_jobs::catalog))
 .route("/api/evals/rag/runs",post(eval_jobs::start))
 .route("/api/evals/rag/runs/{id}",get(eval_jobs::get).delete(eval_jobs::cancel))
 .route("/assets/eval-runner.js",get(||async{([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../evals/rag/site/eval-runner.js"))}))
 .route("/assets/eval-runner.css",get(||async{([(header::CONTENT_TYPE,"text/css; charset=utf-8")],include_str!("../evals/rag/site/eval-runner.css"))}))
 .route("/assets/promptfoo-results.js",get(||async{([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../evals/rag/site/promptfoo-results.js"))}))
 .route("/assets/results.js",get(||async{([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../evals/rag/site/results.js"))}))
 .route("/assets/results.json",get(||async{([(header::CONTENT_TYPE,"application/json; charset=utf-8")],include_str!("../evals/rag/site/results.json"))}))
 .route("/api/source",get({let app=app.clone();move||{let app=app.clone();async move{Json(json!({"sources":app.sources,"as_of":app.manifest["as_of"],"runtime_ready":app.runner.is_some(),"runtime_error":app.runner_error,"model_configuration":app.configuration,"guided_retrieval_available":app.guided_retrieval_available}))}}}))
 .route("/api/questions",get(||async{Json(serde_json::from_str::<Value>(include_str!("../evals/rag/datasets/garden/questions.json")).unwrap())}))
 .route("/api/session",post(new_session).get(summary)).route("/api/runs",post(run))
 .route("/api/runs/{id}",get(get_run)).route("/api/runs/{id}/replay",post(replay))
 .route("/api/runs/{id}/judgement",post(judge)).route("/api/runs/{id}/criteria",post(reveal))
 .route("/api/runs/{id}/diagnosis",post(diagnose)).route("/api/report",get(report))
 .layer(DefaultBodyLimit::max(8192))
 .layer(axum::Extension(benchmarks))
 .layer(axum::middleware::from_fn(response_policy)).layer(axum::Extension(Arc::new(eval_jobs::EvalJobs::new()))).with_state(app)
}
pub async fn serve(index: Index) -> Result<(), Box<dyn std::error::Error>> {
    let bundled_evaluations =
        std::env::var_os("COA_BUNDLED_EVALUATIONS").is_some_and(|value| value == "1");
    if bundled_evaluations {
        bundled_rag_results().map_err(|error| std::io::Error::other(error.body.to_string()))?;
    }
    let traces = std::env::var_os("COA_TRACE_DB")
        .map(|path| TraceStore::open(std::path::Path::new(&path)))
        .transpose()
        .map_err(std::io::Error::other)?;
    let corpus = index.corpus();
    let guided_retrieval_available = corpus == meedoen_retrieval::corpus::CorpusId::DemoTwelve
        && std::env::var_os("COA_DEMO_GUIDED_RAG").is_some_and(|value| value == "1");
    let manifest = serde_json::to_value(index.manifest())?;
    let sources = serde_json::to_value(index.sources())?;
    let index = Mutex::new(index);
    let search: Search = Arc::new(move |query, top_k, method| {
        index
            .lock()
            .map_err(|_| "Zoekindex is niet beschikbaar.")?
            .search_for_method(query, top_k, method)
    });
    let (runner, runner_error, configuration) = match ResponsesRunner::from_env(search) {
        Ok(runner) => {
            let configuration = runner.configuration();
            (Some(runner), None, configuration)
        }
        Err(error) => (
            None,
            Some(error),
            json!({"status":"unavailable","provider":"openai","transport":"responses_api","model":"gpt-6.1-sol"}),
        ),
    };
    let app = Arc::new(WebState {
        corpus,
        store: Mutex::new(RunStore::new()),
        traces,
        limits: Mutex::new(DemoLimits::default()),
        trusted_proxy: std::env::var("COA_TRUSTED_PROXY_IP")
            .ok()
            .map(|value| value.parse::<IpAddr>())
            .transpose()?,
        capacity: Arc::new(Semaphore::new(10)),
        runner,
        runner_error,
        bundled_evaluations,
        guided_retrieval_available,
        configuration,
        manifest,
        sources,
    });
    let port = std::env::var("COA_PORT")
        .unwrap_or_else(|_| "8766".into())
        .parse::<u16>()?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    eprintln!("Open http://127.0.0.1:{port}/ · OpenAI Responses API + lokale bronzoekfunctie");
    if app.runner.is_none() {
        eprintln!(
            "Antwoordservice niet ingesteld: zet OPENAI_API_KEY in .env of gebruik een externe sleutel; stel ook het gebruiksbudget in."
        );
    }
    let benchmarks = Arc::new(benchmarks::Benchmarks::with_runner(app.runner.clone()));
    axum::serve(
        listener,
        router_with_benchmarks(app, benchmarks.clone())
            .into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(benchmarks))
    .await?;
    Ok(())
}
async fn shutdown_signal(benchmarks: Arc<benchmarks::Benchmarks>) {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("register local server termination signal");
    tokio::select! {
        _=tokio::signal::ctrl_c()=>{},
        _=terminate.recv()=>{},
    }
    benchmarks.shutdown().await;
}
#[cfg(test)]
mod tests {
    use super::*;
    use meedoen_retrieval::AS_OF;

    #[tokio::test]
    async fn benchmark_api_rejects_remote_peers_and_proxy_headers() {
        use tower::ServiceExt;
        for (peer, proxy) in [("203.0.113.5:43000", false), ("127.0.0.1:43000", true)] {
            let app = Arc::new(test_state(
                meedoen_retrieval::corpus::CorpusId::BaselineFive,
            ));
            let mut request = axum::http::Request::builder()
                .uri("/api/benchmarks/runs")
                .extension(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
            if proxy {
                request = request.header("x-forwarded-for", "127.0.0.1");
            }
            let response = router(app)
                .oneshot(request.body(axum::body::Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "benchmark history must remain local"
            );
        }
    }

    #[tokio::test]
    async fn benchmark_mutations_require_the_local_page_origin() {
        use tower::ServiceExt;
        let app = Arc::new(test_state(
            meedoen_retrieval::corpus::CorpusId::BaselineFive,
        ));
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/api/benchmarks/plan")
            .extension(ConnectInfo(
                "127.0.0.1:43000".parse::<SocketAddr>().unwrap(),
            ))
            .header("content-type", "application/json")
            .header("host", "127.0.0.1:8766")
            .header("origin", "https://other.example")
            .body(axum::body::Body::from("{}"))
            .unwrap();
        let response = router(app).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    #[tokio::test]
    async fn discussion_export_uses_local_benchmark_identity() {
        use tower::ServiceExt;
        let directory = std::env::temp_dir().join(format!(
            "coa-discussion-http-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let benchmarks = Arc::new(benchmarks::Benchmarks::open(
            directory.clone(),
            directory.clone(),
            directory.clone(),
        ));
        let app = Arc::new(test_state(
            meedoen_retrieval::corpus::CorpusId::BaselineFive,
        ));
        let response = router_with_benchmarks(app, benchmarks.clone())
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/benchmarks/runs/0123456789abcdef0123456789abcdef/discussion")
                    .header("host", "127.0.0.1:8766")
                    .extension(ConnectInfo(
                        "127.0.0.1:43000".parse::<SocketAddr>().unwrap(),
                    ))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("benchmark_not_found"));
        drop(benchmarks);
        std::fs::remove_dir_all(directory).unwrap();
    }

    fn test_state(corpus: meedoen_retrieval::corpus::CorpusId) -> WebState {
        WebState {
            corpus,
            store: Mutex::new(RunStore::new()),
            traces: None,
            limits: Mutex::new(DemoLimits::default()),
            trusted_proxy: None,
            capacity: Arc::new(Semaphore::new(10)),
            runner: None,
            runner_error: None,
            bundled_evaluations: true,
            guided_retrieval_available: false,
            manifest: json!({}),
            sources: json!([]),
            configuration: json!({}),
        }
    }

    async fn wait_for_unavailable_runtime(app: &App, session: &str, id: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let run = locked(app).unwrap().get(session, id).unwrap();
                if run.status != "pending" {
                    assert_eq!(run.status, "failed");
                    assert!(run.error.as_deref().unwrap().starts_with("runtime:"));
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the unavailable runtime must record its failure");
    }

    async fn request_json(
        app: App,
        method: &str,
        path: &str,
        session: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        request_json_from(
            app,
            "127.0.0.1:43210".parse().unwrap(),
            method,
            path,
            session,
            body,
        )
        .await
    }

    async fn request_json_from(
        app: App,
        peer: SocketAddr,
        method: &str,
        path: &str,
        session: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        use tower::ServiceExt;
        let response = router(app)
            .oneshot(
                axum::http::Request::builder()
                    .extension(ConnectInfo(peer))
                    .method(method)
                    .uri(path)
                    .header("content-type", "application/json")
                    .header("x-test-session", session)
                    .body(axum::body::Body::from(if method == "GET" {
                        String::new()
                    } else {
                        body.to_string()
                    }))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    #[test]
    fn bundled_rag_results_survive_an_unavailable_source_checkout() {
        use std::os::unix::fs::PermissionsExt;
        let missing =
            std::env::temp_dir().join(format!("coa-no-source-results-{}.json", std::process::id()));
        assert!(!missing.exists());
        let result = rag_results_from_path(&missing).unwrap();
        assert_eq!(result.0["source"], "promptfoo");
        assert_eq!(result.0["evaluations"].as_array().unwrap().len(), 7);

        std::fs::write(&missing, b"unreadable source checkout").unwrap();
        std::fs::set_permissions(&missing, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(
            std::fs::read(&missing).unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        let unreadable = rag_results_from_path(&missing);
        std::fs::set_permissions(&missing, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::remove_file(&missing).unwrap();
        assert_eq!(unreadable.unwrap().0, result.0);
    }

    #[test]
    fn present_but_invalid_rag_results_never_fall_back_to_old_data() {
        let file =
            std::env::temp_dir().join(format!("coa-invalid-results-{}.json", std::process::id()));
        std::fs::write(&file, b"invalid JSON").unwrap();
        assert!(rag_results_from_path(&file).is_err());
        std::fs::write(&file, vec![b' '; 32 * 1024 * 1024 + 1]).unwrap();
        assert!(rag_results_from_path(&file).is_err());
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    async fn promptfoo_results_are_available_without_starting_a_model() {
        let app = Arc::new(test_state(meedoen_retrieval::corpus::CorpusId::DemoTwelve));
        use tower::ServiceExt;
        let response = router(app)
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/evals/rag")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=300"
        );
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        let bytes = axum::body::to_bytes(response.into_body(), 32 * 1024 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["source"], "promptfoo");
        assert!(body["evaluations"].is_array());
    }

    #[tokio::test]
    async fn session_creation_spam_is_rejected_without_creating_more_sessions() {
        let app = Arc::new(test_state(meedoen_retrieval::corpus::CorpusId::ExpandedTen));
        for _ in 0..30 {
            let (status, _) =
                request_json(app.clone(), "POST", "/api/session", "", json!({})).await;
            assert_eq!(status, StatusCode::OK);
        }
        let (status, body) = request_json(app, "POST", "/api/session", "", json!({})).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body["code"], "session_limit");
    }
    #[tokio::test]
    async fn demo_quota_counts_accepted_questions_and_reports_the_same_wait_in_header_and_body() {
        use tower::ServiceExt;
        let app = Arc::new(test_state(meedoen_retrieval::corpus::CorpusId::ExpandedTen));
        {
            let mut limits = app.limits.lock().unwrap();
            let now = Instant::now();
            for address in 1..=99 {
                limits.record_run(IpAddr::from([192, 0, 2, address]), "prior", now);
            }
        }
        let (status, session) =
            request_json(app.clone(), "POST", "/api/session", "", json!({})).await;
        assert_eq!(status, StatusCode::OK);
        let session = session["session_id"].as_str().unwrap();
        let (status, _) = request_json(
            app.clone(),
            "POST",
            "/api/runs",
            session,
            json!({"question":""}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, run) = request_json(
            app.clone(),
            "POST",
            "/api/runs",
            session,
            json!({"question":"Which activities are available?"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{run}");
        let id = run["id"].as_str().unwrap();
        wait_for_unavailable_runtime(&app, session, id).await;
        let (status, _) = request_json(
            app.clone(),
            "GET",
            &format!("/api/runs/{id}"),
            session,
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, next_session) =
            request_json(app.clone(), "POST", "/api/session", "", json!({})).await;
        assert_eq!(status, StatusCode::OK);
        let _capacity = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            app.capacity.clone().acquire_many_owned(10),
        )
        .await
        .unwrap()
        .unwrap();
        let response = router(app)
            .oneshot(
                axum::http::Request::builder()
                    .extension(ConnectInfo(SocketAddr::from(([203, 0, 113, 1], 43210))))
                    .method("POST")
                    .uri("/api/runs")
                    .header("content-type", "application/json")
                    .header(
                        "x-test-session",
                        next_session["session_id"].as_str().unwrap(),
                    )
                    .body(axum::body::Body::from(
                        json!({"question":"Which activities are indoors?"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let retry_after = response.headers()[header::RETRY_AFTER]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "demo_rate_limit");
        assert_eq!(body["retry_after_seconds"], retry_after);
        assert!((1..=3600).contains(&retry_after));
    }
    #[test]
    fn duplicate_proxy_headers_are_rejected_and_untrusted_headers_are_ignored() {
        let state = WebState {
            trusted_proxy: Some("127.0.0.1".parse().unwrap()),
            ..test_state(meedoen_retrieval::corpus::CorpusId::ExpandedTen)
        };
        let mut headers = HeaderMap::new();
        headers.append("x-real-ip", "203.0.113.1".parse().unwrap());
        headers.append("x-real-ip", "203.0.113.2".parse().unwrap());
        let app = Arc::new(state);
        assert!(visitor_ip(&app, &headers, "127.0.0.1:1234".parse().unwrap()).is_err());
        let untrusted = Arc::new(test_state(meedoen_retrieval::corpus::CorpusId::ExpandedTen));
        assert_eq!(
            visitor_ip(&untrusted, &headers, "127.0.0.1:1234".parse().unwrap()).unwrap(),
            "127.0.0.1".parse::<IpAddr>().unwrap()
        );
    }
    #[tokio::test]
    async fn responses_prevent_framing_and_api_responses_must_not_be_cached() {
        use tower::ServiceExt;
        let app = Arc::new(test_state(meedoen_retrieval::corpus::CorpusId::ExpandedTen));
        for path in [
            "/",
            "/techniek/",
            "/resultaten/",
            "/demo",
            "/assets/demo.js",
            "/api/source",
            "/api/session",
            "/api/runs/unknown",
            "/api/report",
        ] {
            let response = router(app.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .extension(ConnectInfo(
                            "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
                        ))
                        .uri(path)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let policy = response.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap();
            for directive in [
                "frame-ancestors 'none'",
                "script-src 'self'",
                "connect-src 'self'",
            ] {
                assert!(policy.split(';').any(|value| value.trim() == directive));
            }
            assert_eq!(response.headers()[header::X_FRAME_OPTIONS], "DENY");
            assert_eq!(
                response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                "nosniff"
            );
            assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
            if path.starts_with("/api/") {
                assert_eq!(
                    response
                        .headers()
                        .get(header::CACHE_CONTROL)
                        .and_then(|v| v.to_str().ok()),
                    Some("no-store")
                );
            }
        }
    }
    #[tokio::test]
    async fn ten_provider_requests_overlap_with_isolated_answers_and_eleventh_gets_429() {
        use meedoen_retrieval::responses::ResponsesRunner;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::sync::{Barrier, Semaphore};
        let reached = Arc::new(Barrier::new(11));
        // Permits survive even if released before every barrier waiter resumes.
        let release = Arc::new(Semaphore::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(AtomicUsize::new(0));
        let manifest = json!({"sources":[{"id":"ACT-TUIN-001","date":"2026-10-20"}],"as_of":"2026-11-05","corpus":"synthetic"});
        let callback = {
            let manifest = manifest.clone();
            Arc::new(move |_: &str, _: usize, method| {
                Ok(
                    json!({"sources":manifest["sources"],"as_of":manifest["as_of"],"manifest":manifest,"retrieval_method":method,"hits":[{"section":{"id":"S2","source_id":"ACT-TUIN-001","source_date":"2026-10-20","text":"Dinsdag 10 tot 12."}}]}),
                )
            })
        };
        let provider = Router::new().route("/v1/responses",post({
            let reached=reached.clone(); let release=release.clone(); let active=active.clone(); let maximum=maximum.clone(); let requests=requests.clone();
            move |Json(body): Json<Value>| {
                let reached=reached.clone(); let release=release.clone(); let active=active.clone(); let maximum=maximum.clone(); let requests=requests.clone();
                async move {
                    requests.fetch_add(1,Ordering::SeqCst);
                    let question=body["input"][0]["content"][0]["text"].as_str().unwrap();
                    let output=if body["input"].as_array().unwrap().iter().any(|item| item["type"]=="function_call_output") {
                        json!([{"type":"message","role":"assistant","content":[{"type":"output_text","text":json!({"text":question,"citations":[{"source_id":"ACT-TUIN-001","source_date":"2026-10-20","section_id":"S2","quote":"Dinsdag 10 tot 12."}],"unknowns":[]}).to_string()}]}])
                    } else {
                        let n=active.fetch_add(1,Ordering::SeqCst)+1;
                        maximum.fetch_max(n,Ordering::SeqCst);
                        reached.wait().await;
                        release.acquire().await.unwrap().forget();
                        active.fetch_sub(1,Ordering::SeqCst);
                        json!([{"type":"function_call","call_id":"one","name":"search_document","arguments":json!({"query":question,"top_k":3,"search_goal":"Begintijden opzoeken"}).to_string()}])
                    };
                    Json(json!({"status":"completed","model":"gpt-6.1-sol","output":output,"usage":{"input_tokens":100,"output_tokens":30}}))
                }
            }
        })).route("/v1/responses/input_tokens",post(||async{Json(json!({"object":"response.input_tokens","input_tokens":1}))}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let provider = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
        let api_key = "coa-local-test-key";
        let runner = ResponsesRunner::new(api_key.into(), &endpoint, callback).unwrap();
        let app = Arc::new(WebState {
            configuration: runner.configuration(),
            runner: Some(runner),
            manifest,
            ..test_state(meedoen_retrieval::corpus::CorpusId::ExpandedTen)
        });
        let mut visitors = Vec::new();
        for i in 0..11 {
            let peer = SocketAddr::from(([192, 0, 2, i + 1], 43210));
            let (status, session) =
                request_json_from(app.clone(), peer, "POST", "/api/session", "", json!({})).await;
            assert_eq!(status, StatusCode::OK);
            let session = session["session_id"].as_str().unwrap().to_owned();
            let (status,run)=request_json_from(app.clone(),peer,"POST","/api/runs",&session,json!({"question":format!("Visitor {i}"),"answer_language":if i%2==0{"nl"}else{"en"},"retrieval_method":if i%2==0{"dense"}else{"bm25"}})).await;
            if i == 0 {
                let (status, extra_session) =
                    request_json_from(app.clone(), peer, "POST", "/api/session", "", json!({}))
                        .await;
                assert_eq!(status, StatusCode::OK);
                let (status, blocked) = request_json_from(
                    app.clone(),
                    peer,
                    "POST",
                    "/api/runs",
                    extra_session["session_id"].as_str().unwrap(),
                    json!({"question":"Another question from the same visitor"}),
                )
                .await;
                assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
                assert_eq!(blocked["code"], "visitor_busy");
            }
            if i == 10 {
                assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
                assert_eq!(run["code"], "capacity");
                assert!(!run.to_string().contains(api_key));
            } else {
                assert_eq!(status, StatusCode::OK);
                visitors.push((session, run["id"].as_str().unwrap().to_owned()));
            }
        }
        tokio::time::timeout(std::time::Duration::from_secs(3), reached.wait())
            .await
            .expect("all ten HTTP provider requests must arrive before any completes");
        assert_eq!(maximum.load(Ordering::SeqCst), 10);
        let (status, _) = request_json(
            app.clone(),
            "POST",
            "/api/runs",
            &visitors[0].0,
            json!({"question":"Duplicate active question"}),
        )
        .await;
        assert!(status == StatusCode::CONFLICT || status == StatusCode::TOO_MANY_REQUESTS);
        release.add_permits(10);
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if app.capacity.available_permits() == 10 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            app.limits
                .lock()
                .unwrap()
                .check_run("192.0.2.1".parse().unwrap(), "new-session", Instant::now())
                .is_ok()
        );
        for (i, (session, id)) in visitors.iter().enumerate() {
            let (status, run) = request_json(
                app.clone(),
                "GET",
                &format!("/api/runs/{id}"),
                session,
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(run["status"], "completed", "{run}");
            assert!(!run.to_string().contains(api_key));
            assert_eq!(run["result"]["answer"]["text"], format!("Visitor {i}"));
            assert_eq!(
                run["result"]["tool_calls"][0]["query"],
                format!("Visitor {i}")
            );
            assert_eq!(run["result"]["transport"], "responses_api");
            let (foreign, _) = request_json(
                app.clone(),
                "GET",
                &format!("/api/runs/{id}"),
                &visitors[(i + 1) % 10].0,
                Value::Null,
            )
            .await;
            assert_ne!(foreign, StatusCode::OK);
        }
        // Slots are free again, but neither a new session, forged forwarding
        // identity nor the legacy replay endpoint may bypass the hourly quota.
        let peer = SocketAddr::from(([192, 0, 2, 1], 43210));
        {
            let mut limits = app.limits.lock().unwrap();
            for index in 1..10 {
                limits.record_run(peer.ip(), &format!("prior-{index}"), Instant::now());
            }
        }
        let (_, fresh) =
            request_json_from(app.clone(), peer, "POST", "/api/session", "", json!({})).await;
        use tower::ServiceExt;
        let response = router(app.clone())
            .oneshot(
                axum::http::Request::builder()
                    .extension(ConnectInfo(peer))
                    .method("POST")
                    .uri("/api/runs")
                    .header("content-type", "application/json")
                    .header("x-test-session", fresh["session_id"].as_str().unwrap())
                    .header("x-real-ip", "203.0.113.42")
                    .header("x-forwarded-for", "203.0.113.43")
                    .body(axum::body::Body::from(
                        json!({"question":"Quota bypass attempt"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response.headers().contains_key(header::RETRY_AFTER));
        let bytes = axum::body::to_bytes(response.into_body(), 8192)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "ip_rate_limit");
        assert!(body["retry_after_seconds"].as_u64().unwrap() <= 3600);
        let (status, body) = request_json_from(
            app.clone(),
            peer,
            "POST",
            &format!("/api/runs/{}/replay", visitors[0].1),
            &visitors[0].0,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body["code"], "ip_rate_limit");
        assert_eq!(
            requests.load(Ordering::SeqCst),
            20,
            "rejections must never contact the provider"
        );
        provider.abort();
    }
    #[tokio::test]
    async fn eval_catalog_stays_readable_and_reports_local_run_permission() {
        use tower::ServiceExt;
        let app = Arc::new(test_state(
            meedoen_retrieval::corpus::CorpusId::BaselineFive,
        ));
        for (header, expected) in [
            (None, true),
            (Some(("x-real-ip", "203.0.113.5")), false),
            (Some(("x-forwarded-for", "203.0.113.5")), false),
            (Some(("forwarded", "for=203.0.113.5")), false),
        ] {
            let mut request = axum::http::Request::builder()
                .extension(ConnectInfo(
                    "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
                ))
                .uri("/api/evals/rag/catalog");
            if let Some((name, value)) = header {
                request = request.header(name, value);
            }
            let response = router(app.clone())
                .oneshot(request.body(axum::body::Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), 128 * 1024)
                .await
                .unwrap();
            let catalog: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(catalog["can_run"], expected);
            let evaluations = catalog["evals"].as_array().unwrap();
            assert_eq!(evaluations.len(), 12);
            let questions: std::collections::BTreeSet<_> = evaluations
                .iter()
                .map(|row| row["question"].as_str().unwrap())
                .collect();
            assert_eq!(
                questions.len(),
                12,
                "Canonical cards must not duplicate legacy question text"
            );
            assert!(evaluations.iter().any(|row| row["case_id"] == "RAG26-01"));
            assert!(
                evaluations.iter().any(|row| row["case_id"] == "IND26-01"
                    && row["dataset"] == "regression-12-20261118")
            );
            assert!(
                !evaluations
                    .iter()
                    .any(|row| row["case_id"] == "P01" || row["case_id"] == "T02")
            );
            assert_eq!(catalog["embedding_models"][0]["available"], true);
        }
    }

    #[tokio::test]
    async fn learning_site_routes_share_navigation_and_only_expose_curated_assets() {
        use tower::ServiceExt;
        let corpus = meedoen_retrieval::corpus::CorpusId::ExpandedTen;
        let app = Arc::new(test_state(corpus));
        for path in [
            "/",
            "/resultaten/",
            "/benchmark/",
            "/techniek/",
            "/assets/site.css",
            "/assets/coa-symbol.svg",
            "/assets/results.js",
            "/assets/language.js",
            "/assets/demo.js",
            "/assets/benchmark.js",
            "/assets/benchmark-model.js",
            "/assets/benchmark.css",
            "/assets/results.json",
        ] {
            let response = router(app.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .extension(ConnectInfo(
                            "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
                        ))
                        .uri(path)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::OK,
                "missing site route {path}"
            );
            let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
                .await
                .unwrap();
            let text = String::from_utf8(bytes.to_vec()).unwrap();
            if path.ends_with('/') {
                let navigation = text.split("</nav>").next().unwrap();
                if matches!(path, "/resultaten/" | "/benchmark/") {
                    assert!(
                        navigation.contains("/resultaten/") && navigation.contains("/benchmark/"),
                        "evaluation pages share their own navigation"
                    );
                    assert!(
                        !navigation.contains("/techniek/") && !navigation.contains("href=\"/\""),
                        "demo and explanation stay outside the evaluation presentation"
                    );
                } else {
                    assert!(
                        navigation.contains("href=\"/\"") && navigation.contains("/techniek/"),
                        "missing shared navigation in {path}"
                    );
                    assert!(
                        !navigation.contains("/resultaten/") && !navigation.contains("/benchmark/"),
                        "evaluation navigation must not change the demo presentation in {path}"
                    );
                }
            }
            if path == "/" {
                assert!(
                    text.contains("id=\"form\""),
                    "root must render the demo directly"
                );
                assert!(!text.contains("home-intro"));
            }
            assert!(!text.contains("/private/tmp/"));
            assert!(!text.contains("/Users/"));
        }
        for alias in ["/demo", "/demo/"] {
            let response = router(app.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .extension(ConnectInfo(
                            "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
                        ))
                        .uri(alias)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
            assert_eq!(response.headers()[header::LOCATION], "/");
        }
        let response = router(app)
            .oneshot(
                axum::http::Request::builder()
                    .extension(ConnectInfo(
                        "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
                    ))
                    .uri("/assets/PREREGISTRATION.json")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    #[tokio::test]
    async fn expanded_source_reader_exposes_ten_sources_and_its_reference_date() {
        use tower::ServiceExt;
        let corpus = meedoen_retrieval::corpus::CorpusId::ExpandedTen;
        let app = Arc::new(WebState {
            manifest: json!({"as_of": corpus.as_of(), "source_sha256": corpus.sha256()}),
            sources: serde_json::to_value(corpus.sources().unwrap()).unwrap(),
            ..test_state(corpus)
        });
        let response = router(app)
            .oneshot(
                axum::http::Request::builder()
                    .extension(ConnectInfo(
                        "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
                    ))
                    .uri("/api/source")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["as_of"], "2026-11-05");
        let sources = value["sources"].as_array().unwrap();
        assert_eq!(sources.len(), 10);
        assert_eq!(
            sources
                .iter()
                .map(|source| source["sections"].as_array().unwrap().len())
                .sum::<usize>(),
            60
        );
        assert_eq!(sources[0]["date"], "2026-10-20");
        assert_eq!(sources[9]["date"], "2026-11-05");
        assert!(!String::from_utf8_lossy(&bytes).contains("evidence_alternatives"));
    }
    #[tokio::test]
    async fn source_reader_returns_five_activity_documents_without_gold() {
        use tower::ServiceExt;
        let sources =
            meedoen_retrieval::source::parse_sources(meedoen_retrieval::DOCUMENTS).unwrap();
        let app = Arc::new(WebState {
            sources: serde_json::to_value(sources).unwrap(),
            ..test_state(meedoen_retrieval::corpus::CorpusId::BaselineFive)
        });
        let response = router(app)
            .oneshot(
                axum::http::Request::builder()
                    .extension(ConnectInfo(
                        "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
                    ))
                    .uri("/api/source")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["sources"].as_array().unwrap().len(), 5);
        assert_eq!(value["sources"][0]["date"], "2026-10-20");
        assert_eq!(value["sources"][1]["date"], "2026-10-18");
        assert!(!String::from_utf8_lossy(&bytes).contains("required_source_ids"));
    }
    #[tokio::test]
    async fn api_history_and_export_share_safe_metadata_for_success_failure_and_timeout() {
        use meedoen_retrieval::codex::CodexRun;
        use tower::ServiceExt;
        let app = Arc::new(WebState {
            manifest: json!({"source_sha256":"synthetic-source-hash","sources":[]}),
            configuration: json!({"model":"test-model","binaries":{"codex":"synthetic-fingerprint"}}),
            ..test_state(meedoen_retrieval::corpus::CorpusId::BaselineFive)
        });
        let (session, ids) = {
            let mut store = app.store.lock().unwrap();
            let session = store.session(&[]).unwrap();
            let snapshot = context(&app, 3, AnswerLanguage::Nl, DemoSearchMethod::Dense);
            // Legacy private metadata is not part of the exported CodexRun schema.
            let result: CodexRun = serde_json::from_value(json!({
                "id":"synthetic-result", "status":"completed", "question":"Wanneer tuinieren?",
                "answer":{"text":"Dinsdag 10–12.","citations":[],"unknowns":[]},
                "tool_calls":[],"sources":[],"as_of":AS_OF,"manifest":{},
                "client_version":"codex-cli 0.163.0","model":"test-model","elapsed_ms":1,
                "runtime_path":"/Users/FAKE-PRIVATE-HOME/codex"
            }))
            .unwrap();
            let results = [
            Ok(serde_json::to_value(result).unwrap()),
            Err("runtime: Codex exited unsuccessfully; check authentication and runtime configuration".into()),
            Err("runtime: Codex run timed out".into()),
        ];
            let mut ids = Vec::new();
            for result in results {
                let run = store
                    .begin(&session, "Wanneer tuinieren?", 3, snapshot.clone(), None)
                    .unwrap();
                store.complete(&session, &run.id, result).unwrap();
                assert!(store.replay(&session, &run.id, &snapshot).is_ok());
                let mut changed = snapshot.clone();
                changed["model_configuration"]["binaries"]["codex"] = json!("changed-fingerprint");
                assert!(store.replay(&session, &run.id, &changed).is_err());
                ids.push(run.id);
            }
            (session, ids)
        };
        let routes = [
            "/api/session".to_string(),
            format!("/api/runs/{}", ids[0]),
            format!("/api/runs/{}", ids[1]),
            format!("/api/runs/{}", ids[2]),
            "/api/report".to_string(),
        ];
        for path in routes {
            let response = router(app.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .extension(ConnectInfo(
                            "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
                        ))
                        .uri(&path)
                        .header("x-test-session", &session)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap();
            let text = String::from_utf8(bytes.to_vec()).unwrap();
            assert!(!text.contains("FAKE-PRIVATE"), "private metadata in {path}");
            assert!(!text.contains("runtime_path"), "host path field in {path}");
            assert!(
                text.contains("synthetic-fingerprint"),
                "fingerprint missing in {path}"
            );
            assert!(
                text.contains("Wanneer tuinieren?"),
                "question missing in {path}"
            );
        }
    }

    #[tokio::test]
    async fn api_keeps_answer_language_in_context_and_replay_contract() {
        use tower::ServiceExt;
        for (requested, expected) in [
            (None, AnswerLanguage::Nl),
            (Some("nl"), AnswerLanguage::Nl),
            (Some("en"), AnswerLanguage::En),
            (Some("fr"), AnswerLanguage::Nl),
        ] {
            let app = Arc::new(WebState {
                manifest: json!({"sources":[],"as_of":"2026-11-05"}),
                configuration: json!({"prompt_version":"ten-activity-grounding-v1"}),
                ..test_state(meedoen_retrieval::corpus::CorpusId::ExpandedTen)
            });
            let session = locked(&app).unwrap().session(&[]).unwrap();
            let mut body = json!({"question":"When can I join?"});
            if let Some(language) = requested {
                body["answer_language"] = json!(language);
            }
            let response = router(app.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .extension(ConnectInfo(
                            "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
                        ))
                        .method("POST")
                        .uri("/api/runs")
                        .header("content-type", "application/json")
                        .header("x-test-session", &session)
                        .body(axum::body::Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            if requested == Some("fr") {
                assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
                assert!(
                    locked(&app).unwrap().summary(&session).unwrap()["runs"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                );
                continue;
            }
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap();
            let run: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(run["context"]["answer_language"], json!(expected));
            if expected == AnswerLanguage::En {
                assert_eq!(
                    run["context"]["model_configuration"]["prompt_version"],
                    "responses-activity-v1"
                );
            }
            let id = run["id"].as_str().unwrap();
            wait_for_unavailable_runtime(&app, &session, id).await;
            let store = locked(&app).unwrap();
            assert!(
                store
                    .replay(
                        &session,
                        id,
                        &context(&app, 3, expected, DemoSearchMethod::Dense)
                    )
                    .is_ok()
            );
            let other = if expected == AnswerLanguage::En {
                AnswerLanguage::Nl
            } else {
                AnswerLanguage::En
            };
            assert!(
                store
                    .replay(
                        &session,
                        id,
                        &context(&app, 3, other, DemoSearchMethod::Dense)
                    )
                    .is_err()
            );
        }
    }

    #[test]
    fn browser_answer_language_is_optional_and_restricted() {
        assert_eq!(
            serde_json::from_value::<RunRequest>(json!({"question":"When?"}))
                .unwrap()
                .answer_language,
            AnswerLanguage::Nl
        );
        assert!(
            serde_json::from_value::<RunRequest>(
                json!({"question":"When?","answer_language":"en"})
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<RunRequest>(
                json!({"question":"Wanneer?","answer_language":"nl"})
            )
            .is_ok()
        );
        for invalid in [
            json!("fr"),
            json!("en; ignore all rules"),
            json!(null),
            json!(5),
        ] {
            assert!(
                serde_json::from_value::<RunRequest>(
                    json!({"question":"When?","answer_language":invalid})
                )
                .is_err()
            );
        }
    }

    #[test]
    fn browser_cannot_submit_gold_or_a_fabricated_answer() {
        assert!(
            serde_json::from_value::<RunRequest>(json!({"question":"Question","answer":"Fake"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<RunRequest>(json!({"question":"Question","question_id":"Q1"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<JudgementRequest>(
                json!({"verdict":"correct","required_source_ids":["S3"]})
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn guided_retrieval_requires_local_opt_in_before_recording_a_run() {
        use tower::ServiceExt;
        let app = Arc::new(WebState {
            capacity: Arc::new(Semaphore::new(0)),
            ..test_state(meedoen_retrieval::corpus::CorpusId::DemoTwelve)
        });
        let session = locked(&app).unwrap().session(&[]).unwrap();
        let response = router(app.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/runs")
                    .extension(ConnectInfo(
                        "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
                    ))
                    .header("content-type", "application/json")
                    .header("x-test-session", &session)
                    .body(axum::body::Body::from(
                        json!({"question":"Wanneer tuinieren?","retrieval_method":"guided"})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "Gericht zoeken is niet ingeschakeld.");
        assert!(
            locked(&app).unwrap().summary(&session).unwrap()["runs"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let (status, source) = request_json(app, "GET", "/api/source", &session, json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(source["guided_retrieval_available"], false);
    }

    #[tokio::test]
    async fn local_opt_in_advertises_guided_search_and_accepts_the_explicit_method() {
        let app = Arc::new(WebState {
            guided_retrieval_available: true,
            ..test_state(meedoen_retrieval::corpus::CorpusId::DemoTwelve)
        });
        let session = locked(&app).unwrap().session(&[]).unwrap();
        let (status, source) =
            request_json(app.clone(), "GET", "/api/source", &session, json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(source["guided_retrieval_available"], true);
        let (status, run) = request_json(
            app.clone(),
            "POST",
            "/api/runs",
            &session,
            json!({"question":"Wanneer tuinieren?","retrieval_method":"guided"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(run["context"]["retrieval_method"], "guided");
        assert_eq!(run["context"]["retrieval_policy"], GUIDED_RETRIEVAL_VERSION);
        wait_for_unavailable_runtime(&app, &session, run["id"].as_str().unwrap()).await;
    }

    #[tokio::test]
    async fn disabled_guided_search_refuses_replay_before_admission() {
        let search: Search = Arc::new(|_, _, _| panic!("disabled replay must not search"));
        let runner = ResponsesRunner::new(
            "coa-local-test-key".into(),
            "http://127.0.0.1:1/v1/responses",
            search,
        )
        .unwrap();
        let app = Arc::new(WebState {
            runner: Some(runner),
            capacity: Arc::new(Semaphore::new(0)),
            ..test_state(meedoen_retrieval::corpus::CorpusId::DemoTwelve)
        });
        let (session, run) = {
            let mut store = locked(&app).unwrap();
            let session = store.session(&[]).unwrap();
            let snapshot = context(&app, 3, AnswerLanguage::Nl, DemoSearchMethod::Guided);
            let run = store
                .begin(&session, "Wanneer tuinieren?", 3, snapshot, None)
                .unwrap();
            store
                .complete(
                    &session,
                    &run.id,
                    Err("synthetic runtime unavailable".into()),
                )
                .unwrap();
            (session, run)
        };
        let (status, body) = request_json(
            app,
            "POST",
            &format!("/api/runs/{}/replay", run.id),
            &session,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Gericht zoeken is niet ingeschakeld.");
    }

    #[test]
    fn guided_replay_is_bound_to_the_retrieval_policy_version() {
        let app = Arc::new(test_state(meedoen_retrieval::corpus::CorpusId::DemoTwelve));
        let method = serde_json::from_value(json!("guided")).unwrap();
        let snapshot = context(&app, 3, AnswerLanguage::Nl, method);
        assert_eq!(snapshot["retrieval_method"], "guided");
        assert!(
            snapshot["retrieval_policy"]
                .as_str()
                .is_some_and(|version| !version.is_empty())
        );
        let mut store = locked(&app).unwrap();
        let session = store.session(&[]).unwrap();
        let run = store
            .begin(&session, "Wanneer tuinieren?", 3, snapshot.clone(), None)
            .unwrap();
        store
            .complete(
                &session,
                &run.id,
                Err("synthetic runtime unavailable".into()),
            )
            .unwrap();
        assert!(store.replay(&session, &run.id, &snapshot).is_ok());
        let mut changed = snapshot;
        changed["retrieval_policy"] = json!("different-version");
        assert!(store.replay(&session, &run.id, &changed).is_err());
    }

    #[tokio::test]
    async fn demo_retrieval_method_is_validated_and_frozen_before_execution() {
        use tower::ServiceExt;
        for requested in [None, Some("dense"), Some("bm25"), Some("hybrid_rrf")] {
            let app = Arc::new(WebState {
                manifest: json!({"sources":[],"as_of":"2026-11-05"}),
                configuration: json!({"prompt_version":"ten-activity-grounding-v1"}),
                ..test_state(meedoen_retrieval::corpus::CorpusId::ExpandedTen)
            });
            let session = locked(&app).unwrap().session(&[]).unwrap();
            let mut body = json!({"question":"Wanneer tuinieren?","top_k":6});
            if let Some(method) = requested {
                body["retrieval_method"] = json!(method);
            }
            let response = router(app.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .extension(ConnectInfo(
                            "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
                        ))
                        .method("POST")
                        .uri("/api/runs")
                        .header("content-type", "application/json")
                        .header("x-test-session", &session)
                        .body(axum::body::Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            if requested == Some("hybrid_rrf") {
                assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
                assert!(
                    locked(&app).unwrap().summary(&session).unwrap()["runs"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                );
                continue;
            }
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap();
            let run: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                run["context"]["retrieval_method"],
                requested.unwrap_or("dense")
            );
            assert_eq!(run["context"]["top_k"], 6);
            let id = run["id"].as_str().unwrap();
            wait_for_unavailable_runtime(&app, &session, id).await;
            let store = locked(&app).unwrap();
            let frozen = run["context"].clone();
            assert!(store.replay(&session, id, &frozen).is_ok());
            let mut changed = frozen;
            changed["retrieval_method"] = json!(if requested == Some("bm25") {
                "dense"
            } else {
                "bm25"
            });
            assert!(store.replay(&session, id, &changed).is_err());
        }
    }
}
