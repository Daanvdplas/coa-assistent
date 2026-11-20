//! Local operator traces; deliberately separate from visitor bearer sessions.
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const UNAVAILABLE: &str = "runtime: De lokale uitvoeringstraces zijn niet beschikbaar.";
const MAX_VALUE_BYTES: usize = 256 * 1024;

#[derive(Debug, Serialize)]
pub struct ThreadSummary {
    pub id: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub trace_count: u64,
    pub failed_count: u64,
    pub latest_question: String,
}
#[derive(Debug, Serialize)]
pub struct ThreadTrace {
    pub schema_version: u32,
    pub thread_id: String,
    pub traces: Vec<TraceRecord>,
}
#[derive(Debug, Serialize)]
pub struct TraceRecord {
    pub id: String,
    pub thread_id: String,
    pub question: String,
    pub status: String,
    pub created_at_ms: u64,
    pub completed_at_ms: Option<u64>,
    pub context: Value,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub events: Vec<TraceEvent>,
}
#[derive(Debug, Serialize)]
pub struct TraceEvent {
    pub sequence: u64,
    pub kind: String,
    pub at_ms: u64,
    pub elapsed_ms: Option<u64>,
    pub data: Value,
}
struct Writer {
    connection: Mutex<Connection>,
    _lock: File,
}
#[derive(Clone)]
pub struct TraceStore(Arc<Writer>);
#[derive(Clone)]
pub struct TraceHandle {
    store: TraceStore,
    id: String,
}
pub struct TraceReader(Connection);

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub(crate) fn anonymous_id(prefix: &str) -> Result<String, String> {
    let mut entropy = [0; 16];
    getrandom::fill(&mut entropy).map_err(|_| UNAVAILABLE)?;
    let suffix: String = entropy.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{prefix}-{suffix}"))
}
fn encoded(value: &Value) -> Result<String, String> {
    let encoded = serde_json::to_string(value).map_err(|_| UNAVAILABLE)?;
    if encoded.len() > MAX_VALUE_BYTES {
        return Err(UNAVAILABLE.into());
    }
    Ok(encoded)
}
fn private_file(path: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?;
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
    {
        return Err(UNAVAILABLE.into());
    }
    Ok(())
}
fn configure(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|_| UNAVAILABLE)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|_| UNAVAILABLE)?;
    Ok(())
}
impl TraceStore {
    /// The operator creates a private directory outside the checkout first.
    pub fn open(path: &Path) -> Result<Self, String> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or(UNAVAILABLE)?;
        let meta = std::fs::symlink_metadata(parent).map_err(|_| UNAVAILABLE)?;
        if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            return Err(UNAVAILABLE.into());
        }
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".writer.lock");
        let lock_path = std::path::PathBuf::from(lock_path);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&lock_path)
            .map_err(|_| UNAVAILABLE)?;
        private_file(&lock_path)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(UNAVAILABLE.into());
        }
        let _database = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| UNAVAILABLE)?;
        private_file(path)?;
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| UNAVAILABLE)?;
        configure(&connection)?;
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| UNAVAILABLE)?;
        if version > 1 {
            return Err(UNAVAILABLE.into());
        }
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| UNAVAILABLE)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| UNAVAILABLE)?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS traces (
            id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, question TEXT NOT NULL,
            status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, completed_at_ms INTEGER,
            context TEXT NOT NULL, result TEXT, error TEXT);
            CREATE INDEX IF NOT EXISTS traces_thread ON traces(thread_id, created_at_ms);
            CREATE TABLE IF NOT EXISTS trace_events (
            trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL, kind TEXT NOT NULL, at_ms INTEGER NOT NULL,
            elapsed_ms INTEGER, data TEXT NOT NULL, PRIMARY KEY(trace_id,sequence));
            PRAGMA user_version=1;",
            )
            .map_err(|_| UNAVAILABLE)?;
        connection.execute("UPDATE traces SET status='interrupted', completed_at_ms=?1, error=?2 WHERE status='pending'", params![now(), "runtime: De uitvoering is onderbroken door een herstart."]).map_err(|_| UNAVAILABLE)?;
        Ok(Self(Arc::new(Writer {
            connection: Mutex::new(connection),
            _lock: file,
        })))
    }
    pub fn begin(
        &self,
        thread_id: &str,
        run_id: &str,
        question: &str,
        context: Value,
    ) -> Result<TraceHandle, String> {
        let context = encoded(&context)?;
        let id = anonymous_id("trace")?;
        let mut connection = self.0.connection.lock().map_err(|_| UNAVAILABLE)?;
        let transaction = connection.transaction().map_err(|_| UNAVAILABLE)?;
        transaction.execute("INSERT INTO traces (id,thread_id,question,status,created_at_ms,context) VALUES (?1,?2,?3,'pending',?4,?5)", params![id,thread_id,question,now(),context]).map_err(|_| UNAVAILABLE)?;
        transaction
            .execute(
                "INSERT INTO trace_events VALUES (?1,1,'run.started',?2,NULL,?3)",
                params![id, now(), json!({"run_id":run_id}).to_string()],
            )
            .map_err(|_| UNAVAILABLE)?;
        transaction.commit().map_err(|_| UNAVAILABLE)?;
        Ok(TraceHandle {
            store: self.clone(),
            id,
        })
    }
}
impl TraceHandle {
    pub fn event(&self, kind: &str, elapsed_ms: Option<u64>, data: Value) -> Result<(), String> {
        let data = encoded(&data)?;
        let connection = self.store.0.connection.lock().map_err(|_| UNAVAILABLE)?;
        let changed = connection.execute("INSERT INTO trace_events SELECT ?1,COALESCE(MAX(sequence),0)+1,?2,?3,?4,?5 FROM trace_events WHERE trace_id=?1 HAVING EXISTS (SELECT 1 FROM traces WHERE id=?1 AND status='pending')", params![self.id,kind,now(),elapsed_ms.map(|value|value as i64),data]).map_err(|_| UNAVAILABLE)?;
        if changed != 1 {
            return Err(UNAVAILABLE.into());
        }
        Ok(())
    }
    pub fn complete(&self, result: Result<&Value, &str>) -> Result<(), String> {
        let (status, result, error) = match result {
            Ok(value) => ("completed", Some(encoded(value)?), None),
            Err(error) => ("failed", None, Some(error)),
        };
        let mut connection = self.store.0.connection.lock().map_err(|_| UNAVAILABLE)?;
        let transaction = connection.transaction().map_err(|_| UNAVAILABLE)?;
        if let Some(error) = error {
            let last=transaction.query_row("SELECT kind,at_ms FROM trace_events WHERE trace_id=?1 ORDER BY sequence DESC LIMIT 1",[&self.id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?))).optional().map_err(|_|UNAVAILABLE)?;
            if let Some((kind, started)) = last
                && matches!(kind.as_str(), "model.started" | "tool.started")
            {
                let kind = kind.replace(".started", ".cancelled");
                transaction.execute("INSERT INTO trace_events SELECT ?1,COALESCE(MAX(sequence),0)+1,?2,?3,?4,?5 FROM trace_events WHERE trace_id=?1",params![self.id,kind,now(),now().saturating_sub(started),json!({"error":error,"local_cancellation":true,"provider_cancellation_confirmed":false}).to_string()]).map_err(|_|UNAVAILABLE)?;
            }
        }
        let changed = transaction.execute("UPDATE traces SET status=?2,completed_at_ms=?3,result=?4,error=?5 WHERE id=?1 AND status='pending'", params![self.id,status,now(),result,error]).map_err(|_| UNAVAILABLE)?;
        if changed != 1 {
            return Err(UNAVAILABLE.into());
        }
        transaction.execute("INSERT INTO trace_events SELECT ?1,COALESCE(MAX(sequence),0)+1,'run.completed',?2,NULL,?3 FROM trace_events WHERE trace_id=?1", params![self.id,now(),json!({"status":status,"error":error}).to_string()]).map_err(|_| UNAVAILABLE)?;
        transaction.commit().map_err(|_| UNAVAILABLE)?;
        Ok(())
    }
}
impl TraceReader {
    pub fn open(path: &Path) -> Result<Self, String> {
        private_file(path)?;
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| UNAVAILABLE)?;
        configure(&connection)?;
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| UNAVAILABLE)?;
        if version != 1 {
            return Err(UNAVAILABLE.into());
        }
        Ok(Self(connection))
    }
    pub fn threads(&self) -> Result<Vec<ThreadSummary>, String> {
        let mut statement = self.0.prepare("SELECT thread_id,MIN(created_at_ms),MAX(COALESCE(completed_at_ms,created_at_ms)),COUNT(*),SUM(status IN ('failed','interrupted')),(SELECT question FROM traces latest WHERE latest.thread_id=traces.thread_id ORDER BY created_at_ms DESC,rowid DESC LIMIT 1) FROM traces GROUP BY thread_id ORDER BY 3 DESC,thread_id").map_err(|_| UNAVAILABLE)?;
        statement
            .query_map([], |row| {
                Ok(ThreadSummary {
                    id: row.get(0)?,
                    created_at_ms: row.get::<_, i64>(1)? as u64,
                    updated_at_ms: row.get::<_, i64>(2)? as u64,
                    trace_count: row.get::<_, i64>(3)? as u64,
                    failed_count: row.get::<_, i64>(4)? as u64,
                    latest_question: row.get(5)?,
                })
            })
            .map_err(|_| UNAVAILABLE)?
            .collect::<Result<_, _>>()
            .map_err(|_| UNAVAILABLE.into())
    }
    pub fn thread(&self, id: &str) -> Result<Option<ThreadTrace>, String> {
        let _snapshot = self.0.unchecked_transaction().map_err(|_| UNAVAILABLE)?;
        let exists = self
            .0
            .query_row(
                "SELECT 1 FROM traces WHERE thread_id=?1 LIMIT 1",
                [id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| UNAVAILABLE)?
            .is_some();
        if !exists {
            return Ok(None);
        }
        let mut statement = self.0.prepare("SELECT id,thread_id,question,status,created_at_ms,completed_at_ms,context,result,error FROM traces WHERE thread_id=?1 ORDER BY created_at_ms,rowid").map_err(|_| UNAVAILABLE)?;
        let rows = statement
            .query_map([id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)? as u64,
                    row.get::<_, Option<i64>>(5)?.map(|value| value as u64),
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })
            .map_err(|_| UNAVAILABLE)?;
        let mut traces = Vec::new();
        for row in rows {
            let (
                id,
                thread_id,
                question,
                status,
                created_at_ms,
                completed_at_ms,
                context,
                result,
                error,
            ) = row.map_err(|_| UNAVAILABLE)?;
            let mut events = self.0.prepare("SELECT sequence,kind,at_ms,elapsed_ms,data FROM trace_events WHERE trace_id=?1 ORDER BY sequence").map_err(|_| UNAVAILABLE)?;
            let events = events
                .query_map([&id], |row| {
                    Ok((
                        row.get::<_, i64>(0)? as u64,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)? as u64,
                        row.get::<_, Option<i64>>(3)?.map(|value| value as u64),
                        row.get::<_, String>(4)?,
                    ))
                })
                .map_err(|_| UNAVAILABLE)?
                .map(|row| {
                    let (sequence, kind, at_ms, elapsed_ms, data) = row.map_err(|_| UNAVAILABLE)?;
                    Ok(TraceEvent {
                        sequence,
                        kind,
                        at_ms,
                        elapsed_ms,
                        data: serde_json::from_str(&data).map_err(|_| UNAVAILABLE)?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            traces.push(TraceRecord {
                id,
                thread_id,
                question,
                status,
                created_at_ms,
                completed_at_ms,
                context: serde_json::from_str(&context).map_err(|_| UNAVAILABLE)?,
                result: result
                    .map(|value| serde_json::from_str(&value))
                    .transpose()
                    .map_err(|_| UNAVAILABLE)?,
                error,
                events,
            });
        }
        Ok(Some(ThreadTrace {
            schema_version: 1,
            thread_id: id.to_owned(),
            traces,
        }))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;

    fn database() -> std::path::PathBuf {
        let mut bytes = [0; 8];
        getrandom::fill(&mut bytes).unwrap();
        let suffix: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let directory = std::env::temp_dir().join(format!("coa-traces-{suffix}"));
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        directory.join("traces.sqlite")
    }

    #[test]
    fn completed_traces_survive_restart_and_stay_grouped_by_anonymous_thread() {
        let path = database();
        {
            let store = TraceStore::open(&path).unwrap();
            let first = store
                .begin(
                    "thread-one",
                    "run-one",
                    "Wanneer tuinieren?",
                    json!({"method":"bm25"}),
                )
                .unwrap();
            first
                .event("tool.started", None, json!({"query":"tuinieren"}))
                .unwrap();
            first
                .event(
                    "tool.completed",
                    Some(7),
                    json!({"hits":[{"source_id":"ACT-TUIN-001"}]}),
                )
                .unwrap();
            first
                .complete(Ok(&json!({"answer":{"text":"Dinsdag"}})))
                .unwrap();
            store
                .begin("thread-one", "run-two", "Waar?", json!({}))
                .unwrap()
                .complete(Err("tool: Niet beschikbaar."))
                .unwrap();
            store
                .begin("thread-two", "run-three", "Welke sport?", json!({}))
                .unwrap()
                .complete(Ok(&json!({})))
                .unwrap();
        }
        let reader = TraceReader::open(&path).unwrap();
        let threads = reader.threads().unwrap();
        assert_eq!(threads.len(), 2);
        let summary = threads.iter().find(|t| t.id == "thread-one").unwrap();
        assert_eq!(summary.trace_count, 2);
        assert_eq!(summary.failed_count, 1);
        let thread = reader.thread("thread-one").unwrap().unwrap();
        assert_eq!(thread.schema_version, 1);
        assert_eq!(thread.traces.len(), 2);
        assert_eq!(
            thread.traces[0]
                .events
                .iter()
                .map(|e| e.kind.as_str())
                .collect::<Vec<_>>(),
            [
                "run.started",
                "tool.started",
                "tool.completed",
                "run.completed"
            ]
        );
        assert_eq!(thread.traces[0].events[2].elapsed_ms, Some(7));
        assert_eq!(thread.traces[1].status, "failed");
        assert!(reader.thread("not-present").unwrap().is_none());
        drop(reader);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_single_writer_marks_only_abandoned_traces_interrupted_on_restart() {
        let path = database();
        {
            let store = TraceStore::open(&path).unwrap();
            let _pending = store
                .begin("thread-one", "run-one", "Pending", json!({}))
                .unwrap();
            assert!(
                TraceStore::open(&path).is_err(),
                "a second writer must not recover active traces"
            );
            let reader = TraceReader::open(&path).unwrap();
            assert_eq!(
                reader.thread("thread-one").unwrap().unwrap().traces[0].status,
                "pending"
            );
        }
        let store = TraceStore::open(&path).unwrap();
        let reader = TraceReader::open(&path).unwrap();
        let thread = reader.thread("thread-one").unwrap().unwrap();
        assert_eq!(thread.traces[0].status, "interrupted");
        assert!(thread.traces[0].completed_at_ms.is_some());
        drop((reader, store));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn retains_old_traces_when_the_writer_restarts() {
        let path = database();
        {
            let store = TraceStore::open(&path).unwrap();
            store
                .begin("thread-one", "run-one", "Waar?", json!({}))
                .unwrap()
                .complete(Ok(&json!({})))
                .unwrap();
            let eight_days_ms = 8 * 24 * 60 * 60 * 1000;
            store
                .0
                .connection
                .lock()
                .unwrap()
                .execute(
                    "UPDATE traces SET created_at_ms = ?1",
                    [now() - eight_days_ms],
                )
                .unwrap();
        }
        let store = TraceStore::open(&path).unwrap();
        let reader = TraceReader::open(&path).unwrap();
        let thread = reader.thread("thread-one").unwrap();
        drop((reader, store));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();

        assert_eq!(thread.map(|thread| thread.traces.len()), Some(1));
    }

    #[test]
    fn retains_more_than_a_thousand_completed_traces() {
        let path = database();
        let store = TraceStore::open(&path).unwrap();
        for index in 0..1_001 {
            store
                .begin("thread-one", &format!("run-{index}"), "Waar?", json!({}))
                .unwrap()
                .complete(Ok(&json!({})))
                .unwrap();
        }
        let reader = TraceReader::open(&path).unwrap();
        let thread = reader.thread("thread-one").unwrap().unwrap();
        drop((reader, store));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();

        assert_eq!(thread.traces.len(), 1_001);
    }

    #[test]
    fn reader_never_creates_missing_storage_and_storage_is_private() {
        let path = database();
        assert!(TraceReader::open(&path).is_err());
        assert!(!path.exists());
        let store = TraceStore::open(&path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        drop(store);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(TraceStore::open(&path).is_err());
        assert!(TraceReader::open(&path).is_err());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
