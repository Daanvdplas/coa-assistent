//! The application's HTTP limits surround Rig's provider codec.
//!
//! No provider/model loop lives here. Rig creates each request and owns history;
//! this transport preserves our endpoint, byte budgets and safe error boundary.
use super::{
    MAX_COUNT_BYTES, MAX_HISTORY_BYTES, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, MAX_PROVIDER_REQUESTS,
    MAX_RESPONSE_BYTES, MODEL,
    rig_runtime::{BoundaryError, RunState, check_response},
};
use rig::http_client::{
    Bytes, Error, HttpClientExt, LazyBody, MultipartForm, Request, Response, StreamingResponse,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub(super) struct BoundedTransport {
    pub client: reqwest::Client,
    pub endpoint: reqwest::Url,
    pub state: Arc<Mutex<RunState>>,
    pub budget: Option<Arc<crate::demo_budget::AttemptBudget>>,
    pub offline: bool,
}
impl BoundedTransport {
    fn failure(&self, error: &'static str) -> Error {
        if let Ok(mut state) = self.state.lock() {
            state.error = Some(error);
        }
        Error::instance(BoundaryError(error))
    }

    async fn request(&self, request: Request<Bytes>) -> Result<Vec<u8>, Error> {
        if request.method() != reqwest::Method::POST || request.uri() != self.endpoint.as_str() {
            return Err(self.failure("runtime: API-adres is niet toegestaan."));
        }
        if request.body().len() > MAX_HISTORY_BYTES {
            return Err(self.failure("output: De modelcontext is te groot."));
        }
        let count_payload = count_payload(request.body()).map_err(|error| self.failure(error))?;
        {
            let mut state = self.state.lock().map_err(|_| {
                Error::instance(BoundaryError("runtime: De uitvoering is niet beschikbaar."))
            })?;
            // One attempt includes one free count and at most one generation.
            if state.requests >= MAX_PROVIDER_REQUESTS || state.error.is_some() {
                drop(state);
                return Err(self.failure("tool: Het maximum aantal modelverzoeken is bereikt."));
            }
            state.requests += 1;
        }
        match &self.budget {
            Some(budget) => budget.reserve().map_err(|error| self.failure(error))?,
            None if !self.offline => {
                return Err(self
                    .failure("budget: Stel eerst het gebruiksbudget voor de antwoordservice in."));
            }
            None => {}
        }
        let (parts, body) = request.into_parts();
        let mut count_endpoint = self.endpoint.clone();
        count_endpoint.set_path("/v1/responses/input_tokens");
        let count_bytes = serde_json::to_vec(&count_payload)
            .map_err(|_| self.failure("budget: De modelinvoer kan niet worden gecontroleerd."))?;
        let counted = self
            .post(
                count_endpoint,
                parts.headers.clone(),
                Bytes::from(count_bytes),
                MAX_COUNT_BYTES,
            )
            .await?;
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct InputCount {
            object: String,
            input_tokens: u64,
        }
        let counted: InputCount = serde_json::from_slice(&counted)
            .map_err(|_| self.failure("budget: De omvang van de modelinvoer is onbekend."))?;
        if counted.object != "response.input_tokens"
            || !(1..=MAX_INPUT_TOKENS).contains(&counted.input_tokens)
        {
            return Err(self.failure("budget: De modelinvoer is te groot of niet controleerbaar."));
        }
        let bytes = self
            .post(
                self.endpoint.clone(),
                parts.headers,
                body,
                MAX_RESPONSE_BYTES,
            )
            .await?;
        let raw: Value = serde_json::from_slice(&bytes).map_err(|_| {
            self.failure("output: De antwoordservice heeft ongeldige uitvoer geleverd.")
        })?;
        let checked = {
            let mut state = self.state.lock().map_err(|_| {
                Error::instance(BoundaryError("runtime: De uitvoering is niet beschikbaar."))
            })?;
            check_response(&raw, &mut state)
        };
        checked.map_err(|error| self.failure(error.0))?;
        Ok(bytes)
    }

    async fn post(
        &self,
        endpoint: reqwest::Url,
        mut headers: reqwest::header::HeaderMap,
        body: Bytes,
        limit: usize,
    ) -> Result<Vec<u8>, Error> {
        // The count projection has a different length from the generation.
        headers.remove(reqwest::header::CONTENT_LENGTH);
        headers.remove(reqwest::header::TRANSFER_ENCODING);
        let mut response = self
            .client
            .post(endpoint)
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(|_| {
                self.failure("runtime: De antwoordservice is tijdelijk niet bereikbaar.")
            })?;
        if !response.status().is_success() {
            return Err(self.failure(match response.status().as_u16() {
                401 | 403 => "runtime: De antwoordservice is niet juist ingesteld.",
                402 | 429 => {
                    "runtime: De antwoordservice heeft tijdelijk geen capaciteit of tegoed."
                }
                _ => "runtime: De antwoordservice is tijdelijk niet beschikbaar.",
            }));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| self.failure("runtime: Het antwoord kon niet worden ontvangen."))?
        {
            if bytes.len() + chunk.len() > limit {
                return Err(self.failure("output: Het antwoord bevat te veel gegevens."));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

fn count_payload(body: &[u8]) -> Result<Value, &'static str> {
    let request: Value = serde_json::from_slice(body)
        .map_err(|_| "budget: De modelinvoer kan niet worden gecontroleerd.")?;
    let fields = request
        .as_object()
        .ok_or("budget: Ongeldige modelinvoer.")?;
    if request["model"] != MODEL
        || request["service_tier"] != "default"
        || request["max_output_tokens"].as_u64() != Some(MAX_OUTPUT_TOKENS as u64)
        || request["store"] != false
        || request["prompt_cache_options"] != serde_json::json!({"ttl":"30m"})
        || request.get("stream").is_some_and(|value| value != false)
        || ["conversation", "previous_response_id"]
            .iter()
            .any(|key| request.get(key).is_some_and(|value| !value.is_null()))
        || request["tools"].as_array().is_none_or(|tools| {
            tools.len() != 1
                || tools[0]["type"] != "function"
                || tools[0]["name"] != "search_document"
        })
        || long_cache_breakpoint(&request)
    {
        return Err("budget: De modelinstellingen vallen buiten het gebruiksbudget.");
    }
    let mut counted = serde_json::Map::new();
    for (key, value) in fields {
        match key.as_str() {
            "model"
            | "input"
            | "instructions"
            | "tools"
            | "text"
            | "reasoning"
            | "parallel_tool_calls"
            | "tool_choice"
            | "truncation"
            | "personality"
            | "conversation"
            | "previous_response_id" => {
                counted.insert(key.clone(), value.clone());
            }
            "max_output_tokens"
            | "store"
            | "service_tier"
            | "include"
            | "stream"
            | "prompt_cache_options" => {}
            _ => {
                return Err("budget: Onbekende modelinvoer kan niet worden gecontroleerd.");
            }
        }
    }
    Ok(Value::Object(counted))
}

fn long_cache_breakpoint(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            (key == "prompt_cache_breakpoint" && value.get("ttl").is_some_and(|ttl| ttl != "30m"))
                || long_cache_breakpoint(value)
        }),
        Value::Array(values) => values.iter().any(long_cache_breakpoint),
        _ => false,
    }
}

impl HttpClientExt for BoundedTransport {
    fn send<T, U>(
        &self,
        request: Request<T>,
    ) -> impl Future<Output = Result<Response<LazyBody<U>>, Error>> + Send + 'static
    where
        T: Into<Bytes> + Send,
        U: From<Bytes> + Send + 'static,
    {
        let transport = self.clone();
        let request = request.map(Into::into);
        async move {
            let bytes = transport.request(request).await?;
            let body: LazyBody<U> = Box::pin(async move { Ok(U::from(Bytes::from(bytes))) });
            Response::builder()
                .status(200)
                .header("content-type", "application/json")
                .body(body)
                .map_err(Error::Protocol)
        }
    }
    fn send_multipart<U>(
        &self,
        _: Request<MultipartForm>,
    ) -> impl Future<Output = Result<Response<LazyBody<U>>, Error>> + Send + 'static
    where
        U: From<Bytes> + Send + 'static,
    {
        let error = self.failure("tool: Onverwacht API-gebruik is niet toegestaan.");
        async move { Err(error) }
    }
    fn send_streaming<T>(
        &self,
        _: Request<T>,
    ) -> impl Future<Output = Result<StreamingResponse, Error>> + Send
    where
        T: Into<Bytes> + Send,
    {
        let error = self.failure("tool: Onverwacht API-gebruik is niet toegestaan.");
        async move { Err(error) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, routing::post};
    use serde_json::json;

    #[tokio::test]
    async fn preflight_preserves_generation_bytes_and_rejects_inputs_outside_the_cost_policy() {
        let counted = Arc::new(Mutex::new(Vec::<Value>::new()));
        let generated = Arc::new(Mutex::new(Vec::<Bytes>::new()));
        let seen_counts = counted.clone();
        let seen_generations = generated.clone();
        let app = Router::new()
            .route("/v1/responses/input_tokens", post(move |Json(body): Json<Value>| { let seen = seen_counts.clone(); async move {seen.lock().unwrap().push(body); Json(json!({"object":"response.input_tokens","input_tokens":1}))} }))
            .route("/v1/responses", post(move |body: Bytes| { let seen = seen_generations.clone(); async move {seen.lock().unwrap().push(body); Json(json!({"status":"completed","output":[{"type":"function_call","call_id":"one","name":"search_document","arguments":json!({"query":"Hallo","top_k":3,"search_goal":"Begintijden opzoeken"}).to_string()}]}))} }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint: reqwest::Url =
            format!("http://{}/v1/responses", listener.local_addr().unwrap())
                .parse()
                .unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let transport = BoundedTransport {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .build()
                .unwrap(),
            endpoint: endpoint.clone(),
            state: Arc::new(Mutex::new(RunState::default())),
            budget: None,
            offline: true,
        };
        let policy = json!({"model":MODEL,"input":[{"role":"user","content":"Hallo"}],"instructions":"Synthetic instructions","tools":[{"type":"function","name":"search_document","parameters":{}}],"text":{"format":{"type":"json_schema","name":"test","schema":{"type":"object"}}},"reasoning":{"effort":"low"},"parallel_tool_calls":false,"tool_choice":"required","store":false,"service_tier":"default","max_output_tokens":MAX_OUTPUT_TOKENS,"prompt_cache_options":{"ttl":"30m"}});
        let bytes = Bytes::from(format!(
            "\n{}\n",
            serde_json::to_string_pretty(&policy).unwrap()
        ));
        let request = Request::builder()
            .method("POST")
            .uri(endpoint.as_str())
            .header("content-type", "application/json")
            .header("content-length", bytes.len())
            .body(bytes.clone())
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            transport.request(request),
        )
        .await
        .expect("The count request must use its own body length")
        .unwrap();
        assert_eq!(*generated.lock().unwrap(), vec![bytes]);
        assert_eq!(counted.lock().unwrap()[0]["text"], policy["text"]);

        for (key, value) in [
            ("unknown_input_option", json!(true)),
            ("model", json!("unexpected-model")),
            ("service_tier", json!("priority")),
            ("max_output_tokens", json!(4097)),
            ("prompt_cache_options", json!({"ttl":"12h"})),
            ("conversation", json!("mutable-conversation")),
            ("tools", json!([{"type":"web_search"}])),
            (
                "input",
                json!([{"role":"user","content":[{"type":"input_text","text":"Hallo","prompt_cache_breakpoint":{"ttl":"12h"}}]}]),
            ),
        ] {
            let mut invalid = policy.clone();
            invalid[key] = value;
            let transport = BoundedTransport {
                state: Arc::new(Mutex::new(RunState::default())),
                ..transport.clone()
            };
            let request = Request::builder()
                .method("POST")
                .uri(endpoint.as_str())
                .body(Bytes::from(serde_json::to_vec(&invalid).unwrap()))
                .unwrap();
            assert!(
                transport.request(request).await.is_err(),
                "Unbounded policy field {key} must be rejected"
            );
        }
        assert_eq!(generated.lock().unwrap().len(), 1);
        assert_eq!(counted.lock().unwrap().len(), 1);
        server.abort();
    }
}
