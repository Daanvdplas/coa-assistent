# Guided demo retrieval holdout

This source-only holdout exercises the demo's twelve-document Index for Dense, BM25, and Guided with a requested top-k of three. It checks canonical passages delivered by search. It measures neither model answer quality nor whether a model independently chooses a useful follow-up. Every method receives the same literal questions and follow-ups.

The twelve questions and their expected source alternatives were written from the canonical fictional documents and frozen before measurement. They cover broad and narrow intake, exact starts, an activity already underway, a four-activity list, named comparisons, dated availability, and unknown or exclusion evidence. The dataset has SHA-256 `33b05aaff1872eba8f18c9e08a7c047f25d5e9e380b6863dfddb795532b662fd`. The dataset pins the order and bytes of all twelve documents. The search process receives only the planned queries and requested method. It receives neither expected sources nor classifications.

## Release gate

Guided must deliver a complete source alternative for all twelve questions by their third or final planned search, including at least ten on the initial question. Cases complete under Dense or BM25 must also be complete under Guided. Technical, corpus, provenance, and canonical-passage errors must be zero. The three explicit list questions must deliver the predeclared initial-query matches and unknowns, with the required exhaustiveness status. Each Guided response must stay within 1,200 estimated section tokens.

Each alternative is a conjunction of required canonical passages. The alternatives are disjunctive. Completion is the first search of a case's fixed sequence whose cumulative unique passages cover one whole alternative. Duplicate passages or partial coverage across different alternatives cannot complete a case.

## Fresh confirmation for the v2 policy

The original twelve cases serve as known regression checks for the revised policy. The separately frozen `confirmation.json` adds six unseen cases with new named time contrasts, multi-activity guidance requests and unrelated source guards. It has SHA-256 `69e80941ed313d9c378a2da06d9b30deb255f1f8ee707e236aa3099e171998a2` and binds to the original case-file hash. Both cohorts use the same pinned corpus. The combined plan has 46 search strings per method and 138 retrieval rows. The two new explicit selectors are graded along with the original three.

The combined gate requires 18 complete cases after their planned searches and at least 15 on the first search, including at least five of the six fresh cases. A Guided case loss against either comparator, a classification mismatch, a technical or canonical-passage error, or use of the wrong Guided policy identity fails the gate. Combined mode requires `guided-rag-v2` in every Guided response. Standalone mode and its original capture use `guided-rag-v1`.

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

Run the combined v2 plan with `--extension` and a distinct output directory. Pass `--extension` again to replay that capture. The assessment includes a separate confirmation summary and, for each typed check, the expected and observed matches, unknowns and exhaustiveness.

```bash
node evals/rag/scripts/guided_demo_holdout.ts --extension \
  --binary target/debug/meedoen-retrieval \
  --out evals/rag/results/local/guided-demo-confirmation-20261123
```
