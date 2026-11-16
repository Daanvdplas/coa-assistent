import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrich } from "../regrade_inputs.ts";
import { getAssert } from "../assertions.ts";
import { sha256 } from "../json.ts";
import { codexRecord, variables } from "./fixtures.ts";
import type { Envelope, LiveRecord } from "../types.ts";
function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "coa-regrade-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const envelope = codexRecord(),
    live = envelope.record as LiveRecord,
    raw = live.source_audit_jsonl!;
  delete live.source_audit_jsonl;
  const native = structuredClone(live),
    trace = join(root, "native.mcp-trace.jsonl");
  writeFileSync(trace, raw);
  native.audit_trace!.path = trace;
  writeFileSync(
    join(root, "native.jsonl"),
    JSON.stringify({ live: native }) + "\n",
  );
  const input = join(root, "original.json"),
    output = join(root, "enriched.json");
  const vars = {
    ...variables(),
    dataset: "legacy",
    case_id: "P01",
    question: envelope.question,
    profile: "documents_sections",
    ...live.config.retrieval,
    model: "gpt-6.1-sol",
  };
  writeFileSync(
    input,
    JSON.stringify({
      evalId: "original-eval",
      results: { results: [{ vars, response: { output: envelope } }] },
    }),
  );
  return { input, output, trace };
}
test("enrichment binds original native audit without modifying old evidence", (t) => {
  const { input, output } = setup(t),
    before = readFileSync(input),
    result = enrich(input, output);
  assert.deepEqual(readFileSync(input), before);
  const row = result.results.results[0],
    envelope = row.response!.output as Envelope;
  assert.ok((envelope.record as LiveRecord).source_audit_jsonl);
  assert.ok(!("path" in (envelope.record as LiveRecord).audit_trace!));
  assert.equal(getAssert(envelope, { vars: row.vars! }).pass, true);
  assert.equal(
    result.metadata!.source_audit_enrichment!.original_raw_sha256,
    sha256(before),
  );
});
test("corrupted audit is rejected without a new output", (t) => {
  const { input, output, trace } = setup(t);
  appendFileSync(trace, " ");
  assert.throws(() => enrich(input, output));
  assert.equal(existsSync(output), false);
});
