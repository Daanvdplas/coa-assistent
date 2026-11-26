# Guided daypart evaluation

[Three Dutch questions](../../shared/datasets/guided-dayparts-20261126/cases.json) check the first search from the twelve-activity demo. Each question runs through Guided v5 with the demo's default top-k of three. The evaluator checks that Guided classifies every match, reports an exhaustive result with no unknowns, and returns the canonical schedule passages (S2). The search receives only the question.

The reference uses positive overlap with 06:00–12:00 for morning, 12:00–18:00 for afternoon and 18:00–24:00 for evening. Samen koken runs from 11:00 to 13:00 and belongs to both morning and afternoon. The evening case requires all twelve schedule passages to support the empty list. The latest activity, Schaken, ends at 17:00.

## Run locally

Build from the repository root with `cargo build --locked` and prepare the cached MiniLM artifacts according to the [local setup](../../../docs/LOCAL_SETUP.md). Use a fresh result filename.

```sh
node evals/rag/scripts/guided_dayparts.ts \
  --binary target/debug/meedoen-retrieval \
  --out evals/rag/results/local/guided-dayparts-run.json
```

The result file contains the raw retrieval responses, expected and missing passages, and corpus, dataset and binary hashes. Exit code 1 with a saved result indicates a failed source or classification check. This evaluation uses local retrieval and assesses no generated answer or follow-up searches.
