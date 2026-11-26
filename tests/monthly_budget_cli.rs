use serde_json::Value;
use std::{fs, os::unix::fs::PermissionsExt, process::Command};

#[test]
fn monthly_budget_cli_records_an_opening_balance_without_reinitializing() {
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes).unwrap();
    let directory =
        std::env::temp_dir().join(format!("coa-monthly-cli-{:x}", u64::from_ne_bytes(bytes)));
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.join("monthly.json");
    let date = Command::new("date")
        .args(["-u", "+%Y-%m"])
        .output()
        .unwrap();
    assert!(date.status.success());
    let month = std::str::from_utf8(&date.stdout).unwrap().trim();
    let cli = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_meedoen-retrieval"))
            .arg("demo-monthly-budget")
            .args(args)
            .output()
            .unwrap()
    };
    let init = [
        "init",
        path.to_str().unwrap(),
        "--utc-month",
        month,
        "--max-usd-cents",
        "10000",
        "--opening-usd-cents",
        "13",
    ];
    let initialized = cli(&init);
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );
    let original = fs::read(&path).unwrap();
    assert!(!cli(&init).status.success());
    let status = cli(&["status", path.to_str().unwrap()]);
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let status: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status["utc_month"], month);
    assert_eq!(status["max_usd_nanodollars"], 100_000_000_000_u64);
    assert_eq!(status["charged_usd_nanodollars"], 130_000_000);
    assert_eq!(status["remaining_usd_nanodollars"], 99_870_000_000_u64);
    assert_eq!(fs::read(&path).unwrap(), original);
    let replacement = directory.join("replacement.json");
    fs::copy(&path, &replacement).unwrap();
    fs::rename(&replacement, &path).unwrap();
    assert!(!cli(&["status", path.to_str().unwrap()]).status.success());
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_dir_all(directory).unwrap();
}
