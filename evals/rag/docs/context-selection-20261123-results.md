# Context-selection results — 23 November 2026

**Decision: NO_GO. Retain the existing defaults.** The experimental six-activity
policy produced fewer complete source sets. All forty measurements completed
without technical failure; no answer model or AI judge was used.

| Set | Current complete cases | Experimental complete cases | Required sections found |
| --- | --- | --- | --- |
| Twelve existing regressions | 11/12 | 8/12 | 34/38 → 34/38 |
| Eight frozen controls | 3/8 | 1/8 | 40/54 → 39/54 |
| Total | 14/20 | 9/20 | 74/92 → 73/92 |

These section counts are summed per case against its best coherent sufficient
plan. They are required-source coverage, not general recall or precision. The
unchanged 34/38 total hides three newly incomplete regressions, so completeness
and the actual missing sections remain the primary decision measures.

## Fixed comparison

Both policies used weighted multilingual MiniLM, `documents_sections`, candidate
limit 30 **per route**, vector weight 0.7, empty filters, no MMR and the same
1200-estimated-token context ceiling. The current policy selected three section
seeds and expanded their activities in the original canonical order. The
experimental policy selected one seed from each of the first six distinct
activities in the unchanged ranked union, then added remaining sections in
round-robin activity order: ranked sections first, canonical unranked sections
afterward. Whole sections were preserved in both policies.

This measures the combined change in seed count, activity selection and packing.
Ordered candidates, scores and corpus/vector identities were identical within
every pair. The website, existing Evals/Benchmark matrices and defaults were not
changed. The eight controls and four isolated fictional source variants were
independently agent-reviewed and frozen before candidate implementation; human
validation remains absent.

## Existing regressions

In the stage columns each `sections/activities` pair describes
**candidates → seeds → delivered context**. Candidate and seed references are
diagnostic; source coverage counts only actual canonical delivered text.

| Case | Required sources: current → experimental | Current stages | Experimental stages |
| --- | --- | --- | --- |
| RAG26-01 | 2/2 → 2/2 | 42/12 → 3/1 → 6/1 | 42/12 → 6/6 → 20/6 |
| RAG26-02 | 3/3 → 3/3 | 54/12 → 3/3 → 18/3 | 54/12 → 6/6 → 18/6 |
| RAG26-03 | 2/2 → 2/2 | 46/12 → 3/3 → 18/3 | 46/12 → 6/6 → 18/6 |
| RAG26-04 | 4/4 → 4/4 | 49/12 → 3/3 → 17/3 | 49/12 → 6/6 → 18/6 |
| RAG26-05 | 3/3 → 3/3 | 41/12 → 3/2 → 12/2 | 41/12 → 6/6 → 16/6 |
| RAG26-06 | 4/4 → 3/4 | 30/12 → 3/1 → 6/1 | 30/12 → 6/6 → 17/6 |
| RAG26-07 | 3/3 → 2/3 | 39/12 → 3/2 → 12/2 | 39/12 → 6/6 → 16/6 |
| RAG26-08 | 2/2 → 2/2 | 47/12 → 3/2 → 12/2 | 47/12 → 6/6 → 18/6 |
| RAG26-09 | 1/1 → 1/1 | 43/12 → 3/2 → 12/2 | 43/12 → 6/6 → 16/6 |
| RAG26-10 | 2/2 → 2/2 | 46/12 → 3/3 → 16/3 | 46/12 → 6/6 → 16/6 |
| IND26-01 | 4/8 → 7/8 | 43/12 → 3/3 → 17/3 | 43/12 → 6/6 → 18/6 |
| T05 | 4/4 → 3/4 | 39/12 → 3/2 → 12/2 | 39/12 → 6/6 → 18/6 |

RAG26-03 preserves the bicycle **OR** creative-workshop plans separately. Both
policies retained the negative schedule evidence for RAG26-08.

## Frozen controls

| Case and contrast | Required sources: current → experimental | Current stages | Experimental stages |
| --- | --- | --- | --- |
| CTX26-01: exact 14:30 start | 4/5 → 4/5 | 41/12 → 3/3 → 17/3 | 41/12 → 6/6 → 18/6 |
| CTX26-02: active at 14:00 | 8/8 → 5/8 | 41/12 → 3/2 → 12/2 | 41/12 → 6/6 → 18/6 |
| CTX26-03: indoor status unknown | 4/8 → 5/8 | 47/12 → 3/3 → 17/3 | 47/12 → 6/6 → 18/6 |
| CTX26-04: cost unknown | 4/8 → 5/8 | 45/12 → 3/3 → 17/3 | 45/12 → 6/6 → 18/6 |
| CTX26-05: bring own material | 8/8 → 6/8 | 47/12 → 3/2 → 12/2 | 47/12 → 6/6 → 17/6 |
| CTX26-06: 14:30 option excluded from exact 14:00 | 4/5 → 5/5 | 43/12 → 3/3 → 17/3 | 43/12 → 6/6 → 18/6 |
| CTX26-07: request one option | 4/4 → 3/4 | 46/12 → 3/3 → 18/3 | 46/12 → 6/6 → 19/6 |
| CTX26-08: request all options | 4/8 → 6/8 | 45/12 → 3/3 → 17/3 | 45/12 → 6/6 → 17/6 |

These controls measure retrieval of the evidence needed for the distinctions.
They do not establish correct condition interpretation or option classification
by an assistant. Once inspected, the controls become development material.

## Where evidence is lost

All twelve activities were present in every ranked candidate union. Across the
twenty baseline outcomes, eighteen required sections were missing because their
activities were not selected. Across the experimental outcomes, all nineteen
missing required sections belonged to selected activities and were explicitly
omitted at the context ceiling. The broader selection moved the failure from
activity admission to packing, while adding unrelated activities to narrow
questions.

For IND26-01, the baseline delivered all four bicycle sections and no Taalcafé
sections. The candidate delivered seven of eight required sections, using
**1199/1200** estimated tokens. `ACT-TAAL-003:S3`, which explicitly establishes the
indoor location, was absent from the ranked section union, available through
activity expansion, and omitted for lack of context space. The activity was
selected, but its complete proof was still not delivered.

Three previously complete regressions lost a required section to the ceiling:
`ACT-MUZIEK-009:S2` for RAG26-06, `ACT-DIGI-010:S3` for RAG26-07, and
`ACT-KOKEN-004:S3` for T05. Gains on the enumeration question did not compensate
for those completeness regressions.

The result rejects unconditional six-activity diversification with this packing
policy as a replacement. A later proposal should improve how activity relevance
and complete supporting passages share the budget, and preserve evidence for
exclusions and unknowns. Any new candidate needs a separate preregistration and
fresh controls; this round made no post-result changes or additional runs.

## Provenance, verification and limits

The run used clean code revision `d421348f6f3bab18ec6874321ed37f71afbba088` and
the already cached MiniLM model at revision
`faf4aa4225822f3bc6376869cb1164e8e3feedd0`, fastembed 7.1.2, 384 dimensions and
the unchanged document chunk size of eight. It observed two concurrent retrieval
callbacks. Native batch elapsed time was 22.20 seconds. Baseline query preparation
preceded the candidate cache lookup; this single round has **no speed winner**.
Query and overlapping shared-preparation clocks must not be summed.

The twelve baseline outcomes were compared against the hash-bound 20 November
revision-3 captures. Every recorded query, configuration, corpus/vector identity,
candidate score/order, seed, canonical hit, omission, token count and work field
matched exactly as JSON values. Existing sources, criteria, historical results
and the main working tree were preserved.

Formatting, clippy, the full Rust tests and build passed. Type checking and all
199 RAG tooling tests passed with the explicit shared-cache binary path. An
independent reviewer also ran the seven new Rust checks and ten focused tooling
tests, and independently recomputed all forty source-coverage outcomes. The
review found no technical or scoring discrepancy and confirmed NO_GO.

Private raw captures, provenance, full found/missing lists, per-stage references,
timings and the historical parity assessment are retained under
`evals/rag/results/local/context-selection-20261123-d421348-once/`. They are not
published as a new public dashboard dataset. Reproduction and saved-capture
inspection are documented in the [procedure](context-selection-20261123.md).

| Binding | SHA-256 |
| --- | --- |
| Frozen control dataset | `e9d3c65c1874e6ce0eb9dca42071d60e5a44290337cca46e362669e7154eeede` |
| Native executable | `998f1a23b509e3ed0c5f613218bccb712f4d5e2e62ddd77703a92f7fc31a5f83` |
| Exact source-only input | `a280c228fecab072770311ba770f0778f34bb96625fe147aa22c779ba2441a64` |
| Forty native captures | `467be2ec990f4ab9bb5eff30455dd1585d5ab80f6bdbbe8611b4ee47d6d6f0ab` |
| Historical result index | `38d403e02af7a855cb28ce056d7feb54979587e7670959d1b41d3751a5b9fda4` |

Required-source coverage does not establish complete-answer quality, correct
filter interpretation, general recall or precision, human calibration or a
general winner among retrieval methods or embedding models.
