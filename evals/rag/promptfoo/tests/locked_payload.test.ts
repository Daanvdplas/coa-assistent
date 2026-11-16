import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lockedTransaction } from "../ledger.ts";
import { ROOT } from "../provider.ts";
import { isolateEnvironment } from "./environment.ts";

test("failed transaction removes its private payload file and keeps its content out of argv", async (t) => {
  const binary =
    process.env.COA_RAG_BINARY ?? join(ROOT, "target/debug/meedoen-retrieval");
  t.after(isolateEnvironment());
  process.env.COA_RAG_BINARY = binary;
  const directory = mkdtempSync(join(tmpdir(), "coa-payload-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, "observed.json");
  const worker = join(directory, "worker.mjs");
  writeFileSync(
    worker,
    `import fs from 'node:fs';
import {dirname} from 'node:path';
const file=process.argv[4];
const payload=JSON.parse(fs.readFileSync(file,'utf8'));
fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({file,mode:fs.statSync(file).mode&0o777,directoryMode:fs.statSync(dirname(file)).mode&0o777,bytes:payload.privateText.length,argv:process.argv}));
process.exit(9);`,
  );
  await assert.rejects(
    lockedTransaction(join(directory, "ledger.lock"), worker, "fail", {
      privateText: "PRIVATE-CONTENT".repeat(80000),
    }),
    /Locked protocol transaction failed/,
  );
  const observed = JSON.parse(readFileSync(marker, "utf8")) as {
    file: string;
    mode: number;
    directoryMode: number;
    bytes: number;
    argv: string[];
  };
  assert.equal(observed.mode, 0o600);
  assert.equal(observed.directoryMode, 0o700);
  assert.equal(observed.bytes, "PRIVATE-CONTENT".length * 80000);
  assert.ok(
    observed.argv.every((argument) => !argument.includes("PRIVATE-CONTENT")),
  );
  assert.equal(existsSync(observed.file), false);
  assert.equal(existsSync(dirname(observed.file)), false);
});
