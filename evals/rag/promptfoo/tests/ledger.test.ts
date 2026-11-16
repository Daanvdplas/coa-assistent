import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reserve, finish } from "../ledger.ts";
import { isolateEnvironment } from "./environment.ts";
const binary = process.env.COA_TEST_LOCK_BINARY ?? process.env.COA_RAG_BINARY;

test(
  "reservation consumes the shared cap, changed limits cannot reset it, failed attempts stop future calls",
  { skip: !binary },
  async () => {
    const restore = isolateEnvironment(),
      directory = mkdtempSync(join(tmpdir(), "coa-ledger-"));
    try {
      Object.assign(process.env, {
        COA_RAG_BINARY: binary,
        COA_PROMPTFOO_ALLOW_CODEX: "1",
        COA_PROMPTFOO_LEDGER: join(directory, "ledger.json"),
        COA_PROMPTFOO_MAX_GENERATIONS: "2",
        COA_PROMPTFOO_MAX_SECONDS: "900",
      });
      const first = await reserve("legacy", "P01", "gpt-6.1-sol");
      await finish(first.path, first.id, true);
      const second = await reserve("legacy", "P02", "gpt-6-luna");
      await finish(second.path, second.id, true);
      await assert.rejects(
        reserve("legacy", "P03", "gpt-6.1-sol"),
        /exhausted/,
      );
      process.env.COA_PROMPTFOO_MAX_GENERATIONS = "3";
      await assert.rejects(
        reserve("legacy", "P03", "gpt-6.1-sol"),
        /cannot be changed/,
      );
      const state = JSON.parse(readFileSync(first.path, "utf8"));
      assert.equal(state.attempts.length, 2);
      process.env.COA_PROMPTFOO_LEDGER = join(directory, "failed.json");
      const failed = await reserve("legacy", "P01", "gpt-6.1-sol");
      await finish(failed.path, failed.id, false);
      await assert.rejects(reserve("legacy", "P02", "gpt-6-luna"), /stopped/);
    } finally {
      restore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
test(
  "unfinished reservation and expired shared window fail closed",
  { skip: !binary },
  async () => {
    const restore = isolateEnvironment(),
      directory = mkdtempSync(join(tmpdir(), "coa-ledger-"));
    try {
      Object.assign(process.env, {
        COA_RAG_BINARY: binary,
        COA_PROMPTFOO_ALLOW_CODEX: "1",
        COA_PROMPTFOO_LEDGER: join(directory, "ledger.json"),
      });
      const reservation = await reserve("legacy", "P01", "gpt-6.1-sol");
      await assert.rejects(
        reserve("legacy", "P01", "gpt-6.1-sol"),
        /uncertain/,
      );
      await finish(reservation.path, reservation.id, true);
      const state = JSON.parse(readFileSync(reservation.path, "utf8"));
      state.started_at = Date.now() / 1000 - 901;
      writeFileSync(reservation.path, JSON.stringify(state));
      await assert.rejects(reserve("legacy", "P02", "gpt-6-luna"), /exhausted/);
    } finally {
      restore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
test(
  "parallel processes cannot reserve more than one uncertain generation",
  { skip: !binary },
  async () => {
    const restore = isolateEnvironment(),
      directory = mkdtempSync(join(tmpdir(), "coa-parallel-ledger-"));
    try {
      Object.assign(process.env, {
        COA_RAG_BINARY: binary,
        COA_PROMPTFOO_ALLOW_CODEX: "1",
        COA_PROMPTFOO_LEDGER: join(directory, "ledger.json"),
      });
      const results = await Promise.allSettled([
        reserve("legacy", "P01", "gpt-6.1-sol"),
        reserve("legacy", "P02", "gpt-6-luna"),
      ]);
      assert.equal(
        results.filter((row) => row.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((row) => row.status === "rejected").length,
        1,
      );
      const state = JSON.parse(
        readFileSync(process.env.COA_PROMPTFOO_LEDGER!, "utf8"),
      );
      assert.equal(state.attempts.length, 1);
      assert.equal(state.attempts[0].status, "reserved");
    } finally {
      restore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
test(
  "locked transaction carries large private records without exposing their contents in argv",
  { skip: !binary },
  async () => {
    const { lockedTransaction } = await import("../ledger.ts");
    const restore = isolateEnvironment(),
      directory = mkdtempSync(join(tmpdir(), "coa-private-transaction-"));
    try {
      process.env.COA_RAG_BINARY = binary;
      const script = join(directory, "transaction.mjs");
      writeFileSync(
        script,
        "import{readFileSync}from'node:fs';const payload=process.argv[3]==='--payload-file'?JSON.parse(readFileSync(process.argv[4],'utf8')):JSON.parse(process.argv[3]);process.stdout.write(JSON.stringify({value:{length:payload.message.length,argv:process.argv}}));",
      );
      const message = "PRIVATE-MODEL-CONTENT-" + "x".repeat(300000);
      const result = await lockedTransaction<{
        length: number;
        argv: string[];
      }>(join(directory, "lock"), script, "roundtrip", { message });
      assert.equal(result.length, message.length);
      assert.ok(!result.argv.join(" ").includes("PRIVATE-MODEL-CONTENT"));
      assert.ok(result.argv.join(" ").length < 4096);
    } finally {
      restore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
test(
  "ledger transaction writes the locked inode even if its path is replaced",
  { skip: !binary },
  async () => {
    const { lockedTransaction } = await import("../ledger.ts");
    const restore = isolateEnvironment(),
      directory = mkdtempSync(join(tmpdir(), "coa-inode-ledger-"));
    try {
      process.env.COA_RAG_BINARY = binary;
      process.env.COA_OPERATOR_LOCK_FD = "0";
      const path = join(directory, "ledger.json"),
        original = join(directory, "original.json"),
        victim = join(directory, "other.json"),
        script = join(directory, "replace.mjs");
      writeFileSync(victim, "");
      const ledgerModule = new URL("../ledger.ts", import.meta.url);
      writeFileSync(
        script,
        `import {renameSync,symlinkSync} from 'node:fs';renameSync(${JSON.stringify(path)},${JSON.stringify(original)});symlinkSync(${JSON.stringify(victim)},${JSON.stringify(path)});process.argv[1]=${JSON.stringify(ledgerModule.pathname)};await import(${JSON.stringify(ledgerModule.href)});`,
      );
      await lockedTransaction(path, script, "reserve", {
        path,
        dataset: "legacy",
        caseId: "P01",
        model: "gpt-6.1-sol",
        maximum: 8,
        seconds: 900,
      });
      assert.equal(readFileSync(victim, "utf8"), "");
      assert.equal(
        JSON.parse(readFileSync(original, "utf8")).attempts.length,
        1,
      );
    } finally {
      restore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
