# Guided demo retrieval holdout

This source-only holdout exercises the demo's twelve-document Index for Dense, BM25, and Guided with a requested top-k of three. It checks canonical passages delivered by search. It measures neither model answer quality nor whether a model independently chooses a useful follow-up. Every method receives the same literal questions and follow-ups.

The twelve questions and their expected source alternatives were written from the canonical fictional documents and frozen before measurement. They cover broad and narrow intake, exact starts, an activity already underway, a four-activity list, named comparisons, dated availability, and unknown or exclusion evidence. The dataset has SHA-256 `33b05aaff1872eba8f18c9e08a7c047f25d5e9e380b6863dfddb795532b662fd`. The dataset pins the order and bytes of all twelve documents. The search process receives only the planned queries and requested method. It receives neither expected sources nor classifications.

## Release gate

Guided must deliver a complete source alternative for all twelve questions by their third or final planned search, including at least ten on the initial question. Cases complete under Dense or BM25 must also be complete under Guided. Technical, corpus, provenance, and canonical-passage errors must be zero. The three explicit list questions must deliver the predeclared initial-query matches and unknowns, with the required exhaustiveness status. Each Guided response must stay within 1,200 estimated section tokens.

Each alternative is a conjunction of required canonical passages. The alternatives are disjunctive. Completion is the first search of a case's fixed sequence whose cumulative unique passages cover one whole alternative. Duplicate passages or partial coverage across different alternatives cannot complete a case.

## Run and review

Build the reviewed local commit with `cargo build --locked`, and prepare the cached MiniLM artifacts according to the [local setup](../../../docs/LOCAL_SETUP.md). Choose a new output directory.

```bash
node evals/rag/scripts/guided_demo_holdout.ts \
  --binary target/debug/meedoen-retrieval \
  --out evals/rag/results/local/guided-demo-20261123
```

The runner passes one fixed list of 29 search strings per method to the source-only CLI with `--queries-stdin`. Each method uses one prepared Index and emits its result per search in the same order. The CLI runs with only a minimal environment, dotenv disabled and the MiniLM sources cached. No answer-generation or judge process is called. The runner saves the 87 raw rows, their derived assessment, the readable report, and hashes identifying the dataset, corpus, binary, local source revision, and captured rows. A failed release gate produces a report and a nonzero exit status. To recompute the report without running retrieval, use this command.

```bash
node evals/rag/scripts/guided_demo_holdout.ts \
  --replay evals/rag/results/local/guided-demo-20261123
```
