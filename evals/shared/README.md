# Shared datasets

`datasets/` holds one canonical copy of questions and protected expectations used by retrieval and complete-assistant evaluations:

| Directory | Questions | Sources |
| --- | --- | --- |
| `legacy/` | P01–P12 and T01–T06 | Five activities |
| `independent-20261103/` | IND26-01–IND26-12 | Five activities |
| `expanded-10-20261105/` | Ten selected development questions | Ten activities |
| `strengthened-10-20261106/` | RAG26-01–RAG26-10 | Ten activities |
| `demo-12-20261118/` | Seventeen eval cases: ten adapted questions, four chess/sewing questions and three browser cases | Twelve current activities; reference date 13 November 2026 |

Questions, expectations, freezes and independent [AUTHORING notes](datasets/independent-20261103/AUTHORING.md) were moved without changing their bytes. Historical manifest paths identify original inputs. Loaders compare those keys/hashes against current canonical files; provenance was not relabelled. Expectations are loaded only for assessment, never as model instructions or indexed search content. The original candidate status in AUTHORING remains preserved; the additive `FROZEN.json` is authoritative for the later review/freeze.

The current twelve-source development/regression set is `demo-12-20261118`. Its source expectations were independently reviewed by another agent before measurement; this is neither a blind test set nor human calibration. T02 accepts a fully supported bicycle or creative-workshop option. Scores do not repeat the older five-/ten-source measurements. The original five gardening questions belong only to retrieval regression, under `../rag/datasets/garden/`.

Since **16 November 2026**, development question `legacy/P06` uses this visitor question: “Ik zoek een activiteit die helemaal buiten plaatsvindt en vóór 11.00 uur afgelopen is. Wat past daarbij?” Version `activities-evaluation-v2-20261116` expects walking evidence for outdoors and a 10:30 finish, without requiring the visitor to know activity names or compare named alternatives. Frozen `independent-20261103/IND26-10` and saved measurements remain unchanged. New runs bind the new question/expectation identity; old scores do not measure this revision.

Original `activities-evaluation-v1` questions/criteria remain byte-identical in `legacy/v1/`. Old complete-assistant reports recognize that version. Select `--dataset legacy-v1` explicitly for old retrieval traces in `lab assess` or `lab report`; ordinary `legacy` means the current development version.
