import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the temporary tunnel origin is loopback-only maintenance and never forwards app requests", async () => {
  const caddy = process.env.COA_CADDY_BIN ?? "caddy";
  const result = spawnSync(caddy, ["adapt", "--config", new URL("./Caddyfile.quick-tunnel", import.meta.url).pathname, "--adapter", "caddyfile"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.admin.disabled, true);
  assert(!JSON.stringify(config).includes("reverse_proxy"));
  assert(!JSON.stringify(config).includes("8766"));
  assert(!JSON.stringify(config).includes("proxy_protocol"));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  for (const server of Object.values(config.apps.http.servers) as { listen: string[]; automatic_https: { disable: boolean } }[]) {
    assert.deepEqual(server.listen, ["127.0.0.1:9899"]);
    assert.equal(server.automatic_https.disable, true);
    server.listen = [`127.0.0.1:${address.port}`];
  }
  const directory = await mkdtemp(join(tmpdir(), "coa-maintenance-"));
  const file = join(directory, "config.json");
  await writeFile(file, JSON.stringify(config));
  const child = spawn(caddy, ["run", "--config", file], { stdio: "ignore" });
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    for (let attempt = 0; ; attempt += 1) {
      try { await fetch(origin); break; }
      catch {
        assert.equal(child.exitCode, null, "Caddy exited before the maintenance listener became ready");
        assert(attempt < 100);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    for (const [method, path] of [["GET", "/"], ["GET", "/api/source"], ["POST", "/api/session"], ["POST", "/api/runs"]]) {
      const response = await fetch(origin + path, { method });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(await response.text(), /nog geen vragen verwerkt/);
    }
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await rm(directory, { recursive: true, force: true });
  }
});
