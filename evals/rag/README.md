# RAG evaluations with promptfoo

Promptfoo controls RAG cases, configuration matrices, repetitions and assertions. Existing Rust code performs local retrieval or bounded Codex sessions. Promptfoo assertions assess the evidence; native readers remain for historical records, whose scores are not relabelled as new promptfoo results.

## Three browser retrieval tests

`/resultaten/` begins with P01 (gardening time/location), T02 (Tuesday indoors, time/address) and T05 (language café and cooking times/addresses). They use the original five activities, thirty sections and unchanged source criteria. A click runs one question/configuration, not a full matrix.

This browser protocol fixes top-k **5**, candidate-k 30, context ceiling 1200 and `documents_sections`, allowing T05's minimum four-section evidence set. It is not a repeat of old top-3 measurements. All five documents are searched; expected section IDs are never filters or encoder inputs. The twelve-document demo is not a newly labelled evaluation corpus.

Choose dense, BM25, hybrid RRF or weighted hybrid. Dense/hybrid genuinely use multilingual MiniLM or multilingual E5 Small from the [model catalog](embedding-models.json). E5 uses `passage: ` for documents and `query: ` for questions; MiniLM keeps its original unprefixed input. Model/revision, artifact hashes, prefixes, dimensions, actual input hashes and vector hashes bind the run/cache. BM25 loads/downloads no encoder and shows no used embedding model. The catalog uses the existing SDK contract from [fastembed-rs 7.1.2](https://github.com/Anush008/fastembed-rs/releases/tag/v7.1.2), released **19 October 2026**, without a dependency upgrade or general model-ranking claim.

The worker runs only promptfoo's fixed `browser` configuration, existing retrieval provider and source assertions. Model API/Codex settings are removed from its child environment. Raw output and `browser-view.json` remain private under `results/local/browser/<run_id>/`; public snapshots are not overwritten. Missing required support stays visible; unjudged hits are not automatically wrong.

Starting/cancelling requires an owned session, a local connection and valid Host/Origin; forwarded/proxy requests are refused. One heavy job runs at a time without a queue, at most 300 seconds. Separate free-test limits are sixty starts/hour and five/minute per network address. Cancellation cleans up identified owned detached children before releasing capacity. Website model-question limits remain separate. This worker is for direct local use, not a supported public start endpoint.

## Full suites

| Suite | Measurement | Default |
| --- | --- | --- |
| `garden` | MiniLM versus original Jaccard word overlap | 5 gardening questions × 2 methods |
| `retrieval` | Four methods × four storage/structure profiles | 50 questions × 16 configurations |
| `quality` | Fixed context, top-k and filter treatments | 18 legacy questions × 24 + 12 independent questions × 28 |
| `agentic` | Codex with at most four focused search attempts | 10 selected questions × 4 methods |
| `models` | Sol/Luna source completeness and search work | 10 questions × 2 models × 3 repetitions |
| `compact` | Exact MCP projection, source/metadata preservation and byte counts | 1 saved T02 record; offline replay |
| `compact-live` | Predeclared full/compact Codex pairs | 3 pairs, explicitly live |

The historical thirteen-call payload measurement remains provenance; its raw input bundle is absent from this checkout. The default replay honestly uses one available record and makes no new model, cost or speed claim. See [compact MCP](docs/compact-mcp.md).

## Run locally without answer models

Requires Rust, Node **22.22 or newer** and the local model cache. Promptfoo is pinned to **0.125.1**, published **25 October 2026** and checked **13 November 2026**: [official release package](https://www.npmjs.com/package/promptfoo/v/0.125.1).

From the repository root:

```sh
cargo build --locked --features sqlite
npm ci --ignore-scripts --no-audit --no-fund
npm run test:rag
npm run eval:rag -- --suite all-local
```

`all-local` performs fresh retrieval and offline compact projection without Codex generation or AI judgment. It uses preserved datasets; no new gold labels were invented for the twelve-document demo. All sixteen profiles require the SQLite feature. For a small selection:

```sh
npm run eval:rag -- --suite retrieval --dataset legacy --cases T05,P05 --methods bm25 --profiles documents_sections
```

A source assertion may fail legitimately: T05 needs four sections and can be incomplete at top-k three. This is an evidence miss, not an installation failure or a reason to lower the criterion. No positive goal means N/A and exclusion from the source-quality denominator, not perfect retrieval. Answer quality is not assessed.

New raw results, native evidence, logs and promptfoo storage go under ignored `results/local/<run>/`. Telemetry, sharing, promptfoo cache and automatic retries are disabled. Prepared local batches derive only from the exact promptfoo plan, with a new execution ID and source/config/runtime identity; they are not replayed old scores.

## Model trials use Codex

Only `agentic`, `models` and `compact-live` start Codex. Obtain explicit usage authorization and supply `--live`, a bounded ledger and session/time ceilings. The provider removes API-key settings from the child environment and has no OpenAI API provider or judge fallback.

A deliberately small selection:

```sh
npm run eval:rag:live -- --suite agentic --cases P01 --methods dense --ledger evals/rag/results/local/codex-ledger.json --max-generations 1 --max-seconds 180
```

Resume with the same ledger. Failed/uncertain attempts count and are not retried automatically. Model comparisons default to three repetitions; `--repeat 1` is a technical smoke check, not a complete benchmark.

The full `models` protocol retains sixty alternating Sol/Luna attempts. It runs four fixed pilot slots and stops. The `remaining` phase needs independent `PILOT_APPROVED.json` bound to the exact preregistration and saved pilot. Both phases share one unchanged ledger/limits and pinned Codex/host, runtime, source, embedding and vector identity. Only proven model-output/contract failures may continue as failed model outcomes; uncertain, authentication, network and trace failures stop without retry.

```sh
npm run eval:rag:live -- --suite models --phase pilot --ledger evals/rag/results/local/modelvergelijking/ledger.json --max-generations 60 --max-seconds 7200
npm run eval:rag:live -- --suite models --phase remaining --approval evals/rag/results/local/modelvergelijking/PILOT_APPROVED.json --ledger evals/rag/results/local/modelvergelijking/ledger.json --max-generations 60 --max-seconds 7200
```

A separate technical model smoke check requires `--phase smoke`, explicit cases and `--repeat 1`, capped at eight sessions/900 seconds. It does not replace the pilot/full comparison. Historical Python source pins remain unchanged; old pinned runs are not resumed under different code. The old `scripts/model_trials.ts run` is disabled; new trials use promptfoo. Saved historical results and reassessment remain available.

## Read or reassess saved results

Below the local tests, the separately opened archive reads the public allowlist projection `site/promptfoo-results.json`: run IDs, datasets, settings, assertion states/reasons, source hits, N/A and execution errors. The sixty older sessions remain unchanged expandable history. Local tests start no answer model.

Export excludes full configuration, machine paths, audit files, credentials and private reasoning. Only intentionally selected source/test fields are shared. [Provider/assertion details](promptfoo/README.md) explain the contract.

Reassess an existing result without rerunning the model:

```sh
node evals/rag/scripts/regrade_promptfoo_results.mjs evals/rag/results/local/<run>/<suite>.json evals/rag/results/local/<new-assessment>
```

This creates a new promptfoo grading ID retaining original execution ID, time and raw hash. Codex evidence is rebound to original native records and byte-linked audit. The page identifies reassessment; it is not a fresh retrieval/model measurement.

## Procedures and metric definitions

- [Promptfoo provider, assertions and budget contract](promptfoo/README.md).
- [Native retrieval procedures and metrics](docs/retrieval-lab.md), including storage parity and manual review.
- [Predeclared quality protocol](docs/retrieval-lab-quality-v1.md), including AND/OR goals, filters and capacity limits.
- [Iterative-search comparison](docs/agentic-search-comparison.md).
- [Compact MCP audit and historical byte comparison](docs/compact-mcp.md).
- [Saved ranking-role regression](fixtures/regressions/README.md).

These native guides explain retained execution/measurement layers and historical protocols; promptfoo is the current RAG orchestrator. [Complete-assistant evaluation](../coa-assistent/README.md) remains separate.
