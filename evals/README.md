# Evaluations

The website's `/resultaten/` page starts with three separate local retrieval tests (P01/T02/T05), using real search-method and embedding selection. They reuse promptfoo and existing source criteria; full matrices, model trials and historical runs remain separate. Start with [RAG evaluations](rag/README.md).

All evaluation code, datasets, guides and saved results live here, grouped by what they measure:

- [RAG with promptfoo](rag/README.md): are the required sources found, with which strategy and how much search work? Its [provider/assertion guide](rag/promptfoo/README.md) and [procedure index](rag/README.md#procedures-and-metric-definitions) cover the retained protocols.
- [Complete COA assistant](coa-assistent/README.md): is the final answer correct, does it use sources faithfully and preserve unknowns? Its index links reproduction, dataset, held-out cases, metrics and report documentation.
- [Shared datasets](shared/README.md): fixed questions and protected expectations reused by both routes.

Model sessions and separate AI judgments use **Codex CLI**. Local retrieval and reassessment of saved traces require no answer model. The website separately uses the Responses API. Human calibration has not been performed; AI judgments remain provisional.

Product code and fictional activity sources remain in `src/` and `fixtures/`. Ordinary software tests remain in `tests/`; evaluation-specific TypeScript/report checks sit with their evaluation. Existing `eval`, `experiment` and `lab` CLI commands remain available.

## Preserved history

Raw JSON/JSONL, frozen datasets and manifests retain their exact bytes. Historical paths and the sealed October archive identify provenance; they are not instructions to recreate old directories. Current procedures use the current paths. The October archive README is itself hashed and stays in its original language. Frozen [AUTHORING notes](shared/datasets/independent-20261103/AUTHORING.md) retain their original candidate wording; the additive freeze manifest records the later decision.

New local output belongs under ignored `rag/results/local/` or `coa-assistent/results/local/`. Use a new output file for every execution and the same budget ledger when resuming. Only explicitly authorized, bounded `--live` commands may start a model. Never reset a ledger to hide prior attempts.
