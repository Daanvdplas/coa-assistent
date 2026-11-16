import { createHash } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, relative, isAbsolute } from "node:path";

// These fields are f64 in the native Rust protocol, even when their value is
// integral. Keep the original Python assertion's compact JSON byte contract.
const FLOAT_FIELDS = new Set([
  "rrf_k",
  "vector_weight",
  "mmr_lambda",
  "dense_similarity",
  "bm25_score",
  "rank_score",
]);
export function floatText(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Non-finite protocol number");
  if (Object.is(value, -0)) return "-0.0";
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16)) {
    const [mantissa, exponent] = value.toExponential().split("e");
    const power = Number(exponent);
    return (
      mantissa +
      "e" +
      (power < 0 ? "-" : "+") +
      String(Math.abs(power)).padStart(2, "0")
    );
  }
  return Number.isInteger(value) ? value.toString() + ".0" : value.toString();
}
export function canonicalJson(
  value: unknown,
  sorted = false,
  floatFields = FLOAT_FIELDS,
): string {
  function encode(item: unknown, key = ""): string {
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return JSON.stringify(item);
    if (typeof item === "number")
      return floatFields.has(key) ? floatText(item) : JSON.stringify(item);
    if (Array.isArray(item))
      return "[" + item.map((value) => encode(value)).join(",") + "]";
    if (typeof item !== "object")
      throw new Error("Expected JSON protocol value");
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    if (sorted) keys.sort(compareCodepoints);
    return (
      "{" +
      keys
        .map((name) => JSON.stringify(name) + ":" + encode(record[name], name))
        .join(",") +
      "}"
    );
  }
  return encode(value);
}
function compareCodepoints(a: string, b: string): number {
  const left = Array.from(a),
    right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
export function same(left: unknown, right: unknown): boolean {
  // Object member order is not part of the JSON value contract.
  return canonicalJson(left, true) === canonicalJson(right, true);
}
export function checkedFile(
  path: string,
  base: string,
  maximum: number,
): string {
  const resolved = realpathSync(path),
    root = realpathSync(base),
    delta = relative(root, resolved);
  const stat = statSync(resolved);
  if (
    delta === ".." ||
    delta.startsWith("../") ||
    isAbsolute(delta) ||
    !stat.isFile() ||
    stat.size > maximum
  )
    throw new Error("Artifact escaped its private execution");
  return resolved;
}
export function writeNew(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, canonicalJson(value), { flag: "wx", mode: 0o600 });
}
