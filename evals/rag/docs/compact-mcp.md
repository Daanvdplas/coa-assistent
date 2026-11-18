# Compact MCP with a full local audit

**Current orchestrator:** [promptfoo](../README.md). Native procedures below describe the retained layer or historical reporting. The default promptfoo replay uses one available T02 record; the original thirteen-response input bundle is absent from this checkout.

`lab ask --live` defaults to `--payload-mode compact`. Select `full` explicitly for the old model-visible format. Payload choice, method, storage, top-k and filters are fixed for the session. Historical schema-1 files retain their original behavior.

Compact sends one copy of each exact offered section with document ID, title, section ID, source date and text. Query, top-k, reference date, source catalog and configuration/corpus manifest remain available. Ranks, all candidates, startup measurements and duplicate hit text stay in the local audit. `_meta`/`structuredContent` are not assumed hidden channels.

## Audit and integrity

`--output /tmp/antwoord.jsonl` also creates `/tmp/antwoord.mcp-trace.jsonl`, both new files with mode `0600`. Paths come only from CLI configuration, never search arguments. The only MCP tool remains read-only search; it does not load gold files.

Before emitting a successful compact result, MCP writes and synchronizes the full result to the trace. Its public response includes session ID, sequence, request ID, trace ID and full-result SHA-256. They identify successful searches, not provider HTTP requests. Trace excludes private reasoning, authentication and runtime stdout.

After generation, the parent binds every offered result to its trace record. Missing, duplicate, swapped, foreign or truncated records fail. Existing guards then check full settings, exact original sources, dates and quotes. All attempts, including invalid arguments, count toward four. Passing integrity checks is not answer-quality assessment.

Timeout/Ctrl+C preserves synchronized trace records. `partial_not_validated` means records are readable but no completed answer was bound; `invalid` fails the run without invented byte/quality metrics. New live schema 2 records `payload_mode`, `transport_treatment_id`, `audit_trace` and `trace_integrity_status`. Schema 1 loads as `full`, without invented audit evidence. Retrieval-config identity stays separate from transport-treatment identity.

`audit_trace.payload_bytes` measures UTF-8 JSON in successful MCP text blocks, excluding JSON-RPC envelopes/errors. `trace_bytes` is actual JSONL file size. Neither is provider tokens. Fewer bytes alone prove no cost, latency or answer-quality gain.

## Historical offline replay

The pure Rust projection compacts saved full tool results without model/embedding calls. This explicit historical replay requires the original thirteen-response bundle and matching source/configuration guards:

```sh
COA_MCP_REPLAY_INPUT=/path/to/historical/live-directory \
COA_MCP_REPLAY_OUTPUT=/tmp/mcp-replay-new.json \
cargo test --locked --features sqlite --lib \
  replay_historical_model_payload_bytes_without_models -- --ignored --nocapture
```

SQLite is needed because historical configurations include it. Output must be new. The report checks identical offered sections, query, top-k, catalog, date and manifest; answer quality, latency, money and provider tokens are explicitly unmeasured.

The **3 November 2026** replay recorded **161,029 → 35,405 bytes (78.0% fewer)** over thirteen calls. Per-call ranges were full 5,973–17,547 and compact 1,963–5,116. These are minified UTF-8 serde-JSON bytes; extra whitespace/ASCII escaping changes counts. This is a structural comparison of saved outputs, not a fresh retrieval benchmark or live A/B test.

## Predeclared live comparison

The retained proposal contains three pairs/six generation sessions and zero judge calls. It is not a statement that the comparison has been executed. New trials use promptfoo's explicitly authorized `compact-live` suite.

| Question | Method | Profile | Payloads |
| --- | --- | --- | --- |
| T02 | BM25 | documents_sections | full + compact |
| T05 | hybrid_rrf | documents_activities | full + compact |
| P05 | dense | documents_activities | full + compact |

Within each pair, keep question, model/runtime, corpus and settings identical: sections, top-k 3, candidate-k 30, context ceiling 1200, MMR off, filters off. Alternate payload order. Predeclare commands before results; gold never goes to the model. Use new outputs and one approved shared ledger.

Check completion, source/citation guards, trace binding and available usage separately. Retain actual queries, offered sections, attempts, payload/trace bytes and duration. The same user question can produce different follow-up queries; identical retrieval requires identical requests. Answer-quality comparison remains separate/open. Six sessions support no general ranking or statistically supported speed claim. Any extension, such as twelve sessions, requires explicit approval; no calls start automatically.
