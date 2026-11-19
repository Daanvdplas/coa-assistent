# Evaluations

The website's `/resultaten/` page starts with three separate local retrieval tests (P01/T02/T05), using real search-method and embedding selection. They use the current twelve-document dataset `demo-12-20261118`, promptfoo and independently reviewed source criteria; full matrices, model trials and historical runs remain separate. Start with [RAG evaluations](rag/README.md).

The separate `/benchmark/` page runs one selected question across all applicable variants, with two fresh repetitions by default, and compares durable results. Each Evals question has a Benchmark action that starts its local RAG comparison. The question picker contains the preserved seventeen development cases plus the reviewed complete-list regression. RAG and the current Rig assistant are separate modes; model use still requires explicit bounded authorization. Required source-section coverage is shown separately from fact goals and execution errors. It shares only **Evals | Benchmark** navigation with `/resultaten/`; the demo and explanation retain their own presentation. See the [benchmark procedure](benchmark/README.md).

All evaluation code, datasets, guides and saved results live here, grouped by what they measure:

- [RAG with promptfoo](rag/README.md): are the required sources found, with which strategy and how much search work? Its [provider/assertion guide](rag/promptfoo/README.md) and [procedure index](rag/README.md#procedures-and-metric-definitions) cover the retained protocols.
- [Complete COA assistant](coa-assistent/README.md): is the final answer correct, does it use sources faithfully and preserve unknowns? Its index links reproduction, dataset, held-out cases, metrics and report documentation.
- [Shared datasets](shared/README.md): fixed questions and protected expectations reused by both routes.

Model sessions and separate AI judgments use **Codex CLI**. Local retrieval and reassessment of saved traces require no answer model. The website separately uses the Responses API. Human calibration has not been performed; AI judgments remain provisional.

Product code and fictional activity sources remain in `src/` and `fixtures/`. Ordinary software tests remain in `tests/`; evaluation-specific TypeScript/report checks sit with their evaluation. Existing `eval`, `experiment` and `lab` CLI commands remain available.

## Preserved history

Raw JSON/JSONL, frozen datasets and manifests retain their exact bytes. Historical paths and the sealed October archive identify provenance; they are not instructions to recreate old directories. Current procedures use the current paths. The October archive README is itself hashed and stays in its original language. Frozen [AUTHORING notes](shared/datasets/independent-20261103/AUTHORING.md) retain their original candidate wording; the additive freeze manifest records the later decision.

New local output belongs under ignored `rag/results/local/` or `coa-assistent/results/local/`. Use a new output file for every execution and the same budget ledger when resuming. Only explicitly authorized, bounded `--live` commands may start a model. Never reset a ledger to hide prior attempts.
