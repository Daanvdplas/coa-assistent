import test from "node:test";
import assert from "node:assert/strict";
import { projectRun, isComplete } from "./export_site_results.ts";
function sample() {
  const section = {
    source_id: "ACT-TEST",
    id: "S1",
    source_title: "Test",
    source_date: "2026-11-05",
    heading: "Wanneer?",
    text: "Dinsdag om tien uur.",
  };
  const native = {
    answer: { text: "Dinsdag.", reasoning: "DO-NOT-EXPORT" },
    tool_calls: [
      {
        query: "Wanneer?",
        status: "completed",
        result: { hits: [{ section }], private_path: "/Users/PRIVATE" },
        arguments: { auth_token: "SECRET" },
      },
    ],
    reasoning: "HIDDEN",
    runtime_path: "/private/tmp/PRIVATE",
  };
  const ref = { source_id: "ACT-TEST", section_id: "S1" };
  const assessment = {
    actual_search_calls: 1,
    source_coverage: {
      complete: true,
      first_complete_call_index: 1,
      expected_source_options: [[ref]],
    },
    calls: [
      {
        index: 1,
        query: "Wanneer?",
        status: "completed",
        offered_sections: [ref],
        complete_expected_sources: true,
      },
    ],
  };
  return { native, assessment, sources: { "ACT-TEST:S1": section } };
}
test("projection keeps observables without private native fields", () => {
  const { native, assessment, sources } = sample();
  const projected = projectRun(native, assessment, sources);
  assert.deepEqual(projected.calls[0].hits, ["ACT-TEST:S1"]);
  assert.equal(projected.calls[0].query, "Wanneer?");
  assert.equal(projected.complete, true);
  for (const forbidden of [
    "reasoning",
    "runtime_path",
    "arguments",
    "auth_token",
    "PRIVATE",
    "SECRET",
    "HIDDEN",
  ])
    assert.ok(!JSON.stringify(projected).includes(forbidden));
});
test("projection rejects unoffered or changed source text", () => {
  const { native, assessment, sources } = sample();
  sources["ACT-TEST:S1"] = { ...sources["ACT-TEST:S1"] };
  native.tool_calls[0].result.hits[0].section.text = "Tampered source.";
  assert.throws(() => projectRun(native, assessment, sources));
});
test("full alternative cannot be built from two different options", () => {
  assert.equal(
    isComplete(new Set(["A:S2", "B:S3"]), [
      ["A:S2", "A:S3"],
      ["B:S2", "B:S3"],
    ]),
    false,
  );
  assert.equal(
    isComplete(new Set(["B:S2", "B:S3"]), [
      ["A:S2", "A:S3"],
      ["B:S2", "B:S3"],
    ]),
    true,
  );
});
test("source preamble preserves a repeated reference date after metadata", async () => {
  const { readSources } = await import("./export_site_results.ts");
  const [documents] = readSources();
  assert.ok(
    documents
      .find((document) => document.id === "ACT-WANDEL-005")!
      .preamble.endsWith("Referentiedatum: 2026-10-20."),
  );
});
