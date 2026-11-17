import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDependencies } from "./package-release.ts";

test("Linux dependency inventory distinguishes distro libraries from runtime libraries to bundle", () => {
  assert.deepEqual(parseDependencies(`
    linux-vdso.so.1 (0x00007ffc)
    libssl.so.3 => /lib/x86_64-linux-gnu/libssl.so.3 (0x00007f01)
    libonnxruntime.so.1 => /build/ort/lib/libonnxruntime.so.1 (0x00007f02)
    /lib64/ld-linux-x86-64.so.2 (0x00007f03)
  `), [
    { name: "libssl.so.3", path: "/lib/x86_64-linux-gnu/libssl.so.3", bundled: false },
    { name: "libonnxruntime.so.1", path: "/build/ort/lib/libonnxruntime.so.1", bundled: true },
  ]);
});

test("an unresolved runtime library stops packaging instead of creating a broken release", () => {
  assert.throws(() => parseDependencies("libonnxruntime.so.1 => not found"), /Unresolved runtime dependency/);
});
