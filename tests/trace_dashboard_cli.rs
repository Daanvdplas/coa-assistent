use meedoen_retrieval::traces::TraceStore;
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
    time::SystemTime,
};

static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);
const THREAD: &str = "thread-synthetic-cli";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::env::temp_dir().join(format!(
            "coa-trace-cli-{}-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            directory.join(".env"),
            "OPENAI_API_KEY='synthetic-secret-never-read",
        )
        .unwrap();
        Self(directory)
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_meedoen-retrieval"))
            .arg("traces")
            .args(args)
            .current_dir(&self.0)
            .env("OPENAI_API_KEY", "invalid")
            .env("COA_OPENAI_API_KEY_FILE", self.0.join("unused-private-key"))
            .env_remove("COA_DEMO_BUDGET_FILE")
            .output()
            .unwrap()
    }

    fn database(&self, populate: bool) -> PathBuf {
        let path = self.0.join("traces.sqlite");
        let store = TraceStore::open(&path).unwrap();
        if populate {
            let run = store
                .begin(
                    THREAD,
                    "run-synthetic",
                    "Wanneer tuinieren?",
                    json!({"language":"nl"}),
                )
                .unwrap();
            run.event(
                "search.completed",
                Some(4),
                json!({"query":"tuinieren","hits":[]}),
            )
            .unwrap();
            run.complete(Ok(&json!({"answer":{"text":"Dinsdag."}})))
                .unwrap();
        }
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn json_output(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn trace_viewer_opens_only_its_existing_database_before_app_configuration() {
    let fixture = Fixture::new();
    for args in [
        vec!["serve", "--db", "missing.sqlite"],
        vec!["list", "--db", "missing.sqlite"],
        vec!["export", "--db", "missing.sqlite", "--thread", THREAD],
    ] {
        let result = fixture.run(&args);
        let error = String::from_utf8_lossy(&result.stderr);
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
        assert!(error.contains("Trace database is unavailable."), "{error}");
        assert!(!error.contains("synthetic-secret"));
    }
    assert!(!fixture.0.join(".model-cache").exists());
    assert!(!fixture.0.join("missing.sqlite").exists());
}

#[test]
fn direct_list_and_export_print_json_without_mutating_the_database() {
    let fixture = Fixture::new();
    let path = fixture.database(true);
    let original = fs::read(&path).unwrap();
    let listed = json_output(fixture.run(&["list", "--db", path.to_str().unwrap()]));
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], THREAD);
    assert_eq!(listed[0]["trace_count"], 1);
    let exported =
        json_output(fixture.run(&["export", "--db", path.to_str().unwrap(), "--thread", THREAD]));
    assert_eq!(exported["schema_version"], 1);
    assert_eq!(exported["thread_id"], THREAD);
    assert_eq!(exported["traces"][0]["question"], "Wanneer tuinieren?");
    assert_eq!(
        exported["traces"][0]["result"]["answer"]["text"],
        "Dinsdag."
    );
    assert!(
        exported["traces"][0]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "search.completed")
    );
    assert_eq!(fs::read(path).unwrap(), original);
    assert!(!fixture.0.join(".model-cache").exists());
}

#[test]
fn empty_list_is_json_and_unknown_thread_fails_without_output() {
    let fixture = Fixture::new();
    let path = fixture.database(false);
    assert_eq!(
        json_output(fixture.run(&["list", "--db", path.to_str().unwrap()])),
        json!([])
    );
    let result = fixture.run(&[
        "export",
        "--db",
        path.to_str().unwrap(),
        "--thread",
        "missing",
    ]);
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    let error = String::from_utf8_lossy(&result.stderr);
    assert!(error.contains("Thread not found."));
    assert!(!error.contains(path.to_str().unwrap()));
}

#[test]
fn direct_commands_refuse_nonprivate_database_files() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let path = fixture.database(false);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let result = fixture.run(&["list", "--db", path.to_str().unwrap()]);
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(String::from_utf8_lossy(&result.stderr).contains("Trace database is unavailable."));
}
