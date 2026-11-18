# Use a selected retrieval configuration with Codex

The local comparison (`lab run`) uses no Codex or AI judge. `lab ask` then runs one search method and one storage/structure profile in a real Codex session with only the read-only search tool. Settings and typed filters remain fixed; Codex can make at most four search attempts with the same selected top-k. This is a CLI/evaluation route, separate from the Rig website. See the [runtime contract](codex.md).

## Run it

Use an authenticated, compatible Codex runtime and the existing `COA_CODEX_BIN`/`COA_CODEX_MODEL` settings where needed. No new API key is required for this route. Obtain explicit authorization for the model sessions before running:

```sh
rag_output_dir=$(mktemp -d /tmp/coa-selected-rag.XXXXXX)
cargo run --locked --features sqlite -- lab ask --live \
  --methods bm25 --profiles sqlite_activities \
  --question 'Welke activiteit kan ik op dinsdag binnen doen, hoe laat en waar?' \
  --output "$rag_output_dir/antwoord-1.jsonl" \
  --ledger "$rag_output_dir/budget.json" \
  --max-generations 6 --max-seconds 1200
```

This creates a bounded ledger: at most six sessions in twenty minutes, one at a time, each at most 120 seconds. Reuse the same ledger and limits for subsequent questions, with a new output file each time. Failed attempts consume reservations; expired/corrupt ledgers are not renewed automatically. Ctrl+C stops owned subprocesses and keeps the reserved attempt as cancelled. These counts are **sessions**, not known provider HTTP-request counts.

Runtime startup is included in the deadline. The asynchronous `--version` probe owns a process group stopped on timeout/cancellation; executable hashing does not interrupt the deadline. Debug builds optimize only the existing SHA-256 implementation to avoid unnecessary startup delay; hash values and release settings remain unchanged.

`--methods` accepts exactly one of `dense`, `bm25`, `hybrid_rrf`, `hybrid_weighted`. `--profiles` accepts one of `documents_sections`, `documents_activities`, `sqlite_sections`, `sqlite_activities`. Document-only profiles can be built without `--features sqlite`.

Advanced `lab plan` options also apply, including `--top-k 3`, `--selection activity_expansion`, `--mmr on` and `--context-limit 1200`. Supply typed JSON filters with `--query-filters` and enable them with `--apply-filters on`; they apply to all follow-up searches. No filter is inferred from case IDs or expected answers.

BM25 initializes no embedding model. Vector/hybrid methods share MiniLM and its cache with `lab run`; preparation can download model files. Warm the cache with the local comparison first if needed. `--model-cache` and `--sqlite-dir` can be explicit.

## Evidence and checks

The versioned live JSONL records selected configuration, budget reservation, available Codex output and actual searches: passages, component ranks/scores, source dates, preparation and measured search times. BM25/hybrid scores are not labelled cosine similarity or confidence. Missing token usage remains unknown.

Hard checks bind searches to fixed settings and original sections. Quotes must appear exactly in offered passages from the same document and source date. Modified source text, wrong score kinds, invented applied filters or changed context accounting are rejected. Silent fallback to another method is forbidden.

A passing check does not prove a correct answer. `answer_quality_status` remains `not_assessed`; the AI judge stays off. These files have their own live-answer schema and are not retrieval-only reports.

SQLite storage and embeddings are local; the question and selected tool information go to Codex using the existing login. Use fictional information only. No records are changed, messages sent or participants enrolled.
