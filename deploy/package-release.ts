import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, openSync, closeSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Dependency = { name: string; path: string; bundled: boolean };

export function parseDependencies(output: string): Dependency[] {
  const libraries: Dependency[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes("=>")) continue;
    const match = /^\s*([\w.+-]+)\s+=>\s+(\/\S+)\s+\(/.exec(line);
    if (!match) throw new Error("Unresolved runtime dependency; package only a working Linux binary.");
    const [, name, path] = match;
    libraries.push({ name, path, bundled: !/^\/(usr\/)?lib(64)?\//.test(path) });
  }
  return libraries;
}

function command(binary: string, args: string[]): string {
  return execFileSync(binary, args, { encoding: "utf8", maxBuffer: 1024 * 1024 }).trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packageRelease(binary: string, output: string): void {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Build and package on Ubuntu 24.04 x86_64; a macOS binary cannot be deployed.");
  }
  if (command("git", ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("Package an unchanged checkout so the source commit identifies every release file.");
  }
  const descriptor = openSync(binary, "r");
  const header = Buffer.alloc(20);
  try { readSync(descriptor, header, 0, header.length, 0); } finally { closeSync(descriptor); }
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) {
    throw new Error("Release binary must be a Linux x86_64 ELF executable.");
  }
  const dependencies = parseDependencies(command("ldd", [binary]));
  const sourceSha = command("git", ["rev-parse", "HEAD"]);
  mkdirSync(output);
  try {
    mkdirSync(join(output, "bin"));
    mkdirSync(join(output, "lib"));
    mkdirSync(join(output, "config"));
    const files: { path: string; sha256: string }[] = [];
    const copy = (source: string, path: string, mode: number) => {
      const destination = join(output, path);
      copyFileSync(source, destination);
      chmodSync(destination, mode);
      files.push({ path, sha256: sha256(destination) });
    };
    copy(binary, "bin/meedoen-retrieval", 0o755);
    for (const library of dependencies.filter((entry) => entry.bundled)) {
      copy(library.path, `lib/${library.name}`, 0o644);
    }
    for (const name of ["Caddyfile", "Caddyfile.quick-tunnel", "Caddyfile.quick-tunnel.app", "coa-demo.service", "coa-demo-tunnel.service", "caddy-override.conf", "public.env.example"]) {
      copy(join("deploy", name), `config/${name}`, 0o644);
    }
    copy("docs/public-deployment.md", "DEPLOYMENT.md", 0o644);
    const manifest = {
      schema_version: 1, source_sha: sourceSha,
      target: "x86_64-unknown-linux-gnu", build_platform: "ubuntu-24.04",
      rust_version: command("rustc", ["--version"]), cargo_lock_sha256: sha256("Cargo.lock"),
      runtime_dependencies: dependencies.map(({ name, bundled }) => ({ name, bundled })), files,
    };
    writeFileSync(join(output, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    files.push({ path: "release.json", sha256: sha256(join(output, "release.json")) });
    writeFileSync(join(output, "SHA256SUMS"), files.map((file) => `${file.sha256}  ${file.path}\n`).join(""));
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  try {
    const [, , binary, output, ...extra] = process.argv;
    if (!binary || !output || extra.length) throw new Error("Usage: node deploy/package-release.ts BINARY NEW_OUTPUT_DIRECTORY");
    packageRelease(resolve(binary), resolve(output));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release packaging failed.");
    process.exitCode = 1;
  }
}
