import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const caddy = process.env.COA_CADDY_BIN ?? "caddy";
const template = new URL("./Caddyfile", import.meta.url);

test("public proxy requires an explicitly configured hostname", async () => {
  await readFile(template, "utf8");
  const result = spawnSync(caddy, ["adapt", "--config", template.pathname, "--adapter", "caddyfile"], {
    env: { ...process.env, COA_PUBLIC_HOST: "" }, encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, "an empty hostname must not create a catch-all site");
});

test("a public IP uses the public ACME short-lived profile rather than an internal certificate", async () => {
  const result = spawnSync(caddy, ["adapt", "--config", template.pathname, "--adapter", "caddyfile"], {
    env: { ...process.env, COA_PUBLIC_HOST: "198.51.100.10" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const policies = JSON.parse(result.stdout).apps.tls.automation.policies;
  const policy = policies.find((value: { subjects: string[] }) => value.subjects?.includes("198.51.100.10"));
  assert(policy, "the IP needs an explicit certificate policy");
  assert.deepEqual(policy.issuers, [{ module: "acme", ca: "https://acme-v02.api.letsencrypt.org/directory", profile: "shortlived" }]);
});

const profiles: { name: string; file: URL; visitorIp: string; edgeHeaders: Record<string, string> }[] = [
  { name: "public IP", file: template, visitorIp: "127.0.0.1", edgeHeaders: {} },
  { name: "QuickTunnel app", file: new URL("./Caddyfile.quick-tunnel.app", import.meta.url), visitorIp: "203.0.113.42", edgeHeaders: { "CF-Connecting-IP": "203.0.113.42" } },
];
for (const profile of profiles) {
test(`${profile.name} proxy allows only public routes, replaces visitor headers and redacts error requests`, async () => {
  const result = spawnSync(caddy, ["adapt", "--config", profile.file.pathname, "--adapter", "caddyfile"], {
    env: { ...process.env, COA_PUBLIC_HOST: "127.0.0.1" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const adapted = JSON.parse(result.stdout);
  const directory = await mkdtemp(join(tmpdir(), "coa-proxy-contract-"));
  const requests: { path: string; method: string; headers: Record<string, unknown> }[] = [];
  const backend = createServer((request, response) => {
    const entry = { path: request.url!, method: request.method!, headers: request.headers };
    requests.push(entry);
    if (request.url === "/api/source?failure=1") {
      request.socket.destroy();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(entry));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const backendAddress = backend.address();
  assert(backendAddress && typeof backendAddress === "object");
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const proxyAddress = portProbe.address();
  assert(proxyAddress && typeof proxyAddress === "object");
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const origin = `http://127.0.0.1:${proxyAddress.port}`;
  // Exercise the production routes over an ephemeral loopback HTTP listener.
  // Certificate policy is checked above; this test must never issue a certificate.
  for (const server of Object.values(adapted.apps.http.servers) as { listen: string[]; automatic_https?: unknown; tls_connection_policies?: unknown }[]) {
    server.listen = [`127.0.0.1:${proxyAddress.port}`];
    server.automatic_https = { disable: true };
    delete server.tls_connection_policies;
  }
  delete adapted.apps.tls;
  adapted.admin = { disabled: true };
  const config = join(directory, "config.json");
  await writeFile(config, JSON.stringify(adapted).replaceAll("127.0.0.1:8766", `127.0.0.1:${backendAddress.port}`));
  const proxy = spawn(caddy, ["run", "--config", config], {
    env: { ...process.env, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostic = "";
  proxy.stderr.on("data", (chunk: Buffer) => { diagnostic += chunk.toString(); });
  try {
    for (let attempt = 0; ; attempt += 1) {
      try { await fetch(`${origin}/api/source`, { headers: profile.edgeHeaders }); break; }
      catch {
        assert.equal(proxy.exitCode, null, diagnostic);
        assert(attempt < 100, `proxy did not start: ${diagnostic}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    for (const path of ["/", "/demo", "/demo/", "/techniek/", "/resultaten/", "/assets/site.css", "/api/source", "/api/session", "/api/runs/r-123-1", "/api/evals/rag", "/api/evals/rag/catalog"]) {
      assert.equal((await fetch(origin + path, { headers: profile.edgeHeaders })).status, 200, path);
    }
    for (const path of ["/api/session", "/api/runs"]) {
      assert.equal((await fetch(origin + path, { method: "POST", body: "{}", headers: profile.edgeHeaders })).status, 200, path);
    }
    const protectedPaths = ["/api/evals/rag/runs", "/api/evals/rag/runs/eval-123", "/api/runs/r-123-1/replay", "/api/runs/r-123-1/judgement", "/api/runs/r-123-1/criteria", "/api/runs/r-123-1/diagnosis", "/api/report", "/api/questions", "/.env", "/Cargo.toml"];
    const beforeDenied = requests.length;
    for (const path of protectedPaths) {
      for (const method of ["GET", "POST", "DELETE"]) {
        assert.equal((await fetch(origin + path, { method })).status, 404, `${method} ${path}`);
      }
    }
    assert.equal(requests.length, beforeDenied, "denied requests must not reach the app");
    const response = await fetch(`${origin}/api/session`, {
      method: "POST", body: "{}",
      headers: { ...profile.edgeHeaders, "X-Real-IP": "198.51.100.99", "X-Forwarded-For": "198.51.100.88" },
    });
    const forwarded = await response.json() as { headers: Record<string, string> };
    assert.equal(forwarded.headers["x-real-ip"], profile.visitorIp);
    assert(!forwarded.headers["x-forwarded-for"]?.includes("198.51.100.88"));
    const privateSession = "synthetic-session-never-log-7fd9";
    const failed = await fetch(`${origin}/api/source?failure=1`, { headers: { ...profile.edgeHeaders, "X-Test-Session": privateSession } });
    assert.equal(failed.status, 502);
    for (let attempt = 0; attempt < 100 && !diagnostic.includes('"status":502'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(diagnostic, /"status":502/, "upstream errors must retain operational diagnostics");
    assert(!diagnostic.includes(privateSession), "proxy error logs must not disclose the session bearer token");
  } finally {
    proxy.kill("SIGTERM");
    if (proxy.exitCode === null) await once(proxy, "exit");
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
}
