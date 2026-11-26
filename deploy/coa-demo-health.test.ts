import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./coa-demo-health.sh", import.meta.url));
const app = "coa-demo.service";
const proxy = "caddy.service";
const tunnel = "coa-demo-named-tunnel.service";

function watchdog(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "coa-demo-health-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = join(directory, "state");
  const restarts = join(directory, "restarts");
  mkdirSync(state);
  writeFileSync(restarts, "");
  writeFileSync(join(directory, "curl"), [
    "#!/bin/bash",
    'for arg; do url=$arg; done',
    'case "$url" in',
    '  http://127.0.0.1:8766/api/source) result=$APP_RESULT ;;',
    '  http://127.0.0.1:9899/__coa_health) result=$PROXY_RESULT ;;',
    '  http://127.0.0.1:20243/ready) result=$TUNNEL_RESULT ;;',
    '  https://coa-assistent.app/api/source) result=$PUBLIC_RESULT ;;',
    '  *) exit 99 ;;',
    'esac',
    'if [[ "$result" == timeout ]]; then exit 28; fi',
    'printf "%s" "$result"',
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(directory, "systemctl"), [
    "#!/bin/bash",
    'if [[ "$1" == --no-block && "$2" == --job-mode=fail && "$3" == try-restart ]]; then',
    '  printf "%s\\n" "$4" >> "$RESTARTS"',
    '  exit',
    'fi',
    'for unit; do :; done',
    'if [[ "$1" == is-active ]]; then',
    '  [[ "$unit" != "$STOPPED_UNIT" ]]',
    '  exit',
    'fi',
    'if [[ "$1" != show ]]; then exit 99; fi',
    'if [[ "$unit" == "$CHANGING_UNIT" && -f "$METADATA_CALL" ]]; then',
    '  printf "%032d\\n" 2',
    'else',
    '  if [[ "$unit" == "$CHANGING_UNIT" ]]; then touch "$METADATA_CALL"; fi',
    '  printf "%032d\\n" "$INVOCATION_NUMBER"',
    'fi',
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(directory, "date"), '#!/bin/bash\nprintf "%s\\n" "$NOW"\n', { mode: 0o700 });
  let now = 1800000000;
  return {
    check(env: NodeJS.ProcessEnv = {}, elapsed = 60) {
      now += elapsed;
      const result = spawnSync("bash", [script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: directory + ":" + process.env.PATH,
          STATE_DIRECTORY: state,
          RESTARTS: restarts,
          METADATA_CALL: join(directory, "metadata-called"),
          NOW: String(now),
          APP_RESULT: "200",
          PROXY_RESULT: "404",
          TUNNEL_RESULT: "200",
          PUBLIC_RESULT: "200",
          STOPPED_UNIT: "",
          CHANGING_UNIT: "",
          INVOCATION_NUMBER: "1",
          ...env,
        },
      });
      assert.equal(result.status, 0, "Expected health check to run successfully. " + result.stderr);
      return result.stderr;
    },
    restarts() {
      return readFileSync(restarts, "utf8").trim().split("\n").filter(Boolean);
    },
  };
}

test("only the stuck app is restarted after three consecutive failures", (t) => {
  const watch = watchdog(t);
  watch.check({ APP_RESULT: "timeout" });
  watch.check({ APP_RESULT: "timeout" });
  assert.deepEqual(watch.restarts(), []);
  watch.check({ APP_RESULT: "timeout" });
  assert.deepEqual(watch.restarts(), [app]);
});

test("three Caddy transport failures restart only Caddy", (t) => {
  const watch = watchdog(t);
  for (let i = 0; i < 3; i++) watch.check({ PROXY_RESULT: "timeout" });
  assert.deepEqual(watch.restarts(), [proxy]);
});

test("a successful tunnel probe resets consecutive failures", (t) => {
  const watch = watchdog(t);
  watch.check({ TUNNEL_RESULT: "503" });
  watch.check({ TUNNEL_RESULT: "503" });
  watch.check();
  watch.check({ TUNNEL_RESULT: "503" });
  watch.check({ TUNNEL_RESULT: "503" });
  assert.deepEqual(watch.restarts(), []);
  watch.check({ TUNNEL_RESULT: "503" });
  assert.deepEqual(watch.restarts(), [tunnel]);
});

test("tunnel restart cooldown survives a new service invocation", (t) => {
  const watch = watchdog(t);
  for (let i = 0; i < 3; i++) watch.check({ TUNNEL_RESULT: "503" });
  for (let i = 0; i < 3; i++) watch.check({ TUNNEL_RESULT: "503", INVOCATION_NUMBER: "2" });
  assert.deepEqual(watch.restarts(), [tunnel]);
  watch.check({ TUNNEL_RESULT: "503", INVOCATION_NUMBER: "2" }, 719);
  assert.deepEqual(watch.restarts(), [tunnel]);
  watch.check({ TUNNEL_RESULT: "503", INVOCATION_NUMBER: "2" }, 1);
  assert.deepEqual(watch.restarts(), [tunnel, tunnel]);
});

test("failures from different invocations do not add up", (t) => {
  const watch = watchdog(t);
  watch.check({ APP_RESULT: "timeout" });
  watch.check({ APP_RESULT: "timeout" });
  watch.check({ APP_RESULT: "timeout", INVOCATION_NUMBER: "2" });
  watch.check({ APP_RESULT: "timeout", INVOCATION_NUMBER: "2" });
  assert.deepEqual(watch.restarts(), []);
});

test("an invocation change between probing and recovery cancels the restart", (t) => {
  const watch = watchdog(t);
  watch.check({ APP_RESULT: "timeout" });
  watch.check({ APP_RESULT: "timeout" });
  watch.check({ APP_RESULT: "timeout", CHANGING_UNIT: app });
  assert.deepEqual(watch.restarts(), []);
});

test("intentional stop and a maintenance HTTP response leave units alone", (t) => {
  const watch = watchdog(t);
  for (let i = 0; i < 3; i++) {
    watch.check({ STOPPED_UNIT: app, APP_RESULT: "timeout", PROXY_RESULT: "503" });
  }
  assert.deepEqual(watch.restarts(), []);
});

test("a public-only failure is logged without a service restart", (t) => {
  const watch = watchdog(t);
  for (let i = 0; i < 3; i++) {
    assert.match(watch.check({ PUBLIC_RESULT: "503" }), /public HTTPS probe failed/i);
  }
  assert.deepEqual(watch.restarts(), []);
});

test("recovery does not start dependencies that an operator stopped", (t) => {
  const watch = watchdog(t);
  for (let i = 0; i < 3; i++) {
    watch.check({ STOPPED_UNIT: app, PROXY_RESULT: "timeout", TUNNEL_RESULT: "503" });
  }
  assert.deepEqual(watch.restarts(), []);
  for (let i = 0; i < 3; i++) {
    watch.check({ STOPPED_UNIT: proxy, TUNNEL_RESULT: "503" });
  }
  assert.deepEqual(watch.restarts(), []);
});
