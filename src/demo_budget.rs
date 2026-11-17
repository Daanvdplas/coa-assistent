//! Persistent allowance for physical API attempts, not a dollar or token ledger.
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct State {
    schema_version: u8,
    max_attempts: u64,
    attempts: u64,
}

struct LockedState {
    file: File,
    path: PathBuf,
    state: State,
    failed: bool,
}

pub(crate) struct AttemptBudget(Mutex<LockedState>);

impl AttemptBudget {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        private_parent(path)?;
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?;
        check_identity(&file, path)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // Keep this descriptor for the runner's lifetime; a second server must
        // not own an independent in-memory counter for the same allowance.
        let state = read_state(&mut file)?;
        Ok(Self(Mutex::new(LockedState {
            file,
            path: path.to_owned(),
            state,
            failed: false,
        })))
    }

    pub(crate) fn reserve(&self) -> Result<(), &'static str> {
        let mut locked = self
            .0
            .lock()
            .map_err(|_| "budget: De antwoordservice is tijdelijk gestopt.")?;
        if locked.failed {
            return Err("budget: De antwoordservice is tijdelijk gestopt.");
        }
        let checked =
            check_identity(&locked.file, &locked.path).and_then(|_| read_state(&mut locked.file));
        if checked.as_ref().ok() != Some(&locked.state) {
            locked.failed = true;
            return Err("budget: Het gebruiksbudget is niet beschikbaar.");
        }
        if locked.state.attempts >= locked.state.max_attempts {
            return Err("budget: Het gebruiksbudget van deze demo is bereikt.");
        }
        locked.state.attempts += 1;
        // Never refund uncertain attempts. A failed/partial write stops this
        // runner; after a crash, invalid on-disk state also fails closed.
        let result = (|| -> io::Result<()> {
            let bytes = serde_json::to_vec(&locked.state)?;
            locked.file.seek(SeekFrom::Start(0))?;
            locked.file.write_all(&bytes)?;
            locked.file.set_len(bytes.len() as u64)?;
            locked.file.sync_all()
        })();
        if result.is_err() {
            locked.failed = true;
            return Err("budget: Het gebruiksbudget kan niet worden opgeslagen.");
        }
        Ok(())
    }
}

fn read_state(file: &mut File) -> io::Result<State> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    let state: State = serde_json::from_slice(&bytes)?;
    if bytes.len() > 4096
        || state.schema_version != 1
        || state.max_attempts == 0
        || state.attempts > state.max_attempts
    {
        return Err(io::Error::other("Invalid budget state"));
    }
    Ok(state)
}

fn check_identity(file: &File, path: &Path) -> io::Result<()> {
    private_parent(path)?;
    let metadata = file.metadata()?;
    let named = path.symlink_metadata()?;
    if !metadata.is_file()
        || !named.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o600
        || metadata.dev() != named.dev()
        || metadata.ino() != named.ino()
    {
        return Err(io::Error::other(
            "Budget must remain the same private regular file",
        ));
    }
    Ok(())
}

fn private_parent(path: &Path) -> io::Result<&Path> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let metadata = parent.symlink_metadata()?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o700
    {
        return Err(io::Error::other(
            "Budget directory must be owned by the current user with mode 0700",
        ));
    }
    Ok(parent)
}

pub fn cli(args: &[String]) -> io::Result<()> {
    let [command, path, flag, maximum] = args else {
        return Err(io::Error::other(
            "Usage: demo-budget init PATH --max-attempts POSITIVE_INTEGER",
        ));
    };
    let maximum = maximum.parse::<u64>().ok().filter(|n| *n > 0);
    if command != "init" || flag != "--max-attempts" || maximum.is_none() {
        return Err(io::Error::other(
            "Usage: demo-budget init PATH --max-attempts POSITIVE_INTEGER",
        ));
    }
    let path = Path::new(path);
    let parent = private_parent(path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let bytes = serde_json::to_vec(&State {
        schema_version: 1,
        max_attempts: maximum.unwrap(),
        attempts: 0,
    })?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::{Arc, Barrier},
    };

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let mut identifier = [0u8; 8];
            getrandom::fill(&mut identifier).unwrap();
            let path = std::env::temp_dir().join(format!(
                "coa-attempt-budget-{}-{:x}",
                std::process::id(),
                u64::from_ne_bytes(identifier)
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
        fn initialize(&self, maximum: u64) -> PathBuf {
            let path = self.0.join("attempts.json");
            cli(&[
                "init".into(),
                path.to_str().unwrap().into(),
                "--max-attempts".into(),
                maximum.to_string(),
            ])
            .unwrap();
            path
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn concurrent_attempts_share_one_last_durable_slot() {
        let directory = Directory::new();
        let path = directory.initialize(1);
        let budget = Arc::new(AttemptBudget::open(&path).unwrap());
        assert!(
            AttemptBudget::open(&path).is_err(),
            "A second process/instance cannot acquire the lifetime lock"
        );
        let barrier = Arc::new(Barrier::new(10));
        let threads: Vec<_> = (0..10)
            .map(|_| {
                let (budget, barrier) = (budget.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    budget.reserve().is_ok()
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .map(|t| usize::from(t.join().unwrap()))
                .sum::<usize>(),
            1
        );
        drop(budget);
        assert!(
            AttemptBudget::open(&path)
                .unwrap()
                .reserve()
                .unwrap_err()
                .contains("bereikt")
        );
        let state: State = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(state.attempts, 1);
    }

    #[test]
    fn replacing_the_locked_path_blocks_further_attempts() {
        let directory = Directory::new();
        let path = directory.initialize(3);
        let budget = AttemptBudget::open(&path).unwrap();
        budget.reserve().unwrap();
        let old = directory.0.join("old.json");
        fs::rename(&path, &old).unwrap();
        let replacement = br#"{"schema_version":1,"max_attempts":3,"attempts":0}"#;
        fs::write(&path, replacement).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(budget.reserve().is_err());
        assert_eq!(fs::read(&path).unwrap(), replacement);
        assert_eq!(
            serde_json::from_slice::<State>(&fs::read(old).unwrap())
                .unwrap()
                .attempts,
            1
        );
    }

    #[test]
    fn missing_corrupt_and_non_private_state_never_opens_an_allowance() {
        let directory = Directory::new();
        let path = directory.0.join("attempts.json");
        assert!(AttemptBudget::open(&path).is_err());
        for content in [
            "",
            "{broken",
            r#"{"schema_version":1,"max_attempts":0,"attempts":0}"#,
            r#"{"schema_version":1,"max_attempts":1,"attempts":2}"#,
        ] {
            fs::write(&path, content).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(AttemptBudget::open(&path).is_err());
        }
        fs::write(
            &path,
            r#"{"schema_version":1,"max_attempts":1,"attempts":0}"#,
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(AttemptBudget::open(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let budget = AttemptBudget::open(&path).unwrap();
        fs::write(&path, "invalidated during service lifetime").unwrap();
        assert!(budget.reserve().is_err());
        assert!(budget.reserve().is_err());
    }
}
