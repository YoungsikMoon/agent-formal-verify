// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { command, excludes, fixture, includes, leanPin, logs, removeFixtures, run, writeLeanProject } from "./helpers.mjs";

afterEach(removeFixtures);

test("Lean verification refuses an unprepared toolchain without requesting installation", () => {
  const dir = fixture();
  const project = join(dir, "model");
  writeLeanProject(project);
  command(dir, "elan", 'printf "%s\\n" "$@" >> "$TASK_TRACE"; exit 1');
  const result = run(dir, "lean-check.sh", [project]);
  assert.equal(result.status, 3);
  includes(result.stdout, "UNAVAILABLE ");
  includes(result.stdout, "setup.sh lean");
  const args = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  assert.deepEqual(args, ["run", leanPin, "lake", "--version"]);
});

test("Lean preparation reuses ready pins and installs a changed repository pin once", () => {
  const dir = fixture();
  const project = join(dir, "model with spaces");
  const installed = join(dir, "installed");
  const oldPin = "leanprover/lean4:v4.34.0";
  const newPin = leanPin;
  mkdirSync(project);
  writeFileSync(join(project, "lean-toolchain"), oldPin + "\n");
  writeFileSync(installed, oldPin + "\n");
  command(dir, "elan", [
    'printf "%s\\n" "$*" >> "$TASK_TRACE"',
    'case "$1 $2" in',
    '  "toolchain install") printf "%s\\n" "$3" >> "$TASK_INSTALLED" ;;',
    '  *) grep -Fxq "$2" "$TASK_INSTALLED" ;;',
    'esac',
  ].join("\n"));
  const extra = { TASK_INSTALLED: installed };
  assert.equal(run(dir, "setup.sh", ["lean", project], extra).status, 0);
  writeFileSync(join(project, "lean-toolchain"), newPin + "\n");
  const prepared = run(dir, "setup.sh", ["lean", project], extra);
  assert.equal(prepared.status, 0);
  includes(prepared.stdout, "READY Lean " + newPin);
  assert.equal(run(dir, "setup.sh", ["lean", project], extra).status, 0);
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  assert.deepEqual(calls.filter((line) => line.startsWith("toolchain install")), [
    "toolchain install " + newPin,
  ]);
});

test("Lean preparation reports failure when installation does not produce a working toolchain", () => {
  const dir = fixture();
  const project = join(dir, "model");
  writeLeanProject(project);
  command(dir, "elan", 'if [ "$1" = "toolchain" ]; then exit 0; fi; exit 1');
  const result = run(dir, "setup.sh", ["lean", project]);
  assert.equal(result.status, 3);
  excludes(result.stdout, "READY");
  includes(result.stdout, `UNAVAILABLE ${leanPin} does not run after installation`);
});

const audited = "AUDITED 37 declarations";

function leanFixture(log, { status = 0, audit = audited, files = [] } = {}) {
  const dir = fixture();
  const project = join(realpathSync(dir), "model");
  writeLeanProject(project);
  const lib = ".lake/build/lib/lean";
  for (const file of ["Model.lean", "Model/Sub.lean", `${lib}/Model.olean`, `${lib}/Model/Sub.olean`, `${lib}/Ghost.olean`, ".lake/packages/dep/Dep.lean"]) {
    mkdirSync(join(project, file, ".."), { recursive: true });
    writeFileSync(join(project, file), "");
  }
  command(dir, "elan", [
    '[ "$4" = "--version" ] && exit 0',
    'if [ "$6" = "env" ]; then echo audit >> "$TASK_TRACE"; grep "^import" "$8"; printf "%s\\n" "$TASK_AUDIT"; exit 0; fi',
    'shift 6; printf "%s\\n" "$@" > "$TASK_BUILT"',
    `[ ${status} -ne 0 ] || for target; do target=\${target#"$TASK_PROJECT/"}; echo "/physical/.lake/build/lib/lean/\${target%.lean:olean}.olean"; done`,
    `cat "${join(logs, log)}" >&2; exit ${status}`,
  ].join("\n"));
  const check = (args = files, output = audit) => run(dir, "lean-check.sh", [project, ...args], { TASK_AUDIT: output, TASK_BUILT: join(dir, "built"), TASK_PROJECT: project });
  return { dir, project, check, result: check() };
}

test("the Lean checker prints multi-line search output whole and ignores error text in output", () => {
  const { result } = leanFixture("lake-search.log");
  assert.equal(result.status, 0);
  includes(result.stdout, " ({ next := 3, consumed := 1 }, { next := 4, consumed := 1 })]\n");
  includes(result.stdout, "/model: 37 declarations checked, no unfinished proof (sorry), no added axiom\n");
});

test("the Lean checker fails a build that uses sorry", () => {
  const { result } = leanFixture("lake-sorry.log");
  assert.equal(result.status, 1);
  includes(result.stdout, "1 unfinished proofs (sorry)");
  includes(result.stdout, "warning: Model.lean:69:8: declaration uses `sorry`");
});

test("the Lean checker fails a declaration that the audit finds resting on a declared axiom", () => {
  const { result } = leanFixture("lake-search.log", { audit: "AXIOMS 'bogus' depends on axioms: #[cheat]\n" + audited });
  assert.equal(result.status, 1);
  includes(result.stdout, "1 declarations on an added axiom");
  includes(result.stdout, "AXIOMS 'bogus' depends on axioms: #[cheat]\n");
});

test("the Lean checker fails when the audit reports no declarations", () => {
  for (const audit of ["error: unknown constant", "AUDITED 0 declarations"]) {
    const { result } = leanFixture("lake-search.log", { audit });
    assert.equal(result.status, 1);
    includes(result.stdout, "the axiom audit did not run or found no declarations:\nimport Lean\nimport Model\nimport Model.Sub\n" + audit);
  }
});

test("the Lean checker builds every project source by path and audits only the modules Lake reports for them", () => {
  const { dir, project, result } = leanFixture("lake-search.log", { audit: "AUDITED 0 declarations" });
  assert.equal(readFileSync(join(dir, "built"), "utf8"), `${project}/Model.lean:olean\n${project}/Model/Sub.lean:olean\n`);
  includes(result.stdout, "import Lean\nimport Model\nimport Model.Sub\nAUDITED 0");
});

test("the Lean checker explains a source file that no library owns, without auditing", () => {
  const { dir, result } = leanFixture("lake-unowned.log", { status: 1 });
  assert.equal(result.status, 1);
  includes(result.stdout, "error: unknown module source path `/model/Scratch/Model.lean`\nno library owns that file");
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("the Lean checker names the minimum Lean version when the pin's Lake has no path targets", () => {
  for (const log of ["lake-no-query.log", "lake-no-path-target.log"]) {
    const { result } = leanFixture(log, { status: 1 });
    assert.equal(result.status, 1);
    includes(result.stdout, `${leanPin} cannot build a module by its source path; pin Lean 4.20.0 or later\n`);
  }
});

test("the Lean checker names a module path outside Lake's build layout instead of auditing it", () => {
  const dir = fixture();
  const project = join(dir, "model");
  writeLeanProject(project);
  writeFileSync(join(project, "Model.lean"), "");
  command(dir, "elan", [
    '[ "$4" = "--version" ] && exit 0',
    '[ "$6" = "query" ] && { echo "/elsewhere/out/Model.olean"; exit 0; }',
    'echo audit >> "$TASK_TRACE"; exit 1',
  ].join("\n"));
  const result = run(dir, "lean-check.sh", [project]);
  assert.equal(result.status, 1);
  includes(result.stdout, "cannot identify the module of /elsewhere/out/Model.olean");
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("the Lean checker fails when Lake fails, without auditing", () => {
  const { dir, result } = leanFixture("lake-search.log", { status: 1 });
  assert.equal(result.status, 1);
  includes(result.stdout, "lake exit 1");
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("the Lean checker builds and audits only the files it is given, and says so", () => {
  const { dir, project, result } = leanFixture("lake-search.log", { files: ["Model/Sub.lean"] });
  assert.equal(result.status, 0);
  assert.equal(readFileSync(join(dir, "built"), "utf8"), `${project}/Model/Sub.lean:olean\n`);
  includes(result.stdout, `PASS ${project} (Model/Sub.lean only): 37 declarations checked`);
  const missing = leanFixture("lake-search.log", { files: ["Model/Gone.lean"] });
  assert.equal(missing.result.stdout, `FAIL ${missing.project}/Model/Gone.lean does not exist\n`);
});

const statement = (name, kind = "theorem", typeExpr = "type", valueExpr = null, module = "Model") =>
  "STATEMENT " + JSON.stringify({ module, name, kind, typeExpr, valueExpr, type: typeExpr });

const statementAudit = (...records) => [...records, audited].join("\n");

test("the Lean checker freezes unfinished statements deterministically without claiming a proof pass", () => {
  const audit = statementAudit(statement("later"), statement("earlier", "definition", "Nat", "one"));
  const { project, check } = leanFixture("lake-sorry.log", { audit });
  const first = check(["--freeze", "Model.lean"]);
  assert.equal(first.status, 0, first.stdout);
  includes(first.stdout, "FROZEN ");
  excludes(first.stdout, "PASS ");
  const path = join(project, "Model.statements");
  const frozen = readFileSync(path, "utf8");
  assert.equal(JSON.parse(frozen).toolchain, leanPin);
  assert.deepEqual(JSON.parse(frozen).declarations.map((d) => d.name), ["earlier", "later"]);
  assert.equal(check(["--freeze", "Model.lean"]).status, 0);
  assert.equal(readFileSync(path, "utf8"), frozen);
  assert.equal(existsSync(join(project, "Model/Sub.statements")), false);
  assert.equal(check(["Model.lean"]).status, 1);
});

for (const [label, changed] of [
  ["theorem type", statementAudit(statement("property", "theorem", "weaker"), statement("step", "definition", "Nat", "one"))],
  ["definition value", statementAudit(statement("property"), statement("step", "definition", "Nat", "two"))],
  ["deleted declaration", statementAudit(statement("step", "definition", "Nat", "one"))],
]) {
  test(`the Lean checker rejects a frozen ${label} change and allows it after explicit re-freeze`, () => {
    const audit = statementAudit(statement("property"), statement("step", "definition", "Nat", "one"));
    const { check } = leanFixture("lake-search.log", { audit });
    assert.equal(check(["--freeze", "Model.lean"]).status, 0);
    const result = check(["Model.lean"], changed);
    assert.equal(result.status, 1, result.stdout);
    includes(result.stdout, "FROZEN ");
    includes(result.stdout, "statement changed");
    excludes(result.stdout, "PASS ");
    assert.equal(check(["--freeze", "Model.lean"], changed).status, 0);
    assert.equal(check(["Model.lean"], changed).status, 0);
  });
}

test("the Lean checker allows added declarations and checks only selected frozen modules", () => {
  const audit = statementAudit(statement("property"), statement("other", "theorem", "type", null, "Model.Sub"));
  const { check, project } = leanFixture("lake-search.log", { audit });
  assert.equal(check(["--freeze"]).status, 0);
  assert.ok(existsSync(join(project, "Model/Sub.statements")));
  assert.equal(check(["Model.lean"], statementAudit(statement("property"), statement("newLemma"))).status, 0);
  const result = check([], statementAudit(statement("property"), statement("other", "theorem", "changed", null, "Model.Sub")));
  assert.equal(result.status, 1);
  includes(result.stdout, "FROZEN other: statement changed");
});

test("the Lean checker names every frozen declaration when a model becomes empty", () => {
  const { check } = leanFixture("lake-search.log", { audit: statementAudit(statement("property")) });
  assert.equal(check(["--freeze", "Model.lean"]).status, 0);
  const result = check(["Model.lean"], "AUDITED 0 declarations");
  assert.equal(result.status, 1);
  includes(result.stdout, "FROZEN property: statement changed");
  includes(result.stdout, "(deleted)");
});

test("freezing rejects ambiguous private identities without replacing any source's record", () => {
  const audit = statementAudit(statement("property"), statement("other", "theorem", "type", null, "Model.Sub"));
  const { check, project } = leanFixture("lake-search.log", { audit });
  assert.equal(check(["--freeze"]).status, 0);
  const path = join(project, "Model.statements");
  const original = readFileSync(path, "utf8");
  const ambiguous = statementAudit(statement("property", "theorem", "changed"), statement("other", "theorem", "type", null, "Model.Sub"), statement("other", "theorem", "duplicate", null, "Model.Sub"));
  const result = check(["--freeze"], ambiguous);
  assert.equal(result.status, 1);
  includes(result.stdout, "ambiguous declaration identity other in Model.Sub");
  assert.equal(readFileSync(path, "utf8"), original);
});

test("the Lean checker detects a deleted frozen source in project scope but leaves named scope independent", () => {
  const audit = statementAudit(statement("property"), statement("other", "theorem", "type", null, "Model.Sub"));
  const { check, project } = leanFixture("lake-search.log", { audit });
  assert.equal(check(["--freeze"]).status, 0);
  rmSync(join(project, "Model/Sub.lean"));
  const result = check();
  assert.equal(result.status, 1);
  includes(result.stdout, "FROZEN other: statement changed (source deleted)");
  assert.equal(check(["Model.lean"]).status, 0);
  rmSync(join(project, "Model.lean"));
  includes(check().stdout, "FROZEN property: statement changed (source deleted)");
});

test("the Lean checker rejects malformed records and a changed toolchain", () => {
  const audit = statementAudit(statement("property"));
  const { project, check } = leanFixture("lake-search.log", { audit });
  assert.equal(check(["--freeze", "Model.lean"]).status, 0);
  const path = join(project, "Model.statements");
  const frozen = JSON.parse(readFileSync(path, "utf8"));
  frozen.toolchain = "leanprover/lean4:v4.20.0";
  writeFileSync(path, JSON.stringify(frozen));
  const bump = check(["Model.lean"]);
  assert.equal(bump.status, 1);
  includes(bump.stdout, "toolchain changed");
  includes(bump.stdout, "--freeze");
  writeFileSync(path, "{}");
  assert.equal(check(["Model.lean"]).status, 1);
});

test("missing Lean project files stay model failures", () => {
  const dir = fixture();
  const result = run(dir, "lean-check.sh", [dir]);
  assert.equal(result.status, 1);
  includes(result.stdout, "FAIL " + dir + " has no lakefile");
  writeFileSync(join(dir, "lakefile.toml"), 'name = "model"\n');
  command(dir, "elan", "exit 0");
  const pin = run(dir, "lean-check.sh", [dir]);
  assert.equal(pin.status, 1);
  includes(pin.stdout, "FAIL " + dir + " has no lean-toolchain pin");
});

test("Lean installation output follows an unavailable result when installation fails", () => {
  const dir = fixture();
  writeFileSync(join(dir, "lean-toolchain"), leanPin + "\n");
  command(dir, "elan", 'if [ "$1" = "toolchain" ]; then echo "install log"; fi; exit 1');
  const result = run(dir, "setup.sh", ["lean", dir]);
  assert.equal(result.status, 3);
  assert.ok(result.stdout.startsWith("UNAVAILABLE "), result.stdout);
  includes(result.stdout, "install log");
});

test("frozen statements work with the existing system Python", () => {
  const audit = statementAudit(statement("property"));
  const { dir, check } = leanFixture("lake-search.log", { audit });
  command(dir, "python3", '/usr/bin/python3 "$@"');
  const frozen = check(["--freeze", "Model.lean"]);
  assert.equal(frozen.status, 0, frozen.stdout + frozen.stderr);
  assert.equal(check(["Model.lean"]).status, 0);
});
