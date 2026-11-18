# Predeclared quality comparison

**Current orchestrator:** [promptfoo](../README.md). Native commands below describe retained execution/measurement layers and historical reporting, not a second current benchmark scorer.

`lab` separates retrieval records, protected expectations and assessments. Reassessing a saved search repeats neither retrieval nor model calls. Free-form AI judging stays paused; human judgments start empty.

## Separate datasets

- `--dataset legacy` (default): eighteen seen development/regression questions. Original v1 bytes remain under `legacy/v1/`; use `--dataset legacy-v1` for those old traces. The current development dataset contains the revised P06, described in [shared datasets](../../shared/README.md). Historical hashes are not rewritten to look current.
- `--dataset independent-20261103`: twelve questions independently authored, source-reviewed and frozen before first measurement. They concern the same five known documents, not unseen organizations/documents or human-calibrated truth. Eleven have source-support targets; one requests clarification and is excluded from retrieval denominators.

Select the dataset explicitly for **plan, run, assess and report**. Wrong bindings fail before an assessment/report is written. Questions, sources, typed inputs and expectations have separate identities. Imported deterministic grades are fully recomputed; matching a hash alone is insufficient.

## Fixed scenarios

```sh
cargo run --locked -- lab plan --dataset independent-20261103 --protocol quality-v1
```

This plans **336 rows**: twelve questions × 28 configurations.

| Scenario | Profiles | Methods | Selection | Top-k | Filters |
| --- | --- | --- | --- | --- | --- |
| Baseline | All four | All four | Sections | 3 | Off |
| Activity context | Documents/sections | All four | Activity expansion | 3 | Off |
| More sections | Documents/sections | All four | Sections | 6 | Off |
| User filters | Documents/sections | All four | Activity expansion | 3 | On |

Candidate-k remains 30, context ceiling 1200 and MMR off. Sixteen baseline configurations remain separate from twelve additions. Top-k three in expansion means three seeds; whole unchanged related sections can then be added within the same context ceiling.

Legacy `quality-v1` has **432 rows**, eighteen × 24. It excludes filter treatment because those questions lack separately reviewed typed-input sidecars. `lab plan` without the protocol retains the original 288-row baseline.

Frozen `user-query-inputs.json` contains literal questions and supported hard conditions only: weekdays, indoor/outdoor and complete availability windows. It includes no expected activities, passages, roles or answers. Outdoor preference does not become a hard filter. Wheelchair access, paid work or unsupported exact-start conditions cannot be invented as fields. Schedules have minute resolution: “before 11:00” means at latest 10:59.

`INPUTS_FROZEN.json` separately binds independently reviewed input bytes. Before planning, retrieval or assessment, runtime validates that approval, exact input hash, original freeze and question hashes. A valid schema with changed filter values cannot retain the frozen identity.

Five questions have supported filters; seven do not. Reports distinguish filters off, none requested, no demonstrated effect and an actually smaller candidate set. A smaller candidate set does **not** automatically mean fewer vector scores; this small scorer records corpus-scoring work separately. Unknown source values are neither confirmed matches nor confirmed exclusions.

## Run and reassess

The first neural measurement requires independent input-sidecar review and explicit protocol release. These commands make no Codex/judge calls; SQLite needs its optional build feature:

```sh
cargo run --locked --features sqlite -- lab run \
  --dataset independent-20261103 --protocol quality-v1 \
  --model-cache .model-cache --sqlite-dir /tmp/coa-quality-cache \
  --output /tmp/coa-quality-independent.jsonl

cargo run --locked --features sqlite -- lab assess \
  --dataset independent-20261103 --input /tmp/coa-quality-independent.jsonl \
  --output /tmp/coa-quality-independent-assessments.jsonl

cargo run --locked --features sqlite -- lab report \
  --dataset independent-20261103 --input /tmp/coa-quality-independent.jsonl \
  --assessments /tmp/coa-quality-independent-assessments.jsonl \
  --output /tmp/coa-quality-independent.html
```

Always use new output files. Batches share source/model preparation and query embeddings across settings; reports retain shared counts once. Do not add duplicate preparation fields. Without SQLite, planned SQLite rows remain `unsupported`, not invented measurements.

## Interpretation and capacity

The primary measure is **all required source support found**, reported as complete cases/eligible cases. Partial coverage is separate. OR joins alternative evidence groups; AND joins references within each. A first relevant passage or high cosine score is not a complete answer. Supported unknowns, exclusion evidence and clarification remain identifiable; no generated answer means answer quality remains unassessed. `retrieval-task-metrics-v1` is a separate derived view and does not redefine historical v2 grades.

First goal-support reciprocal rank uses required goal references, excluding relevance-only exclusion evidence; it differs from historical relevance MRR. Technical validity, work and timings remain separate. No positive source target means N/A, not a perfect or zero source-quality score.

In section mode, the exact minimum distinct sections across AND/OR alternatives bounds capacity: T05 needs four, so top-k three cannot complete it. Expansion can reach at most top-k distinct seed activities; reports also compute the minimum required activities across alternatives. More required activities than seeds proves infeasibility. Below that bound feasibility remains unknown because tokens/filters can still block support. Filtered-out exclusion text does not automatically make an unwritten answer wrong.

Each row records dataset, frozen-reference hash, typed-input hash, exact settings, scenario and filter effect. Expected roles/actions are loaded only during assessment/reporting, never into retrieval or the answer model. Preserve old raw records, recompute derived grades against correct criteria, and never tune an unseen claim on its observed scores.
