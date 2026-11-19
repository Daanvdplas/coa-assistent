use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use meedoen_retrieval::traces::{ThreadSummary, ThreadTrace, TraceReader};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

const USAGE: &str = "Usage: traces serve --db PATH [--port 8767]";
type SharedReader = Arc<Mutex<TraceReader>>;
type ApiError = (StatusCode, Json<Value>);

fn parse_args(args: &[String]) -> Result<(PathBuf, u16), String> {
    let mut args = args.iter();
    if args.next().map(String::as_str) != Some("serve") {
        return Err(USAGE.into());
    }
    let (mut database, mut port) = (None, None);
    while let Some(option) = args.next() {
        let value = args.next().ok_or(USAGE)?;
        match option.as_str() {
            "--db" if database.is_none() && !value.is_empty() => {
                database = Some(PathBuf::from(value))
            }
            "--port" if port.is_none() => {
                port = Some(
                    value
                        .parse::<u16>()
                        .ok()
                        .filter(|port| *port > 0)
                        .ok_or(USAGE)?,
                );
            }
            _ => return Err(USAGE.into()),
        }
    }
    Ok((database.ok_or(USAGE)?, port.unwrap_or(8767)))
}

pub async fn cli(args: &[String]) -> Result<(), String> {
    let (database, port) = parse_args(args)?;
    let reader = TraceReader::open(&database).map_err(|_| "Trace database is unavailable.")?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|_| "Trace dashboard port is unavailable.")?;
    eprintln!("Traces: http://127.0.0.1:{port}/");
    axum::serve(listener, router(reader, port))
        .await
        .map_err(|_| "Trace dashboard stopped unexpectedly.".into())
}

fn router(reader: TraceReader, port: u16) -> Router {
    Router::new()
        .route(
            "/",
            get(|| async { Html(include_str!("../static/traces/index.html")) }),
        )
        .route(
            "/assets/traces.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../static/traces/traces.css"),
                )
            }),
        )
        .route(
            "/assets/traces.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../static/traces/traces.js"),
                )
            }),
        )
        .route("/api/threads", get(threads))
        .route("/api/threads/{id}", get(thread))
        .route("/api/threads/{id}/export", get(export))
        .with_state(Arc::new(Mutex::new(reader)))
        .layer(middleware::from_fn_with_state(port, local_access))
}

async fn local_access(State(port): State<u16>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let host = headers
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
        .unwrap_or("");
    let valid_host = host == format!("127.0.0.1:{port}")
        || host == format!("localhost:{port}")
        || (port == 80 && matches!(host, "127.0.0.1" | "localhost"));
    let valid_origin = headers
        .get(header::ORIGIN)
        .is_none_or(|origin| origin == format!("http://{host}").as_str());
    let cross_site = headers
        .get("sec-fetch-site")
        .is_some_and(|site| site == "cross-site");
    let mut response = if valid_host && valid_origin && !cross_site {
        next.run(request).await
    } else {
        (StatusCode::FORBIDDEN, "Local access only.").into_response()
    };
    for (name, value) in [
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        ("cross-origin-resource-policy", "same-origin"),
        (
            "content-security-policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        ),
    ] {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}

fn unavailable() -> ApiError {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"Trace data is unavailable."})),
    )
}

async fn threads(State(reader): State<SharedReader>) -> Result<Json<Vec<ThreadSummary>>, ApiError> {
    reader
        .lock()
        .map_err(|_| unavailable())?
        .threads()
        .map(Json)
        .map_err(|_| unavailable())
}

fn load_thread(reader: &Mutex<TraceReader>, id: &str) -> Result<ThreadTrace, ApiError> {
    reader
        .lock()
        .map_err(|_| unavailable())?
        .thread(id)
        .map_err(|_| unavailable())?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(json!({"error":"Thread not found."})),
            )
        })
}

async fn thread(
    State(reader): State<SharedReader>,
    Path(id): Path<String>,
) -> Result<Json<ThreadTrace>, ApiError> {
    load_thread(&reader, &id).map(Json)
}

async fn export(
    State(reader): State<SharedReader>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let thread = load_thread(&reader, &id)?;
    let json = serde_json::to_string_pretty(&thread).map_err(|_| unavailable())?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"thread.json\"",
            ),
        ],
        json,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use meedoen_retrieval::traces::TraceStore;
    use serde_json::json;
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
        time::SystemTime,
    };
    use tower::ServiceExt;

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);
    const THREAD: &str = "0123456789abcdef0123456789abcdef";
    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn fixture() -> (Fixture, Router) {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::env::temp_dir().join(format!(
            "coa-trace-viewer-{}-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.join("traces.sqlite");
        let store = TraceStore::open(&path).unwrap();
        let run = store
            .begin(
                THREAD,
                "run-example",
                "Wanneer kan ik tuinieren?",
                json!({"language":"nl"}),
            )
            .unwrap();
        run.event(
            "search.completed",
            Some(8),
            json!({"query":"tuinieren","hits":[]}),
        )
        .unwrap();
        run.complete(Ok(&json!({"answer":{"text":"Dinsdag."}})))
            .unwrap();
        drop(run);
        drop(store);
        let reader = TraceReader::open(&path).unwrap();
        (Fixture(directory), router(reader, 8767))
    }

    async fn get(
        app: Router,
        path: &str,
        host: &str,
        origin: Option<&str>,
    ) -> axum::response::Response {
        let mut request = Request::builder().uri(path).header("host", host);
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        app.oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[test]
    fn cli_requires_an_existing_database_and_only_accepts_a_local_port() {
        assert_eq!(
            parse_args(&["serve".into(), "--db".into(), "private.sqlite".into()]).unwrap(),
            ("private.sqlite".into(), 8767)
        );
        for args in [
            vec![],
            vec!["serve"],
            vec!["serve", "--db"],
            vec!["serve", "--db", "file", "--host", "0.0.0.0"],
            vec!["serve", "--db", "file", "--port", "0"],
            vec!["serve", "--db", "file", "--port", "65536"],
            vec!["serve", "--db", "file", "--db", "other"],
            vec!["serve", "--db", "file", "--port", "8767", "--port", "8768"],
        ] {
            assert!(parse_args(&args.into_iter().map(String::from).collect::<Vec<_>>()).is_err());
        }
    }

    #[tokio::test]
    async fn thread_overview_detail_and_export_are_read_only() {
        let (fixture, app) = fixture();
        let before = fs::read(fixture.0.join("traces.sqlite")).unwrap();
        let response = get(app.clone(), "/api/threads", "127.0.0.1:8767", None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert!(
            !response
                .headers()
                .contains_key("access-control-allow-origin")
        );
        let threads: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(threads[0]["id"], THREAD);
        assert_eq!(threads[0]["trace_count"], 1);
        let response = get(
            app.clone(),
            &format!("/api/threads/{THREAD}"),
            "127.0.0.1:8767",
            None,
        )
        .await;
        let thread = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let data: Value = serde_json::from_slice(&thread).unwrap();
        assert_eq!(data["schema_version"], 1);
        assert!(
            data["traces"][0]["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["kind"] == "search.completed")
        );
        let response = get(
            app.clone(),
            &format!("/api/threads/{THREAD}/export"),
            "127.0.0.1:8767",
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()["content-disposition"]
                .to_str()
                .unwrap()
                .contains("attachment")
        );
        let exported: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(exported, data);
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/threads")
                    .header("host", "127.0.0.1:8767")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(fs::read(fixture.0.join("traces.sqlite")).unwrap(), before);
    }

    #[tokio::test]
    async fn viewer_rejects_foreign_hosts_and_browser_origins() {
        let (_fixture, app) = fixture();
        for (host, origin) in [
            ("attacker.example:8767", None),
            ("127.0.0.1:8768", None),
            ("127.0.0.1:8767", Some("https://attacker.example")),
            ("127.0.0.1:8767", Some("null")),
        ] {
            assert_eq!(
                get(app.clone(), "/api/threads", host, origin)
                    .await
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            get(
                app,
                "/api/threads",
                "localhost:8767",
                Some("http://localhost:8767")
            )
            .await
            .status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn viewer_serves_its_assets_and_missing_threads_return_404() {
        let (_fixture, app) = fixture();
        for path in ["/", "/assets/traces.css", "/assets/traces.js"] {
            let response = get(app.clone(), path, "127.0.0.1:8767", None).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            assert!(
                response.headers()["content-security-policy"]
                    .to_str()
                    .unwrap()
                    .contains("frame-ancestors 'none'")
            );
        }
        assert_eq!(
            get(app, "/api/threads/missing", "127.0.0.1:8767", None)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}
