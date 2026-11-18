# Evaluate the complete COA assistant

These experiments generate answers using four RAG approaches, enforce source/citation checks and support a separate answer judge and calibration. Generation and AI judgment use Codex CLI. The judge is provisional and has not been calibrated by people.

- [Reproduction procedure](docs/reproduce.md): validation, generation, judgment and reporting.
- [Dataset contract](docs/dataset.md), [six held-out compositions](docs/heldout.md) and [metric definitions](docs/metrics.md).
- [Report behavior](docs/report.md) and [visual framework explanation](docs/framework.html).
- `src/`: the existing `experiment` harness, judge, budget and report renderer.
- `fixtures/`: eight calibration examples, a separate AI reference and a handmade report example. The [human-review worksheet](docs/human-review.html) is a preserved functional instrument, with original Dutch cases and empty human labels.
- [Saved 23–26 October 2026 run](results/2026-10-26/README.md): complete raw history, including original errors and hashes. Its README is hashed evidence and remains unchanged.
- [Shared datasets](../shared/README.md): twelve pilot questions, six original comparison questions and later versions.

## Open an existing report without model calls

From the repository root:

```sh
mkdir -p evals/coa-assistent/results/local
cargo run --locked -- experiment validate
cargo run --locked -- experiment report --input evals/coa-assistent/fixtures/report-example.jsonl --output evals/coa-assistent/results/local/voorbeeld.html
```

The example contains handmade renderer checks, not measured RAG results. For the real October archive:

```sh
COA_EVIDENCE=evals/coa-assistent/results/2026-10-26
cargo run --locked -- experiment report --input "$COA_EVIDENCE/smoke-graded.jsonl,$COA_EVIDENCE/pilot-graded.jsonl,$COA_EVIDENCE/heldout-final-graded.jsonl" --output evals/coa-assistent/results/local/oktober.html
```

Old paths in the sealed archive remain provenance; the commands above use current locations. New model sessions require explicit authorization, `--live`, new output files and a bounded shared ledger following the reproduction procedure.
