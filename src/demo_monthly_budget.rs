//! Private UTC-month allowance for the hosted demo's fixed Responses request policy.
use crate::demo_budget::{
    check_identity, create_json_state, lock_private_file, open_private_file, read_json_state,
    write_json_state,
};
use crate::responses::cost_observation::PRICE_TABLE;
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io,
    mem::MaybeUninit,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

const SCHEMA_VERSION: u8 = 1;
const NANODOLLARS_PER_CENT: u64 = 10_000_000;
const UNAVAILABLE: &str = "budget: Het gebruiksbudget is niet beschikbaar.";
const EXHAUSTED: &str = "budget: De uitgavenlimiet van de demo is bereikt.";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct State {
    schema_version: u8,
    price_table: String,
    file_device: u64,
    file_inode: u64,
    utc_month: u32,
    max_usd_nanodollars: u64,
    opening_usd_nanodollars: u64,
    charged_usd_nanodollars: u64,
    requires_review: bool,
}

struct LockedState {
    file: File,
    path: PathBuf,
    state: State,
    failed: bool,
}

pub(crate) struct MonthlyBudget(Mutex<LockedState>);

pub(crate) struct Reservation<'a> {
    budget: &'a MonthlyBudget,
    utc_month: u32,
    maximum: u64,
}

impl MonthlyBudget {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        let mut file = lock_private_file(path)?;
        let state = read_state(&mut file)?;
        if state.requires_review {
            return Err(io::Error::other("Monthly budget requires operator review"));
        }
        if state.utc_month > utc_month()? {
            return Err(io::Error::other("Monthly budget is for a future UTC month"));
        }
        Ok(Self(Mutex::new(LockedState {
            file,
            path: path.to_owned(),
            state,
            failed: false,
        })))
    }

    fn verified_state(&self) -> Result<MutexGuard<'_, LockedState>, &'static str> {
        let mut locked = self.0.lock().map_err(|_| UNAVAILABLE)?;
        let LockedState {
            file,
            path,
            state,
            failed,
        } = &mut *locked;
        if *failed {
            return Err(UNAVAILABLE);
        }
        if check_identity(file, path)
            .and_then(|()| read_state(file))
            .as_ref()
            .ok()
            != Some(state)
        {
            *failed = true;
            return Err(UNAVAILABLE);
        }
        Ok(locked)
    }

    pub(crate) fn reserve(&self, maximum: u64) -> Result<Reservation<'_>, &'static str> {
        self.reserve_for(maximum, utc_month)
    }

    fn reserve_for(
        &self,
        maximum: u64,
        current_month: impl FnOnce() -> io::Result<u32>,
    ) -> Result<Reservation<'_>, &'static str> {
        let mut locked = self.verified_state()?;
        if locked.state.requires_review {
            return Err(UNAVAILABLE);
        }
        let month = current_month().map_err(|_| UNAVAILABLE)?;
        let effective = state_for_month(&locked.state, month).map_err(|_| UNAVAILABLE)?;
        let charged = effective
            .charged_usd_nanodollars
            .checked_add(maximum)
            .filter(|charge| maximum > 0 && *charge <= effective.max_usd_nanodollars)
            .ok_or(EXHAUSTED)?;
        locked.store(State {
            charged_usd_nanodollars: charged,
            ..effective
        })?;
        Ok(Reservation {
            budget: self,
            utc_month: month,
            maximum,
        })
    }
}

impl LockedState {
    fn store(&mut self, state: State) -> Result<(), &'static str> {
        if write_json_state(&mut self.file, &state).is_err() {
            self.failed = true;
            return Err(UNAVAILABLE);
        }
        self.state = state;
        Ok(())
    }
}

impl Reservation<'_> {
    pub(crate) fn settle(self, actual: u64) -> Result<(), &'static str> {
        // Consuming the reservation makes crediting it twice impossible.
        let mut locked = self.budget.verified_state()?;
        if locked.state.utc_month != self.utc_month || locked.state.requires_review {
            return Ok(());
        }
        let Some(refund) = self.maximum.checked_sub(actual) else {
            return Ok(());
        };
        if refund == 0 {
            return Ok(());
        }
        let mut next = locked.state.clone();
        next.charged_usd_nanodollars = next
            .charged_usd_nanodollars
            .checked_sub(refund)
            .filter(|charge| *charge >= next.opening_usd_nanodollars)
            .ok_or(UNAVAILABLE)?;
        locked.store(next)
    }

    pub(crate) fn flag_policy_mismatch(self) -> Result<(), &'static str> {
        let mut locked = self.budget.verified_state()?;
        if locked.state.requires_review {
            return Ok(());
        }
        let mut next = locked.state.clone();
        next.requires_review = true;
        locked.store(next)
    }
}

fn initialize(path: &Path, month: u32, maximum: u64, opening: u64) -> io::Result<()> {
    create_json_state(path, |file| {
        let metadata = file.metadata()?;
        Ok(State {
            schema_version: SCHEMA_VERSION,
            price_table: PRICE_TABLE.into(),
            file_device: metadata.dev(),
            file_inode: metadata.ino(),
            utc_month: month,
            max_usd_nanodollars: maximum,
            opening_usd_nanodollars: opening,
            charged_usd_nanodollars: opening,
            requires_review: false,
        })
    })
}

fn read_state(file: &mut File) -> io::Result<State> {
    let state: State = read_json_state(file)?;
    let metadata = file.metadata()?;
    if state.file_device != metadata.dev() || state.file_inode != metadata.ino() {
        return Err(io::Error::other("Monthly budget file was replaced"));
    }
    if state.schema_version != SCHEMA_VERSION
        || state.price_table != PRICE_TABLE
        || !valid_month(state.utc_month)
        || state.max_usd_nanodollars == 0
        || state.opening_usd_nanodollars > state.charged_usd_nanodollars
        || state.charged_usd_nanodollars > state.max_usd_nanodollars
    {
        return Err(io::Error::other("Invalid monthly budget state"));
    }
    Ok(state)
}

fn state_for_month(previous: &State, month: u32) -> io::Result<State> {
    if month < previous.utc_month {
        return Err(io::Error::other("UTC month precedes the monthly budget"));
    }
    let mut effective = previous.clone();
    if month > previous.utc_month {
        effective.utc_month = month;
        effective.opening_usd_nanodollars = 0;
        effective.charged_usd_nanodollars = 0;
    }
    Ok(effective)
}

fn valid_month(month: u32) -> bool {
    (1..=9999).contains(&(month / 100)) && (1..=12).contains(&(month % 100))
}

fn utc_month() -> io::Result<u32> {
    let invalid = || io::Error::other("UTC month is unavailable");
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid())?
        .as_secs();
    let seconds = libc::time_t::try_from(seconds).map_err(|_| invalid())?;
    let mut tm = MaybeUninit::<libc::tm>::uninit();
    // gmtime_r initializes the caller-owned tm on success and uses UTC.
    if unsafe { libc::gmtime_r(&seconds, tm.as_mut_ptr()) }.is_null() {
        return Err(invalid());
    }
    let tm = unsafe { tm.assume_init() };
    let year = tm
        .tm_year
        .checked_add(1900)
        .and_then(|year| u32::try_from(year).ok())
        .ok_or_else(invalid)?;
    let month = u32::try_from(tm.tm_mon + 1).map_err(|_| invalid())?;
    let value = year
        .checked_mul(100)
        .and_then(|year| year.checked_add(month))
        .ok_or_else(invalid)?;
    valid_month(value).then_some(value).ok_or_else(invalid)
}

fn parse_month(value: &str) -> Option<u32> {
    let (year, month) = value.split_once('-')?;
    if year.len() != 4
        || month.len() != 2
        || !value.bytes().all(|b| b.is_ascii_digit() || b == b'-')
    {
        return None;
    }
    let value = year.parse::<u32>().ok()? * 100 + month.parse::<u32>().ok()?;
    valid_month(value).then_some(value)
}

fn parse_cents(value: &str) -> Option<u64> {
    value.parse::<u64>().ok()?.checked_mul(NANODOLLARS_PER_CENT)
}

pub fn cli(args: &[String]) -> io::Result<()> {
    const USAGE: &str = "Usage: demo-monthly-budget init PATH --utc-month YYYY-MM --max-usd-cents CENTS --opening-usd-cents CENTS | demo-monthly-budget status PATH";
    match args {
        [
            command,
            path,
            month_flag,
            month,
            max_flag,
            maximum,
            opening_flag,
            opening,
        ] if command == "init"
            && month_flag == "--utc-month"
            && max_flag == "--max-usd-cents"
            && opening_flag == "--opening-usd-cents" =>
        {
            let month = parse_month(month).ok_or_else(|| io::Error::other(USAGE))?;
            if month != utc_month()? {
                return Err(io::Error::other(
                    "Initialize the ledger in its current UTC month",
                ));
            }
            let maximum = parse_cents(maximum)
                .filter(|amount| *amount > 0)
                .ok_or_else(|| io::Error::other(USAGE))?;
            let opening = parse_cents(opening)
                .filter(|amount| *amount <= maximum)
                .ok_or_else(|| io::Error::other(USAGE))?;
            initialize(Path::new(path), month, maximum, opening)
        }
        [command, path] if command == "status" => {
            let path = Path::new(path);
            let mut file = open_private_file(path, false)?;
            let persisted = read_state(&mut file)?;
            check_identity(&file, path)?;
            let state = state_for_month(&persisted, utc_month()?)?;
            println!(
                "{}",
                serde_json::json!({
                    "schema_version": state.schema_version,
                    "price_table": state.price_table,
                "requires_review": state.requires_review,
                    "utc_month": format!("{:04}-{:02}", state.utc_month / 100, state.utc_month % 100),
                    "max_usd_nanodollars": state.max_usd_nanodollars,
                    "opening_usd_nanodollars": state.opening_usd_nanodollars,
                    "charged_usd_nanodollars": state.charged_usd_nanodollars,
                    "remaining_usd_nanodollars": state.max_usd_nanodollars - state.charged_usd_nanodollars,
                })
            );
            Ok(())
        }
        _ => Err(io::Error::other(USAGE)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, sync::Barrier};

    struct Ledger(PathBuf);
    impl Ledger {
        fn new(month: u32, maximum: u64, opening: u64) -> Self {
            let name = crate::traces::anonymous_id("coa-monthly-ledger").unwrap();
            let dir = std::env::temp_dir().join(name);
            fs::create_dir(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
            let path = dir.join("monthly.json");
            initialize(&path, month, maximum, opening).unwrap();
            Self(path)
        }
        fn state(&self) -> State {
            read_state(&mut open_private_file(&self.0, false).unwrap()).unwrap()
        }
    }
    impl Drop for Ledger {
        fn drop(&mut self) {
            fs::remove_dir_all(self.0.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn uncertain_debit_survives_restart_and_valid_charge_credits_only_unused_headroom() {
        let month = utc_month().unwrap();
        let ledger = Ledger::new(month, 1000, 100);
        let budget = MonthlyBudget::open(&ledger.0).unwrap();
        assert!(MonthlyBudget::open(&ledger.0).is_err());
        let uncertain = budget.reserve(400).unwrap();
        assert_eq!(ledger.state().charged_usd_nanodollars, 500);
        let known = budget.reserve(300).unwrap();
        assert!(matches!(budget.reserve(201), Err(EXHAUSTED)));
        known.settle(50).unwrap();
        assert_eq!(ledger.state().charged_usd_nanodollars, 550);
        let _ = uncertain;
        drop(budget);
        let reopened = MonthlyBudget::open(&ledger.0).unwrap();
        assert!(matches!(reopened.reserve(451), Err(EXHAUSTED)));
        let _ = reopened.reserve(450).unwrap();
        assert_eq!(ledger.state().charged_usd_nanodollars, 1000);
        assert_eq!(ledger.state().opening_usd_nanodollars, 100);
    }

    #[test]
    fn concurrent_reservations_cannot_spend_the_same_remaining_amount() {
        let ledger = Ledger::new(202601, 1000, 0);
        let budget = MonthlyBudget::open(&ledger.0).unwrap();
        let barrier = Barrier::new(12);
        let accepted = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..12)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        budget.reserve_for(600, || Ok(202601)).is_ok()
                    })
                })
                .collect();
            threads
                .into_iter()
                .filter_map(|thread| thread.join().unwrap().then_some(()))
                .count()
        });
        assert_eq!(accepted, 1);
        assert_eq!(ledger.state().charged_usd_nanodollars, 600);
    }

    #[test]
    fn rollover_refuses_clock_regression_and_never_credits_old_work_to_the_new_month() {
        let ledger = Ledger::new(202601, 1000, 200);
        let budget = MonthlyBudget::open(&ledger.0).unwrap();
        let old = budget.reserve_for(700, || Ok(202601)).unwrap();
        let new = budget.reserve_for(900, || Ok(202602)).unwrap();
        assert!(matches!(
            budget.reserve_for(1, || Ok(202601)),
            Err(UNAVAILABLE)
        ));
        old.settle(0).unwrap();
        assert_eq!(ledger.state().charged_usd_nanodollars, 900);
        new.settle(701).unwrap();
        assert_eq!(ledger.state().opening_usd_nanodollars, 0);
        assert_eq!(ledger.state().charged_usd_nanodollars, 701);
        assert_eq!(ledger.state().utc_month, 202602);
    }

    #[test]
    fn an_incompatible_paid_receipt_blocks_future_requests_across_restarts_and_months() {
        let ledger = Ledger::new(202601, 1000, 100);
        {
            let budget = MonthlyBudget::open(&ledger.0).unwrap();
            budget
                .reserve_for(250, || Ok(202601))
                .unwrap()
                .flag_policy_mismatch()
                .unwrap();
            assert!(matches!(
                budget.reserve_for(1, || Ok(202602)),
                Err(UNAVAILABLE)
            ));
        }
        assert!(ledger.state().requires_review);
        assert_eq!(ledger.state().charged_usd_nanodollars, 350);
        assert!(MonthlyBudget::open(&ledger.0).is_err());
    }

    #[test]
    fn unexpected_mutation_replacement_and_corruption_block_admission() {
        for replace in [false, true] {
            let ledger = Ledger::new(202601, 1000, 0);
            let budget = MonthlyBudget::open(&ledger.0).unwrap();
            if replace {
                let original = ledger.0.with_extension("archived");
                fs::rename(&ledger.0, &original).unwrap();
                fs::copy(&original, &ledger.0).unwrap();
            } else {
                fs::write(&ledger.0, []).unwrap();
            }
            assert!(matches!(
                budget.reserve_for(1, || Ok(202601)),
                Err(UNAVAILABLE)
            ));
            drop(budget);
            assert!(MonthlyBudget::open(&ledger.0).is_err());
        }
    }
}
