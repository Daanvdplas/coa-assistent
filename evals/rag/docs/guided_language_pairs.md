# Dutch and English questions against the same demo index

Each of the 22 cases from the [Guided holdout](guided_demo_holdout.md) has one Dutch and one English sequence. The existing Dutch and English queries remain in their three frozen files. [The paired fixture](../../shared/datasets/guided-demo-20261123/language-pairs.json) supplies the other language. Preserve the order, number of attempts, times and their numeric notation, negations and thresholds. Keep canonical Dutch activity names when explicitly named in the original, so this comparison covers English prose with those titles. Unnamed activities remain unnamed. The source documents and passage expectations are identical across both languages.

The CLI receives 54 literal queries in each of two batches. It uses the existing multilingual MiniLM, the original twelve Dutch documents, Guided v4, top-k three, candidate-k 30, vector weight 0.7, and the 1,200 estimated token ceiling. Each batch prepares one Index. Every response must report the same corpus, embedding settings, embedding input and document vector hashes. Each emitted passage must match its canonical text and metadata. The retrieval process receives only literal queries and retrieval settings. The cached model runs locally without a provider key or an answer-generation call.

Score each case separately in each language. A case completes after the first attempt that brings the cumulative delivered passages into coverage of an entire expected alternative. Report completion on the first search, each later search and after the planned queries. Evaluate the eight predeclared first-search selector checks for match IDs, unknown IDs, whether the selector applied, and exhaustiveness. Source delivery and selector accuracy measure different outcomes. Report technical or provenance errors separately. The fixed follow-ups measure evidence from planned attempts. The trial does not assess autonomous follow-ups, answer quality, or whether English activity aliases are recognized.

## Run and replay

Inspect the planned literal inputs and hashes before running. The frozen trial uses the macOS binary pinned by the November 23 v4 check from revision `9381cec` and the cached MiniLM snapshot. A new build has a separate binary identity.

```sh
node evals/rag/scripts/guided_language_pairs.ts --plan

node evals/rag/scripts/guided_language_pairs.ts \
  --binary target/debug/meedoen-retrieval \
  --out evals/rag/results/local/guided-demo-language-pairs-20261124

node evals/rag/scripts/guided_language_pairs.ts \
  --replay evals/rag/results/local/guided-demo-language-pairs-20261124
```

The run keeps raw rows, provenance, assessment and report in a fresh local directory. Replay verifies their frozen input and raw-row bindings, then computes the report without retrieval.

## Guided v5 candidate regression

The candidate reuses the frozen questions, source checks and settings. Use the clean committed checkout used to build the candidate. Keep the reviewed commit and binary hashes for replay. Each result must identify Guided v5.

```sh
node evals/rag/scripts/guided_language_pairs.ts --candidate-v5 \
  --binary-revision <full-source-commit> --binary-sha256 <reviewed-binary-sha256> \
  --binary <built-candidate-cli> \
  --out evals/rag/results/local/guided-demo-language-pairs-v5-20261124

node evals/rag/scripts/guided_language_pairs.ts --candidate-v5 \
  --binary-revision <full-source-commit> --binary-sha256 <reviewed-binary-sha256> \
  --replay evals/rag/results/local/guided-demo-language-pairs-v5-20261124
```

The same arguments with `--plan` show the candidate binding without executing retrieval. The original v4 capture still replays with its original command.
