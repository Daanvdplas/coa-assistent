use std::{fs, process::Command, time::SystemTime};

#[test]
fn trace_viewer_opens_only_its_existing_database_before_app_configuration() {
    let directory = std::env::temp_dir().join(format!(
        "coa-trace-cli-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&directory).unwrap();
    fs::write(
        directory.join(".env"),
        "OPENAI_API_KEY='synthetic-secret-never-read",
    )
    .unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_meedoen-retrieval"))
        .args(["traces", "serve", "--db", "missing.sqlite"])
        .current_dir(&directory)
        .env_remove("OPENAI_API_KEY")
        .env_remove("COA_OPENAI_API_KEY_FILE")
        .env_remove("COA_DEMO_BUDGET_FILE")
        .output()
        .unwrap();
    let error = String::from_utf8_lossy(&result.stderr);
    assert!(!result.status.success());
    assert!(error.contains("Trace database is unavailable."), "{error}");
    assert!(!error.contains("synthetic-secret"));
    assert!(!directory.join(".model-cache").exists());
    assert!(!directory.join("missing.sqlite").exists());
    fs::remove_dir_all(directory).unwrap();
}
