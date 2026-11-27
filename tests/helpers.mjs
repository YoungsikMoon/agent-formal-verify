// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Every test file imports this module, so each helper a test starts sees its own settings at their defaults
// unless the test sets them, whatever the developer's shell exports.
delete process.env.TLC_TIMEOUT;
delete process.env.TLC_WORKERS;
delete process.env.TLC_CACHE;
delete process.env.TLC_HTML_REPORT;
delete process.env.KANI_HARNESS_TIMEOUT;
delete process.env.FORMAL_MIN_FREE_GIB;

export const root = fileURLToPath(new URL("..", import.meta.url));
export const scripts = join(root, "skills/formal-verify/scripts");
export const logs = join(root, "tests/fixtures");
export const includes = (text, part) => assert.ok(text.includes(part), `${JSON.stringify(text)} lacks ${JSON.stringify(part)}`);
export const excludes = (text, part) => assert.ok(!text.includes(part), `${JSON.stringify(text)} has ${JSON.stringify(part)}`);

const fixtures = [];
export function removeFixtures() {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
}
// Leave a fixture in place after the test, for a failure that needs its files to diagnose.
export function keepFixture(dir) {
  fixtures.splice(fixtures.indexOf(dir) >>> 0, 1);
}
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "formal-tools-"));
  fixtures.push(dir);
  mkdirSync(join(dir, "bin"));
  return dir;
}
export function command(dir, name, body) {
  const path = join(dir, "bin", name);
  writeFileSync(path, "#!/bin/bash\n" + body + "\n");
  chmodSync(path, 0o755);
  return path;
}
export const KANI = "0.68.0";
export const TOOLCHAIN = "nightly-2026-08-21-aarch64-apple-darwin";
export const bundle = (dir) => join(dir, `kani/kani-${KANI}`);
export const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
export const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
// Behaves as the pinned kani-driver, configured by driver.json and report.json in the fixture directory.
export const DRIVER = readFileSync(join(logs, "kani-driver.py"), "utf8");
// Install a fake Kani bundle at dir/kani, for KANI_HOME, that driver.json in dir configures.
export function installKani(dir, config = {}) {
  for (const path of ["bin/kani-compiler", "bin/cbmc", "toolchain/bin/rustc", "toolchain/bin/cargo"]) {
    const file = join(bundle(dir), path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  for (const executable of ["bin/kani-driver", "toolchain/bin/cargo"]) {
    const path = join(bundle(dir), executable);
    writeFileSync(path, `#!${python}\n${DRIVER}`);
    chmodSync(path, 0o755);
  }
  writeFileSync(join(bundle(dir), "rust-toolchain-version"), `${TOOLCHAIN}\n`);
  writeJson(join(dir, "driver.json"), { version: KANI, harnesses: {}, ...config });
  return dir;
}
export function fakeTlc(dir, body) {
  return command(dir, "tlc-java", '[[ "$*" == *"-help"* ]] && exit 0\n[ "$1" = "-version" ] && exit 0\n' + body);
}
export const leanPin = "leanprover/lean4:v4.34.1";
// A fake elan line that lists the pin as installed, as the Lean checker asks before any elan run.
export const elanListsPin = `[ "$1 $2" = "toolchain list" ] && { echo "${leanPin} (default)"; exit 0; }`;
export function writeLeanProject(project) {
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "lakefile.toml"), 'name = "model"\n');
  writeFileSync(join(project, "lean-toolchain"), leanPin + "\n");
}
export function run(dir, script, args = [], extra = {}) {
  return spawnSync(script.endsWith(".py") ? "python3" : "bash", [join(scripts, script), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: join(dir, "bin") + ":" + process.env.PATH,
      JAVA: command(dir, "java", "exit 0"),
      TLC_JAR: "",
      TASK_TRACE: join(dir, "calls"),
      ...extra,
    },
  });
}

export function isStopped(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "ESRCH";
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterName = stat.slice(stat.lastIndexOf(") ") + 2);
    if (afterName.startsWith("Z")) return true;
  } catch {
    // Non-Linux hosts have no /proc/<pid>/stat; fall back to ps below.
  }
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return !ps.error && ps.status === 0 && (ps.stdout.trim() === "" || ps.stdout.trim().startsWith("Z"));
}

export function processesWhere(match) {
  const listing = spawnSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8" }).stdout;
  return listing.split("\n").map((line) => line.trim().split(/\s+/)).filter(([pid, ...command]) => pid && match(command.join(" "))).map(([pid]) => Number(pid));
}

export function waitFor(condition) {
  const deadline = Date.now() + 1000;
  while (!condition() && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return condition();
}

export function assertProcessStopped(pid) {
  const deadline = Date.now() + 1000;
  while (!isStopped(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.ok(isStopped(pid), `expected child process ${pid} to stop`);
}
