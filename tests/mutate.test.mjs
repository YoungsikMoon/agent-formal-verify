// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { command, elanListsPin, excludes, fakeTlc, fixture, includes, leanPin, logs, removeFixtures, run, scripts, writeLeanProject } from "./helpers.mjs";

afterEach(removeFixtures);

function tlaMutations(checks, mutations, log = "tlc-invariant.log", specPath = "One.tla", matrix) {
  const dir = fixture();
  const spec = "---- MODULE One ----\nStep == x' = x + 1\n====\n";
  writeFileSync(join(dir, "One.tla"), spec);
  writeFileSync(join(dir, "One.matrix"), (matrix ?? [`spec ${specPath}`, ...checks, "run n=4 | N=4", "run n=5 | N=5"]).join("\n") + "\n");
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
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "SPECIFICATION Spec\nINVARIANTS Small\n".repeat(2));
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

test("an independent TLC deadlock never counts as detection by a property or invariant", () => {
  for (const kind of ["PROPERTIES", "INVARIANTS"]) {
    const { dir, result } = tlaMutations([`check ${kind} Ends`], [
      "mutation never step", "detects Ends", "- x + 1", "+ x \\* BUG",
    ], "tlc-deadlock.log");
    assert.equal(result.status, 1);
    includes(result.stdout, "FAIL mutation 'never step' did not reach a verdict:\nFAIL One n=4: Error: Deadlock reached.");
    excludes(result.stdout, "DETECTED");
    const config = readFileSync(join(dir, "calls"), "utf8");
    if (kind === "PROPERTIES") includes(config, "CHECK_DEADLOCK FALSE");
    else excludes(config, "CHECK_DEADLOCK");
  }
});

test("temporal mutation detection requires TLC to report a property violation", () => {
  const { result } = tlaMutations(["check PROPERTY Ends"], [
    "mutation never step", "detects Ends", "- x + 1", "+ x \\* BUG",
  ], "tlc-liveness.log");
  assert.equal(result.status, 0, result.stdout);
  includes(result.stdout, "DETECTED never step: Ends fails in run 'n=4' (Temporal properties were violated)");
});

for (const [log, reason] of [["tlc-invariant.log", "Invariant Small is violated"],
  ["tlc-reach-initial.log", "Invariant ReachNegated is violated by the initial state:"]]) {
  test(`a box property detects a mutation when TLC names its inner invariant (${log})`, () => {
    const { result } = tlaMutations(["check PROPERTIES Safe"], [
      "mutation skip", "detects Safe", "- x + 1", "+ x \\* BUG",
    ], log);
    assert.equal(result.status, 0, result.stdout);
    includes(result.stdout, `DETECTED skip: Safe fails in run 'n=4' (${reason})`);
  });
}

test("an unrelated invariant failure cannot detect a named mutation", () => {
  const { result } = tlaMutations(["check INVARIANT Other"], [
    "mutation skip", "detects Other", "- x + 1", "+ x \\* BUG",
  ]);
  assert.equal(result.status, 1);
  includes(result.stdout, "did not reach a verdict");
  excludes(result.stdout, "DETECTED");
});

test("TLA mutation plans keep check order and reset checks at repeated spec sections", () => {
  for (const matrix of [
    ["spec One.tla", "run early | N=4", "check INVARIANT Small", "run later | N=5"],
    ["spec One.tla", "check INVARIANT Small", "run first | N=4", "spec ./One.tla", "run unchecked | N=5"],
  ]) {
    const { dir, result } = tlaMutations([], ["mutation harmless", "detects Small", "- x + 1", "+ 1 + x"], undefined, undefined, matrix);
    assert.equal(result.stdout, "MISSED harmless\nSUMMARY 0 of 1 mutations detected\n");
    assert.equal(readFileSync(join(dir, "calls"), "utf8"), "SPECIFICATION Spec\nINVARIANT Small\n".repeat(2));
  }
});

test("a mutation filter cannot move a target check onto an earlier run", () => {
  const { dir, result } = tlaMutations([], ["mutation skip", "detects Small", "only early", "- x + 1", "+ x \\* BUG"], undefined, undefined,
    ["spec One.tla", "run early | N=4", "check INVARIANT Small", "run later | N=5"]);
  assert.equal(result.status, 1);
  includes(result.stdout, "FAIL mutation 'skip': no run matches 'early' for 'Small'");
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("the mutation runner checks the unmutated TLA+ spec on every selected run before the first mutation", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\nStep == x' = x + 1\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\ncheck INVARIANTS Small\nrun n=4 | N=4\ncheck INVARIANTS Broken\nrun n=5 | N=5\n");
  writeFileSync(join(dir, "One.mutations"), [
    "mutation skip", "detects Small", "- x + 1", "+ x \\* BUG",
    "mutation stall", "detects Broken", "- x + 1", "+ x \\* BUG",
  ].join("\n") + "\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  // TLC records whether each run holds a mutation, and fails Broken on the unmutated spec too.
  // Small applies to both runs, so the unmutated spec runs three times before Broken fails.
  const java = fakeTlc(dir, [
    'for last; do :; done',
    'if grep -q BUG "$last"; then echo mutated; else echo unmutated; fi >> "$TASK_TRACE"',
    'if grep -q Broken "$(dirname "$last")/MC.cfg"; then echo "Error: Invariant Broken is violated."; exit 12; fi',
    'echo "Model checking completed. No error has been found."',
  ].join("\n"));
  const result = run(dir, "mutate.py", [join(dir, "One.mutations")], { JAVA: java, TLC_JAR: join(dir, "tools.jar") });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAIL unmutated model did not pass Broken: FAIL One n=5: Error: Invariant Broken is violated\./);
  excludes(result.stdout, "skip");
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "unmutated\n".repeat(3));
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
  const names = [["Step.step", "definition"], ...theorems.map((name) => [name, "theorem"])];
  const audit = names.map(([name, kind]) => ({
    module: "Model.Step", name, kind, type: "Prop", typeExpr: "Prop", valueExpr: null,
  }));
  const typeHash = createHash("sha256").update("Prop").digest("hex");
  const declarations = audit.map(({ name, kind, type }) => ({ name, kind, type, typeHash, valueHash: null }));
  writeFileSync(path, JSON.stringify({ format: 1, module: "Model.Step", toolchain: leanPin, declarations }));
  return audit.map((entry) => "STATEMENT " + JSON.stringify(entry)).join("\n");
}

function leanProject() {
  const dir = fixture();
  const project = join(dir, "lean");
  writeLeanProject(project);
  mkdirSync(join(project, "Model"));
  return { dir, project };
}

const leanNote = "NOTE Lean detections mean existing proofs fail, not that theorem statements are false or hypotheses satisfiable.\n";

const leanDecl = (name, line, { private: hidden = false, theorem = true, type = "Prop" } = {}) =>
  ({ name, private: hidden, theorem, type, start: [line, 0], end: [line + 1, 0] });

const leanCommand = (property, line, statement = "Prop") =>
  ({ property, statement, start: [line, 0], end: [line + 1, 0] });

const leanError = (line, extra = {}) => ({ pos: { line, column: 2 }, data: "unsolved goals", ...extra });

const leanAnalysis = (declarations, errors = [], commands = []) => ({ declarations, errors, commands });

function leanMutations(model, frozen, baseline, mutations, outcomes, env = {}) {
  const { dir, project } = leanProject();
  writeFileSync(join(project, "Model/Step.lean"), model);
  const audit = freezeRecord(join(project, "Model/Step.statements"), frozen);
  writeFileSync(join(project, "Model/Step.mutations"), mutations);
  command(dir, "lean", "exit 0");
  const config = join(dir, "analysis.json");
  writeFileSync(config, JSON.stringify({ baseline, mutations: outcomes }));
  command(dir, "elan", [
    elanListsPin,
    '[ "$4" = "--version" ] && { echo version >> "$TASK_TRACE"; exit 0; }',
    '[ "$6" = query ] && { echo "$TASK_PROJECT/.lake/build/lib/lean/Model/Step.olean"; exit 0; }',
    '[[ "$9" == */lean-analysis.lean && "${10}" == audit ]] && { echo "$TASK_AUDIT"; echo "AUDITED 1 declarations"; exit 0; }',
    `[ "$4" = --print-prefix ] && { echo "${dir}"; exit 0; }`,
    '[ "$6" = env ] && [ "$7" != lean ] && { shift 6; exec "$@"; }',
    'echo analyse >> "$TASK_TRACE"',
    '[[ "$9" == */lean-analysis.lean && "${10}" == analyze ]] || { echo "unexpected elan call: $*" >&2; exit 9; }',
    '[ -z "${TASK_LEAN_NOTE-}" ] || echo "$TASK_LEAN_NOTE"',
    '[ -z "${TASK_LEAN_FAIL-}" ] || exit 1',
    'python3 "$TASK_LEAN_DRIVER" "$TASK_LEAN_CONFIG" "${11}"',
  ].join("\n"));
  const result = run(dir, "mutate.py", [join(project, "Model/Step.mutations")], {
    TASK_PROJECT: project, TASK_AUDIT: audit, LEAN_PATH: join(project, ".lake/build/lib/lean"),
    TASK_LEAN_DRIVER: join(logs, "lean-analysis.py"), TASK_LEAN_CONFIG: config, ...env,
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

test("the Lean mutation runner reads Lean's output as UTF-8 whatever the locale's encoding", () => {
  const decls = [leanDecl("Step.property", 2)];
  const mutate = (env) => leanMutations("def step (n : Nat) : Nat := n + 1\n", ["Step.property"], leanAnalysis(decls), noStep,
    [{ text: ":= n\n", analysis: leanAnalysis(decls, [leanError(2)]) }], { TASK_LEAN_NOTE: "ℹ [info] ∀ n, n ≤ n", ...env });
  const ascii = { PYTHONUTF8: "0", PYTHONCOERCECLOCALE: "0", LC_ALL: "C" };
  for (const [env, expected] of [
    [{}, "DETECTED no step: proof/check fails: theorem Step.property\n" + leanNote + "SUMMARY 1 of 1 mutations detected\n"],
    [{ TASK_LEAN_FAIL: "1" }, "FAIL Lean declaration analysis did not complete:\nℹ [info] ∀ n, n ≤ n\n"],
  ]) {
    const utf8 = mutate(env);
    assert.equal(utf8.stdout, expected);
    const result = mutate({ ...env, ...ascii });
    assert.deepEqual([result.status, result.stdout, result.stderr], [utf8.status, utf8.stdout, utf8.stderr]);
  }
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
  const commands = [leanCommand("#guard", 3), leanCommand("example", 4)];
  const model = "def step (n : Nat) : Nat := n + 1\n"
    + "theorem vacuous : True := trivial\n#guard step 0 == 1\nexample : step 0 = 1 := rfl\n";
  const result = leanMutations(model, ["Step.vacuous"],
    leanAnalysis(decls, [], commands), noStep,
    [{ text: ":= n\n", analysis: leanAnalysis(decls, [leanError(3), leanError(4)], commands) }]);
  assert.equal(result.stdout, `DETECTED no step: proof/check fails: #guard at ${result.modelPath}:3; example at ${result.modelPath}:4\n`
    + "UNCOVERED theorem Step.vacuous\n" + leanNote
    + "SUMMARY 1 of 1 mutations detected, 1 properties without a mutation\n");
  assert.equal(result.status, 1);
});

for (const replacement of ["absurd h (Nat.lt_irrefl n)", ""]) {
  test(`a Lean mutation that edits only a theorem's proof reaches no verdict (${replacement ? "replaced" : "deleted"})`, () => {
    const model = "def step (n : Nat) : Nat := n + 1\n"
      + "theorem vacuous (n : Nat) (h : n < 0) : n < step n := absurd h (Nat.not_lt_zero n)\n";
    const decls = [leanDecl("vacuous", 2)];
    const result = leanMutations(model, ["vacuous"], leanAnalysis(decls),
      `mutation edit the proof\n- absurd h (Nat.not_lt_zero n)\n${replacement ? `+ ${replacement}\n` : ""}`,
      [{ text: ":= " + replacement + "\n", analysis: leanAnalysis(decls, [leanError(2)]) }]);
    assert.equal(result.status, 1, result.stdout);
    includes(result.stdout, "FAIL mutation 'edit the proof' did not reach a verdict:\n"
      + "theorem vacuous: the mutation edits this theorem");
    excludes(result.stdout, "DETECTED");
  });
}

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
    const edits = original.split("\n").map((line) => "- " + line)
      .concat(replacement.split("\n").map((line) => "+ " + line)).join("\n");
    const result = leanMutations(model, [], leanAnalysis([], [], [leanCommand("#guard", originalLine)]),
      `mutation change lines\n${edits}\n`,
      [{ text: ":= n\n", analysis: leanAnalysis([], [leanError(mutatedLine)], [leanCommand("#guard", mutatedLine)]) }]);
    assert.equal(result.status, 0, result.stdout);
    includes(result.stdout, `#guard at ${result.modelPath}:${originalLine}\n`);
  }
});

test("a guard restated inside the edit must identify a single original occurrence", () => {
  const guard = "#guard step 0 == 1";
  const commandAt = line => ({ ...leanCommand("#guard", line), end: [line, guard.length] });
  const source = "def step (n : Nat) : Nat := n + 1\n" + guard + "\n";
  const edit = `mutation restate guard\n- n + 1\n- ${guard}\n+ n\n+ ${guard}\n`;
  for (const duplicate of [false, true]) {
    const commands = duplicate ? [commandAt(2), commandAt(3)] : [commandAt(2)];
    const result = leanMutations(source, [], leanAnalysis([], [], [commandAt(2)]), edit + (duplicate ? `+ ${guard}\n` : ""),
      [{ text: ":= n\n", analysis: leanAnalysis([], [leanError(2)], commands) }]);
    if (duplicate) {
      assert.equal(result.status, 1, result.stdout);
      includes(result.stdout, "cannot match this #guard to a single original check");
    } else {
      assert.equal(result.status, 0, result.stdout);
      includes(result.stdout, `#guard at ${result.modelPath}:1 (mutation replacement)\n`);
    }
  }
});

test("an inserted Lean example cannot borrow another example's statement inside the same edit", () => {
  const original = "def one := 1\nexample : True := trivial";
  const mutation = ["mutation duplicate", "- def one := 1", "- example : True := trivial",
    "+ def one := 1", "+ example : True := by exact 0", "+ example : True := trivial", ""].join("\n");
  const result = leanMutations(original + "\n", [], leanAnalysis([], [], [leanCommand("example", 2)]),
    mutation,
    [{ text: "by exact 0", analysis: leanAnalysis([], [leanError(2)], [leanCommand("example", 2), leanCommand("example", 3)]) }]);
  assert.equal(result.status, 1, result.stdout);
  includes(result.stdout, "cannot match this example to a single original check");
  excludes(result.stdout, "DETECTED");
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

test("a Lean theorem whose statement the mutation changes or adds cannot count as a failing proof", () => {
  const baseline = leanAnalysis([leanDecl("Step.property", 2)]);
  for (const decl of [leanDecl("Step.property", 2, { type: "sorry" }), leanDecl("Step.added", 2)]) {
    const result = leanMutations("def step (n : Nat) : Nat := n + 1\n", ["Step.property"], baseline, noStep,
      [{ text: ":= n\n", analysis: leanAnalysis([decl], [leanError(2)]) }]);
    assert.equal(result.status, 1);
    includes(result.stdout, `FAIL mutation 'no step' did not reach a verdict:\ntheorem ${decl.name}: the mutation changes its statement`);
    excludes(result.stdout, "DETECTED");
  }
});

test("a Lean example or guard whose statement the mutation changes, adds or hides cannot count as a failing check", () => {
  const model = "def step (n : Nat) : Nat := n + 1\nexample : step 0 = 1 := rfl\n";
  for (const [unmutated, mutated, reason] of [
    [[leanCommand("example", 2)], leanCommand("example", 2, "sorry"), "the mutation changes its statement"],
    [[], leanCommand("#guard", 2), "cannot match this #guard to a single original check"],
    [[leanCommand("example", 2, null)], leanCommand("example", 2, null), "the mutation changes its statement"],
  ]) {
    const result = leanMutations(model, [], leanAnalysis([], [], unmutated), noStep,
      [{ text: ":= n\n", analysis: leanAnalysis([], [leanError(2)], [mutated]) }]);
    assert.equal(result.status, 1);
    includes(result.stdout, `FAIL mutation 'no step' did not reach a verdict:\n${mutated.property} at ${result.modelPath}:2: ${reason}`);
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

function reachMutation(java, matrix = "spec One.tla\nreach Full | n=4\nrun n=4 | N=4\n", only = "") {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\nStep == x + 1\n====\n");
  writeFileSync(join(dir, "One.matrix"), matrix);
  writeFileSync(join(dir, "One.mutations"), `mutation never full\ndetects reach:Full\n${only ? `only ${only}\n` : ""}- x + 1\n+ x \\* BUG\n`);
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  return run(dir, "mutate.py", [join(dir, "One.mutations")], {
    JAVA: fakeTlc(dir, [
      'for last; do :; done',
      'if ! grep -q BUG "$(dirname "$last")/One.tla"; then',
      '  invariant=$(sed -n "s/^INVARIANT //p" "$(dirname "$last")/MC.cfg")',
      '  echo "Error: Invariant $invariant is violated by the initial state:"; exit 12',
      'fi', java,
    ].join("\n")),
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

test("reach mutation filters retain the matrix's first selected run", () => {
  const result = reachMutation('echo "Model checking completed. No error has been found."',
    "spec One.tla\nreach Full | n=\nrun n=4 | N=4\nrun n=5 | N=5\n", "n=5");
  assert.equal(result.status, 1);
  includes(result.stdout, "FAIL mutation 'never full': no run matches 'n=5' for 'reach:Full'");
  excludes(result.stdout, "DETECTED");
});

test("reach mutation targets and run selection stay within repeated spec sections", () => {
  const result = reachMutation([
    'for last; do :; done',
    'if grep -q "N = 5" "$(dirname "$last")/MC.cfg"; then',
    '  echo "Error: unexpected run"; exit 1',
    'fi',
    'echo "Model checking completed. No error has been found."',
  ].join("\n"), "spec One.tla\nreach Full | chosen\nrun chosen | N=4\nspec ./One.tla\nreach Other | chosen\nrun chosen | N=5\n");
  assert.equal(result.status, 0, result.stdout);
  includes(result.stdout, "DETECTED never full: reach:Full fails in run 'chosen'");
});

test("a detected reach mutation cannot hide an incomplete run in another spec section", () => {
  const result = reachMutation([
    'for last; do :; done',
    'if grep -q "N = 5" "$(dirname "$last")/MC.cfg"; then',
    '  echo "Error: evaluation failed"; exit 1',
    'fi',
    'echo "Model checking completed. No error has been found."',
  ].join("\n"), "spec One.tla\nreach Full | chosen\nrun chosen | N=4\nspec ./One.tla\nreach Full | chosen\nrun chosen | N=5\n");
  assert.equal(result.status, 1);
  includes(result.stdout, "Error: evaluation failed");
  excludes(result.stdout, "DETECTED");
});

test("a reach planning error belongs to its spec even when two specs share a filename", () => {
  const result = reachMutation('echo "Model checking completed. No error has been found."',
    "spec nested/One.tla\nreach Full | missing\nspec ./One.tla\nreach Full | chosen\nrun chosen | N=4\n");
  assert.equal(result.status, 0, result.stdout);
  includes(result.stdout, "DETECTED never full: reach:Full fails in run 'chosen'");
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

test("timed-out reach and ordinary mutations never count as detected, and timed-out baselines stop", () => {
  const reachResult = (() => {
    const dir = fixture();
    writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\nStep == x + 1\n====\n");
    writeFileSync(join(dir, "One.matrix"), "spec One.tla\nreach Full | n=4\nrun n=4 | N=4\n");
    writeFileSync(join(dir, "One.mutations"), "mutation hang\ndetects reach:Full\n- x + 1\n+ x \\* BUG\n");
    writeFileSync(join(dir, "tools.jar"), "user supplied");
    return run(dir, "mutate.py", [join(dir, "One.mutations")], {
      JAVA: fakeTlc(dir, [
        'for last; do :; done',
        'if ! grep -q BUG "$(dirname "$last")/One.tla"; then',
        '  invariant=$(sed -n "s/^INVARIANT //p" "$(dirname "$last")/MC.cfg")',
        '  echo "Error: Invariant $invariant is violated by the initial state:"; exit 12',
        'fi',
        'sleep 3',
        'echo "Model checking completed. No error has been found."',
      ].join("\n")),
      TLC_JAR: join(dir, "tools.jar"),
      TLC_TIMEOUT: "1s",
    });
  })();
  assert.equal(reachResult.status, 1);
  includes(reachResult.stdout, "did not reach a verdict");
  includes(reachResult.stdout, "TLC timed out after 1s");
  excludes(reachResult.stdout, "DETECTED hang");

  for (const hangOriginal of [false, true]) {
    const dir = fixture();
    writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\nStep == x + 1\n====\n");
    writeFileSync(join(dir, "One.matrix"), "spec One.tla\ncheck INVARIANTS Small\nrun n=4 | N=4\n");
    writeFileSync(join(dir, "One.mutations"), "mutation hang\ndetects Small\n- x + 1\n+ x \\* BUG\n");
    writeFileSync(join(dir, "tools.jar"), "user supplied");
    const result = run(dir, "mutate.py", [join(dir, "One.mutations")], {
      JAVA: fakeTlc(dir, hangOriginal ? [
        'sleep 3',
        'echo "Model checking completed. No error has been found."',
      ].join("\n") : [
        'for last; do :; done',
        'if ! grep -q BUG "$(dirname "$last")/One.tla"; then',
        '  echo "Model checking completed. No error has been found."; exit 0',
        'fi',
        'sleep 3',
        'cat "$TLC_LOG"; exit 12',
      ].join("\n")),
      TLC_JAR: join(dir, "tools.jar"),
      TLC_LOG: join(logs, "tlc-invariant.log"),
      TLC_TIMEOUT: "1s",
    });
    assert.equal(result.status, 1);
    includes(result.stdout, hangOriginal ? "FAIL unmutated model did not pass Small" : "did not reach a verdict");
    includes(result.stdout, "TLC timed out after 1s");
    excludes(result.stdout, "DETECTED hang");
  }
});

test("reach mutations keep one worker for the baseline witness and allow TLC_WORKERS for the mutant", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\nStep == x + 1\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nreach Full | n=4\nrun n=4 | N=4\n");
  writeFileSync(join(dir, "One.mutations"), "mutation never full\ndetects reach:Full\n- x + 1\n+ x \\* BUG\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const result = run(dir, "mutate.py", [join(dir, "One.mutations")], {
    JAVA: fakeTlc(dir, [
      'printf "%s\\n" "$*" >> "$TASK_TRACE"',
      'for last; do :; done',
      'if ! grep -q BUG "$(dirname "$last")/One.tla"; then',
      '  invariant=$(sed -n "s/^INVARIANT //p" "$(dirname "$last")/MC.cfg")',
      '  echo "Error: Invariant $invariant is violated by the initial state:"; exit 12',
      'fi',
      'echo "Model checking completed. No error has been found."',
    ].join("\n")),
    TLC_JAR: join(dir, "tools.jar"),
    TLC_WORKERS: "4",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  assert.equal(calls.length, 2);
  includes(calls[0], "-workers 1");
  includes(calls[1], "-workers 4");
});

test("mutate.py flushes each verdict immediately on non-TTY pipes", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\na == x + 1\nb == x + 2\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\ncheck INVARIANTS Small\nrun n=4 | N=4\n");
  writeFileSync(join(dir, "One.mutations"), [
    "mutation first", "detects Small", "- x + 1", "+ x \\* BUG1",
    "mutation second", "detects Small", "- x + 2", "+ x \\* BUG2",
  ].join("\n") + "\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = fakeTlc(dir, [
    'for last; do :; done',
    'if grep -q BUG2 "$last"; then sleep 0.6; fi',
    'if grep -q BUG "$last"; then cat "$TLC_LOG"; exit 12; fi',
    'echo "Model checking completed. No error has been found."',
  ].join("\n"));
  const times = [];
  await new Promise((resolve, reject) => {
    const child = spawn("python3", [join(scripts, "mutate.py"), join(dir, "One.mutations")], {
      env: { ...process.env, JAVA: java, TLC_JAR: join(dir, "tools.jar"), TLC_LOG: join(logs, "tlc-invariant.log") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
      if (out.includes("DETECTED first:") && times.length === 0) times.push(Date.now());
      if (out.includes("SUMMARY 2 of 2") && times.length === 1) times.push(Date.now());
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${out}`))));
  });
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 350, `expected streamed first verdict before delayed second verdict (${times[1] - times[0]}ms)`);
});
