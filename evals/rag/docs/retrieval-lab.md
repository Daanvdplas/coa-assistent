# Compare local retrieval configurations

**Current orchestrator:** [promptfoo](../README.md). Native commands below explain the retained execution/measurement layer and historical reporting, not a second current benchmark scorer.

The original baseline uses five fictional activities, thirty canonical passages and eighteen seen development/regression questions. Select the ten-source version explicitly with `--dataset expanded-10-20261105`; [shared datasets](../../shared/README.md) records versions. The main axes are search method, storage/structure and assessment type.

| Axis | Choices |
| --- | --- |
| Search | `dense`, `bm25`, `hybrid_rrf`, `hybrid_weighted` |
| Storage/structure | `documents_sections`, `documents_activities`, `sqlite_sections`, `sqlite_activities` |
| Assessment | `deterministic`, `manual`, `ai` (paused) |

The original full baseline is **16 configurations × 18 questions = 288 retrieval records**. Assessors reuse those saved records; `lab run`, `lab assess` and `lab report` generate no answers and call no Codex/AI judge.

## Execute

Use the repository working directory and existing `.model-cache`. A first vector run may download approximately 235 MB. Keyword-only retrieval needs no embedding model.

```sh
LAB_RUN_DIR="$(mktemp -d /tmp/coa-retrieval-lab.XXXXXX)"
export CARGO_TARGET_DIR="$PWD/target/retrieval-lab"

cargo run --locked --features sqlite -- lab plan
cargo run --locked --features sqlite -- lab run \
  --model-cache "$PWD/.model-cache" \
  --sqlite-dir "$LAB_RUN_DIR/cache" \
  --output "$LAB_RUN_DIR/retrieval.jsonl"
cargo run --locked --features sqlite -- lab assess \
  --input "$LAB_RUN_DIR/retrieval.jsonl" \
  --types deterministic,manual,ai \
  --output "$LAB_RUN_DIR/assessments.jsonl"
```

SQLite is optional. `--no-default-features` builds the standalone document route; unavailable SQLite rows remain visibly unsupported, without fallback. Output files are never overwritten. Reuse caches if appropriate, but choose a new result file.

Small keyword-only check:

```sh
cargo run --locked --no-default-features -- lab run \
  --methods bm25 --profiles documents_sections --cases T02 \
  --output "$LAB_RUN_DIR/t02-keyword.jsonl"
```

## Inspect and judge saved results

```sh
cargo run --locked --features sqlite -- lab report --input "$LAB_RUN_DIR/retrieval.jsonl" --assessments "$LAB_RUN_DIR/assessments.jsonl" --output "$LAB_RUN_DIR/report.html"
```

Open `report.html` in a browser (`open "$LAB_RUN_DIR/report.html"` on macOS). It needs no server, external scripts or internet. Reporting loads no encoder and repeats no search/model calls. Without `--assessments`, current deterministic metrics, blank manual assessments and paused-AI records are added offline.

1. Select a question, method, storage/structure and assessment.
2. Open a result: expected facts appear beside actual passages with source/date.
3. Inspect missing support and optional metrics/settings.
4. Use **Zelf beoordelen** to record a human decision and optional note. The browser stores it locally; export to JSONL when needed.

Import the export into a new report:

```sh
cargo run --locked --features sqlite -- lab report --input "$LAB_RUN_DIR/retrieval.jsonl" --assessments /path/to/assessments.jsonl --output "$LAB_RUN_DIR/report-with-assessments.html"
```

Existing decisions are retained and missing assessment types added. Wrong/stale bindings are rejected without rerunning retrieval. Unavailable browser storage produces a visible notice. Unexecuted combinations receive no invented zero score. Human fields must not be filled by an agent.

## Evidence, ranking and integrity

Deterministic checks validate source/config identity, unchanged text, traceable candidates/hits and context ceilings. **Evidence coverage** asks which expected fact goals are fully supported. Complete-case count/eligible-case count and average partial goal coverage are separate results; a higher partial average need not mean more fully supported questions. No metric is an automatic general quality verdict.

For T02 (Tuesday, indoors, time/address), `ACT-FIETS-002:S2` and `S3` are required. S2 alone gives 0/2 complete goals; S3 alone 1/2; both 2/2. S2 is useful despite not completing a goal. Source date is **18 October 2026**. These are assessment expectations, never forced search results.

Goals use OR between alternative evidence groups and AND inside each group. A sourced explicit unknown can have a positive support target; a missing fact without a source target has N/A, not perfect retrieval. Without generated answers, answer correctness/citations are N/A. AI judging stays paused.

Relevance metrics need complete labels where required. Historical relevance MRR can credit exclusion evidence; **first goal-support reciprocal rank** considers only required source-goal references. These are different measures. Activity expansion does not create a rank. The [saved regression](../fixtures/regressions/README.md) protects this distinction.

Assessments bind the SHA-256 of the exact JSONL line. Reassessment never retrieves again; modified/different bytes are rejected. Assessor `retrieval-assessment-v2` validates unselected candidates and omitted references too. Invalid traces get no valid ranking score. Reassess older versions into new files rather than repeating retrieval or importing stale deterministic grades; criteria hashes and complete recomputation must agree.

## Controls, storage and fair timing

Advanced options include `--top-k 3|6`, `--candidate-k`, `--context-limit`, `--selection sections|activity_expansion`, `--mmr on|off`, `--apply-filters on|off`, `--rrf-k`, `--vector-weight` and `--mmr-lambda`. `--query-filters` accepts explicit JSON, for example `' {"weekdays":["tuesday"],"environment":"indoor"}'` (leading whitespace is optional). No criteria come from expected answers or case IDs. Unknown source fields remain unknown; preferences do not silently become hard constraints.

Activity expansion is context selection: seeds remain intact, then whole unchanged related sections fit within the shared ceiling. Activity records are a distinct representation with source-backed typed fields and linked passages. Store, representation, filters and method are separately recorded. A top-k seed limit is not the expanded offered-section limit. T05 needs four sections and cannot complete at fixed section top-k three; passing a minimum-capacity bound does not guarantee token/filter feasibility.

Document and SQLite adapters load the same ordered canonical passages and exact f32 vectors into one Rust scorer. SQLite supplies no separate native vector/FTS ranker; storage alone should not improve relevance. Cache identity includes source/embedding inputs, provider/model/SDK/encoding/dimensions; changed text or model invalidates affected entries. Nonfinite or wrong-size vectors are rejected. Dense, BM25, RRF and weighted hybrid retain their honest score kinds/components; none is answer confidence.

`retrieval_ms` measures local search, selection and checks, excluding model initialization, embeddings and storage preparation. Shared model/query work and reuse appear once under `shared_preparation`; do not sum duplicate preparation identities. Preparation depends on order/cache state. Estimated context tokens are not provider usage, total input or cost.

Use consistent `--release` for performance research and retain command, binary hash and environment: records do not capture retrieval build profile. Cold/warm runs must be separate and labelled. A fresh index/cache directory does not imply fresh model weights. Seen questions are not an unseen benchmark.
