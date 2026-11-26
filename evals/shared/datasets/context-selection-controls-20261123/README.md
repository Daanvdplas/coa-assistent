# Context-selection controls

This additive experiment freezes twenty retrieval cases: twelve existing development/regression cases and eight new controls. It compares the current weighted MiniLM activity expansion with one opt-in activity-aware context-selection policy. The unchanged literal question and twelve source documents are the only semantic retrieval inputs; filters stay empty. No answer model or AI judge is used.

The manifest includes complete, ordered source lists and byte hashes. Corpus hashes use the existing delimiter: document text joined with \n---document---\n. Each counterfactual version replaces exactly one section of the fictional language-cafe source; all other eleven document files retain their original bytes. IDs are meaningful only together with their corpus hash. These are controlled fictional versions, not corrections to the demo source facts.

The twelve existing cases refer to their original immutable questions, expectations and exact quotation records. The eight new gold plans and quotes are in `expectations.json`, which is assessment-only and must not enter indexes, query construction, candidate selection, context allocation or stop decisions. The manifest's assessment references must be stripped before native retrieval input.

## New controls

| Case | Contrast | Corpus | Required source sections |
| --- | --- | --- | --- |
| CTX26-01 | Starts exactly at 14.30; 14.00 is not sufficient | Language cafe starts 14.30 | Language cafe S1,S2,S3,S5; bicycle S2 |
| CTX26-02 | Active at 14.00, including an earlier start | Original twelve; question names sewing and language cafes | Sewing S1,S2,S3,S5 and language cafe S1,S2,S3,S5 |
| CTX26-03 | Indoor/outdoor is unknown | Language-cafe location unknown | Bicycle and language cafe S1,S2,S3,S5 |
| CTX26-04 | Unknown costs do not prove free participation | Language-cafe costs unknown | Bicycle and language cafe S1,S2,S3,S5 |
| CTX26-05 | Activity materials must be brought by the participant | Language-cafe materials absent | Bicycle and language cafe S1,S2,S3,S5 |
| CTX26-06 | Starts exactly at 14.00; 14.30 is not sufficient | Same 14.30 version as CTX26-01 | Bicycle S1,S2,S3,S5; language cafe S2 |
| CTX26-07 | One complete option suffices | Original twelve | Bicycle S1,S2,S3,S5 **OR** language cafe S1,S2,S3,S5 |
| CTX26-08 | Every matching option is required | Original twelve | Bicycle **AND** language cafe S1,S2,S3,S5 |

Case questions are literal Dutch functional data. Cases 07 and 08 differ only in the requested quantity. Cases 01 and 06 use the same changed corpus and differ only in requested start time. Case 02 is deliberately bounded to two named activities; it makes no corpus-wide claim about activities active at 14.00. The active-at convention includes the start time and excludes the end time; neither named activity lies at an end-time boundary.

## Assessment limits

A complete plan means the retriever delivered the source evidence needed for the stated task. It does not prove that an assistant reads the conditions correctly or preserves unknowns in an answer. Required negative and unknown statements count as evidence, not irrelevant results. Condition and matching-option labels are independently auditable metadata for explaining the plans; they are not a classifier score. Full per-activity audits support the reviewed answer sets, but only the explicitly frozen source plans define mandatory retrieval evidence. Unlisted context is not automatically wrong.

No human labels have been supplied. The eight controls must be independently reviewed and frozen before production candidate implementation or candidate-result inspection. After the first comparison they are development material; they must not be repeatedly tuned against and presented as unseen validation. Keep all forty measured outcomes, including losses and technical failures. An unsuccessful result is not permission to weaken a plan or rerun a tuned candidate against the same controls.

FROZEN.json will record the independent review, exact artifact hashes and source bindings before implementation begins.
