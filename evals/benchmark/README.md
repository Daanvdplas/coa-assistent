# Local benchmark adapter

The benchmark page evaluates **one question at a time**, selected by its readable title from the eighteen current cases. Each Evals question also has a Benchmark button: an explicit click starts its local RAG variants, with two fresh repetitions, then opens that run on the benchmark page. Opening, refreshing or revisiting a benchmark URL does not start work. Durable request IDs make a retried start return the same run, including after a server restart.

RAG and the current Responses/Rig assistant are separate modes for the selected question. RAG uses the canonical context-quality matrix, which already contains all sixteen ordinary retrieval configurations, without running those configurations twice under another suite name. With SQLite enabled there are twenty-four variants; P01, T02 and T05 additionally have seven browser/embedding variants, for thirty-one total. Two repetitions therefore produce forty-eight or sixty-two measurements. A build without SQLite uses only applicable file profiles. Repetitions can be set from one to three. Model-required assistant runs remain blocked without explicit bounded authorization and a configured provider budget.

Every variant and repetition shows **required source-section coverage**, with found and missing sections. Actual captured payload text must contain the canonical section text, with the correct corpus binding; labels, citations, IDs and expected text added for inspection do not count as retrieved evidence. Repeated facts sharing a section count once. Alternative sufficient evidence plans are assessed separately; their union is not made compulsory. Fact-goal coverage is a separate measure: IND26-01 has eight required sections supporting ten fact goals. These incomplete relevance labels do not define universal recall or precision. Timing remains inspectable for failed runs; a failed or incomplete selection has no speed winner.

The Rust web server calls `adapter.ts` to enumerate canonical plans and execute existing runners. It adds no provider or scoring framework. History, compatible reference comparisons and the terminal discussion report remain available. The older multi-case and historical-protocol APIs remain supported independently of this single-question page.

```sh
node evals/benchmark/adapter.ts catalog
node evals/benchmark/adapter.ts plan selection.json
node evals/benchmark/adapter.ts execute selection-and-plan.json <new-private-output-directory>
node --test evals/benchmark/adapter.test.ts
```

`selection-and-plan.json` contains `{ "selection": ..., "plan": ... }`. Before execution the adapter recomputes source/question/criterion/scorer/runtime identities and rejects a changed plan. A new private `progress.json` is atomically replaced and synced after each completed question/configuration batch. Previously checkpointed results survive cancellation; unfinished native artifacts remain private. Source-assertion failures are completed measurements, while runtime failures are reported separately. Repetitions disable result caching and create fresh execution identities.

The compatibility catalog includes all seven existing RAG suites, the three browser tests, and the native complete-assistant runner. Each retained protocol keeps its own corpus. Empty dataset selection in that API expands to every applicable corpus. Encoder choice applies to the browser protocol only; BM25 has one configuration without a fictitious encoder variant. Native assistant runs remain the Codex route and do not evaluate the separate Rig/Responses website or semantic answer quality.

Model execution requires explicit positive authorization with a session and time ceiling. Codex sessions can contain several provider requests; this is not a dollar cap. The aggregate selected session count must fit that authorization. All native assistant groups and repetitions together must also fit their existing forty-generation ledger. No model calls are made by planning or the adapter's unit tests.

The fixed model comparison starts with its four-session pilot. Its existing preregistration permits at most sixty sessions and 7200 seconds. To preserve the option of a full comparison, approve that full ceiling before the pilot; a pilot initialized with a smaller ceiling cannot be silently extended. The remaining phase requires the original ledger and an independent pilot approval, configured by the operator as `COA_BENCHMARK_MODEL_LEDGER` and `COA_BENCHMARK_MODEL_APPROVAL`. These existing ledgers are never reset. Other model suites share a separate run-local Codex ledger; native assistant execution uses its existing ledger schema. An uncertain model execution stops subsequent model groups instead of retrying them.

All new outputs stay under the server's ignored private results directory. Existing frozen data, raw results and public history exports are never rewritten.

## Current Responses/Rig assistant and completeness regression

The current default selection includes the seventeen-case `demo-12-20261118` set and the separately frozen one-case [`regression-12-20261118`](../shared/datasets/regression-12-20261118/README.md). The latter reuses `IND26-01`; it does not relabel or copy the original frozen set. The combined local matrices contain 288 retrieval and 432 context-quality rows before filtering or repetitions.

The separate `assistant-rig` suite executes all selected current cases through the same ResponsesRunner as the demo, sharing its real search callback and durable attempt-budget Arc. Node delegates these groups to the Rust worker; it does not create a second API client or spending ledger. Rig authorization uses physical `max_attempts`, separate from Codex `max_sessions`. The aggregate worst case is five attempts per selected question execution across all datasets and repetitions; all eighteen cases with both methods therefore require an explicit ceiling of 180 attempts. No attempt or monetary budget is assumed.

Captured answers are saved before protected references are assessed. All cases have deterministic provenance, source and citation checks. The new `IND26-01` regression additionally checks the complete two-option answer and requested details against eight genuinely offered source sections; generic cases retain `answer_quality: not_assessed`. Only a complete, correct regression result is eligible for speed ranking. Controlled local provider fixtures and model-free regressions are instrument verification, never live model-quality measurements. The optional AI judge remains a separate later step.
