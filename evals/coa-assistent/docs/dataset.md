# Activity-evaluation dataset

The twelve cases in `evals/shared/datasets/legacy/questions.json` are an instrument pilot over five fictional documents, not evidence of general RAG quality. P01–P06 are known development cases; P07–P12 broaden the pilot across bicycles, language, cooking, walking and absent activities. No human reference judgments have been recorded. See [shared datasets](../../shared/README.md) for later versions, including the revised P06; the original v1 remains preserved.

## Inputs and protected expectations

`questions.json` contains question text, version, reference date and exact source hashes. Only the question text goes to the generator; family, split and type are evaluation metadata. `expectations.json` separately contains meaning criteria and a test canary. It is never indexed or offered to the answer generator. The separate judge may receive criteria only after generation. Dataset validation alone does not prove the request boundary; runner tests check it.

The corpus fingerprint uses the index manifest's exact UTF-8 documents and separators. `questions_sha256` hashes compact UTF-8 JSON in version-1 `QuestionSet` field order: question/metadata changes alter its binding to expectations, JSON-file whitespace does not. Changed source bytes or reference dates require a new dataset version and review; old results keep their original manifest.

## Evidence semantics

A fact has a description, not a required answer sentence. Every section in one `evidence_alternatives` group is required (AND); any complete alternative group can support the fact (OR). A section is identified by both document and section ID.

An explicit unknown can have source support: the walking source says wheelchair access is not described. Where no positive source exists, such as gardening transport or Saturday badminton, `kind: unknown` has empty alternatives and requires an honest unknown answer. No positive denominator means N/A, not zero retrieval. Existing expected evidence that is not retrieved gives zero coverage.

`relevant_sections` includes direct support for facts/conditions and useful exclusion evidence. For a complete Tuesday list, all five day sections help establish matches and exclusions. Relevance labels are task annotations, not intrinsic passage properties. Precision/recall need complete labels; fact coverage can use incomplete relevance annotations. Use the current dataset's flags rather than assuming historical label completeness.

## Human calibration and the AI reference

[human-review.html](human-review.html) contains eight handmade candidate answers and exact source excerpts, not live model output or suggested labels. H01–H04 develop the rubric; H05–H08 check the judge separately. A correct unknown or necessary clarification can be good. “Needs review” means the person cannot decide sufficiently.

The worksheet copies chosen labels to JSON without storage or a network request. `human_label` fields remain empty until a real person supplies them. Human calibration is deferred. Separate `ai-reference.json` contains provisional source-grounded references from another AI agent, checked against case IDs, source text and the worksheet fingerprint. `origin: ai_agent` and `human_calibration: false` remain explicit. Agreement measures agreement with that AI reference, not human validation or reliability on other topics. The original worksheet and human fields remain unchanged.

## Add evaluation questions

A new unseen comparison needs separate question/expectation files, a version and independently reviewed criteria before execution. Keep a question family and its paraphrases in one split. Known misses cannot later become unseen cases. Record selection and freeze timing before running; do not change expectations to improve a poor score. Correct genuine label errors through an explained new version and preserve both results.

These are limited applications of coverage/calibration principles, not formal guarantees of the research methods. Sources: [Coverage, Not Averages](https://proceedings.mlr.press/v306/klearman26a.html) and [How to Correctly Report LLM-as-a-Judge Evaluations](https://proceedings.mlr.press/v306/lee26bl.html), ICML **6–11 July 2026**.
