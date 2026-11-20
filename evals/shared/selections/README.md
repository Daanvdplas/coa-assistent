# RAG quality selection

[`rag-quality-12-20261120.json`](rag-quality-12-20261120.json) selects the **ten existing RAG26-01–10 questions plus IND26-01**. It references immutable questions, expectations and quotation records in [`demo-12-20261118`](../datasets/demo-12-20261118/) and [`regression-12-20261118`](../datasets/regression-12-20261118/). All eleven source contracts were independently audited against the twelve documents before implementation. Human labels remain empty; this is known development/regression material, not blind or human-calibrated validation.

The earlier uncommitted proposal selected ten additional questions, including chess and sewing. The user clarified that the existing ten RAG26 cases and the complex enumeration regression were wanted. This selection supersedes that proposal before any measurements; no frozen input or historical result changes.

## Fixed source plans

Within a plan all listed sections are required (**AND**). Only RAG26-03 has two alternative sufficient plans (**OR**); do not merge the bicycle and creative-workshop alternatives. Canonical `expectations.json` defines assessment; `reference-details.json` contains exact quotes and source dates.

| Public ID / case | Required sections | Unique sections / goals |
| --- | --- | --- |
| `quality-garden` / RAG26-01 | ACT-TUIN-001:S2,S3 | 2 / 1 |
| `quality-tuesday` / RAG26-02 | ACT-TUIN-001:S2; ACT-FIETS-002:S2; ACT-MAAK-006:S2 | 3 / 1 |
| `quality-indoor` / RAG26-03 | ACT-FIETS-002:S2,S3 **OR** ACT-MAAK-006:S2,S3 | 2 / 1 |
| `quality-outdoor` / RAG26-04 | ACT-WANDEL-005:S2,S3; ACT-PARK-007:S2,S3 | 4 / 1 |
| `quality-language` / RAG26-05 | ACT-TAAL-003:S1,S4; ACT-BIEB-008:S4 | 3 / 1 |
| `quality-music` / RAG26-06 | ACT-MUZIEK-009:S1,S2,S4,S5 | 4 / 1 |
| `quality-digital` / RAG26-07 | ACT-DIGI-010:S3,S4,S5 | 3 / 1 |
| `quality-sunday` / RAG26-08 | ACT-MUZIEK-009:S2; ACT-DIGI-010:S2 | 2 / 1 |
| `quality-cooking` / RAG26-09 | ACT-KOKEN-004:S5 | 1 / 1 |
| `quality-capacity` / RAG26-10 | ACT-PARK-007:S6; ACT-DIGI-010:S6 | 2 / 1 |
| `quality-complete-options` / IND26-01 | ACT-FIETS-002:S1,S2,S3,S5; ACT-TAAL-003:S1,S2,S3,S5 | 8 / 10 |

All search the same twelve fictional documents and 72 sections, as of **13 November 2026**. The English music question remains unchanged. Sunday is a bounded negative check of the two named schedules, not an exhaustive claim about every activity. Allergen information is explicitly unknown. Historical place counts do not establish current availability. Chess and sewing remain corpus distractors and separately available questions.

Required-section coverage is primary. RAG26 cases each have one bundled source goal: 0/1 goals does not mean zero source sections were found. IND26-01 needs eight sections supporting ten goals. Repeated references count once; actual captured text, not expected inspection text, proves retrieval. Relevance labels are incomplete, so these scores do not establish universal recall/precision or answer correctness.

## Cards, aliases and measurements

Evals shows these eleven quality cards plus T05. Old `garden-time-location` and `indoor-tuesday` start routes retain P01 and T02 identities. Their saved raw criteria and percentages remain unchanged. The new RAG26-01 and RAG26-03 cards use their own canonical criteria; equal question text does not merge evaluation identities.

Each question is benchmarked separately with two fresh repetitions. Keep all existing baselines, including configurations whose section ceiling cannot cover a four- or eight-section requirement. Two additional dense E5 k3 configurations, with and without activity expansion, match the existing MiniLM/BM25 k3 settings and give a feasible-context comparison without changing fusion. Every selected configuration uses candidate limit 30 and the same context ceiling of 1200 estimated tokens. The context estimator and actual selected sections remain inspectable; expansion can still omit sections at that ceiling.

Storage organized as activity records is flattened into sections before ranking: top-k always selects seed **sections**, independently of storage layout. Only explicit `activity_expansion` adds other sections of seed activities, bounded by the context ceiling.

The directly measured `query_total_ms` starts on an already prepared index before query-vector lookup/inference and ends after ranking, expansion and context construction. Index/model/document preparation remains separately recorded and shared by preparation identity. Do not sum overlapping preparation stages or repeated copies. Historical query totals remain unknown; `retrieval_ms` is ranking/context-selection time only. Compare speed only for complete source results, with cache state and the small two-repetition sample visible. Do not tune RRF/weighted fusion from one question or label two samples a universal winner.
