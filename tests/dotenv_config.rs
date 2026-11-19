use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
    time::SystemTime,
};

const FAKE_KEY: &str = "coa-synthetic-dotenv-key";
const MISSING_KEY: &str =
    "runtime: De antwoordservice is nog niet ingesteld. Een OpenAI API-sleutel ontbreekt.";
const MISSING_BUDGET: &str = "budget: Stel eerst het gebruiksbudget voor de antwoordservice in.";
static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

struct Setup(PathBuf);

impl Setup {
    fn new(dotenv: Option<&str>) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "coa-dotenv-{}-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        if let Some(contents) = dotenv {
            fs::write(directory.join(".env"), contents).unwrap();
        }
        Self(directory)
    }

    fn probe(&self, expected: &str, settings: &[(&str, &str)]) {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "configuration_probe", "--nocapture"])
            .current_dir(&self.0)
            .env("COA_CONFIG_PROBE", expected);
        for key in [
            "OPENAI_API_KEY",
            "COA_OPENAI_API_KEY_FILE",
            "COA_DEMO_BUDGET_FILE",
            "COA_RESPONSES_TEST_URL",
            "COA_RESPONSES_TEST_TIMEOUT_MS",
            "COA_DISABLE_DOTENV",
        ] {
            command.env_remove(key);
        }
        command.envs(settings.iter().copied());
        let output = command.output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(!stderr.contains(FAKE_KEY) && !stdout.contains(FAKE_KEY));
        assert!(output.status.success(), "{stderr}{stdout}");
    }
}

impl Drop for Setup {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn configuration_probe() {
    let Ok(expected) = std::env::var("COA_CONFIG_PROBE") else {
        return;
    };
    let runner =
        meedoen_retrieval::responses::ResponsesRunner::from_env(std::sync::Arc::new(|_, _, _| {
            panic!("Configuration must not search or make model requests")
        }));
    let actual = match runner {
        Ok(runner) => {
            assert!(!runner.configuration().to_string().contains(FAKE_KEY));
            "ready".to_owned()
        }
        Err(error) => error,
    };
    assert_eq!(actual, expected);
    assert!(std::env::var_os("OPENAI_API_KEY").is_none_or(|value| value != FAKE_KEY));
}

#[test]
fn dotenv_key_is_loaded_but_does_not_authorize_model_use() {
    let setup = Setup::new(Some(&format!(
        "# Local configuration\nexport OPENAI_API_KEY=\"{FAKE_KEY}\"\nCOA_DEMO_BUDGET_FILE=not-authorized.json\n"
    )));
    setup.probe(MISSING_BUDGET, &[]);
}

#[cfg(unix)]
#[test]
fn dotenv_key_configures_the_runner_with_an_existing_budget_without_spending() {
    use std::os::unix::fs::PermissionsExt;
    let setup = Setup::new(Some(&format!("OPENAI_API_KEY={FAKE_KEY}\n")));
    fs::set_permissions(&setup.0, fs::Permissions::from_mode(0o700)).unwrap();
    let budget = setup.0.join("attempts.json");
    let state = r#"{"schema_version":2,"max_attempts":1,"attempts":0}"#;
    fs::write(&budget, state).unwrap();
    fs::set_permissions(&budget, fs::Permissions::from_mode(0o600)).unwrap();
    setup.probe(
        "ready",
        &[("COA_DEMO_BUDGET_FILE", budget.to_str().unwrap())],
    );
    assert_eq!(fs::read_to_string(budget).unwrap(), state);
}

#[test]
fn shell_key_takes_precedence_over_dotenv() {
    let setup = Setup::new(Some(&format!("OPENAI_API_KEY={FAKE_KEY}\n")));
    setup.probe(
        "runtime: Ongeldige API-sleutel.",
        &[("OPENAI_API_KEY", "short")],
    );
}

#[cfg(unix)]
#[test]
fn explicit_key_file_takes_precedence_over_dotenv() {
    use std::os::unix::fs::PermissionsExt;
    let setup = Setup::new(Some("OPENAI_API_KEY='invalid dotenv"));
    let path = setup.0.join("external-key");
    fs::write(&path, FAKE_KEY).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    setup.probe(
        MISSING_BUDGET,
        &[("COA_OPENAI_API_KEY_FILE", path.to_str().unwrap())],
    );
}

#[test]
fn preview_can_disable_dotenv_loading() {
    let setup = Setup::new(Some(&format!("OPENAI_API_KEY={FAKE_KEY}\n")));
    setup.probe(MISSING_KEY, &[("COA_DISABLE_DOTENV", "1")]);
}

#[test]
fn missing_dotenv_keeps_preview_available() {
    Setup::new(None).probe(MISSING_KEY, &[]);
}

#[test]
fn malformed_dotenv_error_does_not_expose_its_contents() {
    let setup = Setup::new(Some(&format!("OPENAI_API_KEY='{FAKE_KEY}")));
    setup.probe("runtime: Het .env-bestand kan niet worden gelezen.", &[]);
}

#[test]
fn offline_mock_does_not_read_dotenv_or_real_credentials() {
    let setup = Setup::new(Some("OPENAI_API_KEY='invalid dotenv"));
    setup.probe(
        "ready",
        &[("COA_RESPONSES_TEST_URL", "http://127.0.0.1:1/v1/responses")],
    );
}
