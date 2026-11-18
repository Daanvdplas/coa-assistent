# Run the complete-assistant evaluation

This protocol uses five fictional documents, twelve development/pilot questions and six predeclared comparison questions. Inspect evidence coverage, answer quality and efficiency separately. The small set and provisional AI judge support an exploratory comparison, not a general reliability claim.

## 1. Start without model calls

Run from the repository root. Rust/dependencies are required; Cargo may download dependencies during the first build. No Codex login is needed:

```sh
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo run --locked -- experiment validate
cargo run --locked -- experiment validate --questions evals/shared/datasets/legacy/heldout-questions.json --expectations evals/shared/datasets/legacy/heldout-expectations.json

mkdir -p /tmp/coa-rag-preview
cargo run --locked -- experiment report --input evals/coa-assistent/fixtures/report-example.jsonl --output /tmp/coa-rag-preview/voorbeeld.html
```

Open `voorbeeld.html`. Its six handmade renderer checks remain labelled as examples. Filtering/expansion works directly from disk without a model/network. The live demo remains separate.

## 2. Check two known questions

First obtain explicit authorization for model usage. This route needs an authenticated compatible [Codex runtime](../../../docs/codex.md) and local embedding files. MiniLM embeds locally; answer generation and separate judging send context to OpenAI through Codex and consume usage. `--live` is required.

Choose a new directory for an independently authorized run. Resume with the **existing directory and same ledger**. Every output file must be new:

```sh
COA_EVAL_DIR=/tmp/coa-rag-evaluation
mkdir -p "$COA_EVAL_DIR"

cargo run --locked -- experiment run --live --cases P01,P06 --arms agentic_dense,full_context --output "$COA_EVAL_DIR/smoke-generation.jsonl" --ledger "$COA_EVAL_DIR/ledger.json" --max-cases 2 --max-generations 4 --max-judgements 0 --max-seconds 600
```

This smoke check uses two questions with Codex search/direct context, at most four generations. Each attempt reserves a session first. The shared ledger bounds the full protocol to 40 generation sessions, 56 judgment sessions and four hours; failures count. Only one session runs at a time, at most 120 seconds. A session can contain several provider requests; MCP searches are traced separately.

An expired window stops work. Never renew/reset the ledger to bypass usage. Only an explicitly authorized continuation may extend its existing expired window:

```sh
cargo run --locked -- experiment extend-window --ledger "$COA_EVAL_DIR/ledger.json" --seconds 14400 --authorize-continuation
```

The command requires an existing expired, exclusively locked ledger. It preserves original start, consumed sessions and 40/56 ceilings, recording old/new deadlines, authorization reason/time and counters. An active window, invalid audit chain or corrupt ledger is refused. Older binaries refuse the extended schema; use the matching current executable.

## 3. Complete the pilot, then compare six questions

Run the remaining ten pilot cases once. Together with the smoke cases, they cover twelve known questions; preserve original context failures:

```sh
cargo run --locked -- experiment run --live --cases P02,P03,P04,P05,P07,P08,P09,P10,P11,P12 --arms agentic_dense --output "$COA_EVAL_DIR/pilot-generation.jsonl" --ledger "$COA_EVAL_DIR/ledger.json" --max-cases 10 --max-generations 10 --max-judgements 0 --max-seconds 1800
```

Review the pilot and freeze prompts, sources, criteria and settings **before** the first six-case comparison. These are new compositions of known facts. Do not tune on their results and call a later run unseen:

```sh
cargo run --locked -- experiment run --live --questions evals/shared/datasets/legacy/heldout-questions.json --expectations evals/shared/datasets/legacy/heldout-expectations.json --cases T01,T02,T03,T04,T05,T06 --arms agentic_dense,full_context,dense_once,bm25 --output "$COA_EVAL_DIR/heldout-generation.jsonl" --ledger "$COA_EVAL_DIR/ledger.json" --max-cases 6 --max-generations 24 --max-judgements 0 --max-seconds 3600
```

The arms are iterative Codex/MCP retrieval, all thirty source sections supplied directly without tools, one MiniLM search and one BM25 search. The last two offer only their selected passages to the same answer model. BM25 uses k1=1.2, b=0.75, no stemming; its lexical scores are unbounded. Artifacts preserve source/question hashes, model/executable identity, actual context, errors, citations and available usage. Unknown usage stays `null`; aliases/provider routing limit exact reproducibility.

The standard protocol uses **4 + 10 + 24 = 38 generations**. At most two technically justified additional attempts fit the ceiling. There are no automatic retries; record the reason/selected run and preserve the first failure.

## 4. Judge saved answers separately

These commands create judgments, not new answers or searches. The judge receives the question, complete saved answer, actual offered context and separately loaded criteria/reference passages. It has no MCP, shell, files, browser or other tools:

```sh
cargo run --locked -- experiment grade --live --input "$COA_EVAL_DIR/smoke-generation.jsonl" --output "$COA_EVAL_DIR/smoke-graded.jsonl" --ledger "$COA_EVAL_DIR/ledger.json" --max-judgements 4 --max-seconds 600

cargo run --locked -- experiment grade --live --input "$COA_EVAL_DIR/pilot-generation.jsonl" --output "$COA_EVAL_DIR/pilot-graded.jsonl" --ledger "$COA_EVAL_DIR/ledger.json" --max-judgements 10 --max-seconds 1800

cargo run --locked -- experiment grade --live --questions evals/shared/datasets/legacy/heldout-questions.json --expectations evals/shared/datasets/legacy/heldout-expectations.json --input "$COA_EVAL_DIR/heldout-generation.jsonl" --output "$COA_EVAL_DIR/heldout-graded.jsonl" --ledger "$COA_EVAL_DIR/ledger.json" --max-judgements 24 --max-seconds 3600
```

The judge assesses correctness, completeness, relevance, source support and honest unknowns with short exact excerpts. Criteria receive `good`, `bad` or `review_needed`; invalid output/timeouts yield no content score. Good fractions retain numerator/denominator and undecided counts. A high AI score cannot override hard failures. Rejudging uses a new file and the same remaining ledger.

## 5. Read the report

```sh
cargo run --locked -- experiment report --input "$COA_EVAL_DIR/smoke-graded.jsonl,$COA_EVAL_DIR/pilot-graded.jsonl,$COA_EVAL_DIR/heldout-graded.jsonl" --output /tmp/coa-rag-preview/resultaten.html
```

Open `resultaten.html`. The paired table compares the same six questions with denominators, missing runs and technical failures. A unique run shows its ID; repetitions do not get an automatic winner. Do not combine a generation file with its judged copy: run IDs must be unique.

The renderer validates dataset versions and recomputes metrics. Keep original JSONL, ledger and code version. HTML is a readable view, not a signed attestation. [Metrics](metrics.md) and [report behavior](report.md) explain floats, N/A, unknown usage and timing limits.

## 6. Keep the AI reference and privacy explicit

Optional, separately authorized check:

```sh
cargo run --locked -- experiment calibrate --live --output "$COA_EVAL_DIR/ai-reference-check.json" --ledger "$COA_EVAL_DIR/ledger.json" --max-judgements 8 --max-seconds 1200
```

This compares eight fixed candidates with a separate **AI reference**. Development/check subsets remain separate; reference labels/notes never go to the judge. Checkpoints preserve progress. `human_calibration: false` remains visible and human fields remain empty. Agreement with this small AI set does not establish reliable judging elsewhere. A later separate reference artifact can be selected with `--reference`.

Use fictional data only. Retrieved passages—or all thirty sections for full context—go through Codex to OpenAI. The judge also receives criteria/reference passages. Authentication stays outside shared artifacts; errors are bounded/sanitized. Read [privacy](../../../docs/privacy.md) before expanding access/data or publishing.

Serve only `/tmp/coa-rag-preview` for an HTML preview. Keep JSONL, diagnostics, ledgers and credentials outside. Public sharing needs separate release approval; this procedure publishes nothing.
