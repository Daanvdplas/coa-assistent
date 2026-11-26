use std::{fs, process::Command, time::SystemTime};

#[test]
fn budget_initialization_requires_an_explicit_cap_and_never_resets_existing_state() {
    let directory = std::env::temp_dir().join(format!(
        "coa-demo-budget-cli-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&directory).unwrap();
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.join("attempts.json");
    let binary = env!("CARGO_BIN_EXE_meedoen-retrieval");
    for suffix in [vec![], vec!["--max-attempts", "0"]] {
        assert!(
            !Command::new(binary)
                .arg("demo-budget")
                .arg("init")
                .arg(&path)
                .args(suffix)
                .output()
                .unwrap()
                .status
                .success()
        );
        assert!(!path.exists());
    }
    let output = Command::new(binary)
        .arg("demo-budget")
        .arg("init")
        .arg(&path)
        .args(["--max-attempts", "3"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Explicit budget initialization must succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let original = fs::read(&path).unwrap();
    let state: serde_json::Value = serde_json::from_slice(&original).unwrap();
    assert_eq!(
        state,
        serde_json::json!({"schema_version":2,"max_attempts":3,"attempts":0})
    );
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    assert!(
        !Command::new(binary)
            .arg("demo-budget")
            .arg("init")
            .arg(&path)
            .args(["--max-attempts", "300"])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn failed_provider_attempts_remain_spent_after_crash_and_exhaustion_blocks_http() {
    if std::env::var_os("COA_BUDGET_TEST_CHILD").is_some() {
        let runner = meedoen_retrieval::responses::ResponsesRunner::from_env(std::sync::Arc::new(
            |_, _, _| Err("No search expected".into()),
        ))
        .unwrap();
        assert!(
            runner
                .run(
                    "Wanneer tuinieren?",
                    3,
                    meedoen_retrieval::corpus::CorpusId::DemoTwelve,
                    meedoen_retrieval::codex::AnswerLanguage::Nl,
                    meedoen_retrieval::DemoSearchMethod::Bm25
                )
                .await
                .is_err()
        );
        return;
    }
    use axum::{Router, http::StatusCode, routing::post};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let directory = std::env::temp_dir().join(format!(
        "coa-demo-budget-http-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.join("attempts.json");
    let output = Command::new(env!("CARGO_BIN_EXE_meedoen-retrieval"))
        .arg("demo-budget")
        .arg("init")
        .arg(&path)
        .args(["--max-attempts", "2"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let requests = Arc::new(AtomicUsize::new(0));
    let counts = Arc::new(AtomicUsize::new(0));
    let counted = counts.clone();
    let second_started = Arc::new(tokio::sync::Notify::new());
    let received = requests.clone();
    let signal = second_started.clone();
    let app = Router::new()
        .route(
            "/v1/responses",
            post(move || {
                let received = received.clone();
                let signal = signal.clone();
                async move {
                    if received.fetch_add(1, Ordering::SeqCst) == 1 {
                        signal.notify_one();
                        std::future::pending::<()>().await;
                    }
                    StatusCode::INTERNAL_SERVER_ERROR
                }
            }),
        )
        .route(
            "/v1/responses/input_tokens",
            post(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                async {
                    axum::Json(
                        serde_json::json!({"object":"response.input_tokens","input_tokens":1}),
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/responses", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    for (index, expected) in [1, 2, 2].into_iter().enumerate() {
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "failed_provider_attempts_remain_spent_after_crash_and_exhaustion_blocks_http",
                "--nocapture",
            ])
            .env("COA_BUDGET_TEST_CHILD", "1")
            .env("COA_DEMO_BUDGET_FILE", &path)
            .env("COA_RESPONSES_TEST_URL", &url)
            .env_remove("COA_RESPONSES_TEST_TIMEOUT_MS")
            .env_remove("OPENAI_API_KEY")
            .env_remove("COA_OPENAI_API_KEY_FILE")
            .env_remove("COA_DEMO_MONTHLY_BUDGET_FILE")
            .env_remove("COA_OPENAI_ENFORCED_PROJECT_ID")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        if index == 1 {
            tokio::time::timeout(std::time::Duration::from_secs(5), second_started.notified())
                .await
                .unwrap();
            child.kill().await.unwrap();
        }
        let output =
            tokio::time::timeout(std::time::Duration::from_secs(10), child.wait_with_output())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(
            output.status.success(),
            index != 1,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let state: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            state["attempts"], expected,
            "Failed requests must reserve durably before sending HTTP"
        );
        assert_eq!(requests.load(Ordering::SeqCst), expected);
        assert_eq!(
            counts.load(Ordering::SeqCst),
            expected,
            "Exhaustion must also prevent free metadata traffic"
        );
    }
    server.abort();
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn a_partial_write_cannot_reopen_the_allowance_after_restart() {
    if std::env::var_os("COA_BUDGET_TEST_CHILD").is_some() {
        let path = std::env::var_os("COA_DEMO_BUDGET_FILE").unwrap();
        let restarting = std::env::var("COA_BUDGET_TEST_RESTART").as_deref() == Ok("1");
        if !restarting {
            // Stop inside 99 -> 100. Overwriting without first removing the old
            // tail produces valid JSON with the lower counter 19.
            let maximum = (fs::metadata(&path).unwrap().len() - 2) as libc::rlim_t;
            let limit = libc::rlimit {
                rlim_cur: maximum,
                rlim_max: maximum,
            };
            unsafe {
                libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
                assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &limit), 0);
            }
        }
        let runner = meedoen_retrieval::responses::ResponsesRunner::from_env(std::sync::Arc::new(
            |_, _, _| Err("No search expected".into()),
        ));
        if restarting && runner.is_err() {
            return;
        }
        let runner = runner.unwrap();
        let error = runner
            .run(
                "Wanneer tuinieren?",
                3,
                meedoen_retrieval::corpus::CorpusId::DemoTwelve,
                meedoen_retrieval::codex::AnswerLanguage::Nl,
                meedoen_retrieval::DemoSearchMethod::Bm25,
            )
            .await
            .unwrap_err();
        assert!(
            !restarting,
            "A partial write reopened the allowance after restart: {}",
            fs::read_to_string(path).unwrap()
        );
        assert!(error.starts_with("budget:"));
        return;
    }
    use axum::{Router, http::StatusCode, routing::post};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let directory = std::env::temp_dir().join(format!(
        "coa-demo-budget-io-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.join("attempts.json");
    fs::write(
        &path,
        br#"{"schema_version":2,"max_attempts":150,"attempts":99}"#,
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let counts = Arc::new(AtomicUsize::new(0));
    let counted = counts.clone();
    let received = requests.clone();
    let app = Router::new()
        .route(
            "/v1/responses",
            post(move || {
                let received = received.clone();
                async move {
                    received.fetch_add(1, Ordering::SeqCst);
                    StatusCode::INTERNAL_SERVER_ERROR
                }
            }),
        )
        .route(
            "/v1/responses/input_tokens",
            post(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                async {
                    axum::Json(
                        serde_json::json!({"object":"response.input_tokens","input_tokens":1}),
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/responses", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    for restarting in ["0", "1"] {
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            tokio::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "a_partial_write_cannot_reopen_the_allowance_after_restart",
                    "--nocapture",
                ])
                .env("COA_BUDGET_TEST_CHILD", "1")
                .env("COA_BUDGET_TEST_RESTART", restarting)
                .env("COA_DEMO_BUDGET_FILE", &path)
                .env("COA_RESPONSES_TEST_URL", &url)
                .env_remove("COA_RESPONSES_TEST_TIMEOUT_MS")
                .env_remove("OPENAI_API_KEY")
                .env_remove("COA_OPENAI_API_KEY_FILE")
                .env_remove("COA_DEMO_MONTHLY_BUDGET_FILE")
                .env_remove("COA_OPENAI_ENFORCED_PROJECT_ID")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    assert_eq!(counts.load(Ordering::SeqCst), 0);
    server.abort();
    fs::remove_dir_all(directory).unwrap();
}
