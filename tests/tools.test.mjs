// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { command, excludes, fixture, includes, leanPin, removeFixtures, run, scripts } from "./helpers.mjs";

afterEach(removeFixtures);

test("missing runtimes and hash tools are unavailable with their remedies", () => {
  const dir = fixture();
  const jar = join(dir, "tools.jar");
  writeFileSync(jar, "jar");
  writeFileSync(join(dir, "lean-toolchain"), leanPin + "\n");
  const java = command(dir, "java", "exit 0");
  const cases = [
    ["tlc-tools.sh", "require_tlc_runtime", { JAVA: "/absent/java" }, "install a JDK"],
    ["tlc-tools.sh", "require_tlc_runtime", { JAVA: java }, "install Python 3"],
    ["tlc-tools.sh", 'check_tlc_jar "$TASK_JAR"', { TASK_JAR: jar }, "install sha256sum or shasum"],
    ["lean-tools.sh", 'lean_pin "$TASK_PROJECT"', { TASK_PROJECT: dir }, "install elan"],
  ];
  for (const [script, call, extra, remedy] of cases) {
    const result = spawnSync("/bin/bash", ["-c", 'source "$1"; ' + call, "bash", join(scripts, script)], {
      encoding: "utf8", env: { ...process.env, PATH: join(dir, "bin"), ...extra },
    });
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.ok(result.stdout.startsWith("UNAVAILABLE "), result.stdout);
    includes(result.stdout, remedy);
    excludes(result.stdout, "PASS");
    excludes(result.stdout, "SUMMARY");
  }
});

test("helper usage errors exit 2", () => {
  const dir = fixture();
  for (const [script, args] of [["lean-check.sh", []], ["tlc-matrix.sh", []], ["mutate.py", []], ["setup.sh", ["lean"]]]) {
    assert.equal(run(dir, script, args).status, 2, script);
  }
});
