import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, sha256 } from "../json.ts";

test("canonical JSON preserves native float fields and Python UTF-8 sorted serialization", () => {
  assert.equal(
    canonicalJson({ z: "é😀", rrf_k: 60, top_k: 3, vector_weight: 0.7 }, true),
    '{"rrf_k":60.0,"top_k":3,"vector_weight":0.7,"z":"é😀"}',
  );
  assert.equal(
    canonicalJson({ dense_similarity: 1e-7, rank_score: 1e20 }, true),
    '{"dense_similarity":1e-07,"rank_score":1e+20}',
  );
  assert.equal(
    sha256("é"),
    "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
  );
});
