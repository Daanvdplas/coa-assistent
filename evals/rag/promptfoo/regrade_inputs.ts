/** Bind saved Codex rows to native source audits without running a model. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseJson } from "../scripts/model_trials.ts";
import { canonicalJson, same, sha256, writeNew } from "./json.ts";
import { safeLive } from "./provider.ts";
import type { Envelope, LiveRecord, NativeRecord, Variables } from "./types.ts";
interface ReportRow {
  vars?: Variables;
  response?: { output?: unknown; metadata?: Record<string, unknown> };
}
interface Enrichment {
  schema_version: number;
  original_eval_id: string;
  original_raw_sha256: string;
  enriched_rows: number;
  model_calls: number;
}
export interface Report {
  evalId: string;
  results: { results: ReportRow[] };
  metadata?: { source_audit_enrichment?: Enrichment; [key: string]: unknown };
}
export function enrich(inputPath: string, outputPath: string): Report {
  const input = realpathSync(inputPath),
    output = resolve(outputPath);
  if (existsSync(output) || input === output)
    throw new Error("Choose a new enriched artifact");
  const original = readFileSync(input),
    report = parseJson<Report>(original.toString()),
    base = dirname(input);
  const paths = readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name));
  paths.sort(
    (a, b) =>
      Number(!a.endsWith("/native.jsonl")) -
        Number(!b.endsWith("/native.jsonl")) ||
      a.split("/").length - b.split("/").length ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
  const candidates = new Map<
    string,
    { path: string; raw: NativeRecord | LiveRecord }
  >();
  for (const path of paths) {
    if (path.endsWith(".mcp-trace.jsonl")) continue;
    try {
      const raw = parseJson<NativeRecord | LiveRecord>(
        readFileSync(path, "utf8").trim(),
      );
      if (!raw || typeof raw !== "object") continue;
      const live = "live" in raw && raw.live ? raw.live : (raw as LiveRecord);
      if (live.run_id && live.audit_trace?.path && !candidates.has(live.run_id))
        candidates.set(live.run_id, { path, raw });
    } catch {
      continue;
    }
  }
  let count = 0;
  for (const row of report.results.results) {
    const response = row.response;
    if (!response) continue;
    const output = response.output;
    const envelope = (
      typeof output === "string" ? parseJson(output) : output
    ) as Envelope | undefined;
    if (
      !envelope ||
      typeof envelope !== "object" ||
      envelope.operation !== "codex"
    )
      continue;
    const old = envelope.record as LiveRecord,
      runId = old.run_id,
      candidate = candidates.get(runId);
    if (!candidate)
      throw new Error("No matching preserved native source audit for " + runId);
    const safe = safeLive(candidate.raw, base);
    if (
      Object.entries(old).some(
        ([key, value]) => !same(safe[key as keyof LiveRecord], value),
      )
    )
      throw new Error("Native evidence differs from original provider output");
    envelope.record = safe;
    response.output =
      typeof output === "string" ? canonicalJson(envelope) : envelope;
    response.metadata = {
      ...response.metadata,
      native_record_sha256: sha256(readFileSync(candidate.path)),
      source_audit_enriched: true,
    };
    count++;
  }
  report.metadata = {
    ...report.metadata,
    source_audit_enrichment: {
      schema_version: 1,
      original_eval_id: report.evalId,
      original_raw_sha256: sha256(original),
      enriched_rows: count,
      model_calls: 0,
    },
  };
  mkdirSync(dirname(output), { recursive: true });
  writeNew(output, report);
  return report;
}
function main(): void {
  const { values } = parseArgs({
    options: { input: { type: "string" }, output: { type: "string" } },
  });
  if (!values.input || !values.output)
    throw new Error("Usage: regrade_inputs.ts --input FILE --output NEW_FILE");
  const result = enrich(values.input, values.output);
  console.log(JSON.stringify(result.metadata?.source_audit_enrichment));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
