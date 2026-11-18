# Promptfoo execution and assertion contract

This is the canonical RAG orchestration layer. Promptfoo selects questions, configurations, repetitions and assertions. Rust performs local retrieval or an isolated Codex/MCP session. Native assessors/historical reports remain available for compatibility and inspection; their scores are not imported as new promptfoo measurements. [The RAG index](../README.md) explains browser tests and complete suites.

## Start without model calls

Requires Rust and Node **22.22.0 or newer**. Owned evaluation tools/tests are TypeScript; Python is unnecessary. From the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
cargo build --locked --features sqlite
npm run eval:rag -- --suite all-local
```

Optional `--binary /absolute/path/to/meedoen-retrieval` and `--model-cache /absolute/path/to/.model-cache` select local inputs. SQLite must be compiled into the executable to compare all four storage profiles.

| Suite | Default execution | Answer-model use |
| --- | --- | --- |
| `garden` | 5 fixed gardening questions × dense/Jaccard: 10 rows | None |
| `retrieval` | 50 questions × 4 methods × 4 profiles: 800 rows | None |
| `quality` | Legacy 18 × 24 + independent 12 × 28: 768 rows | None |
| `compact` | Exact Rust projection of one saved T02 trace, metadata/hash/UTF-8 byte checks | No retrieval or model |
| `agentic` | 10 selected questions × 4 methods: 40 sessions | Explicit live opt-in |
| `models` | 10 questions × Sol/Luna × 3 repetitions: 60 sessions | Explicit live opt-in |
| `compact-live` | T02/T05/P05 full/compact pairs: 6 sessions | Explicit live opt-in |

`all-local` selects the first four. Methods are `dense`, `bm25`, `hybrid_rrf`, `hybrid_weighted`; profiles are `documents_sections`, `documents_activities`, `sqlite_sections`, `sqlite_activities`. [cases.cjs](cases.cjs) defines the full matrix. Preserved source/label bytes remain unchanged; this is not a new twelve-document gold corpus.

```sh
npm run eval:rag -- --suite retrieval --dataset legacy --cases T05,P05 --methods bm25 --profiles documents_sections
```

## Codex is the evaluation model route

Obtain usage approval before model work. Every trial requires `--live`, an explicit ledger and session/time limits. This is a small technical execution check, not a full comparison:

```sh
npm run eval:rag:live -- --suite models --phase smoke --cases RAG26-01 --repeat 1 --ledger evals/rag/results/local/model-smoke/ledger.json --max-generations 8 --max-seconds 900
```

That selection requests one Sol and one Luna session. Full `models` retains sixty alternating case/model/repetition slots. `--phase pilot` runs the first four; `--phase remaining --approval <file>` requires independent hash-bound approval of the original preregistration/pilot. Clean interruption resumes at the next unexecuted slot; uncertain attempts stop without retry. Without a phase, only the plan is shown. Smoke selection does not replace the full protocol.

All continuation uses the same shared ledger/limits. A separately authorized new sixty-session comparison needs its own explicit allowance, never a reset of the previous ledger. Before each Codex start, the global counter reserves an attempt. Rust `lock-exec` holds an OS file lock while TypeScript writes and synchronizes the transaction. Crashes release the lock but leave uncertain reservations consumed.

Failed/uncertain attempts count and stop further work without automatic retry. Only proven `model_output_invalid`/`model_contract_violation` outcomes may continue as failed model responses within a comparison; source quality remains unknown. Authentication/network/trace failures stop. Processes fit within remaining shared time, including cleanup. Native subledgers split datasets/models/treatments without enlarging the global limit. No silent reset/extension is allowed. Cache/retries are off; one session runs at a time.

The provider removes OpenAI API-key settings from child environments, loads no key file and uses no promptfoo OpenAI provider or model judge. Codex receives only questions and fixed retrieval settings. Labels, expectations and criteria belong to assertions.

## Results and interpretation

Each execution gets a new ignored `evals/rag/results/local/` directory with real promptfoo JSON, summaries and private native artifacts. Retrieval preparation shares model/index construction only for exactly selected request groups. The provider reads byte-bound records from the same new execution ID, not old benchmark output or promptfoo cache.

`gradingResult.componentResults[].metadata.source_metrics` records complete evidence sets, partial coverage, supported ranking metrics, missed goals, section/activity capacity bounds and N/A where positive goals are absent. Only source quality is assessed; free-form answer quality stays `not_assessed`.

Missing required sources remain a real assertion failure. Unknown/clarification cases without positive targets get integrity checks without perfect/zero source-quality scores. Provider errors, invalid traces and unsupported profiles remain execution problems. Exit code 100 can therefore be a preserved evidence miss; inspect result categories rather than assuming installation failure.

The exporter updates `/resultaten/` using permitted observable fields, excluding credentials, raw runtime paths and private reasoning. Sixty historical records in `../site/results.json` remain unchanged. The [thirteen-call compact comparison](../docs/compact-mcp.md) is historical; the default one-record replay does not claim to re-execute that bundle. Bytes are not quality, provider tokens or money.

## Implementation and verification

- [provider.ts](provider.ts): execution and bounded Codex ledgers.
- [prepare.ts](prepare.ts): exact fresh local request groups without assessment.
- [assertions.ts](assertions.ts): canonical source/trace checks and derived metrics.
- [data-pins.json](data-pins.json): hashes of preserved input bytes, not new labels.

Pinned **promptfoo 0.125.1**, published **25 October 2026 at 02:12:24.374 UTC**, per the [official npm registry](https://registry.npmjs.org/promptfoo). Version and native TypeScript loading were checked **16 November 2026**. The provider follows the installed `ApiProvider.callApi(prompt, context, options)` contract; assertions use promptfoo's JavaScript assertion type with TypeScript files. The real CLI has been checked using Rust BM25 without model calls.

Use `npm run typecheck` and `npm run test:rag`. Set `COA_RAG_BINARY` after building Rust to include file-lock, shared-budget and child-cleanup checks. New model trials pin TypeScript code and the native executable. Historical preregistrations with Python source pins are not rewritten/resumed under changed code; saved results can still be reassessed without models.
