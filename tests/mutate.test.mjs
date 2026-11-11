// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { command, excludes, fakeTlc, fixture, includes, logs, removeFixtures, run, writeLeanProject } from "./helpers.mjs";

afterEach(removeFixtures);

function tlaMutations(checks, mutations, log = "tlc-invariant.log", specPath = "One.tla") {
  const dir = fixture();
  const spec = "---- MODULE One ----\nStep == x' = x + 1\n====\n";
  writeFileSync(join(dir, "One.tla"), spec);
  writeFileSync(join(dir, "One.matrix"), [`spec ${specPath}`, ...checks, "run n=4 | N=4", "run n=5 | N=5"].join("\n") + "\n");
  writeFileSync(join(dir, "One.mutations"), mutations.join("\n") + "\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  // TLC fails on a spec that holds BUG, and records the checks it was given.
  const java = fakeTlc(dir, [
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

test("the mutation runner finds its spec's matrix section however the spec line writes the path", () => {
  const { result } = tlaMutations(["check INVARIANTS Small"], ["mutation skip", "detects Small", "only n=4", "- x' = x + 1", "+ x' = x + 2 \\* BUG"], undefined, "./One.tla");
  assert.equal(result.stdout, "DETECTED skip: Small fails in run 'n=4' (Invariant Small is violated)\nSUMMARY 1 of 1 mutations detected\n");
  assert.equal(result.status, 0);
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

test("the mutation runner checks every mutation's lines before it runs any model", () => {
  const valid = ["mutation valid", "detects Small", "- x + 1", "+ x + 2 \\* BUG"];
  const cases = [
    [["mutation stale", "detects Small", "- y + 1", "+ y"], "mutation 'stale': its - text occurs 0 times"],
    [["mutation silent", "- x + 1", "+ x"], "mutation 'silent' has no detects line"],
    [["mutation twice", "detects Small", "detects Small", "- x + 1", "+ x"], "mutation 'twice' has two detects lines"],
  ];
  for (const [mutation, message] of cases) {
    const { dir, result } = tlaMutations(["check INVARIANTS Small"], [...valid, ...mutation]);
    assert.equal(result.status, 1);
    includes(result.stdout, message);
    excludes(result.stdout, "DETECTED");
    assert.equal(existsSync(join(dir, "calls")), false);
  }
});

function freezeRecord(path, theorems) {
  const declarations = theorems.map((name) => ({ name, kind: "theorem" }));
  writeFileSync(path, JSON.stringify({ declarations }));
}

function leanProject() {
  const dir = fixture();
  const project = join(dir, "lean");
  writeLeanProject(project);
  mkdirSync(join(project, "Model"));
  return { dir, project };
}

const leanNote = "NOTE Lean detections mean existing proofs fail, not that theorem statements are false or hypotheses satisfiable.\n";

const leanDecl = (name, line, { private: hidden = false, theorem = true } = {}) =>
  ({ name, private: hidden, theorem, start: [line, 0], end: [line + 1, 0] });

const leanError = (line, extra = {}) => ({ pos: { line, column: 2 }, data: "unsolved goals", ...extra });

const leanAnalysis = (declarations, errors = [], commands = []) => ({ declarations, errors, commands });

function leanMutations(model, frozen, baseline, mutations, outcomes) {
  const { dir, project } = leanProject();
  writeFileSync(join(project, "Model/Step.lean"), model);
  freezeRecord(join(project, "Model/Step.statements"), frozen);
  writeFileSync(join(project, "Model/Step.mutations"), mutations);
  const config = join(dir, "analysis.json");
  writeFileSync(config, JSON.stringify({ baseline, mutations: outcomes }));
  command(dir, "elan", [
    '[ "$4" = "--version" ] && { echo version >> "$TASK_TRACE"; exit 0; }',
    'echo analyse >> "$TASK_TRACE"',
    'python3 "$TASK_LEAN_DRIVER" "$TASK_LEAN_CONFIG" "${@: -1}"',
  ].join("\n"));
  const result = run(dir, "mutate.py", [join(project, "Model/Step.mutations")], {
    TASK_LEAN_DRIVER: join(logs, "lean-analysis.py"), TASK_LEAN_CONFIG: config,
  });
  assert.equal(readFileSync(join(project, "Model/Step.lean"), "utf8"), model);
  return {
    ...result,
    modelPath: realpathSync(join(project, "Model/Step.lean")),
    calls: readFileSync(join(dir, "calls"), "utf8").trim().split("\n"),
  };
}

const noStep = "mutation no step\n- n + 1\n+ n\n";

test("the Lean mutation runner checks the toolchain once for the whole run", () => {
  const decls = [leanDecl("Step.property", 2)];
  const { calls } = leanMutations("def step (n : Nat) : Nat := n + 1\n", ["Step.property"], leanAnalysis(decls),
    noStep + "\nmutation same step\n- n + 1\n+ 1 + n\n", [{ text: ":= n\n", analysis: leanAnalysis(decls, [leanError(2)]) }]);
  assert.deepEqual(calls, ["version", "analyse", "analyse", "analyse"]);
});

test("Lean mutation coverage preserves fully qualified identities and private exemptions", () => {
  const model = [
    "namespace Outer.Inner",
    "def step (n : Nat) : Nat := n + 1",
    "  @[simp] theorem property (n : Nat) : n < step n := by simp [step]",
    "namespace Other",
    "  theorem property (n : Nat) (h : n < 0) : n < step n := absurd h (Nat.not_lt_zero n)",
    "end Other",
    "private theorem helper : True := trivial",
    "theorem added : True := trivial",
    "end Outer.Inner",
  ].join("\n") + "\n";
  const decls = [leanDecl("Outer.Inner.step", 2, { theorem: false }),
    leanDecl("Outer.Inner.property", 3), leanDecl("Outer.Inner.Other.property", 5),
    leanDecl("Outer.Inner.helper", 7, { private: true }), leanDecl("Outer.Inner.added", 8)];
  const result = leanMutations(model,
    ["Outer.Inner.property", "Outer.Inner.Other.property", "Outer.Inner.helper", "Outer.Inner.step.eq_1"],
    leanAnalysis(decls), noStep, [{ text: ":= n\n", analysis: leanAnalysis(decls, [leanError(3)]) }]);
  assert.equal(result.stdout, "DETECTED no step: proof/check fails: theorem Outer.Inner.property\n"
    + "UNCOVERED theorem Outer.Inner.Other.property\n" + leanNote
    + "SUMMARY 1 of 1 mutations detected, 1 properties without a mutation\n");
  assert.equal(result.status, 1);
});

test("a failing Lean guard or example cannot cover an unrelated theorem", () => {
  const decls = [leanDecl("Step.vacuous", 2)];
  const commands = [{ property: "#guard", start: [3, 0], end: [4, 0] },
    { property: "example", start: [4, 0], end: [5, 0] }];
  const model = "def step (n : Nat) : Nat := n + 1\n"
    + "theorem vacuous : True := trivial\n#guard step 0 == 1\nexample : step 0 = 1 := rfl\n";
  const result = leanMutations(model, ["Step.vacuous"],
    leanAnalysis(decls), noStep,
    [{ text: ":= n\n", analysis: leanAnalysis(decls, [leanError(3), leanError(4)], commands) }]);
  assert.equal(result.stdout, `DETECTED no step: proof/check fails: #guard at ${result.modelPath}:3; example at ${result.modelPath}:4\n`
    + "UNCOVERED theorem Step.vacuous\n" + leanNote
    + "SUMMARY 1 of 1 mutations detected, 1 properties without a mutation\n");
  assert.equal(result.status, 1);
});

test("Lean proof sensitivity reports its limit even when every recorded proof breaks", () => {
  const model = "def step (n : Nat) : Nat := n + 1\n"
    + "theorem vacuous (n : Nat) (_h : n < 0) : n < step n := by simp [step]\n";
  const decls = [leanDecl("vacuous", 2)];
  const result = leanMutations(model, ["vacuous"], leanAnalysis(decls), noStep,
    [{ text: ":= n\n", analysis: leanAnalysis(decls, [leanError(2)]) }]);
  assert.equal(result.stdout, "DETECTED no step: proof/check fails: theorem vacuous\n"
    + leanNote + "SUMMARY 1 of 1 mutations detected\n");
  assert.equal(result.status, 0);
});

test("Lean mutations use the mutated declaration ranges after a multiline replacement", () => {
  const model = "def step (n : Nat) : Nat := n + 1\ntheorem grows (n : Nat) : n < step n := by simp [step]\n";
  const result = leanMutations(model, ["grows"], leanAnalysis([leanDecl("grows", 2)]),
    "mutation split line\n- n + 1\n+ n\n+ -- extra line\n",
    [{ text: "-- extra line", analysis: leanAnalysis([leanDecl("grows", 3)], [leanError(3)]) }]);
  assert.equal(result.status, 0, result.stdout);
  includes(result.stdout, "proof/check fails: theorem grows");
});

test("Lean command locations refer to the original model after lines are inserted or removed", () => {
  for (const [original, replacement, mutatedLine] of [["n + 1", "n\n-- extra line", 3],
    ["n + 1\n-- separator", "n", 2]]) {
    const model = `def step (n : Nat) : Nat := ${original}\n#guard step 0 == 1\n`;
    const originalLine = model.split("\n").findIndex((line) => line.startsWith("#guard")) + 1;
    const commands = [{ property: "#guard", start: [mutatedLine, 0], end: [mutatedLine + 1, 0] }];
    const edits = original.split("\n").map((line) => "- " + line)
      .concat(replacement.split("\n").map((line) => "+ " + line)).join("\n");
    const result = leanMutations(model, [], leanAnalysis([]), `mutation change lines\n${edits}\n`,
      [{ text: ":= n\n", analysis: leanAnalysis([], [leanError(mutatedLine)], commands) }]);
    assert.equal(result.status, 0, result.stdout);
    includes(result.stdout, `#guard at ${result.modelPath}:${originalLine}\n`);
  }
});

test("Lean locations label commands created inside a mutation replacement", () => {
  const commands = [{ property: "#guard", start: [2, 0], end: [3, 0] }];
  const result = leanMutations("def step (n : Nat) : Nat := n + 1\n", [], leanAnalysis([]),
    "mutation insert guard\n- n + 1\n+ n\n+ #guard step 0 == 1\n",
    [{ text: "#guard", analysis: leanAnalysis([], [leanError(2)], commands) }]);
  assert.equal(result.status, 0, result.stdout);
  includes(result.stdout, `#guard at ${result.modelPath}:1 (mutation replacement)\n`);
});

test("a Lean mutation with no error remains missed and its theorem remains uncovered", () => {
  const result = leanMutations("def step (n : Nat) : Nat := n + 1\n", ["Step.property"],
    leanAnalysis([leanDecl("Step.property", 2)]), noStep,
    [{ text: ":= n\n", analysis: leanAnalysis([leanDecl("Step.property", 2)]) }]);
  assert.equal(result.stdout, "MISSED no step\nUNCOVERED theorem Step.property\n" + leanNote
    + "SUMMARY 0 of 1 mutations detected, 1 properties without a mutation\n");
  assert.equal(result.status, 1);
});

test("Lean mutations reject definition, unattributed and external-file errors", () => {
  const decls = [leanDecl("Step.step", 1, { theorem: false }), leanDecl("Step.property", 2)];
  for (const error of [leanError(1), leanError(9), leanError(2, { fileName: "/elsewhere/Dep.lean" })]) {
    const result = leanMutations("def step (n : Nat) : Nat := n + 1\n", ["Step.property"],
      leanAnalysis(decls), noStep, [{ text: ":= n\n", analysis: leanAnalysis(decls, [error]) }]);
    assert.equal(result.status, 1);
    includes(result.stdout, "FAIL mutation 'no step' did not reach a verdict:");
    excludes(result.stdout, "DETECTED");
  }
});

test("the Lean mutation runner refuses a broken unmutated model", () => {
  const result = leanMutations("def step (n : Nat) : Nat := n + 1\n", [],
    leanAnalysis([], [leanError(1)]), noStep, []);
  assert.equal(result.status, 1);
  includes(result.stdout, "FAIL unmutated Lean model does not elaborate: unsolved goals");
  excludes(result.stdout, "DETECTED");
});

test("the mutation runner rejects a Lean detects line, which would cover a theorem that never fails, before running Lean", () => {
  const { dir, project } = leanProject();
  writeFileSync(join(project, "Model/Step.lean"), "def step (n : Nat) : Nat := n + 1\ntheorem vacuous (n : Nat) (h : n < 0) : n < step n := absurd h (Nat.not_lt_zero n)\n");
  freezeRecord(join(project, "Model/Step.statements"), ["vacuous"]);
  writeFileSync(join(project, "Model/Step.mutations"), "mutation no step\ndetects theorem vacuous\n- n + 1\n+ n\n");
  command(dir, "elan", 'echo elan >> "$TASK_TRACE"; exit 0');
  const result = run(dir, "mutate.py", [join(project, "Model/Step.mutations")]);
  assert.equal(result.stdout, "FAIL mutation 'no step': Lean mutations take no detects line; the runner names the theorems that fail\n");
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("the mutation runner rejects a Lean only line, which limits TLA+ runs alone, before running Lean", () => {
  const { dir, project } = leanProject();
  writeFileSync(join(project, "Model/Step.lean"), "def step (n : Nat) : Nat := n + 1\n");
  freezeRecord(join(project, "Model/Step.statements"), []);
  writeFileSync(join(project, "Model/Step.mutations"), "mutation no step\nonly n=1\n- n + 1\n+ n\n");
  command(dir, "elan", 'echo elan >> "$TASK_TRACE"; exit 0');
  const result = run(dir, "mutate.py", [join(project, "Model/Step.mutations")]);
  assert.equal(result.stdout, "FAIL mutation 'no step': Lean mutations do not support 'only'\n");
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(dir, "calls")), false);
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
      writeLeanProject(dir);
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
    JAVA: fakeTlc(dir, java),
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

test("malformed mutation matrix checks fail before running a model", () => {
  for (const check of ["check", "check INVARIANTS", "check UNKNOWN Small"]) {
    const { dir, result } = tlaMutations([check], ["mutation one", "detects Small", "- x + 1", "+ x"]);
    assert.equal(result.status, 1);
    includes(result.stdout, "malformed check");
    excludes(result.stderr, "Traceback");
    assert.equal(existsSync(join(dir, "calls")), false);
  }
});
