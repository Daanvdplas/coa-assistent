//! The web demo's Rig agent, with a bounded, stateless Responses API transport.
//! CLI and experiment entry points continue to use the separate Codex runner.
mod rig_runtime;
mod transport;
use crate::{
    DemoSearchMethod,
    codex::{AnswerLanguage, ToolCall},
    corpus::CorpusId,
    experiment::types::TokenUsage,
};
use reqwest::{
    Client, Url,
    header::{AUTHORIZATION, HeaderMap, HeaderValue},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io::Read, path::Path, sync::Arc, time::Duration};

const ENDPOINT: &str = "https://api.openai.com/v1/responses";
const MODEL: &str = "gpt-6.1-sol";
const RUNTIME_VERSION: &str = "rig-0.46.0";
const MAX_SEARCHES: usize = 4;
const MAX_PROVIDER_REQUESTS: usize = 5;
const TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_HISTORY_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_TOKENS: usize = 4096;
const MAX_INPUT_TOKENS: u64 = 300_000;
const MAX_COUNT_BYTES: usize = 16 * 1024;
const MOCK_KEY: &str = "coa-local-test-key";
pub type Search = Arc<dyn Fn(&str, usize, DemoSearchMethod) -> Result<Value, String> + Send + Sync>;

#[derive(Clone)]
pub struct ResponsesRunner {
    client: Client,
    endpoint: Url,
    provider: rig::providers::openai::OpenAIConfig,
    search: Search,
    timeout: Duration,
    offline: bool,
    budget: Option<Arc<crate::demo_budget::AttemptBudget>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArguments {
    query: String,
    top_k: usize,
    search_goal: String,
}
impl ResponsesRunner {
    /// Endpoints are restricted to OpenAI or an explicit loopback development server.
    /// The web factory below never sends a real credential to a test endpoint.
    pub fn new(api_key: String, endpoint: &str, search: Search) -> Result<Self, String> {
        let endpoint = Url::parse(endpoint).map_err(|_| "runtime: Ongeldig API-adres.")?;
        let offline = endpoint.scheme() == "http"
            && matches!(endpoint.host_str(), Some("127.0.0.1" | "[::1]" | "::1"));
        if (endpoint.as_str() != ENDPOINT && !offline)
            || endpoint.path() != "/v1/responses"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
        {
            return Err("runtime: API-adres is niet toegestaan.".into());
        }
        let key = validate_key(api_key)?;
        let provider = rig::providers::openai::OpenAIConfig::new(key.clone())
            .with_base_url(endpoint.as_str().trim_end_matches("/responses"));
        if offline && (!cfg!(debug_assertions) || key != MOCK_KEY) {
            return Err("runtime: Een lokale test accepteert uitsluitend de vaste testsleutel in een debugbuild.".into());
        }
        let mut bearer = HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| "runtime: Ongeldige API-sleutel.")?;
        bearer.set_sensitive(true);
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, bearer);
        let client = Client::builder()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(10))
            .timeout(TIMEOUT)
            .build()
            .map_err(|_| "runtime: Antwoordservice kan niet worden gestart.")?;
        Ok(Self {
            client,
            endpoint,
            provider,
            search,
            timeout: TIMEOUT,
            offline,
            budget: None,
        })
    }
    pub fn from_env(search: Search) -> Result<Self, String> {
        if let Ok(url) = std::env::var("COA_RESPONSES_TEST_URL") {
            if !cfg!(debug_assertions) || !url.starts_with("http://") {
                return Err(
                    "runtime: Testconfiguratie is alleen lokaal in een debugbuild toegestaan."
                        .into(),
                );
            }
            // Never read a user's real API key in offline test mode.
            let mut runner = Self::new(MOCK_KEY.into(), &url, search)?;
            if !runner.offline {
                return Err("runtime: Testadres moet loopback zijn.".into());
            }
            if let Ok(value) = std::env::var("COA_RESPONSES_TEST_TIMEOUT_MS") {
                let milliseconds = value
                    .parse::<u64>()
                    .ok()
                    .filter(|n| (1..=120_000).contains(n))
                    .ok_or("runtime: Ongeldige testdeadline.")?;
                runner.timeout = Duration::from_millis(milliseconds);
            }
            runner.budget = configured_budget(false)?;
            return Ok(runner);
        }
        let key = match std::env::var("OPENAI_API_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty())
        {
            Some(key) => key,
            None => match std::env::var_os("COA_OPENAI_API_KEY_FILE") {
                Some(path) => read_key(Path::new(&path))?,
                None => dotenv_key()?.ok_or("runtime: De antwoordservice is nog niet ingesteld. Een OpenAI API-sleutel ontbreekt.")?,
            },
        };
        let mut runner = Self::new(key, ENDPOINT, search)?;
        runner.budget = configured_budget(true)?;
        Ok(runner)
    }
    pub fn configuration(&self) -> Value {
        json!({"provider":"openai","transport":"responses_api","runtime":RUNTIME_VERSION,"model":MODEL,"reasoning_effort":"low","store":false,"prompt_version":"responses-activity-v4","max_searches":MAX_SEARCHES,"max_provider_requests":MAX_PROVIDER_REQUESTS,"max_input_token_preflights":MAX_PROVIDER_REQUESTS,"max_input_tokens_per_request":MAX_INPUT_TOKENS,"budget_policy_version":crate::demo_budget::POLICY_VERSION,"max_output_tokens_per_request":MAX_OUTPUT_TOKENS,"timeout_ms":self.timeout.as_millis(),"offline_mock":self.offline})
    }
    pub async fn run(
        &self,
        query: &str,
        top_k: usize,
        corpus: CorpusId,
        language: AnswerLanguage,
        method: DemoSearchMethod,
    ) -> Result<Value, String> {
        let query = crate::validate_query(query).map_err(|_| "input: Ongeldige vraag.")?;
        crate::ranking::validate_top_k(top_k)
            .map_err(|_| "input: Ongeldig aantal bronpassages.")?;
        tokio::time::timeout(
            self.timeout,
            self.run_inner(&query, top_k, corpus, language, method),
        )
        .await
        .map_err(|_| "runtime: De antwoordservice heeft te lang gewacht.".to_owned())?
    }
    async fn run_inner(
        &self,
        query: &str,
        top_k: usize,
        corpus: CorpusId,
        language: AnswerLanguage,
        method: DemoSearchMethod,
    ) -> Result<Value, String> {
        rig_runtime::run(self, query, top_k, corpus, language, method).await
    }
}

fn dotenv_key() -> Result<Option<String>, String> {
    if std::env::var("COA_DISABLE_DOTENV").as_deref() == Ok("1") {
        return Ok(None);
    }
    // Read only the local key without mutating the multithreaded process's
    // environment or importing budget/test configuration from the file.
    let entries = match dotenvy::from_path_iter(".env") {
        Ok(entries) => entries,
        Err(error) if error.not_found() => return Ok(None),
        Err(_) => return Err("runtime: Het .env-bestand kan niet worden gelezen.".into()),
    };
    let mut key = None;
    for entry in entries {
        let (name, value) =
            entry.map_err(|_| "runtime: Het .env-bestand kan niet worden gelezen.")?;
        if name == "OPENAI_API_KEY" && key.is_none() && !value.trim().is_empty() {
            key = Some(value);
        }
    }
    Ok(key)
}

fn configured_budget(
    required: bool,
) -> Result<Option<Arc<crate::demo_budget::AttemptBudget>>, String> {
    let Some(path) = std::env::var_os("COA_DEMO_BUDGET_FILE") else {
        return if required {
            Err("budget: Stel eerst het gebruiksbudget voor de antwoordservice in.".into())
        } else {
            Ok(None)
        };
    };
    crate::demo_budget::AttemptBudget::open(Path::new(&path))
        .map(|budget| Some(Arc::new(budget)))
        .map_err(|_| "budget: Het gebruiksbudget is niet beschikbaar of al in gebruik.".into())
}

fn validate_key(key: String) -> Result<String, String> {
    let key = key.trim();
    if !(16..=4096).contains(&key.len()) || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("runtime: Ongeldige API-sleutel.".into());
    }
    Ok(key.to_owned())
}
fn read_key(path: &Path) -> Result<String, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| "runtime: Het API-sleutelbestand is niet beschikbaar.")?;
        let meta = file
            .metadata()
            .map_err(|_| "runtime: Het API-sleutelbestand is niet beschikbaar.")?;
        if !meta.is_file()
            || meta.nlink() != 1
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o077 != 0
        {
            return Err("runtime: Het API-sleutelbestand moet een eigen regulier bestand met rechten 0600 zijn.".into());
        }
        let mut key = String::new();
        (&mut file)
            .take(4097)
            .read_to_string(&mut key)
            .map_err(|_| "runtime: Het API-sleutelbestand kan niet worden gelezen.")?;
        validate_key(key)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err("runtime: Gebruik OPENAI_API_KEY op dit systeem.".into())
    }
}
fn add_usage(total: &mut Option<TokenUsage>, value: &Value) {
    let current = (|| {
        Some(TokenUsage {
            input_tokens: value["input_tokens"].as_u64()?,
            output_tokens: value["output_tokens"].as_u64()?,
            cached_input_tokens: value["input_tokens_details"]["cached_tokens"].as_u64(),
            reasoning_output_tokens: value["output_tokens_details"]["reasoning_tokens"].as_u64(),
        })
    })();
    *total = total
        .as_ref()
        .zip(current.as_ref())
        .and_then(|(sum, current)| {
            Some(TokenUsage {
                input_tokens: sum.input_tokens.checked_add(current.input_tokens)?,
                output_tokens: sum.output_tokens.checked_add(current.output_tokens)?,
                cached_input_tokens: sum
                    .cached_input_tokens
                    .zip(current.cached_input_tokens)
                    .and_then(|(a, b)| a.checked_add(b)),
                reasoning_output_tokens: sum
                    .reasoning_output_tokens
                    .zip(current.reasoning_output_tokens)
                    .and_then(|(a, b)| a.checked_add(b)),
            })
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, extract::State, routing::post};
    use serde_json::{Value, json};
    use std::{
        collections::VecDeque,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    fn evidence(method: crate::DemoSearchMethod) -> Value {
        json!({"sources":[{"id":"ACT-TUIN-001","date":"2026-10-20"}],"as_of":"2026-11-05","manifest":{"corpus":"synthetic-ten"},"retrieval_method":method,"hits":[{"section":{"source_id":"ACT-TUIN-001","source_date":"2026-10-20","id":"S2","text":"Iedere dinsdag van 10.00 tot 12.00 uur."},"similarity":0.8}]})
    }
    fn search() -> Search {
        Arc::new(|_, _, method| Ok(evidence(method)))
    }
    fn envelope(output: Value) -> Value {
        json!({"id":"resp_synthetic","object":"response","status":"completed","model":"gpt-6.1-sol","output":output,"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":20},"output_tokens":25,"output_tokens_details":{"reasoning_tokens":5}}})
    }
    fn call(id: &str, query: &str) -> Value {
        json!({"type":"function_call","id":format!("fc_{id}"),"call_id":id,"name":"search_document","arguments":json!({"query":query,"top_k":3,"search_goal":"Begintijden opzoeken"}).to_string(),"status":"completed"})
    }
    fn final_answer() -> Value {
        json!({"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":json!({"text":"Dinsdag van 10 tot 12 uur.","citations":[{"source_id":"ACT-TUIN-001","source_date":"2026-10-20","section_id":"S2","quote":"Iedere dinsdag van 10.00 tot 12.00 uur."}],"unknowns":[]}).to_string(),"annotations":[]}]})
    }
    fn count_stub<S: Clone + Send + Sync + 'static>() -> axum::routing::MethodRouter<S> {
        post(|| async { Json(json!({"object":"response.input_tokens","input_tokens":1})) })
    }
    async fn mock(
        responses: Vec<Value>,
    ) -> (String, Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
        let (url, seen, _, task) = mock_with_counts(responses, None).await;
        (url, seen, task)
    }
    async fn mock_with_counts(
        responses: Vec<Value>,
        counts: Option<Vec<Value>>,
    ) -> (
        String,
        Arc<Mutex<Vec<Value>>>,
        Arc<Mutex<Vec<Value>>>,
        tokio::task::JoinHandle<()>,
    ) {
        type Script = (
            Arc<Mutex<VecDeque<Value>>>,
            Arc<Mutex<Vec<Value>>>,
            Arc<Mutex<Option<VecDeque<Value>>>>,
            Arc<Mutex<Vec<Value>>>,
        );
        async fn respond(
            State((script, seen, _, _)): State<Script>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            seen.lock().unwrap().push(body);
            Json(
                script
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("no unexpected provider requests"),
            )
        }
        async fn count(
            State((_, _, script, seen)): State<Script>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            seen.lock().unwrap().push(body);
            Json(match script.lock().unwrap().as_mut() {
                Some(script) => script.pop_front().expect("no unexpected count requests"),
                None => json!({"object":"response.input_tokens","input_tokens":1}),
            })
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        let count_seen = Arc::new(Mutex::new(Vec::new()));
        let script = Arc::new(Mutex::new(responses.into()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let app = Router::new()
            .route("/v1/responses", post(respond))
            .route("/v1/responses/input_tokens", post(count))
            .with_state((
                script,
                seen.clone(),
                Arc::new(Mutex::new(counts.map(Into::into))),
                count_seen.clone(),
            ));
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (endpoint, seen, count_seen, task)
    }
    async fn run(runner: &ResponsesRunner) -> Result<Value, String> {
        runner
            .run(
                "Wanneer tuinieren?",
                3,
                crate::corpus::CorpusId::ExpandedTen,
                crate::codex::AnswerLanguage::En,
                crate::DemoSearchMethod::Bm25,
            )
            .await
    }

    #[tokio::test]
    async fn preflight_counts_the_exact_replayed_input_and_blocks_an_oversized_second_turn() {
        let first = envelope(json!([
            {"type":"reasoning","id":"rs_count","summary":[],"encrypted_content":"synthetic-encrypted-private"},
            call("one", "tuinieren tijd")
        ]));
        let (url, seen, counts, task) = mock_with_counts(
            vec![first, envelope(json!([final_answer()]))],
            Some(vec![
                json!({"object":"response.input_tokens","input_tokens":300000}),
                json!({"object":"response.input_tokens","input_tokens":300001}),
            ]),
        )
        .await;
        let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
        assert!(
            run(&runner).await.is_err(),
            "An oversized count must stop before generating the next turn"
        );
        let requests = seen.lock().unwrap();
        let counted = counts.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(counted.len(), 2);
        for key in [
            "model",
            "input",
            "instructions",
            "tools",
            "text",
            "reasoning",
            "tool_choice",
            "parallel_tool_calls",
        ] {
            assert_eq!(
                counted[0].get(key),
                requests[0].get(key),
                "Count and generation differ for {key}"
            );
        }
        assert!(
            counted[1]
                .to_string()
                .contains("synthetic-encrypted-private")
        );
        assert!(
            counted[1]["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["type"] == "function_call_output")
        );
        assert_eq!(requests[0]["service_tier"], "default");
        assert_eq!(requests[0]["max_output_tokens"], 4096);
        assert_eq!(requests[0]["prompt_cache_options"]["ttl"], "30m");
        task.abort();
    }

    #[tokio::test]
    async fn failed_or_untrusted_counts_never_start_generation_or_expose_private_diagnostics() {
        for count in [
            Value::Null,
            json!({"object":"wrong","input_tokens":1}),
            json!({"object":"response.input_tokens","input_tokens":0}),
            json!({"object":"response.input_tokens","input_tokens":-1}),
            json!({"object":"response.input_tokens","input_tokens":1.0}),
            json!({"object":"response.input_tokens","input_tokens":"1"}),
            json!({"object":"response.input_tokens","input_tokens":1,"unexpected":"private-count-detail"}),
        ] {
            let (url, generations, counts, task) =
                mock_with_counts(vec![], Some(vec![count])).await;
            let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
            let error = run(&runner).await.unwrap_err();
            assert!(generations.lock().unwrap().is_empty());
            assert_eq!(counts.lock().unwrap().len(), 1);
            assert!(!error.contains("private-count-detail"));
            task.abort();
        }
        use axum::{http::StatusCode, response::IntoResponse};
        for (status, body) in [
            (StatusCode::UNAUTHORIZED, "private-count-key".to_owned()),
            (
                StatusCode::TOO_MANY_REQUESTS,
                "private-count-key".to_owned(),
            ),
            (
                StatusCode::TEMPORARY_REDIRECT,
                "private-count-key".to_owned(),
            ),
            (StatusCode::OK, "{\"private-count-key\":".to_owned()),
            (
                StatusCode::OK,
                format!(
                    "{}{}",
                    json!({"object":"response.input_tokens","input_tokens":1}),
                    " ".repeat(MAX_COUNT_BYTES)
                ),
            ),
        ] {
            let generations = Arc::new(AtomicUsize::new(0));
            let seen = generations.clone();
            let app = Router::new()
                .route(
                    "/v1/responses/input_tokens",
                    post(move || {
                        let body = body.clone();
                        async move { (status, body).into_response() }
                    }),
                )
                .route(
                    "/v1/responses",
                    post(move || {
                        seen.fetch_add(1, Ordering::SeqCst);
                        async { StatusCode::INTERNAL_SERVER_ERROR }
                    }),
                );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/v1/responses", listener.local_addr().unwrap());
            let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
            let error = run(&runner).await.unwrap_err();
            assert_eq!(generations.load(Ordering::SeqCst), 0);
            assert!(
                !error.contains("private-count-key")
                    && !error.contains(MOCK_KEY)
                    && !error.contains("127.0.0.1")
            );
            task.abort();
        }
    }

    #[tokio::test]
    async fn every_physical_transport_attempt_requires_a_durable_slot() {
        let (url, seen, task) = mock(vec![envelope(json!([call("unused", "tuinieren")]))]).await;
        let mut runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
        // Require the production guard while keeping all network traffic on loopback.
        runner.offline = false;
        assert!(run(&runner).await.unwrap_err().starts_with("budget:"));
        assert!(seen.lock().unwrap().is_empty());

        use std::os::unix::fs::PermissionsExt;
        let mut identifier = [0u8; 8];
        getrandom::fill(&mut identifier).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "coa-tool-round-budget-{:x}",
            u64::from_ne_bytes(identifier)
        ));
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.join("attempts.json");
        crate::demo_budget::cli(&[
            "init".into(),
            path.to_str().unwrap().into(),
            "--max-attempts".into(),
            "1".into(),
        ])
        .unwrap();
        runner.offline = true;
        runner.budget = Some(Arc::new(
            crate::demo_budget::AttemptBudget::open(&path).unwrap(),
        ));
        assert!(run(&runner).await.unwrap_err().starts_with("budget:"));
        assert_eq!(
            seen.lock().unwrap().len(),
            1,
            "The second request inside the same tool loop needs its own durable slot"
        );
        let state: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(state["attempts"], 1);
        drop(runner);
        std::fs::remove_dir_all(directory).unwrap();
        task.abort();
    }

    #[tokio::test]
    async fn duplicate_tool_identity_is_rejected_before_a_second_search() {
        let (url, seen, task) = mock(vec![
            envelope(json!([call("same", "tuinieren")])),
            envelope(json!([call("same", "tuinieren tijd")])),
        ])
        .await;
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let runner = ResponsesRunner::new(
            MOCK_KEY.into(),
            &url,
            Arc::new(move |_, _, method| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(evidence(method))
            }),
        )
        .unwrap();
        assert!(run(&runner).await.unwrap_err().starts_with("tool:"));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(seen.lock().unwrap().len(), 2);
        task.abort();
    }
    #[tokio::test]
    async fn parallel_tool_response_is_rejected_before_any_search() {
        let (url, seen, task) = mock(vec![envelope(json!([
            call("one", "tuinieren"),
            call("two", "tuinieren tijd")
        ]))])
        .await;
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let runner = ResponsesRunner::new(
            MOCK_KEY.into(),
            &url,
            Arc::new(move |_, _, method| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(evidence(method))
            }),
        )
        .unwrap();
        assert!(run(&runner).await.unwrap_err().starts_with("tool:"));
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert_eq!(seen.lock().unwrap().len(), 1);
        task.abort();
    }
    #[tokio::test]
    async fn oversized_evidence_never_starts_another_provider_request() {
        let (url, seen, task) = mock(vec![envelope(json!([call("one", "tuinieren")]))]).await;
        let runner = ResponsesRunner::new(
            MOCK_KEY.into(),
            &url,
            Arc::new(|_, _, method| {
                let mut result = evidence(method);
                result["synthetic_padding"] = json!("x".repeat(MAX_HISTORY_BYTES));
                Ok(result)
            }),
        )
        .unwrap();
        assert!(run(&runner).await.unwrap_err().starts_with("output:"));
        assert_eq!(seen.lock().unwrap().len(), 1);
        task.abort();
    }
    #[tokio::test]
    async fn null_assistant_phase_is_a_valid_final_answer() {
        let mut answer = final_answer();
        answer["phase"] = Value::Null;
        let (url, _, task) = mock(vec![
            envelope(json!([call("one", "tuinieren")])),
            envelope(json!([answer])),
        ])
        .await;
        let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
        assert!(
            run(&runner).await.is_ok(),
            "a null phase must behave like an omitted phase"
        );
        task.abort();
    }
    #[tokio::test]
    async fn encrypted_reasoning_and_commentary_survive_two_tool_rounds_without_becoming_public() {
        let reasoning = |id: &str| json!({"type":"reasoning","id":id,"summary":[{"type":"summary_text","text":"private-synthetic-summary"}],"encrypted_content":format!("private-encrypted-{id}")});
        let commentary = |id: &str| json!({"type":"message","id":id,"role":"assistant","phase":"commentary","status":"completed","content":[{"type":"output_text","text":"I will inspect the source.","annotations":[]}]});
        let first = vec![
            reasoning("one"),
            commentary("one"),
            call("one", "tuinieren tijd"),
        ];
        let second = vec![
            reasoning("two"),
            commentary("two"),
            call("two", "tuinieren wanneer"),
        ];
        let mut final_item = final_answer();
        final_item["phase"] = json!("final_answer");
        let (url, seen, task) = mock(vec![
            envelope(json!(first)),
            envelope(json!(second)),
            envelope(json!([reasoning("three"), commentary("three"), final_item])),
        ])
        .await;
        let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
        let result = run(&runner)
            .await
            .expect("commentary is not the structured final answer");
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 3);
        let one = requests[1]["input"].as_array().unwrap();
        assert_eq!(&one[1..4], first.as_slice());
        let two = requests[2]["input"].as_array().unwrap();
        assert_eq!(&two[..one.len()], one.as_slice());
        assert_eq!(&two[one.len()..one.len() + 3], second.as_slice());
        assert_eq!(two[0]["content"][0]["text"], "Wanneer tuinieren?");
        assert!(
            !result.to_string().contains("private-encrypted")
                && !result.to_string().contains("private-synthetic-summary")
        );
        task.abort();
    }
    #[test]
    fn real_credentials_cannot_be_configured_for_a_loopback_mock() {
        assert!(
            ResponsesRunner::new(
                "a-real-looking-private-key".into(),
                "http://127.0.0.1:8891/v1/responses",
                search()
            )
            .is_err()
        );
    }
    #[tokio::test]
    async fn oversized_chunked_and_incomplete_json_bodies_are_rejected_safely() {
        use axum::body::{Body, Bytes};
        use axum::response::Response;
        for large in [true, false] {
            let app = Router::new()
                .route(
                    "/v1/responses",
                    post(move || async move {
                        let payload = if large {
                            format!(
                                "{{\"private-provider-body\":\"{}\"}}",
                                "x".repeat(MAX_RESPONSE_BYTES)
                            )
                        } else {
                            "{\"private-provider-body\":".to_owned()
                        };
                        let chunks: Vec<Result<Bytes, std::io::Error>> = payload
                            .as_bytes()
                            .chunks(4096)
                            .map(|chunk| Ok(Bytes::copy_from_slice(chunk)))
                            .collect();
                        let stream = futures_util::stream::iter(chunks);
                        Response::builder()
                            .header("content-type", "application/json")
                            .body(Body::from_stream(stream))
                            .unwrap()
                    }),
                )
                .route("/v1/responses/input_tokens", count_stub());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/v1/responses", listener.local_addr().unwrap());
            let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
            let error = run(&runner).await.unwrap_err();
            assert!(error.starts_with("output:"));
            assert!(!error.contains("private-provider-body"));
            task.abort();
        }
    }
    #[tokio::test]
    async fn invalid_public_goals_stop_before_search_and_are_not_repaired() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for goal in [
            None,
            Some(json!("")),
            Some(json!("  ")),
            Some(json!("x".repeat(81))),
            Some(json!("Zoeken\nreden")),
            Some(json!(123)),
        ] {
            let mut args = json!({"query":"tuinieren", "top_k":3});
            if let Some(goal) = goal {
                args["search_goal"] = goal;
            }
            let mut item = call("invalid", "tuinieren");
            item["arguments"] = json!(args.to_string());
            let (url, seen, task) = mock(vec![envelope(json!([item]))]).await;
            let searches = Arc::new(AtomicUsize::new(0));
            let observed = searches.clone();
            let search: Search = Arc::new(move |_, _, method| {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(evidence(method))
            });
            let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search).unwrap();
            assert!(run(&runner).await.unwrap_err().starts_with("tool:"));
            assert_eq!(searches.load(Ordering::SeqCst), 0);
            assert_eq!(seen.lock().unwrap().len(), 1, "No repair or provider retry");
            task.abort();
        }
    }

    #[test]
    fn legacy_codex_calls_remain_valid_without_invented_goals() {
        let legacy = json!({"server":"coa", "tool":"search_document", "query":"tuinieren", "top_k":3, "status":"completed", "result":evidence(DemoSearchMethod::Bm25), "error":null});
        let call: ToolCall = serde_json::from_value(legacy.clone()).unwrap();
        let answer = final_answer()["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_owned();
        let result = crate::codex::validate_retrieved_answer(vec![call], Some(answer)).unwrap();
        assert_eq!(result["tool_calls"][0], legacy);
        assert!(result["tool_calls"][0].get("search_goal").is_none());
        assert!(!crate::codex::generation_prompt("tuinieren", 3).contains("search_goal"));
    }

    #[tokio::test]
    async fn web_search_goals_follow_actual_calls_even_when_queries_repeat() {
        let targeted_call = |id: &str, goal: &str| {
            let mut item = call(id, "tuinieren");
            item["arguments"] = json!(
                json!({
                    "query":"tuinieren", "top_k":3, "search_goal":goal
                })
                .to_string()
            );
            item
        };
        let (url, seen, task) = mock(vec![
            envelope(json!([targeted_call("one", "Begintijden opzoeken")])),
            envelope(json!([targeted_call("two", "Locatie opzoeken")])),
            envelope(json!([final_answer()])),
        ])
        .await;
        let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
        let result = run(&runner).await.unwrap();
        let calls = result["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["search_goal"], "Begintijden opzoeken");
        assert_eq!(calls[1]["search_goal"], "Locatie opzoeken");
        for call in calls {
            assert_eq!(call["query"], "tuinieren");
            assert_eq!(call["top_k"], 3);
            assert_eq!(call["result"], evidence(crate::DemoSearchMethod::Bm25));
        }
        let requests = seen.lock().unwrap();
        let schema = &requests[0]["tools"][0]["parameters"];
        assert!(
            schema["required"]
                .as_array()
                .unwrap()
                .contains(&json!("search_goal"))
        );
        assert_eq!(schema["properties"]["search_goal"]["maxLength"], 80);
        task.abort();
    }

    #[tokio::test]
    async fn stateless_tool_loop_keeps_real_evidence_and_sums_all_provider_usage() {
        let reasoning = json!({"type":"reasoning","id":"rs_synthetic","summary":[],"encrypted_content":"synthetic-encrypted-private"});
        let (url, seen, task) = mock(vec![
            envelope(json!([reasoning, call("one", "tuinieren tijd")])),
            envelope(json!([final_answer()])),
        ])
        .await;
        let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
        let result = run(&runner).await.unwrap();
        assert_eq!(runner.configuration()["runtime"], "rig-0.46.0");
        assert_eq!(runner.configuration()["max_searches"], 4);
        assert_eq!(runner.configuration()["max_provider_requests"], 5);
        assert_eq!(result["client_version"], "rig-0.46.0");
        assert_eq!(result["provider"], "openai");
        assert_eq!(result["transport"], "responses_api");
        assert_eq!(result["provider_requests"], 2);
        assert_eq!(result["usage"]["input_tokens"], 200);
        assert_eq!(result["usage"]["output_tokens"], 50);
        assert_eq!(result["usage"]["reasoning_output_tokens"], 10);
        assert_eq!(result["tool_calls"][0]["query"], "tuinieren tijd");
        assert_eq!(
            result["tool_calls"][0]["result"],
            evidence(crate::DemoSearchMethod::Bm25)
        );
        let public = result.to_string();
        assert!(!public.contains(MOCK_KEY) && !public.contains("synthetic-encrypted-private"));
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for request in requests.iter() {
            assert_eq!(request["model"], "gpt-6.1-sol");
            assert_eq!(request["store"], false);
            assert_eq!(request["reasoning"]["effort"], "low");
            assert_eq!(request["parallel_tool_calls"], false);
            assert_eq!(request["text"]["format"]["strict"], true);
            assert_eq!(request["tools"].as_array().unwrap().len(), 1);
            assert!(request.get("previous_response_id").is_none());
            assert!(
                request["instructions"]
                    .as_str()
                    .unwrap()
                    .contains("untrusted DATA")
            );
            assert!(
                request["instructions"]
                    .as_str()
                    .unwrap()
                    .contains("in English")
            );
            let instructions = request["instructions"].as_str().unwrap();
            assert!(
                instructions.contains("Do not use Markdown tables"),
                "Web answers must stay readable in the plain-text renderer"
            );
            assert!(instructions.contains("Lead with the specific activities"));
            assert!(instructions.contains("Keep relevant uncertainty honest"));
            assert!(instructions.contains("Do not add standalone verdicts"));
            assert!(instructions.contains("Dit is een bevestigde passende optie"));
        }
        assert_eq!(
            runner.configuration()["prompt_version"],
            "responses-activity-v4"
        );
        assert_eq!(requests[0]["tool_choice"], "required");
        assert!(
            requests[1]["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["encrypted_content"] == "synthetic-encrypted-private")
        );
        assert!(
            requests[1]["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["type"] == "function_call_output" && item["call_id"] == "one")
        );
        task.abort();
    }
    #[tokio::test]
    async fn unknown_or_invalid_tool_calls_never_execute_local_code() {
        for bad in [
            json!({"name":"shell","arguments":"{}"}),
            json!({"name":"search_document","arguments":"{\"query\":\"ok\",\"top_k\":3,\"search_goal\":\"Begintijden opzoeken\",\"path\":\"/etc/shadow\"}"}),
            json!({"name":"search_document","arguments":"{\"query\":\"\",\"top_k\":3,\"search_goal\":\"Begintijden opzoeken\"}"}),
            json!({"name":"search_document","arguments":"{\"query\":"}),
        ] {
            let mut item = call("one", "ok");
            item["name"] = bad["name"].clone();
            item["arguments"] = bad["arguments"].clone();
            let (url, seen, task) = mock(vec![envelope(json!([item]))]).await;
            let calls = Arc::new(AtomicUsize::new(0));
            let count = calls.clone();
            let runner = ResponsesRunner::new(
                MOCK_KEY.into(),
                &url,
                Arc::new(move |_, _, method| {
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(evidence(method))
                }),
            )
            .unwrap();
            assert!(run(&runner).await.unwrap_err().starts_with("tool:"));
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert_eq!(
                seen.lock().unwrap().len(),
                1,
                "invalid tools must not cause a retry"
            );
            task.abort();
        }
    }
    #[tokio::test]
    async fn four_searches_are_the_limit_and_fifth_request_must_finish() {
        for last in [final_answer(), call("five", "do not execute")] {
            let mut script: Vec<Value> = (0..4)
                .map(|i| envelope(json!([call(&format!("call{i}"), "tuinieren")])))
                .collect();
            script.push(envelope(json!([last.clone()])));
            let (url, seen, task) = mock(script).await;
            let count = Arc::new(AtomicUsize::new(0));
            let n = count.clone();
            let runner = ResponsesRunner::new(
                MOCK_KEY.into(),
                &url,
                Arc::new(move |_, _, method| {
                    n.fetch_add(1, Ordering::SeqCst);
                    Ok(evidence(method))
                }),
            )
            .unwrap();
            let result = run(&runner).await;
            assert_eq!(result.is_ok(), last["type"] == "message");
            assert_eq!(count.load(Ordering::SeqCst), 4);
            assert_eq!(seen.lock().unwrap()[4]["tool_choice"], "none");
            task.abort();
        }
    }
    #[tokio::test]
    async fn invented_citations_and_refusals_or_incomplete_responses_fail_closed() {
        let mut wrong = final_answer();
        wrong["content"][0]["text"] = json!({"text":"Monday","citations":[{"source_id":"ACT-TUIN-001","source_date":"2026-10-20","section_id":"S2","quote":"Not in source"}],"unknowns":[]}).to_string().into();
        let mut incomplete = envelope(json!([final_answer()]));
        incomplete["status"] = json!("incomplete");
        for response in [
            envelope(json!([wrong])),
            incomplete,
            envelope(
                json!([{"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"synthetic-private-detail"}]}]),
            ),
        ] {
            let (url, _, task) =
                mock(vec![envelope(json!([call("one", "tuinieren")])), response]).await;
            let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
            let error = run(&runner).await.unwrap_err();
            assert!(!error.contains("synthetic-private-detail"));
            task.abort();
        }
    }
    #[tokio::test]
    async fn provider_error_details_cannot_escape() {
        use axum::{http::StatusCode, response::IntoResponse};
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            let app = Router::new()
                .route(
                    "/v1/responses",
                    post(move || async move {
                        (status, "synthetic-api-key private provider diagnostics").into_response()
                    }),
                )
                .route("/v1/responses/input_tokens", count_stub());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/v1/responses", listener.local_addr().unwrap());
            let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
            let error = run(&runner).await.unwrap_err();
            assert!(error.starts_with("runtime:"));
            assert!(
                !error.contains("private")
                    && !error.contains("synthetic-api-key")
                    && !error.contains("127.0.0.1")
            );
            task.abort();
        }
    }
    #[tokio::test]
    async fn redirects_are_rejected_without_contacting_the_destination() {
        use axum::{http::StatusCode, response::IntoResponse};
        let destination_hits = Arc::new(AtomicUsize::new(0));
        let hits = destination_hits.clone();
        let destination = Router::new().route(
            "/stolen",
            post(move || {
                hits.fetch_add(1, Ordering::SeqCst);
                async { Json(envelope(json!([final_answer()]))) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let location = format!("http://{}/stolen", listener.local_addr().unwrap());
        let destination_task =
            tokio::spawn(async move { axum::serve(listener, destination).await.unwrap() });
        let app = Router::new()
            .route(
                "/v1/responses",
                post(move || {
                    let location = location.clone();
                    async move {
                        (StatusCode::TEMPORARY_REDIRECT, [("location", location)]).into_response()
                    }
                }),
            )
            .route("/v1/responses/input_tokens", count_stub());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
        let result = run(&runner).await;
        assert_eq!(destination_hits.load(Ordering::SeqCst), 0);
        assert!(result.unwrap_err().starts_with("runtime:"));
        task.abort();
        destination_task.abort();
    }
    #[tokio::test(start_paused = true)]
    async fn deadline_covers_the_whole_tool_loop() {
        // A blocking task inhibits Tokio's automatic clock advance during real I/O.
        // Dropping the sender releases it, including when an assertion panics.
        let (release_clock, wait_for_release) = std::sync::mpsc::channel::<()>();
        let (clock_ready, ready) = tokio::sync::oneshot::channel();
        let clock_guard = tokio::task::spawn_blocking(move || {
            clock_ready.send(()).unwrap();
            let _ = wait_for_release.recv();
        });
        ready.await.unwrap();
        let first_response = Arc::new(tokio::sync::Notify::new());
        let release_first = first_response.clone();
        let (request_started, mut requests) = tokio::sync::mpsc::unbounded_channel();
        let count_started = request_started.clone();
        let release_count = Arc::new(tokio::sync::Notify::new());
        let count_release = release_count.clone();
        let free_counts = Arc::new(AtomicUsize::new(0));
        let counted = free_counts.clone();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let app = Router::new()
            .route(
                "/v1/responses",
                post(move || {
                    let seen = seen.clone();
                    let first_response = first_response.clone();
                    let request_started = request_started.clone();
                    async move {
                        let request = seen.fetch_add(1, Ordering::SeqCst);
                        request_started.send(request).unwrap();
                        if request == 0 {
                            first_response.notified().await;
                            Json(envelope(json!([call("one", "tuinieren")])))
                        } else {
                            std::future::pending::<()>().await;
                            unreachable!()
                        }
                    }
                }),
            )
            .route(
                "/v1/responses/input_tokens",
                post(move || {
                    let counted = counted.clone();
                    let count_started = count_started.clone();
                    let count_release = count_release.clone();
                    async move {
                        if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                            count_started.send(usize::MAX).unwrap();
                            count_release.notified().await;
                        }
                        Json(json!({"object":"response.input_tokens","input_tokens":1}))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let runner = ResponsesRunner::new(MOCK_KEY.into(), &url, search()).unwrap();
        let mut execution = tokio::spawn(async move { run(&runner).await });
        assert_eq!(requests.recv().await, Some(usize::MAX));
        tokio::time::advance(Duration::from_secs(30)).await;
        release_count.notify_one();
        for request in 0..2 {
            let started = tokio::select! {
                started = requests.recv() => started,
                result = &mut execution => {
                    panic!("execution stopped before request {request}: {result:?}")
                }
            };
            assert_eq!(started, Some(request));
            if request == 0 {
                tokio::time::advance(Duration::from_secs(30)).await;
                release_first.notify_one();
            }
        }
        assert_eq!(free_counts.load(Ordering::SeqCst), 2);
        tokio::time::advance(Duration::from_secs(59)).await;
        assert!(!execution.is_finished());
        tokio::time::advance(Duration::from_secs(2)).await;
        drop(release_clock);
        clock_guard.await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), execution)
            .await
            .expect("round two gets only the remaining shared budget, not 120 new seconds")
            .unwrap();
        assert_eq!(
            result.unwrap_err(),
            "runtime: De antwoordservice heeft te lang gewacht."
        );
        assert_eq!(count.load(Ordering::SeqCst), 2);
        task.abort();
    }
}
