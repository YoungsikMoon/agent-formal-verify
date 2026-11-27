// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { assertProcessStopped, command, elanListsPin, excludes, fixture, includes, leanPin, logs, removeFixtures, run, scripts, writeLeanProject } from "./helpers.mjs";

afterEach(removeFixtures);

// elan run installs a toolchain that is not installed, even without --install, so the checker never runs one.
test("Lean verification and Lean mutations refuse a toolchain that elan does not list, without running it", () => {
  const dir = realpathSync(fixture());
  const project = join(dir, "model");
  writeLeanProject(project);
  mkdirSync(join(project, "Model"));
  writeFileSync(join(project, "Model/Step.lean"), "def step (n : Nat) : Nat := n + 1\n");
  writeFileSync(join(project, "Model/Step.statements"), JSON.stringify({ format: 1, module: "Model.Step", toolchain: leanPin,
    declarations: [{ name: "step", kind: "definition", type: "Nat → Nat", typeHash: "0", valueHash: "0" }] }));
  writeFileSync(join(project, "Model/Step.mutations"), "mutation no step\n- n + 1\n+ n\n");
  command(dir, "elan", [
    'printf "%s\\n" "$*" >> "$TASK_TRACE"',
    '[ "$1" = run ] && echo "installing $2" >> "$TASK_TRACE"',
    'exit 0',
  ].join("\n"));
  for (const [script, args] of [["lean-check.sh", [project]], ["mutate.py", [join(project, "Model/Step.mutations")]]]) {
    const result = run(dir, script, args);
    assert.equal(result.status, 3, script + result.stdout + result.stderr);
    assert.equal(result.stdout, `UNAVAILABLE ${leanPin} is not ready; run bash ${scripts}/setup.sh lean ${project}\n`);
  }
  assert.deepEqual(readFileSync(join(dir, "calls"), "utf8").trim().split("\n"), ["toolchain list", "toolchain list"]);
});

test("the Lean checker finds a pin installed under the name elan gives it, and runs only that toolchain", () => {
  for (let [pinned, listed] of [["4.34.1", leanPin], ["v4.34.1", leanPin], ["leanprover/lean4:4.34.1", leanPin],
    ["nightly-2025-01-01", "leanprover/lean4-nightly:nightly-2025-01-01"], ["custom", "custom"], [null, "nothing"]]) {
    const dir = fixture();
    writeLeanProject(dir);
    // An absolute path names a toolchain directory, which elan never lists.
    pinned ??= join(dir, "toolchain");
    mkdirSync(join(dir, "toolchain"), { recursive: true });
    writeFileSync(join(dir, "lean-toolchain"), pinned + "\n");
    command(dir, "elan", [
      'printf "%s\\n" "$*" >> "$TASK_TRACE"',
      `[ "$1 $2" = "toolchain list" ] && { echo "${listed} (default)"; exit 0; }`,
      'exit 1',
    ].join("\n"));
    const result = run(dir, "lean-check.sh", [dir]);
    assert.equal(result.status, 3, pinned + result.stdout);
    const listing = listed === "nothing" ? [] : ["toolchain list"];
    assert.deepEqual(readFileSync(join(dir, "calls"), "utf8").trim().split("\n"), [...listing, `run ${pinned} lake --version`], pinned);
  }
});

test("a Lean pin that names a release channel fails, since elan resolves it online", () => {
  for (const pinned of ["stable", "leanprover/lean4:nightly", "beta", "acme/model:lean-toolchain"]) {
    const dir = fixture();
    writeLeanProject(dir);
    writeFileSync(join(dir, "lean-toolchain"), pinned + "\n");
    command(dir, "elan", 'printf "%s\\n" "$*" >> "$TASK_TRACE"; exit 0');
    for (const [script, args] of [["lean-check.sh", [dir]], ["setup.sh", ["lean", dir]]]) {
      const result = run(dir, script, args);
      assert.equal(result.status, 1, script + result.stdout);
      includes(result.stdout, `FAIL ${join(dir, "lean-toolchain")} pins ${pinned}, which elan resolves to a release online; pin a release`);
    }
    assert.equal(existsSync(join(dir, "calls")), false);
  }
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
    '  "toolchain list") cat "$TASK_INSTALLED" ;;',
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
  // elan lists the toolchain and installs it, but it does not run.
  command(dir, "elan", [elanListsPin, 'if [ "$1" = "toolchain" ]; then exit 0; fi; exit 1'].join("\n"));
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
    elanListsPin,
    '[ "$4" = "--version" ] && exit 0',
    `[ "$3" = "lean" ] && { echo "\${TASK_PREFIX-${dir}}"; echo "$TASK_PREFIX_ERROR" >&2; exit "\${TASK_PREFIX_STATUS:-0}"; }`,
    // Lake writes notices, such as one for a project with both lakefiles, to stderr.
    '[ "$7" = printenv ] && { echo "info: [root]: lakefile.lean and lakefile.toml are both present; using lakefile.lean" >&2; echo "$LEAN_PATH"; exit 0; }',
    'if [[ "$8" == */lean-replay.lean ]]; then echo replay >> "$TASK_TRACE"; sed "s/^/replaying /" "$AFV_REPLAY_MODULES"; [ -z "$TASK_REPLAY" ] || { echo "$TASK_REPLAY"; exit 1; }; exit 0; fi',
    'if [[ "$9" == */lean-analysis.lean && "${10}" == audit ]]; then echo audit >> "$TASK_TRACE"; sed "s/^/module /" "${@: -1}"; printf "%s\\n" "$TASK_AUDIT"; exit 0; fi',
    'shift 6; printf "%s\\n" "$@" > "$TASK_BUILT"',
    `[ ${status} -ne 0 ] || for target; do target=\${target#"$TASK_PROJECT/"}; echo "$TASK_PROJECT/.lake/build/lib/lean/\${target%.lean:olean}.olean"; done`,
    `cat "${join(logs, log)}" >&2; exit ${status}`,
  ].join("\n"));
  const check = (args = files, output = audit, extra = {}) => run(dir, "lean-check.sh", [project, ...args], { LEAN_PATH: join(project, lib), TASK_AUDIT: output, TASK_BUILT: join(dir, "built"), TASK_PROJECT: project, ...extra });
  return { dir, project, check, result: check() };
}

test("the Lean checker prints multi-line search output whole and ignores error text in output", () => {
  const { result } = leanFixture("lake-search.log");
  assert.equal(result.status, 0);
  includes(result.stdout, " ({ next := 3, consumed := 1 }, { next := 4, consumed := 1 })]\n");
  includes(result.stdout, "/model: 37 declarations checked, no unfinished proof (sorry), no added axiom, kernel replay unavailable");
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
    includes(result.stdout, "the axiom audit did not run or found no declarations:\nmodule Model\nmodule Model.Sub\n" + audit);
  }
});

test("the Lean checker builds every project source by path and audits only the modules Lake reports for them", () => {
  const { dir, project, result } = leanFixture("lake-search.log", { audit: "AUDITED 0 declarations" });
  assert.equal(readFileSync(join(dir, "built"), "utf8"), `${project}/Model.lean:olean\n${project}/Model/Sub.lean:olean\n`);
  includes(result.stdout, "module Model\nmodule Model.Sub\nAUDITED 0");
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
    elanListsPin,
    '[ "$4" = "--version" ] && exit 0',
    '[ "$6" = "query" ] && { echo "/elsewhere/out/Model.olean"; exit 0; }',
    '[ "$7" = printenv ] && { echo "$LEAN_PATH"; exit 0; }',
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

test("the Lean checker replays the built modules through the kernel when the pin ships leanchecker", () => {
  const { dir, check } = leanFixture("lake-search.log");
  command(dir, "leanchecker", "exit 0");
  const result = check();
  assert.equal(result.status, 0, result.stdout);
  includes(result.stdout, "REPLAYED 2 modules through the Lean kernel\n");
  includes(result.stdout, "no added axiom, kernel replay passed");
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "audit\naudit\nreplay\n");
});

test("a named Lean replay includes imported project modules once", () => {
  const { dir, check } = leanFixture("lake-search.log");
  command(dir, "leanchecker", "exit 0");
  const audit = ["IMPORTED Model", "IMPORTED Model.Sub", "IMPORTED Lean", audited].join("\n");
  const result = check(["Model/Sub.lean"], audit);
  assert.equal(result.status, 0, result.stdout);
  includes(result.stdout, "REPLAYED 2 modules through the Lean kernel\n");
});

test("the Lean checker fails a module that kernel replay rejects, and names it", () => {
  const { dir, project, check } = leanFixture("lake-search.log");
  command(dir, "leanchecker", "exit 0");
  const result = check([], audited, { TASK_REPLAY: "leanchecker found a problem in Model.Sub" });
  assert.equal(result.status, 1);
  includes(result.stdout, `FAIL ${project}: kernel replay rejected a built module\n`);
  includes(result.stdout, "leanchecker found a problem in Model.Sub\n");
  excludes(result.stdout, "PASS ");
});

test("the Lean checker passes a pin without leanchecker and reports the replay as unavailable", () => {
  const { dir, result } = leanFixture("lake-search.log");
  assert.equal(result.status, 0);
  includes(result.stdout, `UNAVAILABLE kernel replay: ${leanPin} ships no leanchecker\n`);
  includes(result.stdout, "no added axiom, kernel replay unavailable");
  excludes(result.stdout, "REPLAYED");
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "audit\n");
});

test("an unsuccessful prefix lookup or invalid prefix fails before claiming a replay verdict", () => {
  const { dir, check } = leanFixture("lake-search.log");
  for (const env of [{ TASK_PREFIX_STATUS: "17", TASK_PREFIX_ERROR: "lookup failed" }, { TASK_PREFIX: "" }, { TASK_PREFIX: join(dir, "missing") }]) {
    const result = check([], audited, env);
    assert.equal(result.status, 1, result.stdout);
    includes(result.stdout, "cannot locate " + leanPin + " for kernel replay");
    if (env.TASK_PREFIX_ERROR) includes(result.stdout, env.TASK_PREFIX_ERROR);
    excludes(result.stdout, "PASS ");
    excludes(result.stdout, "ships no leanchecker");
  }
});

test("freezing does not replay", () => {
  const { dir, check } = leanFixture("lake-search.log", { audit: statementAudit(statement("property")) });
  command(dir, "leanchecker", "exit 0");
  const frozen = check(["--freeze", "Model.lean"]);
  assert.equal(frozen.status, 0, frozen.stdout);
  excludes(frozen.stdout, "REPLAYED");
  excludes(readFileSync(join(dir, "calls"), "utf8"), "replay");
});

test("the Lean checker fails a witness that does not state its property's hypotheses, except when freezing", () => {
  const failed = "WITNESS failed Model.step: Model.step.witness must state ∃ (n : Nat), n < 3";
  const audit = statementAudit(statement("property"), "WITNESS checked Model.other", failed);
  const { project, check, result } = leanFixture("lake-search.log", { audit });
  assert.equal(result.status, 1);
  includes(result.stdout, `FAIL ${project}: 1 witnesses do not state their property's hypotheses\n`);
  includes(result.stdout, failed + "\n");
  excludes(result.stdout, "PASS ");
  const frozen = check(["--freeze", "Model.lean"]);
  assert.equal(frozen.status, 0, frozen.stdout);
  excludes(frozen.stdout, "WITNESS");
});

test("the Lean checker passes properties without a checked witness and counts each status", () => {
  const lines = [
    "WITNESS absent Model.a: no theorem Model.a.witness states ∃ (n : Nat), n < 3",
    "WITNESS checked Model.b",
    "WITNESS no-hypotheses Model.c",
    "WITNESS unavailable Model.d: the type of hz uses the proof of a hypothesis",
  ];
  const { result } = leanFixture("lake-search.log", { audit: [...lines, audited].join("\n") });
  assert.equal(result.status, 0, result.stdout);
  for (const line of lines) includes(result.stdout, line + "\n");
  includes(result.stdout, "kernel replay unavailable, 1 witnesses checked, 1 absent, 1 unavailable, 1 properties without hypotheses\n");
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

test("the Lean checker reads Lean's output as UTF-8 whatever the locale's encoding", () => {
  const type = "∀ (n : Nat), n ≤ n";
  const { project, check } = leanFixture("lake-search.log", { audit: statementAudit(statement("refl", "theorem", type)) });
  const result = check(["--freeze", "Model.lean"], undefined, { PYTHONUTF8: "0", PYTHONCOERCECLOCALE: "0", LC_ALL: "C" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [record] = JSON.parse(readFileSync(join(project, "Model.statements"), "utf8")).declarations;
  assert.equal(record.type, type);
  assert.equal(record.typeHash, createHash("sha256").update(type, "utf8").digest("hex"));
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

test("legacy opaque records require review and explicit re-freezing", () => {
  const audit = statementAudit(statement("step", "opaque", "Nat", "one"));
  const { project, check } = leanFixture("lake-search.log", { audit });
  assert.equal(check(["--freeze", "Model.lean"]).status, 0);
  const path = join(project, "Model.statements");
  const legacy = JSON.parse(readFileSync(path, "utf8"));
  legacy.declarations[0].valueHash = null;
  const contents = JSON.stringify(legacy);
  writeFileSync(path, contents);
  for (const value of ["one", "two"]) {
    const result = check(["Model.lean"], statementAudit(statement("step", "opaque", "Nat", value)));
    assert.equal(result.status, 1, result.stdout);
    includes(result.stdout, "FROZEN step: opaque body was not recorded; review the definition and run --freeze");
    excludes(result.stdout, "PASS ");
    assert.equal(readFileSync(path, "utf8"), contents);
  }
  assert.equal(check(["--freeze", "Model.lean"]).status, 0);
  assert.equal(check(["Model.lean"]).status, 0);
});

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

test("the Lean checker reports a python3 older than 3.9 as unavailable before building", () => {
  const { dir, check } = leanFixture("lake-search.log");
  command(dir, "python3", "echo 3.8.20\nexit 1");
  const result = check(["Model.lean"]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.stdout, "UNAVAILABLE python3 is Python 3.8.20; install Python 3.9 or later\n");
});

test("lean-check.sh honors TMPDIR, and on SIGTERM stops its build and the processes it started, cleans its temp dir and ends by SIGTERM", async () => {
  const dir = fixture();
  const project = join(dir, "lean");
  const leanTmp = join(dir, "lean-tmp");
  writeLeanProject(project);
  writeFileSync(join(project, "Model.lean"), "def x : Nat := 1\n");
  const readyFile = join(dir, "elan.ready");
  command(dir, "elan", [
    elanListsPin,
    '[ "$4" = "--version" ] && exit 0',
    'sleep 15 &',
    'echo "$$ $!" > "$TASK_READY_FILE"',
    'wait',
  ].join("\n"));
  const start = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn("bash", [join(scripts, "lean-check.sh"), project], {
      env: { ...process.env, PATH: join(dir, "bin") + ":" + process.env.PATH, TMPDIR: leanTmp, TASK_READY_FILE: readyFile, FORMAL_MIN_FREE_GIB: "0" },
    });
    const timer = setInterval(() => {
      if (existsSync(readyFile) && readFileSync(readyFile, "utf8").endsWith("\n")) {
        clearInterval(timer);
        child.kill("SIGTERM");
      }
    }, 20);
    child.on("close", (exitCode, signalName) => {
      clearInterval(timer);
      resolve({ exitCode, signalName });
    });
  });
  assert.ok(Date.now() - start < 4000, "lean-check.sh waited for child instead of exiting promptly on SIGTERM");
  for (const pid of readFileSync(readyFile, "utf8").trim().split(" ")) assertProcessStopped(Number(pid));
  assert.deepEqual(readdirSync(leanTmp), []);
  assert.equal(code.signalName, "SIGTERM", JSON.stringify(code));
});
