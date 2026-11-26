import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("packaged Linux runtime warms MiniLM and requires an explicit spending policy", { timeout: 300_000 }, async () => {
  assert(process.env.COA_RELEASE_DIR, "Set COA_RELEASE_DIR to the freshly packaged Linux release");
  const release = resolve(process.env.COA_RELEASE_DIR);
  const binary = join(release, "bin/meedoen-retrieval");
  const directory = await mkdtemp(join(tmpdir(), "coa-linux-release-"));
  await chmod(directory, 0o700);
  await mkdir(join(directory, "budget"), { mode: 0o700 });
  const budget = join(directory, "budget/attempts.json");
  const key = join(directory, "openai-api-key");
  await writeFile(key, "sk-coa-release-smoke-not-a-real-api-key", { mode: 0o600 });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(COA_|OPENAI_)/.test(name)));
  Object.assign(environment, {
    LD_LIBRARY_PATH: join(release, "lib"),
    COA_OPENAI_API_KEY_FILE: key, COA_DEMO_BUDGET_FILE: budget,
    COA_BUNDLED_EVALUATIONS: "1", COA_BENCHMARK_DIR: join(directory, "benchmarks"),
  });
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  environment.COA_PORT = String(port);
  async function source(env = environment) {
    const child = spawn(binary, ["serve"], { cwd: directory, env, stdio: "ignore" });
    try {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        assert.equal(child.exitCode, null, "packaged runtime exited during warmup");
        const response = await fetch(`http://127.0.0.1:${port}/api/source`).catch(() => undefined);
        if (response?.ok) {
          const archive = await fetch(`http://127.0.0.1:${port}/api/evals/rag`, { method: "HEAD" });
          assert.equal(archive.status, 200);
          assert.equal(archive.headers.get("cache-control"), "public, max-age=300");
          return await response.json() as { runtime_ready: boolean; sources: unknown[]; as_of: string; model_configuration: Record<string, unknown> };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail("packaged MiniLM warmup exceeded two minutes");
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null) await once(child, "exit");
    }
  }
  try {
    const unavailable = await source();
    assert.equal(unavailable.sources.length, 12);
    assert.equal(unavailable.runtime_ready, false, "an absent budget must disable paid requests");
    const initialization = spawnSync(binary, ["demo-budget", "init", budget, "--max-attempts", "1"], { cwd: directory, env: environment, encoding: "utf8" });
    assert.equal(initialization.status, 0, "test-only quota initialization must work");
    const original = await readFile(budget);
    assert.equal(JSON.parse(original.toString()).schema_version, 2, "the release must require the input-bound policy");
    const repeated = spawnSync(binary, ["demo-budget", "init", budget, "--max-attempts", "2"], { cwd: directory, env: environment, encoding: "utf8" });
    assert.notEqual(repeated.status, 0, "reinitialization must not reset the cap");
    assert.deepEqual(await readFile(budget), original);
    const available = await source();
    assert.equal(available.runtime_ready, true, "a valid budget enables the configured service");
    assert.equal(available.model_configuration.budget_policy_version, 2);
    assert.equal(available.model_configuration.max_input_tokens_per_request, 300000);
    assert.equal(available.model_configuration.max_input_token_preflights, 5);
    assert.equal(available.model_configuration.max_provider_requests, 5);
    assert.equal(available.model_configuration.max_output_tokens_per_request, 4096);
    assert.deepEqual(await readFile(budget), original, "starting the service cannot spend or reset a reservation");
    const project = { ...environment, COA_OPENAI_ENFORCED_PROJECT_ID: "proj_test_only" };
    assert.equal((await source(project)).runtime_ready, false, "dual spend policies must fail closed");
    const projectOnly: NodeJS.ProcessEnv = { ...project };
    delete projectOnly.COA_DEMO_BUDGET_FILE;
    const provider = await source(projectOnly);
    assert.equal(provider.runtime_ready, true, "an explicit project policy can replace the active ledger");
    assert.equal(provider.model_configuration.spend_control, "openai_project");
    assert.equal(provider.model_configuration.budget_policy_version, 2);
    assert(!JSON.stringify(provider.model_configuration).includes(project.COA_OPENAI_ENFORCED_PROJECT_ID));
    const missingKey = { ...projectOnly };
    delete missingKey.COA_OPENAI_API_KEY_FILE;
    assert.equal((await source(missingKey)).runtime_ready, false, "project mode must require a private key file");
    const invalid = { ...projectOnly, COA_OPENAI_ENFORCED_PROJECT_ID: "bad-project" };
    assert.equal((await source(invalid)).runtime_ready, false, "bad project IDs must fail closed");
    const inherited = { ...projectOnly, OPENAI_API_KEY: "sk-another-project-test-key" };
    assert.equal((await source(inherited)).runtime_ready, false, "an inherited key must not override the project key file");
    assert.deepEqual(await readFile(budget), original, "selecting the project policy preserves the audit ledger");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
