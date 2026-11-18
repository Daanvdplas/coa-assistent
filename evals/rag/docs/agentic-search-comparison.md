# Compare iterative search

**Current orchestrator:** [promptfoo](../README.md). Native commands below document the retained layer and historical reporting, not a second current benchmark scorer.

This comparison uses the same Codex assistant for ten fixed questions with four retrieval methods; only the method changes. Each search returns at most three passages, each session has at most four attempts and 120 seconds. Invalid/failed attempts count.

The assistant receives the question and actual retrieved text, deciding whether a focused follow-up is needed. Protected expectations are loaded only afterwards by `agent-assess`/`agent-report`, never by the search loop.

## Inspect the plan

No model calls:

```sh
cargo run --locked --release -- lab agent-plan
cargo run --locked --release -- lab agent-plan --cases T02,P06
```

The full plan has forty sessions, ten questions × four methods; the small check has eight. Method order rotates per question. This is not a repeated general speed benchmark.

## Historical native execution procedure

New RAG model trials use [promptfoo](../README.md#model-trials-use-codex). If reproducing the native protocol with explicit model authorization, use an authenticated compatible Codex runtime and existing cache. `COA_CODEX_MODEL` can explicitly select an available model. Keep model, runtime programs and sources unchanged between pilot and remainder; runtime identity includes executable hashes.

Build once and use exactly that executable. Choose new output files and one shared ledger. The forty-session ceiling includes failures, with no AI judge:

```sh
cargo build --locked --release
cp target/release/meedoen-retrieval /tmp/coa-agentic-fixed

/tmp/coa-agentic-fixed lab agent-run --live \
  --cases T02,P06 \
  --output /tmp/coa-agentic-pilot.jsonl \
  --ledger /tmp/coa-agentic-budget.json \
  --max-generations 40 --max-seconds 4800 \
  --model-cache .model-cache
```

Review all eight saved attempts before continuing. If code, sources, model and limits are unchanged, they count within the final forty; do not rerun them to select a better result.

```sh
/tmp/coa-agentic-fixed lab agent-run --live \
  --cases P01,P07,P09,T01,IND26-05,IND26-03,IND26-07,IND26-09 \
  --output /tmp/coa-agentic-rest.jsonl \
  --ledger /tmp/coa-agentic-budget.json \
  --max-generations 40 --max-seconds 4800 \
  --model-cache .model-cache
```

Technical errors stop the batch. There are no hidden retries or automatic budget renewals. Preserve the original failure and never edit a ledger to hide attempts.

## Assess saved evidence

These commands start no Codex session, retrieval or judge; inputs remain unchanged:

```sh
/tmp/coa-agentic-fixed lab agent-assess \
  --input /tmp/coa-agentic-pilot.jsonl,/tmp/coa-agentic-rest.jsonl \
  --output /tmp/coa-agentic-assessments.jsonl

/tmp/coa-agentic-fixed lab agent-report \
  --input /tmp/coa-agentic-pilot.jsonl,/tmp/coa-agentic-rest.jsonl \
  --assessments /tmp/coa-agentic-assessments.jsonl \
  --output /tmp/coa-agentic-report.json
```

Assessment validates question/dataset, settings, original output bytes, runtime and MCP trace, then counts only passages actually offered across searches, deduplicated by source identity. Valid evidence alternatives remain valid: the historical nature question needs the time plus one of two accepted nature passages. Use the dataset version matching the run, not revised development labels.

Reports retain actual total search attempts and full measured session duration. The first step reaching complete evidence is additional detail; subsequent searches do not disappear from total work.

A failed session receives no successful content assessment. Without a complete runtime trace, attempt count remains unknown; successful sidecar rows are no substitute. Wrong-model rejection stays a failure with observed/expected identity.

Source completeness is not written-answer correctness. Free-form AI judging stays off; agents never populate human judgments.
