# Private trace inspection

The optional trace store records the web assistant's model and search steps for private inspection. Read thread summaries and JSON directly through the CLI, or use the optional local dashboard. The visitor website has no dashboard link or trace-reading route.

Threads group traces for inspection; they do not add conversational memory. Each run receives only the current question.

## Record traces

Tracing is off unless the website process inherits `COA_TRACE_DB`. Create a private directory outside the checkout:

```sh
mkdir -p "$HOME/.config/coa/traces"
chmod 700 "$HOME/.config/coa/traces"
export COA_TRACE_DB="$HOME/.config/coa/traces/traces.sqlite"
```

Then use the existing [local startup procedure](LOCAL_SETUP.md) with the same approved API key and persistent spending budget. This setting does not authorize model calls or change their limit. `.env` loads only `OPENAI_API_KEY`, so set the trace path in the server environment. Unset `COA_TRACE_DB` to stop recording on the next website start.

The directory must already exist, belong to the current user and have mode `0700`. The writer creates a private `0600` SQLite database, its WAL/SHM files and a writer-lock file in that directory. Only one website writer can open it at a time. Invalid configured storage fails startup; recording errors stop further model work for the affected run. Already reserved model attempts remain spent.

## Read traces without a dashboard

From the project root, list recorded threads and export one thread:

```sh
cargo run --locked -- traces list --db "$HOME/.config/coa/traces/traces.sqlite"
cargo run --locked -- traces export --db "$HOME/.config/coa/traces/traces.sqlite" --thread THREAD_ID
```

`list` writes a JSON array of thread summaries, including IDs, timestamps, run counts and the latest question. An empty database returns `[]`. `export` writes the same complete schema-1 thread JSON as the dashboard download. Replace `THREAD_ID` with an ID from the list.

The application writes only JSON to stdout on success. Failures use stderr and a nonzero exit code; an unknown thread or missing database produces no JSON or new database. These commands open the existing database read-only, start no server and load no API key, activity index or answer service. They need no model calls. Use the built binary directly when scripting to avoid Cargo's build messages on stderr.

## Open the optional dashboard

In a second terminal, from the project root:

```sh
cargo run --locked -- traces serve --db "$HOME/.config/coa/traces/traces.sqlite"
```

Open **http://127.0.0.1:8767/**. Use `--port 8768` if necessary. The command opens an existing database read-only and starts before the activity index, API-key loading or answer service. It needs no provider credentials or model calls and can inspect saved traces while the website is stopped.

Select a thread to inspect its runs, context, results and timed events. **Refresh** loads new records. **Download JSON** exports that thread's complete stored schema-1 record. The download contains questions, answers and source content; the recipient controls its later use and deletion.

The dashboard binds only to `127.0.0.1`, rejects foreign Host/Origin values, sends no CORS permission and disables browser caching. It has no account login; local machine access remains the operator's boundary. Keep it outside public reverse-proxy and tunnel routes.

## Read a hosted database privately

After an approved deployment enables recording, the owner or their agent can use existing SSH authorization to run the CLI as the database-owning application user. For the documented deployment layout:

```sh
ssh operator@your-host 'sudo -u coa-demo env LD_LIBRARY_PATH=/opt/coa-demo/current/lib /opt/coa-demo/current/bin/meedoen-retrieval traces list --db /var/lib/coa-demo/traces/traces.sqlite'
ssh operator@your-host 'sudo -u coa-demo env LD_LIBRARY_PATH=/opt/coa-demo/current/lib /opt/coa-demo/current/bin/meedoen-retrieval traces export --db /var/lib/coa-demo/traces/traces.sqlite --thread THREAD_ID'
```

Replace the SSH account/host and thread ID with the authorized values. This uses the existing SSH access boundary and private file ownership; it adds no public endpoint, dashboard process, port or authentication service. Keep actual trace content out of public chat, Git and reports. If saving JSON, use a private file outside the checkout, with `umask 077`; downloads and copies have their own cleanup lifecycle.

If you prefer the dashboard, run it as the database-owning user on the host and reach its loopback port through SSH:

```sh
ssh -N -L 8767:127.0.0.1:8767 operator@your-host
```

Then open the same local URL. The database-owning user and server paths depend on the approved deployment; these commands do not grant access to a different user's private files.

## What is retained

Each random thread ID groups runs from the same visitor session without storing its bearer/session token or network address. Run records contain the question, selected context, final result or safe error, status and timestamps. Events include projected public model instructions/input/output, token counts, search arguments and retrieved passages, plus timings. Encrypted replay, private reasoning, authorization headers, server-loaded API credentials and raw provider error bodies are excluded. Questions remain as entered: use fictional information only.

The recorder uses the bounded Rig transport and search-tool path. Rig's global content telemetry stays disabled; there is no external trace service. Each stored JSON value is limited to 256 KiB; oversized records fail rather than being silently truncated.

Completed, failed and interrupted traces are pruned to seven days and at most 1000 records on writer startup, new runs and completion. Pending runs are exempt while active; a writer restart marks unfinished runs interrupted. This is activity-triggered cleanup, not a background deletion timer. Stopping the writer can leave older data on disk until it next runs.

To remove traces, stop the website writer and dashboard, then remove only the private trace directory you selected, including its database, WAL/SHM and lock files. Keep spending ledgers intact. JSON downloads, copies and backups have separate owners and are not removed by this cleanup. The database is private local storage, not application-level encrypted storage. See [privacy](privacy.md) for the wider data lifecycle.
