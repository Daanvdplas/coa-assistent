#![cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn operator_lock_survives_wrapper_death_and_releases_after_child_exit() {
    let directory = std::env::temp_dir().join(format!("coa-lock-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let lock = directory.join("ledger.lock");
    let marker = directory.join("ready");
    let binary = env!("CARGO_BIN_EXE_meedoen-retrieval");
    let mut holder = Command::new(binary)
        .args([
            "lock-exec",
            lock.to_str().unwrap(),
            "--",
            "sh",
            "-c",
            "printf ready > \"$1\"; exec sleep 60",
            "sh",
            marker.to_str().unwrap(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.is_file() {
            assert!(
                holder.try_wait().unwrap().is_none(),
                "Lock holder exited before executing child"
            );
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let contender = || {
            Command::new(binary)
                .args([
                    "lock-exec",
                    lock.to_str().unwrap(),
                    "--nonblocking",
                    "--",
                    "sh",
                    "-c",
                    "exit 0",
                ])
                .output()
                .unwrap()
        };
        assert_eq!(contender().status.code(), Some(75));
        holder.kill().unwrap();
        holder.wait().unwrap();
        assert_eq!(
            contender().status.code(),
            Some(75),
            "Child must retain lock after wrapper death"
        );
    }));
    unsafe {
        libc::kill(-(holder.id() as i32), libc::SIGKILL);
    }
    let _ = holder.wait();
    if result.is_ok() {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = Command::new(binary)
                .args([
                    "lock-exec",
                    lock.to_str().unwrap(),
                    "--nonblocking",
                    "--",
                    "sh",
                    "-c",
                    "exit 17",
                ])
                .status()
                .unwrap();
            if status.code() == Some(17) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "OS lock did not release after child death"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    std::fs::remove_dir_all(directory).unwrap();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
