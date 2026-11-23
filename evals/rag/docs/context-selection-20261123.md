# Frozen context-selection experiment

This opt-in, model-free experiment compares two **joint selection policies**. It does not change the website, Evals/Benchmark matrices or existing defaults:

- `baseline`: weighted MiniLM, three section seeds, current activity expansion.
- `activity_balanced`: the same weighted candidates, up to six distinct activity seeds, then balanced context allocation.

Candidate limit 30 per search route, fusion weights, MiniLM identity, empty filters and the 1200-estimated-token context ceiling remain fixed. Changing both seed selection and allocation tests their combined effect, not each mechanism separately. The same case pair must retain identical ordered candidates, scores and corpus/vector identity; the grader rejects drift.

The independently agent-reviewed [freeze](../../shared/datasets/context-selection-controls-20261123/FROZEN.json) binds twelve existing regressions plus eight controls with four isolated fictional source variants. Existing source and criteria bytes remain unchanged. Only literal questions and complete byte-bound document lists enter the native worker. Expected sections, matching-option labels, unknown-condition labels and reference quotes stay assessment-only.

## Run once

From the reviewed branch root, after the ordinary Rust/TypeScript checks and independent code review:

```sh
node evals/rag/scripts/context_selection.ts run \
  --binary /absolute/path/to/meedoen-retrieval \
  --model-cache /absolute/path/to/existing/.model-cache \
  --output evals/rag/results/local/context-selection-<new-id>
```

The native command permits cached MiniLM only and makes no answer-model or judge calls. It runs twenty cases × two policies × one execution: **forty measurements**, with at most two retrieval callbacks concurrently. It must not download a model or silently retry. The wrapper removes provider settings from the child environment and disables dotenv. It refuses an existing output directory.

`input.json` is the exact source-only request. `native.jsonl` contains durable native captures; stdout summary, stderr and exit status are retained separately. `provenance.json` binds the binary, wrapper, existing scorer, frozen dataset and source revision. `assessment.json` and `report.md` retain every outcome, including incomplete evidence and technical failures. No old artifacts are overwritten.

## Inspect or reassess saved captures

Read `report.md` for required-section counts per question and policy. `assessment.json` includes found/missing canonical section keys, original fact-goal scores, candidate/seed/context activity sets and the recorded omission reason for missing evidence. Candidate and seed keys are diagnostic references; only actual canonical payload text counts as delivered evidence. Expansion can add sections not present in the ranked candidates.

This read-only reassessment prints derived scores from saved bytes; it performs zero retrieval or model calls and does not replace original measurements:

```sh
node --input-type=module - evals/rag/results/local/<saved-run> <<'JS'
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadExperiment, assessExperiment } from './evals/rag/scripts/context_selection.ts';
const run = resolve(process.argv[2]);
const bytes = readFileSync(resolve(run, 'input.json'), 'utf8');
const experiment = loadExperiment(process.cwd(), JSON.parse(bytes).execution_id);
if (experiment.inputBytes !== bytes) throw new Error('Saved request differs from frozen input');
const assessment = assessExperiment(experiment, readFileSync(resolve(run, 'native.jsonl'), 'utf8'));
console.log(JSON.stringify(assessment, null, 2));
JS
```

## Decision and limits

The candidate receives `GO` only with zero technical failures, no existing-case coverage regressions, all twelve existing source plans complete (including all eight IND26-01 sections), and all eight control plans complete. Otherwise retain the baseline and report `NO_GO`; do not weaken gold or tune repeatedly against these controls.

Coherent OR plans stay coherent. Negative and explicit unknown evidence is required where frozen. Coverage does not score activity classification, filter interpretation or final-answer correctness. Precision remains unknown because relevance labels are incomplete. Human labels remain empty. Once examined, these controls become development material.

Baseline executes before candidate within a prepared pair: its query may be cold while the candidate lookup is warm. Query cache state and direct query clocks remain visible, but this single-execution round cannot establish a speed winner. Shared preparation stages overlap and must not be summed.
