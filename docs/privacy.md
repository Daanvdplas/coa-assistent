# Privacy and data lifecycle

Use **fictional activities and questions only**. This independent prototype is not an internal COA plan or a privacy certification. Local embeddings do not keep answer context local: the website sends questions and retrieved passages to OpenAI's Responses API; CLI/model evaluations send context through Codex. The full-context evaluation arm sends all thirty original sections. A separate grader also receives saved answers, criteria and reference passages.

The application does not enforce a general personal-data filter, organizational account policy or document-level authorization. Session tokens are not resident identities or organizational permissions. Do not introduce real resident information or internal COA documents into questions, Git, sources or binaries.

## Where data goes

| Data | Location and purpose | Retention and cleanup |
| --- | --- | --- |
| Fictional source documents | `fixtures/`, Git copies and embedded binary; source API/browser display | Persist until their owners remove sources, old binaries, artifacts and copies. A new commit does not erase Git history. |
| Model weights/tokenizer | `.model-cache/`; local embeddings | Remain on disk across restarts. Stop dependent processes before removing the specific cache. These are model files, not a stored question-vector database. |
| Live source/query vectors | Shared `Index` in server RAM; separate CLI/MCP index when applicable | Process lifetime; stop the server and owned child processes. No secure RAM/swap erasure guarantee. Evaluation SQLite profiles separately persist source/vector caches. |
| Website questions, answers, context and searches | `RunStore` RAM and browser DOM | At most 256 sessions, 40 runs/session, 256 total runs, 256 KiB/run. Sessions expire after 30 minutes without a newly started question; API access cleans up, protecting pending runs. Restart clears app RAM. |
| Session and language preference | `sessionStorage['coa-test-session']`, `localStorage['coa-demo-language']` | Browser-managed; language preference persists. Clear site/session data if needed. Browser cleanup does not erase server/provider copies. |
| Network/session rate counters | Bounded process RAM; abuse control | At most 4096 normalized addresses; expiry on subsequent checks or restart. Addresses are absent from run records, reports and application logs. |
| API key and spending state | Server environment, private untracked working-directory `.env`, or operator-selected external key file; separate persistent schema-2 budget | The key is server-only. Only `OPENAI_API_KEY` is read from `.env`; it cannot issue a budget. Budget contains policy/schema, cap and usage, without questions/answers/addresses/key. Preserve the budget across updates and stops; never reset it as cleanup. |
| Optional `/api/report` TXT export | Download owned by its recipient | Contains question, answer, status and limited safe metadata; not anonymous. The UI has no ordinary export button, but the API remains. Owners must remove their own copies. |
| Evaluation JSON/JSONL, SQLite caches, ledgers and audits | Private local evaluation directories; reproducibility | Persist until deliberately removed by the responsible owner. Keep ledgers/audit evidence for accounting; raw files are not public website assets. |
| Codex temporary schemas/process output | Owned temporary run directory and bounded stdout/stderr buffers | Cleanup is attempted on normal completion, error and cancellation. A hard crash can leave files. Raw stderr/reasoning is not copied into shared run errors; independent Codex/OS diagnostics are not fully inventoried. |
| Provider processing and external diagnostics | OpenAI; optionally a hosting proxy/tunnel operator | Applicable account terms, provider retention, abuse-monitoring logs and deletion capabilities require separate confirmation. Restart cannot erase these copies. |

Current code: [`runs.rs`](../src/runs.rs), [`demo_limits.rs`](../src/demo_limits.rs), [`responses.rs`](../src/responses.rs), [`codex.rs`](../src/codex.rs), [`web.rs`](../src/web.rs) and [browser session handling](../static/site/demo.js). [Architecture](CODEBASE_GUIDE.md) explains limits and [deployment](public-deployment.md) explains the optional public proxy/tunnel.

## Transport and output boundaries

Local browsing uses HTTP on loopback. Web generation uses HTTPS to OpenAI; CLI MCP uses local stdin/stdout pipes, while Codex makes its own provider connections. The Codex bridge exposes one read-only search tool, not arbitrary files/URLs. MCP itself runs as the host user outside the command sandbox; command restrictions are not a claim that every host process is isolated. See [Codex boundaries](codex.md).

`store: false` disables Responses application storage but does not promise Zero Data Retention or the absence of safety logs. API policy cannot be assumed to apply identically to a Codex/ChatGPT login. No authentication files, account agreement, storage encryption, swap, crash dumps, backups or full network/TLS inventory have been inspected as part of this documentation change.

Shared run/configuration metadata uses an allowlist. Provider bodies, key values, private runtime paths and raw reasoning are excluded from public errors/records. Public evaluation projections expose only intentionally selected source/test fields; hiding a UI control does not remove its underlying API. Exact quote checks prove provenance, not correct interpretation, access rights or anonymization. Embeddings and hashes are not automatically anonymous or encrypted.

## Stop and clean up a synthetic run

1. Stop the relevant server and its owned children to prevent further requests. Preserve spending ledgers; accepted provider work can still incur charges.
2. Identify only that run's private output, temporary directories, exports and optional source/vector cache. Remove them only when the owner no longer needs reproducibility/accounting evidence. Do not broadly delete another process's temporary files or reset budgets.
3. Clear the tester's browser session/site data where appropriate. Ask recipients and backup/provider owners to handle their copies under their own policies. The application cannot recall shared downloads or prove secure deletion from swap/backups.
4. If a credential was exposed, stop use and have its authorized owner revoke/rotate it. Do not include the credential in the incident record.

This procedure is bounded local cleanup, not a guarantee of complete deletion. Temporary-schema cleanup and sanitized error tests do not establish a general privacy certification.

## Before considering real organizational data

A separate organizational decision must identify the data owner, permitted fields/purpose, recipients, approved route/account/workspace, access scope, retention/deletion terms and incident contact. Training controls, safety logs, application state, processing/storage regions and international transfers require route-specific confirmation by the responsible account/organization owner. These decisions remain **unknown**; the current prototype does not supply them.

Until those conditions are approved and independently verified, keep real internal data out. If external processing is disallowed, investigate permitted local retrieval separately; this document does not authorize it or select a new provider. Public synthetic testing also needs its own release approval.

Historical provider references: [Codex authentication](https://learn.chatgpt.com/docs/auth), HTTP Last-Modified **21 October 2026, 06:22:09 UTC**; [API data controls](https://developers.openai.com/api/docs/guides/your-data), HTTP Last-Modified **21 October 2026, 06:22:15 UTC**, both retrieved that day. This is recorded HTTP metadata, not an editorial publication date or proof of this account's current terms. Reconfirm the applicable route before any broader use.
