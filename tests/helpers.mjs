// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const scripts = join(root, "skills/formal-verify/scripts");
export const logs = join(root, "tests/fixtures");
export const includes = (text, part) => assert.ok(text.includes(part), `${JSON.stringify(text)} lacks ${JSON.stringify(part)}`);
export const excludes = (text, part) => assert.ok(!text.includes(part), `${JSON.stringify(text)} has ${JSON.stringify(part)}`);

const fixtures = [];
export function removeFixtures() {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
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
export function fakeTlc(dir, body) {
  return command(dir, "tlc-java", '[[ "$*" == *"-help"* ]] && exit 0\n[ "$1" = "-version" ] && exit 0\n' + body);
}
export const leanPin = "leanprover/lean4:v4.34.1";
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
