// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { command, excludes, fixture, includes, logs, removeFixtures, run, scripts } from "./helpers.mjs";

afterEach(removeFixtures);

test("TLC setup names the release to fetch when the pinned JAR is missing, without downloading it", () => {
  const dir = fixture();
  command(dir, "curl", 'echo download >> "$TASK_TRACE"; exit 99');
  const result = run(dir, "setup.sh", ["tla"], { TLC_CACHE: join(dir, "cache") });
  assert.equal(result.status, 3);
  includes(result.stdout, "UNAVAILABLE " + join(dir, "cache/tla2tools-v1.7.4.jar") + " is missing");
  includes(result.stdout, "https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4");
  assert.equal(existsSync(join(dir, "calls")), false);
  assert.equal(existsSync(join(dir, "cache")), false);
});

test("TLC setup rejects a cached JAR that does not match the pin", () => {
  const dir = fixture();
  mkdirSync(join(dir, "cache"));
  writeFileSync(join(dir, "cache/tla2tools-v1.7.4.jar"), "truncated");
  const result = run(dir, "setup.sh", ["tla"], { TLC_CACHE: join(dir, "cache") });
  assert.equal(result.status, 3);
  includes(result.stdout, "UNAVAILABLE ");
  includes(result.stdout, "has sha256");
});

test("TLC verification reports a supplied JAR that does not exist", () => {
  const dir = fixture();
  const matrix = join(dir, "empty.matrix");
  writeFileSync(matrix, "");
  const result = run(dir, "tlc-matrix.sh", [matrix], { TLC_JAR: join(dir, "absent.jar") });
  assert.equal(result.status, 3);
  includes(result.stdout, "UNAVAILABLE ");
  includes(result.stdout, "does not exist");
});

test("TLC setup accepts an explicitly supplied local JAR", () => {
  const dir = fixture();
  const jar = join(dir, "local tools.jar");
  writeFileSync(jar, "user supplied");
  const result = run(dir, "setup.sh", ["tla"], { TLC_JAR: jar });
  assert.equal(result.status, 0);
  includes(result.stdout, "READY TLC " + jar);
});

test("Lean verification refuses an unprepared toolchain without requesting installation", () => {
  const dir = fixture();
  const project = join(dir, "model");
  mkdirSync(project);
  writeFileSync(join(project, "lakefile.toml"), 'name = "model"\n');
  writeFileSync(join(project, "lean-toolchain"), "leanprover/lean4:v4.34.1\n");
  command(dir, "elan", 'printf "%s\\n" "$@" >> "$TASK_TRACE"; exit 1');
  const result = run(dir, "lean-check.sh", [project]);
  assert.equal(result.status, 3);
  includes(result.stdout, "UNAVAILABLE ");
  includes(result.stdout, "setup.sh lean");
  const args = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  assert.deepEqual(args, ["run", "leanprover/lean4:v4.34.1", "lake", "--version"]);
});

test("Lean preparation reuses ready pins and installs a changed repository pin once", () => {
  const dir = fixture();
  const project = join(dir, "model with spaces");
  const installed = join(dir, "installed");
  const oldPin = "leanprover/lean4:v4.34.0";
  const newPin = "leanprover/lean4:v4.34.1";
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
  mkdirSync(project);
  writeFileSync(join(project, "lean-toolchain"), "leanprover/lean4:v4.34.1\n");
  command(dir, "elan", 'if [ "$1" = "toolchain" ]; then exit 0; fi; exit 1');
  const result = run(dir, "setup.sh", ["lean", project]);
  assert.equal(result.status, 3);
  excludes(result.stdout, "READY");
  includes(result.stdout, "UNAVAILABLE leanprover/lean4:v4.34.1 does not run after installation");
});

function reduce(log) {
  return spawnSync("python3", [join(scripts, "tlc-trace.py"), join(logs, log)], { encoding: "utf8" });
}

test("the trace reducer shows only changed variables for an invariant violation", () => {
  const result = reduce("tlc-invariant.log");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, [
    "--- state 1: Initial predicate",
    "    x = 0",
    "    y = 0",
    "--- state 2: Step",
    "    x = 1",
    "--- state 3: Step",
    "    x = 2",
    "    y = 1",
    "--- state 4: Step",
    "    x = 3",
    "",
  ].join("\n"));
});

test("the trace reducer keeps the lasso of a liveness counter-example", () => {
  const result = reduce("tlc-liveness.log");
  assert.equal(result.status, 0);
  includes(result.stdout, "--- state 3: Step\n    x = 2\n    y = 1\n--- Back to state 1");
});

test("the trace reducer reads a one-variable spec and its multi-line values", () => {
  const result = reduce("tlc-one-variable.log");
  assert.equal(result.status, 0);
  includes(result.stdout, "--- state 1: Initial predicate\n    x = <<>>\n--- state 2: Next\n    x = << [ id |-> 0,");
  includes(result.stdout, "   [ id |-> 1,");
});

test("the trace reducer fails on a log without an error trace", () => {
  const result = reduce("lake-sorry.log");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

function matrixFixture(lines, java) {
  const dir = fixture();
  for (const sub of ["a", "b"]) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, "a/One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "a/Helper.tla"), "---- MODULE Helper ----\n====\n");
  writeFileSync(join(dir, "b/Two.tla"), "---- MODULE Two ----\n====\n");
  writeFileSync(join(dir, "checks.matrix"), lines.join("\n") + "\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const passing = 'echo "Model checking completed. No error has been found."; echo "4 distinct states found"';
  return {
    dir,
    matrix: (args = []) => run(dir, "tlc-matrix.sh", [join(dir, "checks.matrix"), ...args], {
      JAVA: command(dir, "tlc-java", '[[ "$*" == *"-help"* ]] && exit 0\n[ "$1" = "-version" ] && exit 0\n' + (java ?? passing)),
      TLC_JAR: join(dir, "tools.jar"),
      TLC_LOG: join(logs, "tlc-invariant.log"),
    }),
  };
}

test("the matrix runner reduces the trace of an invariant violation", () => {
  const { matrix } = matrixFixture(["spec a/One.tla", "check INVARIANTS Small", "run n=4 | N=4"], 'cat "$TLC_LOG"; exit 12');
  const result = matrix();
  assert.equal(result.status, 1);
  includes(result.stdout, "FAIL One n=4: Error: Invariant Small is violated.");
  includes(result.stdout, "--- state 4: Step\n    x = 3\n");
  excludes(result.stdout, "/\\ y = 1");
});

test("the matrix runner reports the final state count, not a progress line's", () => {
  const { matrix } = matrixFixture(["spec a/One.tla", "run n=450 | N=450"], [
    'echo "Progress(294) at 2026-10-01 17:24:40: 12,610,693 states generated (12,610,693 s/min), 4,246,783 distinct states found (4,246,783 ds/min), 43,235 states left on queue."',
    'echo "Model checking completed. No error has been found."',
    'echo "274591352 states generated, 91733851 distinct states found, 0 states left on queue."',
  ].join("\n"));
  assert.equal(matrix().stdout, "PASS One n=450 91733851 distinct states found\nSUMMARY 1 of 1 runs passed, 91733851 distinct states in total\n");
});

test("the matrix runner totals the passing runs and their state counts", () => {
  const { matrix } = matrixFixture(
    ["spec a/One.tla", "run small | N=1", "run large | N=2", "spec a/Gone.tla", "run lost | N=1"],
    'echo "Model checking completed. No error has been found."; echo "9,000 states generated, 1,204 distinct states found, 0 states left on queue."',
  );
  const result = matrix();
  assert.equal(result.status, 1);
  includes(result.stdout, "SUMMARY 2 of 3 runs passed, 2408 distinct states in total\n");
});

test("the matrix runner gives each run only its own spec directory's modules", () => {
  const { dir, matrix } = matrixFixture(
    ["spec a/One.tla", "run first | N=1", "\t", "spec b/Two.tla", "run second |"],
    'for last; do :; done; ls "$(dirname "$last")" | grep tla$ | tr "\\n" " " >> "$TASK_TRACE"; echo >> "$TASK_TRACE"\n' +
      'echo "Model checking completed. No error has been found."',
  );
  const result = matrix();
  excludes(result.stdout, "unknown directive");
  assert.equal(result.status, 0);
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "Helper.tla One.tla \nTwo.tla \n");
});

test("the matrix runner reports a missing spec in one line without starting TLC", () => {
  const { dir, matrix } = matrixFixture(["spec a/Gone.tla", "run only | N=1"], 'echo started >> "$TASK_TRACE"');
  const result = matrix();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "FAIL Gone only: spec a/Gone.tla not found\nSUMMARY 0 of 1 runs passed, 0 distinct states in total\n");
  assert.equal(result.stderr, "");
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("the matrix runner names the matrix when it has no runs and the filter when none match", () => {
  const { dir, matrix } = matrixFixture(["spec a/One.tla"]);
  assert.equal(matrix().stdout, `FAIL no run in ${join(dir, "checks.matrix")}\n`);
  assert.equal(matrix(["absent"]).stdout, `FAIL no run matching 'absent' in ${join(dir, "checks.matrix")}\n`);
});

test("the matrix runner fails a check line that no spec would keep", () => {
  const { matrix } = matrixFixture(["check INVARIANTS Small", "spec a/One.tla", "run n=4 | N=4"]);
  const result = matrix();
  assert.equal(result.status, 1);
  includes(result.stdout, "FAIL check 'INVARIANTS Small' before any spec line");
});

test("the matrix runner fails a run line without a bar instead of inventing a constant", () => {
  const { dir, matrix } = matrixFixture(["spec a/One.tla", "run n=4"], 'echo started >> "$TASK_TRACE"');
  const result = matrix();
  assert.equal(result.status, 1);
  includes(result.stdout, "FAIL run 'n=4' has no | before its constants");
  assert.equal(existsSync(join(dir, "calls")), false);
});

const audited = "AUDITED 37 declarations";
function leanFixture(log, { status = 0, audit = audited, files = [] } = {}) {
  const dir = fixture();
  const project = join(realpathSync(dir), "model");
  mkdirSync(project);
  writeFileSync(join(project, "lakefile.toml"), 'name = "model"\n');
  writeFileSync(join(project, "lean-toolchain"), "leanprover/lean4:v4.34.1\n");
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
    includes(result.stdout, "leanprover/lean4:v4.34.1 cannot build a module by its source path; pin Lean 4.20.0 or later\n");
  }
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
  assert.equal(JSON.parse(frozen).toolchain, "leanprover/lean4:v4.34.1");
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

function tlaMutations(checks, mutations, log = "tlc-invariant.log") {
  const dir = fixture();
  const spec = "---- MODULE One ----\nStep == x' = x + 1\n====\n";
  writeFileSync(join(dir, "One.tla"), spec);
  writeFileSync(join(dir, "One.matrix"), ["spec One.tla", ...checks, "run n=4 | N=4", "run n=5 | N=5"].join("\n") + "\n");
  writeFileSync(join(dir, "One.mutations"), mutations.join("\n") + "\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  // TLC fails on a spec that holds BUG, and records the checks it was given.
  const java = command(dir, "tlc-java", [
    '[[ "$*" == *"-help"* ]] && exit 0\n[ "$1" = "-version" ] && exit 0',
    'for last; do :; done',
    'grep -v CONSTANTS "$(dirname "$last")/MC.cfg" | grep "^[A-Z]" >> "$TASK_TRACE"',
    'if grep -q BUG "$last"; then cat "$TLC_LOG"; exit 12; fi',
    'echo "Model checking completed. No error has been found."',
  ].join("\n"));
  const result = run(dir, "mutate.py", [join(dir, "One.mutations")], { JAVA: java, TLC_JAR: join(dir, "tools.jar"), TLC_LOG: join(logs, log) });
  assert.equal(readFileSync(join(dir, "One.tla"), "utf8"), spec);
  return { dir, result };
}

test("the mutation runner checks each TLA+ mutation against its one property and leaves the spec unchanged", () => {
  const { dir, result } = tlaMutations(["check INVARIANTS Small Other", "check PROPERTIES Ends"], [
    "# a comment",
    "mutation skip a step",
    "detects Small",
    "only n=4",
    "- x' = x + 1",
    "+ x' = x + 2 \\* BUG",
  ]);
  assert.equal(result.stdout, [
    "DETECTED skip a step: Small fails in run 'n=4' (Invariant Small is violated)",
    "UNCOVERED Ends",
    "UNCOVERED Other",
    "SUMMARY 1 of 1 mutations detected, 2 properties without a mutation",
    "",
  ].join("\n"));
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "SPECIFICATION Spec\nINVARIANTS Small\n");
});

test("the mutation runner fails a mutation that every run still passes", () => {
  const { result } = tlaMutations(["check INVARIANTS Small"], ["mutation harmless", "detects Small", "- x + 1", "+ 1 + x"]);
  assert.equal(result.stdout, "MISSED harmless\nSUMMARY 0 of 1 mutations detected\n");
  assert.equal(result.status, 1);
});

test("the mutation runner counts a deadlock as detection by a temporal property, not by an invariant", () => {
  const stuck = (keyword) => ["mutation never step", `detects ${keyword}`, "- x + 1", "+ x \\* BUG"];
  const temporal = tlaMutations(["check PROPERTIES Ends"], stuck("Ends"), "tlc-deadlock.log").result;
  assert.equal(temporal.stdout, "DETECTED never step: Ends fails in run 'n=4' (Deadlock reached)\nSUMMARY 1 of 1 mutations detected\n");
  assert.equal(temporal.status, 0);
  const invariant = tlaMutations(["check INVARIANTS Small"], stuck("Small"), "tlc-deadlock.log").result;
  assert.equal(invariant.status, 1);
  includes(invariant.stdout, "FAIL mutation 'never step' did not reach a verdict:\nFAIL One n=4: Error: Deadlock reached.");
  excludes(invariant.stdout, "mutations detected");
});

test("the mutation runner rejects text that is absent or repeated, and a property the matrix does not check", () => {
  const cases = [
    [["mutation gone", "detects Small", "- y + 1", "+ y"], "its - text occurs 0 times"],
    [["mutation twice", "detects Small", "- x", "+ y"], "its - text occurs 2 times"],
    [["mutation unchecked", "detects Large", "- x + 1", "+ x"], "detects 'Large', which"],
    [["detects Small"], "'detects Small' before any mutation line"],
  ];
  for (const [mutations, message] of cases) {
    const { dir, result } = tlaMutations(["check INVARIANTS Small"], mutations);
    assert.equal(result.status, 1);
    includes(result.stdout, message);
    assert.equal(existsSync(join(dir, "calls")), false);
  }
});

function freezeRecord(path, theorems) {
  const declarations = theorems.map((name) => ({ name, kind: "theorem", type: "", typeHash: "", valueHash: null }));
  writeFileSync(path, JSON.stringify({ format: 1, toolchain: "leanprover/lean4:v4.34.1", module: "Model", declarations }));
}

function leanProject() {
  const dir = fixture();
  const project = join(dir, "lean");
  mkdirSync(join(project, "Model"), { recursive: true });
  writeFileSync(join(project, "lakefile.toml"), 'name = "model"\n');
  writeFileSync(join(project, "lean-toolchain"), "leanprover/lean4:v4.34.1\n");
  return { dir, project };
}

test("the mutation runner names the Lean declarations that fail on a mutation", () => {
  const { dir, project } = leanProject();
  const model = "def step (n : Nat) : Nat := n + 1\n\ntheorem step_grows (n : Nat) :\n    n < step n := by\n  simp [step]\n#guard step 1 == 2\n";
  writeFileSync(join(project, "Model/Step.lean"), model);
  freezeRecord(join(project, "Model/Step.statements"), ["step_grows"]);
  const mutations = (text) => writeFileSync(join(project, "Model/Step.mutations"), text);
  // Lean reports an error in the proof and at the guard when the step is gone,
  // and in the definition when it does not parse.
  command(dir, "elan", [
    '[ "$4" = "--version" ] && exit 0',
    '[ "$5" = "$TASK_PROJECT" ] || exit 9',
    'if grep -q ":= n +$" "$8"; then echo "$8:1:30: error: unexpected token"; echo "$8:6:0: error: unknown identifier"; exit 1; fi',
    'grep -q ":= n$" "$8" || exit 0',
    'echo "/elsewhere/Dep.lean:1:0: error: not this file"; echo "$8:5:2: error: unsolved goals"; echo "$8:6:0: error: The expression did not evaluate to true"; exit 1',
  ].join("\n"));
  const check = () => run(dir, "mutate.py", [join(project, "Model/Step.mutations")], { TASK_PROJECT: realpathSync(project) });
  mutations("mutation no step\n- n + 1\n+ n\n\nmutation same step\n- n + 1\n+ 1 + n\n");
  const result = check();
  assert.equal(result.stdout, "DETECTED no step: fails theorem step_grows; #guard step 1 == 2\nMISSED same step\nSUMMARY 1 of 2 mutations detected\n");
  assert.equal(result.status, 1);
  mutations("mutation half a step\n- n + 1\n+ n +\n");
  const broken = check();
  assert.equal(broken.status, 1);
  includes(broken.stdout, "FAIL mutation 'half a step' did not reach a verdict:\n");
  includes(broken.stdout, "error: unexpected token");
  assert.equal(readFileSync(join(project, "Model/Step.lean"), "utf8"), model);
});

test("the mutation runner reports a frozen public Lean theorem that no mutation breaks", () => {
  const { dir, project } = leanProject();
  writeFileSync(join(project, "Model/Step.lean"), [
    "namespace Outer",
    "namespace Inner",
    "def step (n : Nat) : Nat := n + 1",
    "theorem step_grows (n : Nat) : n < step n := by simp [step]",
    "theorem State.vacuous (n : Nat) (h : n < 0) : n < step n := absurd h (Nat.not_lt_zero n)",
    "private theorem helper (n : Nat) : 0 ≤ n := Nat.zero_le n",
    "theorem added (n : Nat) : n ≤ n := Nat.le_refl n",
    "end Inner",
    "end Outer",
  ].join("\n") + "\n");
  freezeRecord(join(project, "Model/Step.statements"),
    ["Outer.Inner.State.vacuous", "Outer.Inner.helper", "Outer.Inner.step.eq_1", "Outer.Inner.step_grows"]);
  writeFileSync(join(project, "Model/Step.mutations"), "mutation no step\n- n + 1\n+ n\n");
  // Without the step, only the proof of step_grows fails; the vacuous theorem
  // holds whatever step does.
  command(dir, "elan", [
    '[ "$4" = "--version" ] && exit 0',
    'grep -q ":= n$" "$8" || exit 0',
    'echo "$8:4:44: error: unsolved goals"; exit 1',
  ].join("\n"));
  const result = run(dir, "mutate.py", [join(project, "Model/Step.mutations")]);
  assert.equal(result.stdout, "DETECTED no step: fails theorem step_grows\nUNCOVERED theorem State.vacuous\n"
    + "SUMMARY 1 of 1 mutations detected, 1 properties without a mutation\n");
  assert.equal(result.status, 1);
});

test("the mutation runner rejects a Lean model without a statements record before running Lean", () => {
  const { dir, project } = leanProject();
  writeFileSync(join(project, "Model/Step.lean"), "def step (n : Nat) : Nat := n + 1\n");
  writeFileSync(join(project, "Model/Step.mutations"), "mutation no step\n- n + 1\n+ n\n");
  command(dir, "elan", 'echo elan >> "$TASK_TRACE"; exit 0');
  const result = run(dir, "mutate.py", [join(project, "Model/Step.mutations")]);
  assert.equal(result.stdout, `FAIL ${join(realpathSync(project), "Model/Step.statements")} is missing; `
    + "freeze the model with lean-check.sh --freeze before checking its mutations\n");
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(dir, "calls")), false);
});


test("missing runtimes and hash tools are unavailable with their remedies", () => {
  const dir = fixture();
  const jar = join(dir, "tools.jar");
  writeFileSync(jar, "jar");
  writeFileSync(join(dir, "lean-toolchain"), "leanprover/lean4:v4.34.1\n");
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

test("mutation runners preserve unavailable status and never report a missed mutation", () => {
  for (const language of ["tla", "lean"]) {
    const dir = fixture();
    const model = join(dir, "One." + language);
    writeFileSync(model, "Step = x + 1\n");
    const path = join(dir, "One.mutations");
    writeFileSync(path, "mutation skip\n" + (language === "tla" ? "detects Small\n" : "") + "- x + 1\n+ x\n");
    if (language === "tla") {
      writeFileSync(join(dir, "One.matrix"), "spec One.tla\ncheck INVARIANTS Small\nrun n=1 | N=1\n");
    } else {
      writeFileSync(join(dir, "lakefile.toml"), 'name = "model"\n');
      writeFileSync(join(dir, "lean-toolchain"), "leanprover/lean4:v4.34.1\n");
      freezeRecord(join(dir, "One.statements"), []);
      command(dir, "elan", "exit 1");
    }
    const result = run(dir, "mutate.py", [path], { TLC_JAR: join(dir, "absent.jar") });
    assert.equal(result.status, 3, result.stdout);
    assert.ok(result.stdout.startsWith("UNAVAILABLE "), result.stdout);
    excludes(result.stdout, "MISSED");
    excludes(result.stdout, "SUMMARY");
  }
});

test("helper usage errors exit 2", () => {
  const dir = fixture();
  for (const [script, args] of [["lean-check.sh", []], ["tlc-matrix.sh", []], ["mutate.py", []], ["setup.sh", ["lean"]]]) {
    assert.equal(run(dir, script, args).status, 2, script);
  }
});


test("an existing JAR whose TLC entry point cannot run is unavailable", () => {
  const dir = fixture();
  const jar = join(dir, "bad.jar");
  writeFileSync(jar, "not a jar");
  const matrix = join(dir, "One.matrix");
  writeFileSync(matrix, "spec One.tla\nrun n=1 | N=1\n");
  const java = command(dir, "bad-java", '[ "$1" = "-version" ] && exit 0\necho "Could not find or load main class tlc2.TLC" >&2; exit 1');
  for (const [script, args] of [["setup.sh", ["tla"]], ["tlc-matrix.sh", [matrix]]]) {
    const result = run(dir, script, args, { JAVA: java, TLC_JAR: jar });
    assert.equal(result.status, 3, result.stdout);
    assert.ok(result.stdout.startsWith("UNAVAILABLE "), result.stdout);
    includes(result.stdout, "tlc2.TLC");
    excludes(result.stdout, "READY");
    excludes(result.stdout, "SUMMARY");
  }
});

test("Lean installation output follows an unavailable result when installation fails", () => {
  const dir = fixture();
  writeFileSync(join(dir, "lean-toolchain"), "leanprover/lean4:v4.34.1\n");
  command(dir, "elan", 'if [ "$1" = "toolchain" ]; then echo "install log"; fi; exit 1');
  const result = run(dir, "setup.sh", ["lean", dir]);
  assert.equal(result.status, 3);
  assert.ok(result.stdout.startsWith("UNAVAILABLE "), result.stdout);
  includes(result.stdout, "install log");
});


test("the pinned TLC help command may return 1 after printing its help", () => {
  const dir = fixture();
  const jar = join(dir, "tools.jar");
  writeFileSync(jar, "supplied");
  const java = command(dir, "help-java", '[ "$1" = "-version" ] && exit 0\necho "TLC - provides model checking and simulation of TLA+ specifications - Version 2.19"; exit 1');
  const result = run(dir, "setup.sh", ["tla"], { JAVA: java, TLC_JAR: jar });
  assert.equal(result.status, 0, result.stdout);
  includes(result.stdout, "READY TLC");
});


test("frozen statements work with the existing system Python", () => {
  const audit = statementAudit(statement("property"));
  const { dir, check } = leanFixture("lake-search.log", { audit });
  command(dir, "python3", '/usr/bin/python3 "$@"');
  const frozen = check(["--freeze", "Model.lean"]);
  assert.equal(frozen.status, 0, frozen.stdout + frozen.stderr);
  assert.equal(check(["Model.lean"]).status, 0);
});

const reachJava = [
  'for last; do :; done',
  'dir=$(dirname "$last")',
  'if grep -q "^INVARIANT Reach" "$dir/MC.cfg"; then',
  '  name=$(sed -n "s/^INVARIANT //p" "$dir/MC.cfg")',
  '  sed "s/ReachNegated/$name/g" "$TLC_REACH_LOG"',
  '  exit 12',
  'fi',
  'echo "Model checking completed. No error has been found."',
  'echo "4 distinct states found"',
].join("\n");

function reachFixture(lines, java = reachJava, log = "tlc-reach.log") {
  const setup = matrixFixture(lines, java.replaceAll('"$TLC_REACH_LOG"', `"${join(logs, log)}"`));
  return setup;
}

test("reach checks report the shortest witness and count separately", () => {
  const { matrix } = reachFixture(["spec a/One.tla", "reach Full | n=1", "run n=1 | N=1"]);
  const result = matrix();
  assert.equal(result.status, 0);
  includes(result.stdout, "PASS One reach Full n=1: shortest trace 2 states (1 transitions)");
  includes(result.stdout, "SUMMARY 1 of 1 runs passed, 1 of 1 reach checks passed, 4 distinct states in total");
});

test("reach checks recognize an initial-state witness", () => {
  const { matrix } = reachFixture(["spec a/One.tla", "reach Full | n=1", "run n=1 | N=1"], reachJava, "tlc-reach-initial.log");
  const result = matrix();
  assert.equal(result.status, 0);
  includes(result.stdout, "shortest trace 1 states (0 transitions)");
});

test("an exhaustive reach search without a witness fails", () => {
  const { matrix } = reachFixture(["spec a/One.tla", "reach Full | n=1", "run n=1 | N=1"], 'echo "Model checking completed. No error has been found."');
  const result = matrix();
  assert.equal(result.status, 1);
  includes(result.stdout, "FAIL One reach Full n=1: the model never reaches this state");
  includes(result.stdout, "0 of 1 reach checks passed");
});

test("reach parsing rejects missing spec, operator, separator, or label", () => {
  for (const directive of ["reach Full | n=1", "spec a/One.tla\nreach Full", "spec a/One.tla\nreach Full |", "spec a/One.tla\nreach | n=1", "spec a/One.tla\nreach Full() | n=1"]) {
    const { matrix } = reachFixture([directive, "spec a/One.tla", "run n=1 | N=1"]);
    assert.equal(matrix().status, 1, directive);
  }
});

test("reach reports unmatched labels and resets at the next spec", () => {
  const { matrix } = reachFixture(["spec a/One.tla", "reach Full | absent", "run n=1 | N=1", "spec b/Two.tla", "run absent | N=1"]);
  const result = matrix();
  assert.equal(result.status, 1);
  includes(result.stdout, "reach Full: no run matching 'absent'");
  excludes(result.stdout, "PASS Two reach");
});

test("reach chooses the first matching run even when declared after it", () => {
  const { dir, matrix } = reachFixture(["spec a/One.tla", "run n=1 first | N=1", "run n=1 second | N=2", "reach Full | n=1"],
    'for last; do :; done\ngrep "N =" "$(dirname "$last")/MC.cfg" >> "$TASK_TRACE"\n' + reachJava);
  assert.equal(matrix().status, 0);
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "  N = 1\n  N = 2\n  N = 1\n");
  const filtered = matrix(["second"]);
  assert.equal(filtered.status, 0);
  excludes(filtered.stdout, "PASS One reach");
});

test("reach uses one worker and disables deadlock only for witness searches", () => {
  const { dir, matrix } = reachFixture(["spec a/One.tla", "reach Full | n=1", "run n=1 | N=1"],
    'printf "%s\\n" "$*" >> "$TASK_TRACE"\n' + reachJava);
  assert.equal(matrix().status, 0);
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  excludes(calls[0], "-deadlock");
  includes(calls[1], "-workers 1");
  includes(calls[1], "-deadlock");
});

test("reach does not confuse a runtime error with an unreachable state", () => {
  const { matrix } = reachFixture(["spec a/One.tla", "reach Full | n=1", "run n=1 | N=1"], 'echo "Error: undefined operator Full"; exit 1');
  const result = matrix();
  assert.equal(result.status, 1);
  excludes(result.stdout, "the model never reaches this state");
  includes(result.stdout, "undefined operator Full");
});

test("mutation detector validation precedes all tool runs", () => {
  const { dir, result } = tlaMutations(["check INVARIANTS Small"], ["mutation valid", "detects Small", "- x + 1", "+ 1 + x", "mutation invalid", "detects reach:Missing", "- x + 1", "+ x"]);
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("property mutations ignore reach declarations and reach checks add no property coverage", () => {
  const { result } = tlaMutations(["check INVARIANTS Small", "reach Full | n=4"], ["mutation skip", "detects Small", "- x + 1", "+ x + 2 \\* BUG"]);
  assert.equal(result.status, 0);
  includes(result.stdout, "SUMMARY 1 of 1 mutations detected");
  excludes(result.stdout, "UNCOVERED reach");
});

function reachMutation(java) {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\nStep == x + 1\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nreach Full | n=4\nrun n=4 | N=4\n");
  writeFileSync(join(dir, "One.mutations"), "mutation never full\ndetects reach:Full\n- x + 1\n+ x \\* BUG\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  return run(dir, "mutate.py", [join(dir, "One.mutations")], {
    JAVA: command(dir, "tlc-java", '[[ "$*" == *"-help"* ]] && exit 0\n[ "$1" = "-version" ] && exit 0\n' + java),
    TLC_JAR: join(dir, "tools.jar"),
  });
}

test("reach mutations are detected by exhausted reach searches, including stopped models", () => {
  const result = reachMutation([
    'for last; do :; done',
    'if grep -q "^INVARIANT Reach" "$(dirname "$last")/MC.cfg"; then',
    '  echo "Model checking completed. No error has been found."; exit 0',
    'fi',
    'echo "Error: Deadlock reached."; exit 11',
  ].join("\n"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  includes(result.stdout, "DETECTED never full: reach:Full fails in run 'n=4' (the model never reaches this state)");
});

test("a deadlock alone does not detect a reach mutation", () => {
  const result = reachMutation('echo "Error: Deadlock reached."; exit 11');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stdout, "did not reach a verdict");
  excludes(result.stdout, "DETECTED never full");
});

test("reach searches do not inherit ordinary checks", () => {
  const { dir, matrix } = reachFixture(["spec a/One.tla", "check INVARIANTS Small", "check PROPERTIES Ends", "reach Full | n=1", "run n=1 | N=1"],
    'for last; do :; done\ngrep -E "^(INVARIANT|PROPERT)" "$(dirname "$last")/MC.cfg" >> "$TASK_TRACE"\n' + reachJava);
  assert.equal(matrix().status, 0);
  const checks = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  assert.equal(checks.length, 3);
  assert.equal(checks[0], "INVARIANTS Small");
  assert.equal(checks[1], "PROPERTIES Ends");
  assert.match(checks[2], /^INVARIANT Reach[a-f0-9]+Negated$/);
});

test("a different invariant violation cannot pass a reach check", () => {
  const { matrix } = reachFixture(["spec a/One.tla", "reach Full | n=1", "run n=1 | N=1"], 'echo "Error: Invariant Other is violated."; echo "State 1: <Init>"; exit 12');
  const result = matrix();
  assert.equal(result.status, 1);
  excludes(result.stdout, "PASS One reach");
  excludes(result.stdout, "the model never reaches this state");
});

test("malformed mutation matrix checks fail before running a model", () => {
  for (const check of ["check", "check INVARIANTS", "check UNKNOWN Small"]) {
    const { dir, result } = tlaMutations([check], ["mutation one", "detects Small", "- x + 1", "+ x"]);
    assert.equal(result.status, 1);
    includes(result.stdout, "malformed check");
    excludes(result.stderr, "Traceback");
    assert.equal(existsSync(join(dir, "calls")), false);
  }
});

test("the matrix runner rejects empty or unsupported checks", () => {
  for (const check of ["check", "check INVARIANTS", "check UNKNOWN Small"]) {
    const { matrix } = matrixFixture(["spec a/One.tla", check, "run n=1 | N=1"]);
    const result = matrix();
    assert.equal(result.status, 1);
    includes(result.stdout, "malformed check");
  }
});
