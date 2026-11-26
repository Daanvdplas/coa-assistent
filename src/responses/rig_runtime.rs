//! Rig owns the model/tool loop; COA supplies its search tool and boundaries.
use super::{
    DemoSearchMethod, MAX_OUTPUT_TOKENS, MAX_PROVIDER_REQUESTS, MAX_SEARCHES, MODEL,
    RUNTIME_VERSION, Search, SearchArguments, TokenUsage, ToolCall, add_usage,
};
use rig::{
    AgentBuilder,
    agent::{
        AgentHook, CompletionCallAction, CompletionCallEvent, HookContext, InvalidToolCallAction,
        InvalidToolCallContext, OutcomeAction, OutcomeEvent, OutputMode, RequestPatch,
    },
    completion::{Effort, GenerationOptions},
    message::ToolChoice,
    tool::{Tool, ToolContext},
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Instant,
};

pub(super) struct RecordedSearch {
    call: ToolCall,
    search_goal: String,
}

pub(super) struct RunState {
    pub trace: Option<crate::traces::TraceHandle>,
    pub calls: Vec<RecordedSearch>,
    pub ids: HashSet<String>,
    pub requests: usize,
    pub usage: Option<TokenUsage>,
    pub error: Option<&'static str>,
    pub answer: Option<String>,
}
impl Default for RunState {
    fn default() -> Self {
        Self {
            trace: None,
            calls: Vec::new(),
            ids: HashSet::new(),
            requests: 0,
            usage: Some(TokenUsage {
                input_tokens: 0,
                output_tokens: 0,
                cached_input_tokens: Some(0),
                reasoning_output_tokens: Some(0),
            }),
            error: None,
            answer: None,
        }
    }
}

#[derive(Clone)]
struct SearchTool {
    search: Search,
    method: DemoSearchMethod,
    state: Arc<Mutex<RunState>>,
}

#[derive(Debug)]
pub(super) struct BoundaryError(pub &'static str);
impl std::fmt::Display for BoundaryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for BoundaryError {}

impl SearchTool {
    async fn execute(&self, arguments: SearchArguments) -> Result<Value, BoundaryError> {
        let started = Instant::now();
        let trace = self.state.lock().ok().and_then(|state| state.trace.clone());
        if let Some(trace) = &trace {
            trace.event("tool.started", None, json!({"tool":"search_document","arguments":{"query":arguments.query,"top_k":arguments.top_k,"search_goal":arguments.search_goal}})).map_err(|_| BoundaryError("runtime: De uitvoeringstrace kon niet worden opgeslagen."))?;
        }
        let result = self.execute_inner(arguments).await;
        if let Err(error) = &result
            && let Ok(mut state) = self.state.lock()
        {
            state.error = Some(error.0);
        }
        if let Some(trace) = &trace {
            let data = match &result {
                Ok(result) => json!({"tool":"search_document","result":result}),
                Err(error) => json!({"tool":"search_document","error":error.0}),
            };
            trace
                .event(
                    if result.is_ok() {
                        "tool.completed"
                    } else {
                        "tool.failed"
                    },
                    Some(started.elapsed().as_millis() as u64),
                    data,
                )
                .map_err(|_| {
                    BoundaryError("runtime: De uitvoeringstrace kon niet worden opgeslagen.")
                })?;
        }
        result
    }
    async fn execute_inner(&self, arguments: SearchArguments) -> Result<Value, BoundaryError> {
        crate::validate_query(&arguments.query)
            .map_err(|_| BoundaryError("tool: Ongeldige zoekvraag."))?;
        crate::ranking::validate_top_k(arguments.top_k)
            .map_err(|_| BoundaryError("tool: Ongeldig aantal bronpassages."))?;
        if arguments.search_goal.trim().is_empty()
            || arguments.search_goal.chars().count() > 80
            || arguments.search_goal.chars().any(char::is_control)
        {
            return Err(BoundaryError("tool: Ongeldig publiek zoekdoel."));
        }
        if self
            .state
            .lock()
            .map_err(|_| BoundaryError("runtime: De uitvoering is niet beschikbaar."))?
            .calls
            .len()
            >= MAX_SEARCHES
        {
            return Err(BoundaryError(
                "tool: Alleen maximaal vier bronzoekacties zijn toegestaan.",
            ));
        }
        let search = self.search.clone();
        let query = arguments.query.clone();
        let method = self.method;
        let result = tokio::task::spawn_blocking(move || search(&query, arguments.top_k, method))
            .await
            .map_err(|_| BoundaryError("tool: De bronzoekfunctie is niet beschikbaar."))?
            .map_err(|_| BoundaryError("tool: De bronzoekfunctie is niet beschikbaar."))?;
        if result["retrieval_method"] != json!(method) {
            return Err(BoundaryError("tool: De zoekmethode is veranderd."));
        }
        self.state
            .lock()
            .map_err(|_| BoundaryError("runtime: De uitvoering is niet beschikbaar."))?
            .calls
            .push(RecordedSearch {
                search_goal: arguments.search_goal,
                call: ToolCall {
                    server: "local".into(),
                    tool: "search_document".into(),
                    query: arguments.query,
                    top_k: arguments.top_k,
                    status: "completed".into(),
                    result: Some(result.clone()),
                    error: None,
                },
            });
        Ok(result)
    }
}
impl Tool for SearchTool {
    const NAME: &'static str = "search_document";
    type Args = SearchArguments;
    type Output = Value;
    type Error = BoundaryError;
    fn description(&self) -> String {
        "Search only the fictional activity corpus. Supply search_goal as a short public task in the requested answer language, such as 'Begintijden opzoeken': state what information this call seeks, never private reasoning, conclusions, criteria satisfied or completeness claims. Missing availability and transport stay unknown. At most four searches.".into()
    }
    fn parameters(&self) -> Value {
        json!({"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":1000},"top_k":{"type":"integer","minimum":1,"maximum":6},"search_goal":{"type":"string","minLength":1,"maxLength":80,"description":"Short public information-seeking task for this call, not reasoning or a result; for example Begintijden opzoeken."}},"required":["query","top_k","search_goal"],"additionalProperties":false})
    }
    async fn call(
        &self,
        _: &mut ToolContext,
        arguments: SearchArguments,
    ) -> Result<Value, BoundaryError> {
        self.execute(arguments).await
    }
}

struct RunPolicy(Arc<Mutex<RunState>>);
impl AgentHook for RunPolicy {
    async fn on_completion_call(
        &self,
        _: &HookContext,
        _: CompletionCallEvent<'_>,
    ) -> CompletionCallAction {
        let Ok(state) = self.0.lock() else {
            return CompletionCallAction::stop("runtime: De uitvoering is niet beschikbaar.");
        };
        if let Some(error) = state.error {
            return CompletionCallAction::stop(error);
        }
        let choice = if state.calls.is_empty() {
            ToolChoice::Required
        } else if state.calls.len() >= MAX_SEARCHES {
            ToolChoice::None
        } else {
            ToolChoice::Auto
        };
        CompletionCallAction::patch(RequestPatch::new().tool_choice(choice))
    }
    async fn on_invalid_tool_call(
        &self,
        _: &HookContext,
        _: &InvalidToolCallContext,
    ) -> Option<InvalidToolCallAction> {
        let error = "tool: Ongeldige bronzoekactie.";
        if let Ok(mut state) = self.0.lock() {
            state.error = Some(error);
        }
        Some(InvalidToolCallAction::stop(error))
    }
    async fn on_outcome(&self, _: &HookContext, event: OutcomeEvent<'_>) -> OutcomeAction {
        if let Ok(mut state) = self.0.lock() {
            if event
                .tool_result()
                .is_some_and(|result| !result.is_success())
            {
                state.error.get_or_insert("tool: Ongeldige bronzoekactie.");
            }
            if let Some(error) = state.error {
                return OutcomeAction::stop(error);
            }
        }
        OutcomeAction::proceed()
    }
}

pub(super) async fn run(
    runner: &super::ResponsesRunner,
    query: &str,
    top_k: usize,
    corpus: crate::corpus::CorpusId,
    language: crate::codex::AnswerLanguage,
    method: DemoSearchMethod,
    trace: Option<crate::traces::TraceHandle>,
) -> Result<Value, String> {
    let started = Instant::now();
    let state = Arc::new(Mutex::new(RunState {
        trace,
        ..RunState::default()
    }));
    let transport = super::transport::BoundedTransport {
        client: runner.client.clone(),
        endpoint: runner.endpoint.clone(),
        state: state.clone(),
        spend_control: runner.spend_control.clone(),
        offline: runner.offline,
    };
    let model = rig::Model::new(
        rig::providers::openai::responses_api::wire::Responses::new(runner.provider.clone(), MODEL)
            .with_strict_tools(),
        transport,
    );
    let prompt = crate::codex::generation_prompt_for_answer_language("", top_k, corpus, language);
    let instructions = prompt
        .split("\\n\\nUser question (data):")
        .next()
        .unwrap_or(&prompt)
        .replace("coa.search_document", "search_document");
    let instructions = format!(
        "{instructions}\n\nFor the web demo's answer.text only: Lead with the specific activities and practical details the person asked for. Use short, natural sentences, as a helpful colleague would. Write plain text or a short '-' list. Do not use Markdown tables, pipe-delimited tables, Markdown headings or emphasis. Keep relevant uncertainty honest and brief in ordinary words; do not add a generic verdict or jargon about criteria, coverage or proof. Do not add standalone verdicts such as 'Deze optie voldoet aantoonbaar aan alle voorwaarden' or 'Dit is een bevestigde passende optie', or English equivalents. Do not replace them with another approval or summary sentence. Finish after the practical information and any relevant uncertainty. When asked for all suitable options, keep an honest, brief completeness caveat if the retrieved evidence does not establish the full list. Do not invent facts or hide relevant missing information. Keep the existing language, JSON schema, separate citations, source/date bindings, unknowns and search rules unchanged."
    );
    let schema = crate::codex::output_schema()
        .try_into()
        .map_err(|_| "output: Ongeldig antwoordschema.")?;
    let agent = AgentBuilder::new(model)
        .preamble(instructions)
        .tool(SearchTool {
            search: runner.search.clone(),
            method,
            state: state.clone(),
        })
        .options(
            GenerationOptions::new()
                .reasoning(Effort::Low)
                .parallel_tool_calls(false),
        )
        .provider_option(rig::providers::openai::extension::OpenAiOptions::new().store(false))
        .max_tokens(MAX_OUTPUT_TOKENS as u64)
        .additional_params(json!({"service_tier":"default","prompt_cache_options":{"ttl":"30m"}}))
        .output_schema_raw(schema)
        .output_mode(OutputMode::Native)
        .record_content_telemetry(false)
        .add_hook(RunPolicy(state.clone()))
        .build();
    let response = agent
        .prompt(query)
        .max_turns(MAX_PROVIDER_REQUESTS)
        .max_invalid_tool_call_retries(0)
        .max_consecutive_malformed_tool_calls(0)
        .tool_concurrency(1)
        .await;
    let mut state = state
        .lock()
        .map_err(|_| "runtime: De uitvoering is niet beschikbaar.")?;
    response.map_err(|_| {
        state
            .error
            .unwrap_or("output: De antwoordservice heeft ongeldige uitvoer geleverd.")
            .to_owned()
    })?;
    // Public output deliberately excludes Rig's private history and raw responses.
    let (calls, search_goals): (Vec<_>, Vec<_>) = std::mem::take(&mut state.calls)
        .into_iter()
        .map(|record| (record.call, record.search_goal))
        .unzip();
    let mut result = crate::codex::validate_retrieved_answer(calls, state.answer.take())?;
    let public_calls = result["tool_calls"]
        .as_array_mut()
        .filter(|calls| calls.len() == search_goals.len())
        .ok_or("output: Ongeldige zoekgeschiedenis.")?;
    for (call, goal) in public_calls.iter_mut().zip(search_goals) {
        call["search_goal"] = json!(goal);
    }
    result["question"] = json!(query);
    result["id"] = json!(format!("api-{}", started.elapsed().as_nanos()));
    result["model"] = json!(MODEL);
    result["client_version"] = json!(RUNTIME_VERSION);
    result["provider"] = json!("openai");
    result["transport"] = json!("responses_api");
    result["provider_requests"] = json!(state.requests);
    result["retrieval_method"] = json!(method);
    result["elapsed_ms"] = json!(started.elapsed().as_millis() as u64);
    result["usage"] =
        serde_json::to_value(&state.usage).map_err(|_| "output: Ongeldig gebruiksoverzicht.")?;
    Ok(result)
}

pub(super) fn check_response(response: &Value, state: &mut RunState) -> Result<(), BoundaryError> {
    if response["status"] != "completed" {
        return Err(BoundaryError(
            "output: De antwoordservice heeft geen volledig antwoord geleverd.",
        ));
    }
    let items = response["output"]
        .as_array()
        .filter(|items| !items.is_empty())
        .ok_or(BoundaryError(
            "output: De antwoordservice heeft geen uitvoer geleverd.",
        ))?;
    let mut tools = 0;
    let mut answer = None;
    for item in items {
        match item["type"].as_str() {
            Some("reasoning") => {}
            Some("function_call") => {
                tools += 1;
                if tools > 1 {
                    return Err(BoundaryError("tool: Onverwachte parallelle zoekacties."));
                }
                if state.calls.len() >= MAX_SEARCHES || item["name"] != "search_document" {
                    return Err(BoundaryError(
                        "tool: Alleen maximaal vier bronzoekacties zijn toegestaan.",
                    ));
                }
                let id = item["call_id"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 200)
                    .ok_or(BoundaryError("tool: Ongeldige zoekidentiteit."))?;
                if !state.ids.insert(id.into()) {
                    return Err(BoundaryError("tool: Dubbele zoekidentiteit."));
                }
                let arguments = item["arguments"]
                    .as_str()
                    .filter(|args| args.len() <= 16_384)
                    .ok_or(BoundaryError("tool: Ongeldige zoekinvoer."))?;
                // Reject malformed wire arguments before provider decoding can
                // classify them as an unrelated output error or repair them.
                serde_json::from_str::<SearchArguments>(arguments)
                    .map_err(|_| BoundaryError("tool: Ongeldige zoekinvoer."))?;
            }
            Some("message") => {
                if item["role"] != "assistant" {
                    return Err(BoundaryError("output: Ongeldige antwoordrol."));
                }
                if item["phase"] == "commentary" {
                    continue;
                }
                if !item["phase"].is_null() && item["phase"] != "final_answer" {
                    return Err(BoundaryError("output: Ongeldige antwoordfase."));
                }
                for content in item["content"]
                    .as_array()
                    .ok_or(BoundaryError("output: Ongeldig antwoord."))?
                {
                    if content["type"] != "output_text" || answer.is_some() {
                        return Err(BoundaryError(
                            "output: Het antwoord kan niet worden verwerkt.",
                        ));
                    }
                    answer = Some(
                        content["text"]
                            .as_str()
                            .ok_or(BoundaryError("output: Ongeldige antwoordtekst."))?
                            .to_owned(),
                    );
                }
            }
            _ => {
                return Err(BoundaryError(
                    "tool: Onbekend gereedschap is niet toegestaan.",
                ));
            }
        }
    }
    state.answer = answer;
    add_usage(&mut state.usage, &response["usage"]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn search_tool_runs_the_selected_method_and_records_the_actual_evidence() {
        let state = Arc::new(Mutex::new(RunState::default()));
        let tool = SearchTool {
            search: Arc::new(|query, top_k, method| {
                assert_eq!(query, "tuinieren tijd");
                assert_eq!(top_k, 3);
                assert_eq!(method, DemoSearchMethod::Bm25);
                Ok(json!({"retrieval_method":method,"hits":[{"section":{"id":"S2"}}]}))
            }),
            method: DemoSearchMethod::Bm25,
            state: state.clone(),
        };
        let result = tool
            .execute(SearchArguments {
                query: "tuinieren tijd".into(),
                top_k: 3,
                search_goal: "Begintijden opzoeken".into(),
            })
            .await
            .unwrap();
        let state = state.lock().unwrap();
        assert_eq!(state.calls.len(), 1);
        assert_eq!(state.calls[0].call.result.as_ref(), Some(&result));
        assert_eq!(state.calls[0].call.query, "tuinieren tijd");
        assert_eq!(state.calls[0].search_goal, "Begintijden opzoeken");
    }
}
