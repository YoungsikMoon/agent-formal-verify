// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fixture, installKani, removeFixtures, root, run, scripts } from "./helpers.mjs";

afterEach(removeFixtures);

const examples = join(root, "skills/formal-verify/examples");

function models() {
  const dir = realpathSync(fixture());
  for (const folder of ["tla", "lean", "kani"]) mkdirSync(join(dir, folder));
  const paths = {
    matrix: join(dir, "tla/BoundedQueue.matrix"),
    spec: join(dir, "tla/BoundedQueue.tla"),
    statements: join(dir, "lean/BoundedQueue.statements"),
    rust: join(dir, "kani/lib.rs"),
    record: join(dir, "record.json"),
  };
  // The TLA+ cases edit this counter spec's exact text, so they read a fixed copy rather than the template.
  copyFileSync(join(root, "tests/fixtures/tla-baseline/BoundedQueue.matrix"), paths.matrix);
  copyFileSync(join(root, "tests/fixtures/tla-baseline/BoundedQueue.tla"), paths.spec);
  copyFileSync(join(examples, "lean-template/Model/BoundedQueue.statements"), paths.statements);
  copyFileSync(join(examples, "kani-template/src/lib.rs"), paths.rust);
  return { dir, ...paths };
}

// Kani is the fake that a test installs at dir/kani, or absent, whatever this machine has installed.
const baseline = (dir, ...args) => run(dir, "baseline.py", args, { KANI_HOME: join(dir, "kani") });
const lines = (result) => result.stdout.split("\n").filter(Boolean);
// Install the fake Kani at dir/kani, compiling each of names from target.
const compiles = (dir, target, names) =>
  installKani(dir, { harnesses: Object.fromEntries(names.map((name) => [name, 1])), harnessSources: Object.fromEntries(names.map((name) => [name, target])) });

function edit(path, from, to) {
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes(from), `${path} lacks ${JSON.stringify(from)}`);
  writeFileSync(path, text.replace(from, to));
}

function rewriteStatements(path, change) {
  const record = JSON.parse(readFileSync(path, "utf8"));
  change(record);
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
}

function recordedThenEdited(setup, target, change) {
  const files = models();
  setup?.(files);
  assert.equal(baseline(files.dir, "record", files.record, files[target]).status, 0);
  change(files);
  const result = baseline(files.dir, "compare", files.record);
  return { files, result, out: lines(result) };
}

function assertChanged({ files, result, out }, target, ...details) {
  assert.equal(result.status, 1);
  assert.equal(out[0], `CHANGED ${files[target]}`);
  assert.equal(out.at(-1), "SUMMARY 0 unchanged, 1 changed");
  for (const detail of details) assert.ok(out.some((line) => line.includes(detail)), `${JSON.stringify(out)} lacks ${detail}`);
}

function assertUnchanged({ files, result, out }, target) {
  assert.equal(result.status, 0);
  assert.deepEqual(out, [`UNCHANGED ${files[target]}`, "SUMMARY 1 unchanged, 0 changed"]);
}

const tla = (from, to) => (change) => edit(change.spec, from, to);
const rust = (from, to) => (change) => edit(change.rust, from, to);

function crate(files) {
  const dir = realpathSync(fixture());
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

// Read the routes to target in a crate of files with a new RouteReader, as [crate root relative to the crate, guards,
// module path], with the label the record holds for them, or the reader's error with the crate's path as <crate>.
function routes(files, target) {
  const dir = crate(files);
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "from pathlib import Path",
    "import kani_reader",
    `crate, path = Path(${JSON.stringify(dir)}), Path(${JSON.stringify(join(dir, target))})`,
    "try:",
    "    found = kani_reader.RouteReader().routes(path)",
    "except ValueError as error:",
    "    print(json.dumps({'error': str(error).replace(str(crate), '<crate>')}))",
    "else:",
    "    routes = [[str(route.root.relative_to(crate)), route.guards, route.module] for route in found]",
    "    print(json.dumps({'routes': routes, 'label': kani_reader.route_label(path, found)}))",
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const harness = "#[kani::proof]\nfn a() { kani::cover!(true); }\n";
const cargoToml = '[package]\nname = "p"\nversion = "0.1.0"\n';

test("a re-frozen Lean declaration is changed and named, whichever hash moved", () => {
  for (const field of ["typeHash", "valueHash"]) {
    const outcome = recordedThenEdited(null, "statements", ({ statements }) =>
      rewriteStatements(statements, (record) => {
        record.declarations.find((entry) => entry.name === "BoundedQueue.Invariant")[field] = "0".repeat(64);
      }));
    assertChanged(outcome, "statements", "changed declaration BoundedQueue.Invariant");
  }
});

test("a Lean declaration added after the record is allowed", () => {
  const outcome = recordedThenEdited(null, "statements", ({ statements }) =>
    rewriteStatements(statements, (record) => {
      record.declarations.push({ name: "BoundedQueue.helper", kind: "theorem", type: "True", typeHash: "1".repeat(64), valueHash: null });
    }));
  assertUnchanged(outcome, "statements");
});

test("a removed Lean declaration and a changed toolchain are changed", () => {
  const removed = recordedThenEdited(null, "statements", ({ statements }) =>
    rewriteStatements(statements, (record) => {
      record.declarations = record.declarations.filter((entry) => entry.name !== "BoundedQueue.claim");
    }));
  assertChanged(removed, "statements", "removed declaration BoundedQueue.claim");
  const toolchain = recordedThenEdited(null, "statements", ({ statements }) =>
    rewriteStatements(statements, (record) => {
      record.toolchain = "leanprover/lean4:v4.0.0";
    }));
  assertChanged(toolchain, "statements", "changed toolchain");
});

test("a TLA+ check line that loses a property is changed", () => {
  const outcome = recordedThenEdited(null, "matrix", ({ matrix }) => edit(matrix, "check INVARIANTS TypeOK InWindow", "check INVARIANTS TypeOK"));
  assertChanged(outcome, "matrix", "removed check BoundedQueue.tla INVARIANTS InWindow");
});

test("moving TLA+ checks below their runs loses those runs' guarantees", () => {
  const outcome = recordedThenEdited(null, "matrix", ({ matrix }) => {
    const text = readFileSync(matrix, "utf8");
    const checks = text.split("\n").filter((line) => line.startsWith("check "));
    writeFileSync(matrix, text.split("\n").filter((line) => !line.startsWith("check ")).join("\n") + checks.join("\n") + "\n");
  });
  assertChanged(outcome, "matrix", "removed check BoundedQueue.tla INVARIANTS InWindow");
});

test("a TLA+ reach check records the first matching run's inputs", () => {
  const setup = ({ matrix }) => edit(matrix, "reach WindowFull | window=1", "reach WindowFull | window=");
  const outcome = recordedThenEdited(setup, "matrix", ({ matrix }) => {
    const text = readFileSync(matrix, "utf8");
    const runs = text.split("\n").filter((line) => line.startsWith("run "));
    writeFileSync(matrix, text.split("\n").filter((line) => !line.startsWith("run ")).join("\n") + runs.reverse().join("\n") + "\n");
  });
  assertChanged(outcome, "matrix", "changed reach BoundedQueue.tla WindowFull");
});

test("repeated TLA+ spec sections keep their checks attached to their own runs", () => {
  const setup = ({ matrix }) => writeFileSync(matrix, [
    "spec BoundedQueue.tla", "check INVARIANTS TypeOK InWindow", "run first | Window=1 Items=3",
    "spec BoundedQueue.tla", "check INVARIANTS TypeOK", "run second | Window=2 Items=3", "",
  ].join("\n"));
  const outcome = recordedThenEdited(setup, "matrix", ({ matrix }) => {
    edit(matrix, "check INVARIANTS TypeOK InWindow", "check INVARIANTS TypeOK");
    edit(matrix, "run second", "check INVARIANTS InWindow\nrun second");
  });
  assertChanged(outcome, "matrix", "removed check BoundedQueue.tla INVARIANTS InWindow | [run BoundedQueue.tla first]");
});

test("adding a TLA+ check strengthens an existing run without changing its baseline", () => {
  const setup = ({ matrix }) => edit(matrix, "check INVARIANTS TypeOK InWindow", "check INVARIANTS TypeOK");
  const outcome = recordedThenEdited(setup, "matrix", ({ matrix }) => edit(matrix, "check INVARIANTS TypeOK", "check INVARIANTS TypeOK InWindow"));
  assertUnchanged(outcome, "matrix");
});

test("duplicate TLA+ checks cannot stand in for a check on a different occurrence of the same run label", () => {
  const section = "spec BoundedQueue.tla\ncheck INVARIANTS TypeOK InWindow\nrun same | Window=1 Items=3\n";
  const setup = ({ matrix }) => writeFileSync(matrix, section + section);
  const outcome = recordedThenEdited(setup, "matrix", ({ matrix }) => writeFileSync(matrix,
    section.replace("TypeOK InWindow", "TypeOK InWindow InWindow") + section.replace("TypeOK InWindow", "TypeOK")));
  assertChanged(outcome, "matrix", "removed check BoundedQueue.tla INVARIANTS InWindow");
});

test("an unedited matrix that repeats a spec section compares unchanged", () => {
  const section = "spec BoundedQueue.tla\ncheck INVARIANTS TypeOK InWindow\nrun same | Window=1 Items=3\n";
  const setup = ({ matrix }) => writeFileSync(matrix, section + section);
  assertUnchanged(recordedThenEdited(setup, "matrix", () => {}), "matrix");
});

test("a TLA+ Spec that loses fairness is changed", () => {
  assertChanged(recordedThenEdited(null, "matrix", tla(" /\\ WF_vars(Consume)", "")), "matrix", "changed definition BoundedQueue.tla Spec");
});

test("a TLA+ subscript that Spec names under [][...]_ and WF_ is changed", () => {
  const outcome = recordedThenEdited(null, "matrix", tla("vars == <<next, consumed>>", "vars == <<next>>"));
  assertChanged(outcome, "matrix", "changed definition BoundedQueue.tla vars");
});

test("a TLA+ subscript is followed in a fairness definition, under a quantifier and after spaces", () => {
  const spec = "Spec == Init /\\ [][Next]_vars /\\ WF_vars(Claim) /\\ WF_vars(Consume)";
  const shapes = [
    "Fairness == WF_vars(Claim) /\\ WF_vars(Consume)\nSpec == Init /\\ [][Next]_<<next, consumed>> /\\ Fairness",
    "Act(k) == Claim \\/ Consume\nSpec == Init /\\ [][Next]_<<next, consumed>> /\\ \\A k \\in {1} : WF_vars(Act(k))",
    "Spec == Init /\\ [] [Next]_vars",
    "Spec == Init /\\ [][Next]_<<next, consumed>> /\\ []<><<Consume>>_vars",
  ];
  for (const shape of shapes) {
    const setup = (files) => {
      edit(files.spec, "UNCHANGED vars", "UNCHANGED <<next, consumed>>");
      edit(files.spec, spec, shape);
    };
    const outcome = recordedThenEdited(setup, "matrix", tla("vars == <<next, consumed>>", "vars == <<next>>"));
    assertChanged(outcome, "matrix", "changed definition BoundedQueue.tla vars");
  }
});

test("a weakened TLA+ property is changed", () => {
  const outcome = recordedThenEdited(null, "matrix", tla("next <= consumed + Window", "next <= consumed + Window + 1"));
  assertChanged(outcome, "matrix", "changed definition BoundedQueue.tla InWindow");
});

test("a TLA+ helper that a property references is changed, and an action that none references is not", () => {
  const helper = tla("AllConsumed == <>(consumed = Items)", "Finished == consumed = Items\nAllConsumed == <>Finished");
  const outcome = recordedThenEdited(helper, "matrix", tla("Finished == consumed = Items", "Finished == consumed >= 0"));
  assertChanged(outcome, "matrix", "changed definition BoundedQueue.tla Finished");
  assertUnchanged(recordedThenEdited(null, "matrix", tla("next' = next + 1", "next' = next + 2")), "matrix");
});

test("a TLA+ operator that only a function definition's domain references is changed", () => {
  const helper = tla("InWindow == consumed <= next /\\ next <= consumed + Window",
    "Slots == 0..Window\nFits[k \\in Slots] == next <= consumed + k\nInWindow == consumed <= next /\\ \\E k \\in DOMAIN Fits : Fits[k]");
  const outcome = recordedThenEdited(helper, "matrix", tla("Slots == 0..Window", "Slots == 0..Items"));
  assertChanged(outcome, "matrix", "changed definition BoundedQueue.tla Slots");
});

test("TLA+ properties follow transitive local imports and leave unrelated action bodies free to change", () => {
  function setup(files) {
    edit(files.spec, "EXTENDS Naturals", "EXTENDS Naturals,\n  Predicates");
    edit(files.spec, "AllConsumed == <>(consumed = Items)", "AllConsumed == <>Finished(consumed, Items)");
    writeFileSync(join(files.dir, "tla/Predicates.tla"),
      "---- MODULE Predicates ----\nEXTENDS Limits\nFinished(n, total) == Equal(n, total)\n====\n");
    writeFileSync(join(files.dir, "tla/Limits.tla"),
      "---- MODULE Limits ----\nEqual(n, m) == n = m\nOtherAction == TRUE\n====\n");
  }
  const change = (from, to) => ({ dir }) => edit(join(dir, "tla/Limits.tla"), from, to);
  assertChanged(recordedThenEdited(setup, "matrix", change("n = m", "TRUE")), "matrix", "changed definition Limits.tla Equal");
  assertUnchanged(recordedThenEdited(setup, "matrix", change("OtherAction == TRUE", "OtherAction == FALSE")), "matrix");
});

test("a multi-line LOCAL definition with a tab after LOCAL does not hide the imported operator of that name", () => {
  function setup(files) {
    edit(files.spec, "EXTENDS Naturals", "EXTENDS Naturals, Shared, Hidden");
    edit(files.spec, "AllConsumed == <>(consumed = Items)", "AllConsumed == <>Finished(consumed, Items)");
    writeFileSync(join(files.dir, "tla/Shared.tla"), "---- MODULE Shared ----\nFinished(n, total) == n = total\n====\n");
    writeFileSync(join(files.dir, "tla/Hidden.tla"), "---- MODULE Hidden ----\nLOCAL\tFinished(n, total) ==\n  TRUE\n====\n");
  }
  assertChanged(recordedThenEdited(setup, "matrix", ({ dir }) => edit(join(dir, "tla/Shared.tla"), "n = total", "TRUE")),
    "matrix", "changed definition Shared.tla Finished");
});

test("a locally imported operator with an indented header is tracked", () => {
  const setup = (files) => {
    edit(files.spec, "EXTENDS Naturals", "EXTENDS Naturals, Limits");
    edit(files.spec, "AllConsumed == <>(consumed = Items)", "AllConsumed == <>Equal(consumed, Items)");
    writeFileSync(join(files.dir, "tla/Limits.tla"), "---- MODULE Limits ----\n  Equal(n, m) == n = m\n====\n");
  };
  assertChanged(recordedThenEdited(setup, "matrix", ({ dir }) =>
    edit(join(dir, "tla/Limits.tla"), "n = m", "TRUE")), "matrix", "Limits.tla");
});

test("a local TLA+ instance retains both its operator bodies and its substitutions", () => {
  function setup(files) {
    edit(files.spec, "AllConsumed == <>(consumed = Items)",
      "Bounds == INSTANCE Limit WITH Max <- Items\nAllConsumed == <>Bounds!Finished(consumed)");
    writeFileSync(join(files.dir, "tla/Limit.tla"),
      "---- MODULE Limit ----\nCONSTANT Max\nFinished(n) == n = Max\n====\n");
  }
  assertChanged(recordedThenEdited(setup, "matrix", ({ dir }) =>
    edit(join(dir, "tla/Limit.tla"), "n = Max", "TRUE")), "matrix", "Limit.tla");
  assertChanged(recordedThenEdited(setup, "matrix", tla("Max <- Items", "Max <- Window")), "matrix", "BoundedQueue.tla");
});

test("pre-import TLA+ baselines require review and can be recorded again", () => {
  const files = models();
  assert.equal(baseline(files.dir, "record", files.record, files.matrix).status, 0);
  const record = JSON.parse(readFileSync(files.record, "utf8"));
  delete record.models[files.matrix].surface["imports BoundedQueue.tla"];
  writeFileSync(files.record, JSON.stringify(record));
  const compared = baseline(files.dir, "compare", files.record);
  assert.equal(compared.status, 1);
  assert.match(compared.stdout, /previous baseline did not track imported modules/);
  assert.equal(baseline(files.dir, "record", files.record, files.matrix).status, 0);
  assert.equal(baseline(files.dir, "compare", files.record).status, 0);
});

test("a pre-layout TLA+ record requires review even if the model has only single-line definitions", () => {
  const files = models();
  assert.equal(baseline(files.dir, "record", files.record, files.matrix).status, 0);
  const record = JSON.parse(readFileSync(files.record, "utf8"));
  delete record.models[files.matrix].surface["TLA+ layout version"];
  writeFileSync(files.record, JSON.stringify(record));
  const result = baseline(files.dir, "compare", files.record);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /did not preserve TLA\+ layout/);
});

test("indented LET definitions keep per-definition records for actions and properties", () => {
  const setup = (files) => {
    edit(files.spec, "         /\\ next' = next + 1", "         /\\ LET step == 1\n            IN next' = next + step");
    edit(files.spec, "AllConsumed == <>(consumed = Items)", "AllConsumed ==\n    LET done == consumed = Items\n    IN <>done");
  };
  assertUnchanged(recordedThenEdited(setup, "matrix", tla("step == 1", "step == 2")), "matrix");
  assertChanged(recordedThenEdited(setup, "matrix", tla("done == consumed = Items", "done == consumed >= 0")),
    "matrix", "changed definition BoundedQueue.tla AllConsumed");
});

test("a nested LET closes only its own scope, so a later definition of the outer LET stays local", () => {
  const setup = tla("AllConsumed == <>(consumed = Items)",
    "AllConsumed ==\n    LET done == LET all == Items IN consumed = all\n        also == TRUE\n    IN <>(done /\\ also)");
  assertChanged(recordedThenEdited(setup, "matrix", tla("also == TRUE", "also == FALSE")),
    "matrix", "changed definition BoundedQueue.tla AllConsumed");
});

test("an imported module with an indented LET definition keeps per-definition records", () => {
  const setup = (files) => {
    edit(files.spec, "EXTENDS Naturals", "EXTENDS Naturals, Limits");
    edit(files.spec, "AllConsumed == <>(consumed = Items)", "AllConsumed == <>Equal(consumed, Items)");
    writeFileSync(join(files.dir, "tla/Limits.tla"),
      "---- MODULE Limits ----\nEqual(n, m) ==\n  LET same == n = m IN same\nOtherAction == TRUE\n====\n");
  };
  const change = (from, to) => ({ dir }) => edit(join(dir, "tla/Limits.tla"), from, to);
  assertChanged(recordedThenEdited(setup, "matrix", change("same == n = m", "same == TRUE")), "matrix", "changed definition Limits.tla Equal");
  assertUnchanged(recordedThenEdited(setup, "matrix", change("OtherAction == TRUE", "OtherAction == FALSE")), "matrix");
});

test("an indented TLA+ definition after a LET closes, or a column-0 one inside a LET, compares the whole module", () => {
  for (const replacement of [
    "Unused ==\n  LET one == 1 IN one\n  Finished == consumed = Items\nAllConsumed == <>Finished",
    "AllConsumed ==\n  LET\nFinished == consumed = Items\n  IN <>Finished",
    "AllConsumed ==\n  LET Finished == consumed = Items\na ++ b == a + b\n  IN <>Finished",
  ]) {
    const setup = tla("AllConsumed == <>(consumed = Items)", replacement);
    assertChanged(recordedThenEdited(setup, "matrix", tla("Finished == consumed = Items", "Finished == TRUE")),
      "matrix", "changed module text");
  }
});

test("a TLA+ Init that Spec narrows is changed", () => {
  assertChanged(recordedThenEdited(null, "matrix", tla("Init == next = 0 /\\ consumed = 0", "Init == next = 0 /\\ consumed = 0 /\\ Items = 0")), "matrix", "changed definition BoundedQueue.tla Init");
});

test("an edit on an unindented continuation line of a TLA+ property is changed", () => {
  const unindented = tla("InWindow == consumed <= next /\\ next <= consumed + Window", "InWindow ==\nconsumed <= next /\\\nnext <= consumed + Window");
  const outcome = recordedThenEdited(unindented, "matrix", tla("\nnext <= consumed + Window", "\nnext <= consumed + Window + 1"));
  assertChanged(outcome, "matrix", "changed definition BoundedQueue.tla InWindow");
});

test("a TLA+ operator with an operator parameter is its own recorded definition", () => {
  const higherOrder = (files) => {
    edit(files.spec, "InWindow == consumed <= next /\\ next <= consumed + Window", "InWindow == consumed <= next /\\ next <= consumed + Window /\\ Holds(Bounded)");
    edit(files.spec, "\nSpec ==", "\nBounded(n) == n >= 0\nHolds(P(_)) == P(next)\n\nSpec ==");
  };
  const outcome = recordedThenEdited(higherOrder, "matrix", tla("Holds(P(_)) == P(next)", "Holds(P(_)) == TRUE"));
  assertChanged(outcome, "matrix", "changed definition BoundedQueue.tla Holds");
});

test("TLA+ definitions with nested brackets or a leading digit are their own recorded definitions", () => {
  const named = (files) => {
    edit(files.spec, "InWindow == consumed <= next /\\ next <= consumed + Window", "InWindow == consumed <= next /\\ next <= 1aBound /\\ Pair[[a |-> 0]] = 0");
    edit(files.spec, "\nSpec ==", "\n1aBound == consumed + Window\nPair[r \\in [a : {0, 1}]] == r.a\n\nSpec ==");
  };
  assertChanged(recordedThenEdited(named, "matrix", tla("1aBound == consumed + Window", "1aBound == consumed + Window + 1")), "matrix", "changed definition BoundedQueue.tla 1aBound");
  assertChanged(recordedThenEdited(named, "matrix", tla("== r.a", "== 0")), "matrix", "changed definition BoundedQueue.tla Pair");
});

test("a column-0 TLA+ definition the record cannot name is recorded whether or not a property names it", () => {
  const infix = (files) => edit(files.spec, "\nSpec ==", "\na \\prec b == a < b\n\nSpec ==");
  assertChanged(recordedThenEdited(infix, "matrix", tla("a \\prec b == a < b", "a \\prec b == a <= b")), "matrix", "changed definition BoundedQueue.tla a \\prec b");
  const local = tla("InWindow == consumed <= next /\\ next <= consumed + Window", "InWindow ==\nLET d == consumed + Window IN\nconsumed <= next /\\ next <= d");
  assertChanged(recordedThenEdited(local, "matrix", tla("consumed + Window IN", "consumed + Window + 1 IN")), "matrix", "changed definition BoundedQueue.tla LET d");
});

test("a TLA+ comment edit and an added run line leave the model unchanged", () => {
  assertUnchanged(recordedThenEdited(null, "matrix", tla("\\* Stutter at the end", "\\* Stutters at the very end")), "matrix");
  assertUnchanged(recordedThenEdited(null, "matrix", tla("consumed <= next /\\", "consumed <=   next (* why *) /\\")), "matrix");
  assertUnchanged(recordedThenEdited(null, "matrix", ({ matrix }) => edit(matrix, "run window=4 items=0 | Window=4 Items=0", "run window=4 items=0 | Window=4 Items=0\nrun window=2 items=2 | Window=2 Items=2")), "matrix");
});

test("TLA+ comment markers inside strings do not hide changes to a property", () => {
  for (const literal of [String.raw`"(*"`, String.raw`"\\*"`, String.raw`"\"(*"`]) {
    const property = `AllConsumed == <>(consumed = Items) /\\ ${literal} # "bad"`;
    const setup = tla("AllConsumed == <>(consumed = Items)", property);
    assertChanged(recordedThenEdited(setup, "matrix", tla(' # "bad"', ' # "worse"')), "matrix", "changed definition BoundedQueue.tla AllConsumed");
  }
});

test("whitespace inside TLA+ string literals is part of the property", () => {
  const setup = tla("AllConsumed == <>(consumed = Items)", 'AllConsumed == <>(consumed = Items) /\\ "a b" # "a  b"');
  assertChanged(recordedThenEdited(setup, "matrix", tla('"a  b"', '"a b"')), "matrix", "changed definition BoundedQueue.tla AllConsumed");
});

test("a TLA+ run whose constants change is changed", () => {
  const outcome = recordedThenEdited(null, "matrix", ({ matrix }) => edit(matrix, "Window=4 Items=5", "Window=4 Items=1"));
  assertChanged(outcome, "matrix", "changed run BoundedQueue.tla window=4 items=5");
});

test("a TLA+ property that names a missing operator fails", () => {
  const files = models();
  edit(files.matrix, "check PROPERTIES AllConsumed", "check PROPERTIES NoSuchProperty");
  const result = baseline(files.dir, "record", files.record, files.matrix);
  assert.equal(result.status, 1);
  assert.ok(lines(result)[0].startsWith("FAIL baseline:"));
  assert.ok(result.stdout.includes("NoSuchProperty"));
});

test("a malformed matrix line fails the record", () => {
  const files = models();
  edit(files.matrix, "reach WindowFull | window=1", "reach WindowFull");
  const result = baseline(files.dir, "record", files.record, files.matrix);
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes("malformed reach"));
});

test("an added Kani assume is changed", () => {
  const outcome = recordedThenEdited(null, "rust", rust("kani::assume(window > 0 && window <= 2);", "kani::assume(window > 0 && window <= 2);\n        kani::assume(state.next == 0);"));
  assertChanged(outcome, "rust", "added assume state.next == 0");
});

test("a cfg that can switch a recorded Kani harness off is changed, and cfg(kani) is not", () => {
  const guarded = recordedThenEdited(null, "rust", rust("    #[kani::proof]\n    #[kani::unwind(2)]\n    fn consume_keeps_invariant", "    #[cfg(feature = \"slow-proofs\")]\n    #[kani::proof]\n    #[kani::unwind(2)]\n    fn consume_keeps_invariant"));
  assertChanged(guarded, "rust", "changed harness proofs::consume_keeps_invariant", 'new: cfg(feature = "slow-proofs")');
  const module = recordedThenEdited(null, "rust", rust("#[cfg(kani)]\nmod proofs {", "#[cfg(kani)]\n#[cfg(not(miri))]\nmod proofs {\n    #![cfg(target_os = \"linux\")]"));
  assertChanged(module, "rust", "changed harness proofs::claim_keeps_invariant", 'new: cfg(not(miri)) cfg(target_os = "linux")');
  const file = recordedThenEdited(null, "rust", ({ rust: path }) => writeFileSync(path, `#![cfg(unix)]\n${readFileSync(path, "utf8")}`));
  assertChanged(file, "rust", "new: cfg(unix)");
  const setup = ({ rust: path }) => writeFileSync(path, "#[cfg(feature = \"a\")] #[kani::proof] fn first() {}");
  assertChanged(recordedThenEdited(setup, "rust", rust("#[cfg(feature = \"a\")] ", "")), "rust", 'old: cfg(feature = "a")');
  const nested = ({ rust: path }) => writeFileSync(path, "#[cfg(b)] mod m { #![cfg(c)] fn outer() { #[cfg(d)] #[kani::proof] fn inner() {} } }");
  const removed = recordedThenEdited(nested, "rust", rust("#[cfg(b)] ", ""));
  assertChanged(removed, "rust", "changed harness m::outer::inner");
  assert.ok(removed.out.includes("    old: cfg(b) cfg(c) cfg(d)"), JSON.stringify(removed.out));
  const attribute = recordedThenEdited(setup, "rust", rust("#[kani::proof]", "#[cfg_attr(kani, cfg(not(miri)))] #[kani::proof]"));
  assertChanged(attribute, "rust", 'new: cfg(feature = "a") cfg_attr(kani, cfg(not(miri)))');
  const marked = recordedThenEdited(setup, "rust", ({ rust: path }) => writeFileSync(path, `\ufeff#![cfg(unix)]\n${readFileSync(path, "utf8")}`));
  assertChanged(marked, "rust", 'new: cfg(unix) cfg(feature = "a")');
  const kani = recordedThenEdited(null, "rust", rust("    #[kani::proof]\n    #[kani::unwind(2)]\n    fn consume_keeps_invariant", "    #[cfg( kani )]\n    #[kani::proof]\n    #[kani::unwind(2)]\n    fn consume_keeps_invariant"));
  assertUnchanged(kani, "rust");
});

test("a cfg on the out-of-line mod declarations that lead to a recorded Kani harness file is changed", () => {
  const both = crate({ "lib.rs": "#[cfg(kani)]\nmod proofs;\n", "proofs.rs": harness });
  const [lib, proofs, record] = ["lib.rs", "proofs.rs", "record.json"].map((name) => join(both, name));
  assert.equal(baseline(both, "record", record, lib, proofs).status, 0);
  edit(lib, "mod proofs;", '#[cfg(feature = "slow-proofs")]\nmod proofs;');
  const added = baseline(both, "compare", record);
  assert.equal(added.status, 1);
  assert.deepEqual(lines(added), [`UNCHANGED ${lib}`, `CHANGED ${proofs}`, "  changed harness a", "    old: ", '    new: cfg(feature = "slow-proofs")', "SUMMARY 1 unchanged, 1 changed"]);

  // One run reads two harness files on different routes of one crate.
  const nested = crate({
    "src/lib.rs": "#![cfg(unix)]\n#[cfg(a)]\nmod verify;\n#[cfg(d)] pub mod checks;\n",
    "src/verify.rs": "mod inner {\n    #[cfg(b)]\n    mod proofs;\n}\n",
    "src/verify/inner/proofs.rs": harness,
    "src/checks/mod.rs": harness,
  });
  const [inner, checks, nestedRecord] = ["src/verify/inner/proofs.rs", "src/checks/mod.rs", "record.json"].map((name) => join(nested, name));
  assert.equal(baseline(nested, "record", nestedRecord, inner, checks).status, 0);
  edit(join(nested, "src/lib.rs"), "#[cfg(a)]\n", "");
  edit(join(nested, "src/lib.rs"), "#[cfg(d)] ", "");
  assert.deepEqual(lines(baseline(nested, "compare", nestedRecord)), [
    `CHANGED ${checks}`, "  changed harness a", "    old: cfg(unix) cfg(d)", "    new: cfg(unix)",
    `CHANGED ${inner}`, "  changed harness a", "    old: cfg(unix) cfg(a) cfg(b)", "    new: cfg(unix) cfg(b)",
    "SUMMARY 0 unchanged, 2 changed",
  ]);

  // record names each file it could not read on the way to a file that no route reaches.
  const broken = crate({ "lib.rs": "mod proofs;\nfn open() {\n", "proofs.rs": harness });
  const failed = baseline(broken, "record", join(broken, "record.json"), join(broken, "proofs.rs"));
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, new RegExp(`^FAIL baseline: ${join(broken, "proofs.rs")}: no module declaration that the record can read leads to this file from a crate root; .*; ${join(broken, "lib.rs")}: unbalanced \\{`));
});

test("a cfg after an attribute that holds fn or mod is read up to the item's own keyword", () => {
  const setup = ({ rust: path }) => writeFileSync(path, "#[cfg_attr(any(), doc(fn x))]\n#[kani::proof]\nfn first() {}\n");
  const added = recordedThenEdited(setup, "rust", rust("#[kani::proof]", '#[cfg(feature = "slow-proofs")]\n#[kani::proof]'));
  assertChanged(added, "rust", "changed harness first", 'new: cfg(feature = "slow-proofs")');
  const module = ({ rust: path }) => writeFileSync(path, "#[cfg_attr(any(), doc(mod y))]\n#[cfg(b)]\nmod m {\n    #[kani::proof]\n    fn a() {}\n}\n");
  assertChanged(recordedThenEdited(module, "rust", rust("#[cfg(b)]\n", "")), "rust", "changed harness m::a", "old: cfg(b)");
});

test("compare fails for a recorded Kani harness file that its only readable route no longer reaches", () => {
  const wrapped = crate({ "lib.rs": "mod proofs;\n", "proofs.rs": harness });
  const [proofs, record] = ["proofs.rs", "record.json"].map((name) => join(wrapped, name));
  assert.equal(baseline(wrapped, "record", record, proofs).status, 0);
  writeFileSync(join(wrapped, "lib.rs"), "cfg_if::cfg_if! { if #[cfg(feature = \"slow\")] { mod proofs; } }\n");
  const failed = baseline(wrapped, "compare", record);
  assert.equal(failed.status, 1);
  assert.equal(lines(failed)[0], `CHANGED ${proofs}`);
  assert.match(lines(failed)[1], /^ {2}FAIL .*proofs\.rs: no module declaration that the record can read leads to this file/);
});

test("removing one of several routes to a Kani harness file is changed", () => {
  const dir = crate({ "Cargo.toml": cargoToml, "src/lib.rs": "mod proofs;\n", "src/main.rs": '#[cfg(feature = "slow")]\nmod proofs;\nfn main() {}\n', "src/proofs.rs": harness });
  const [record, proofs] = ["record.json", "src/proofs.rs"].map((name) => join(dir, name));
  compiles(dir, "src/proofs.rs", ["proofs::a"]);
  assert.equal(baseline(dir, "record", record, proofs).status, 0);
  assert.equal(JSON.parse(readFileSync(record, "utf8")).models[proofs].surface["harness a"], 'routes(lib.rs: unguarded; main.rs: cfg(feature = "slow"))');
  writeFileSync(join(dir, "src/lib.rs"), "");
  const result = baseline(dir, "compare", record);
  assert.equal(result.status, 1, result.stdout);
  assert.deepEqual(lines(result), [`CHANGED ${proofs}`, "  changed harness a", '    old: routes(lib.rs: unguarded; main.rs: cfg(feature = "slow"))', '    new: cfg(feature = "slow")', "SUMMARY 0 unchanged, 1 changed"]);
});

test("each harness that Kani compiles from a recorded file must be on a route the record reads, and must keep compiling", () => {
  const files = { "Cargo.toml": '[package]\nname = "p"\nversion = "0.1.0"\n', "src/lib.rs": '#[path = "proofs.rs"] mod readable;\n', "src/proofs.rs": "#[kani::proof]\nfn a() {}\n" };
  const compiledCrate = (compiled) => {
    const dir = realpathSync(fixture());
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    compiles(dir, "src/proofs.rs", compiled);
    return { dir, record: join(dir, "record.json"), proofs: join(dir, "src/proofs.rs") };
  };
  const hiddenRoute = "Kani compiles proofs::a from this file, but no route that the record reads gives that name";

  // A macro such as builders::declare!(proofs) compiles the file a second time, as proofs, which the record cannot read.
  const hidden = compiledCrate(["readable::a", "proofs::a"]);
  const refused = baseline(hidden.dir, "record", hidden.record, hidden.proofs);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, `FAIL baseline: ${hidden.proofs}: ${hiddenRoute}; declare the module with \`mod <name>;\` or \`#[path = "..."]\` outside macros and function bodies\n`);

  const readable = compiledCrate(["readable::a"]);
  assert.deepEqual(lines(baseline(readable.dir, "record", readable.record, readable.proofs)).slice(1), []);
  assert.deepEqual(JSON.parse(readFileSync(readable.record, "utf8")).models[readable.proofs].compiled, ["harness a"]);
  assert.deepEqual(lines(baseline(readable.dir, "compare", readable.record)), [`UNCHANGED ${readable.proofs}`, "SUMMARY 1 unchanged, 0 changed"]);
  compiles(readable.dir, "src/proofs.rs", ["readable::a", "proofs::a"]);
  const added = lines(baseline(readable.dir, "compare", readable.record));
  assert.equal(added[0], `CHANGED ${readable.proofs}`);
  assert.ok(added[1].startsWith(`  FAIL ${hiddenRoute}`), added[1]);
  // A cfg that the text does not show, such as a default feature removed from Cargo.toml, switches the harness off.
  compiles(readable.dir, "src/proofs.rs", []);
  assert.deepEqual(lines(baseline(readable.dir, "compare", readable.record)), [`CHANGED ${readable.proofs}`, "  not compiled harness a", "SUMMARY 0 unchanged, 1 changed"]);
  // A file checked against Kani at record needs Kani at compare.
  rmSync(join(readable.dir, "kani"), { recursive: true });
  const noKani = baseline(readable.dir, "compare", readable.record);
  assert.equal(noKani.status, 1);
  assert.equal(lines(noKani)[0], `CHANGED ${readable.proofs}`);
  assert.match(lines(noKani)[1], /^ {2}FAIL cannot ask Kani which harnesses it compiles in .*UNAVAILABLE Kani/);
  rmSync(join(readable.dir, "Cargo.toml"));
  assert.deepEqual(lines(baseline(readable.dir, "compare", readable.record)), [`CHANGED ${readable.proofs}`, "  not compiled harness a", "SUMMARY 0 unchanged, 1 changed"]);

  // Without Kani a harness file is recorded from its text alone. While its text parts are unchanged, compare prints
  // NOT CHECKED for it, since a route that the record does not read could have been switched off since record.
  const missing = compiledCrate([]);
  rmSync(join(missing.dir, "kani"), { recursive: true });
  const unchecked = lines(baseline(missing.dir, "record", missing.record, missing.proofs));
  assert.equal(unchecked.length, 2);
  assert.match(unchecked[1], new RegExp(`^ {2}not checked against Kani: cannot ask Kani which harnesses it compiles in ${missing.dir}: UNAVAILABLE Kani`));
  assert.equal(JSON.parse(readFileSync(missing.record, "utf8")).models[missing.proofs].compiled, undefined);
  const notChecked = "  not checked against Kani at record, so compare cannot see a harness that stopped compiling on a route that the record does not read";
  const withoutKani = baseline(missing.dir, "compare", missing.record);
  assert.equal(withoutKani.status, 0, withoutKani.stdout);
  assert.deepEqual(lines(withoutKani).slice(0, 2), [`NOT CHECKED ${missing.proofs}`, notChecked]);
  assert.match(lines(withoutKani)[2], /^ {2}cannot ask Kani which harnesses it compiles in .*UNAVAILABLE Kani/);
  assert.equal(lines(withoutKani).at(-1), "SUMMARY 0 unchanged, 0 changed, 1 not checked");
  compiles(missing.dir, "src/proofs.rs", ["readable::a"]);
  assert.deepEqual(lines(baseline(missing.dir, "compare", missing.record)), [`NOT CHECKED ${missing.proofs}`, notChecked, "SUMMARY 0 unchanged, 0 changed, 1 not checked"]);
  // A changed text part, or a harness that Kani compiles on a route that the record does not read, is still CHANGED.
  writeFileSync(missing.proofs, "#[kani::proof]\nfn a() { kani::assume(true); }\n");
  assert.deepEqual(lines(baseline(missing.dir, "compare", missing.record)), [`CHANGED ${missing.proofs}`, "  added assume true in a", notChecked, "SUMMARY 0 unchanged, 1 changed"]);
  writeFileSync(missing.proofs, files["src/proofs.rs"]);
  compiles(missing.dir, "src/proofs.rs", ["readable::a", "proofs::a"]);
  const hiddenNow = baseline(missing.dir, "compare", missing.record);
  assert.equal(hiddenNow.status, 1);
  assert.equal(lines(hiddenNow)[0], `CHANGED ${missing.proofs}`);
  assert.ok(lines(hiddenNow)[1].startsWith(`  FAIL ${hiddenRoute}`), hiddenNow.stdout);
  // move onto a file that was checked against Kani keeps the merged entry unchecked, with that file's harnesses.
  const other = join(missing.dir, "src/other.rs");
  writeFileSync(other, "#[kani::proof]\nfn b() {}\n");
  writeFileSync(join(missing.dir, "src/lib.rs"), '#[path = "proofs.rs"] mod readable;\nmod other;\n');
  compiles(missing.dir, "src/other.rs", ["other::b"]);
  assert.equal(baseline(missing.dir, "record", missing.record, other).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(missing.record, "utf8")).models[other].compiled, ["harness b"]);
  // A NOT CHECKED file does not hide a CHANGED one, and the summary counts each.
  assert.equal(lines(baseline(missing.dir, "compare", missing.record)).at(-1), "SUMMARY 1 unchanged, 0 changed, 1 not checked");
  writeFileSync(other, "fn b() {}\n");
  const both = baseline(missing.dir, "compare", missing.record);
  assert.equal(both.status, 1);
  assert.equal(lines(both).at(-1), "SUMMARY 0 unchanged, 1 changed, 1 not checked");
  writeFileSync(other, "#[kani::proof]\nfn b() {}\n#[kani::proof]\nfn a() {}\n");
  rmSync(missing.proofs);
  writeFileSync(join(missing.dir, "src/lib.rs"), "mod other;\n");
  assert.equal(baseline(missing.dir, "move", missing.record, missing.proofs, other).status, 0);
  const merged = JSON.parse(readFileSync(missing.record, "utf8")).models[other];
  assert.deepEqual([merged.compiled, merged.partial], [["harness b"], true]);
  compiles(missing.dir, "src/other.rs", ["other::a", "other::b"]);
  assert.deepEqual(lines(baseline(missing.dir, "compare", missing.record)), [`NOT CHECKED ${other}`, notChecked, "SUMMARY 0 unchanged, 0 changed, 1 not checked"]);
  compiles(missing.dir, "src/other.rs", ["other::a"]);
  assert.deepEqual(lines(baseline(missing.dir, "compare", missing.record)), [`CHANGED ${other}`, "  not compiled harness b", notChecked, "SUMMARY 0 unchanged, 1 changed"]);
  rmSync(join(missing.dir, "kani"), { recursive: true });
  assert.match(lines(baseline(missing.dir, "compare", missing.record))[1], /^ {2}FAIL cannot ask Kani which harnesses it compiles in .*UNAVAILABLE Kani/);

  // A closure or a const _ block adds an anonymous segment to Kani's name, which is not a route.
  const closure = compiledCrate(["readable::f::{closure#0}::g", "readable::f::_::h"]);
  writeFileSync(closure.proofs, "fn f() {\n    let _c = || {\n        #[kani::proof]\n        fn g() {}\n    };\n    const _: () = {\n        #[kani::proof]\n        fn h() {}\n    };\n}\n");
  assert.equal(baseline(closure.dir, "record", closure.record, closure.proofs).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(closure.record, "utf8")).models[closure.proofs].compiled, ["harness f::g", "harness f::h"]);

  // move carries the compiled harnesses to the new file, renamed with --module, so compare still reports one switched off.
  const moved = compiledCrate(["readable::a"]);
  assert.equal(baseline(moved.dir, "record", moved.record, moved.proofs).status, 0);
  const checks = join(moved.dir, "src/checks.rs");
  writeFileSync(checks, "mod inner {\n    #[kani::proof]\n    fn a() {}\n}\n");
  writeFileSync(join(moved.dir, "src/lib.rs"), '#[path = "checks.rs"] mod readable;\n');
  assert.equal(baseline(moved.dir, "move", moved.record, moved.proofs, checks, "--module", "crate", "inner").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(moved.record, "utf8")).models[checks].compiled, ["harness inner::a"]);
  compiles(moved.dir, "src/checks.rs", []);
  assert.deepEqual(lines(baseline(moved.dir, "compare", moved.record)), [`CHANGED ${checks}`, "  not compiled harness inner::a", "SUMMARY 0 unchanged, 1 changed"]);
});

test("a mod declaration inside cfg_if! is not a route the record reads, so Kani's list decides", () => {
  const cfgIf = "cfg_if::cfg_if! {\n    if #[cfg(kani)] {\n        mod proofs;\n    }\n}\n";
  const recorded = (lib, compiled) => {
    const dir = realpathSync(fixture());
    const files = { "Cargo.toml": '[package]\nname = "p"\nversion = "0.1.0"\n', "src/lib.rs": lib, "src/proofs.rs": "#[kani::proof]\nfn a() {}\n" };
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    compiles(dir, "src/proofs.rs", compiled);
    const proofs = join(dir, "src/proofs.rs");
    return { proofs, result: baseline(dir, "record", join(dir, "record.json"), proofs) };
  };

  const alone = recorded(cfgIf, ["proofs::a"]);
  assert.equal(alone.result.status, 1);
  assert.equal(alone.result.stdout, `FAIL baseline: ${alone.proofs}: no module declaration that the record can read leads to this file from a crate root; declare it with \`mod <name>;\` or \`#[path = "..."]\` outside macros and function bodies, in a file that a crate root reaches\n`);

  const beside = recorded(`#[path = "proofs.rs"] mod readable;\n${cfgIf}`, ["readable::a", "proofs::a"]);
  assert.equal(beside.result.status, 1);
  assert.equal(beside.result.stdout, `FAIL baseline: ${beside.proofs}: Kani compiles proofs::a from this file, but no route that the record reads gives that name; declare the module with \`mod <name>;\` or \`#[path = "..."]\` outside macros and function bodies\n`);
});

test("each route in the crate that the record cannot read is noted in the harness's value and printed at record", () => {
  const queue = "#[cfg(kani)]\nmod proofs {\n    #[kani::proof]\n    fn check_push() {}\n}\n";
  const declare = 'macro_rules! declare { ($($t:tt)*) => { $($t)* } }\ndeclare! { #[cfg(feature = "slow")] mod queue; }\nfn main() {}\n';
  const dir = crate({ "src/lib.rs": "pub mod queue;\n", "src/main.rs": declare, "src/queue.rs": queue });
  const [record, proofs] = ["record.json", "src/queue.rs"].map((name) => join(dir, name));
  const recorded = baseline(dir, "record", record, proofs);
  assert.deepEqual(lines(recorded).slice(1), [`  route not read: ${join(dir, "src/main.rs")}:2: mod queue is inside a macro or block`]);
  assert.equal(JSON.parse(readFileSync(record, "utf8")).models[proofs].surface["harness proofs::check_push"], "unread(main.rs: mod queue in a macro or block)");
  // The note names the route, not its guards, so only adding or removing such a route is changed.
  edit(join(dir, "src/main.rs"), 'feature = "slow"', 'feature = "fast"');
  assertUnchanged(compared({ dir, record, rust: proofs }), "rust");
  writeFileSync(join(dir, "src/main.rs"), "fn main() {}\n");
  assert.deepEqual(lines(baseline(dir, "compare", record)), [`CHANGED ${proofs}`, "  changed harness proofs::check_push", "    old: unread(main.rs: mod queue in a macro or block)", "    new: ", "SUMMARY 0 unchanged, 1 changed"]);

  // An unreadable #[path] or include!, and a file that does not parse, may each lead to the harness file too.
  const lib = 'mod other;\nmod proofs;\n#[path = "a\\x2e.rs"] mod p;\ninclude!(concat!(env!("OUT_DIR"), "/gen.rs"));\n';
  const unread = crate({ "lib.rs": lib, "other.rs": "fn open() {\n", "proofs.rs": harness });
  const [unreadRecord, unreadProofs] = ["record.json", "proofs.rs"].map((name) => join(unread, name));
  const notes = lines(baseline(unread, "record", unreadRecord, unreadProofs)).slice(1);
  assert.equal(notes.length, 3, notes.join("\n"));
  assert.ok(notes.every((line) => line.startsWith(`  route not read: ${unread}/`)), notes.join("\n"));
  assert.equal(JSON.parse(readFileSync(unreadRecord, "utf8")).models[unreadProofs].surface["harness a"],
    'unread(lib.rs: include!(concat!(env!("OUT_DIR"), "/gen.rs")); lib.rs: mod p under a path it cannot read; other.rs: a file it cannot parse)');

  // A mod that a macro builds, one in a function body, and an include! in a macro are noted too, each one apart.
  const noted = (files, target, item) => {
    const at = crate(files);
    const result = baseline(at, "record", join(at, "record.json"), join(at, target));
    assert.equal(result.status, 0, result.stdout);
    return { at, value: JSON.parse(readFileSync(join(at, "record.json"), "utf8")).models[join(at, target)].surface[item] };
  };
  const built = 'macro_rules! declare { ($n:ident) => { #[cfg(feature = "slow")] mod $n; } }\ndeclare!(queue);\nfn main() {}\n';
  assert.equal(noted({ "src/lib.rs": "pub mod queue;\n", "src/main.rs": built, "src/queue.rs": queue }, "src/queue.rs", "harness proofs::check_push").value, "unread(main.rs: mod $n in a macro or block)");
  const inBody = 'fn main() {\n    #[cfg(feature = "slow")]\n    #[path = "queue.rs"]\n    mod queue;\n}\n';
  assert.equal(noted({ "src/lib.rs": "pub mod queue;\n", "src/main.rs": inBody, "src/queue.rs": queue }, "src/queue.rs", "harness proofs::check_push").value, "unread(main.rs: mod queue in a macro or block)");
  const included = 'mod proofs;\ncfg_if::cfg_if! { if #[cfg(kani)] { include!("extra.rs"); } }\n';
  assert.equal(noted({ "lib.rs": included, "proofs.rs": harness }, "proofs.rs", "harness a").value, 'unread(lib.rs: include!("extra.rs") in a macro or block)');
  const twice = 'mod proofs;\ncfg_if::cfg_if! { if #[cfg(unix)] { #[path = "unix.rs"] mod imp; } else { #[path = "windows.rs"] mod imp; } }\n';
  const both = noted({ "lib.rs": twice, "proofs.rs": harness }, "proofs.rs", "harness a");
  assert.equal(both.value, "unread(lib.rs: mod imp in a macro or block; lib.rs: mod imp in a macro or block)");
  edit(join(both.at, "lib.rs"), ' else { #[path = "windows.rs"] mod imp; }', "");
  assertChanged(compared({ dir: both.at, record: join(both.at, "record.json"), rust: join(both.at, "proofs.rs") }), "rust", "    new: unread(lib.rs: mod imp in a macro or block)");
});

test("the route reader follows out-of-line mod declarations from the crate roots and reads the cfg guards on each", () => {
  const nested = {
    "src/lib.rs": "#![cfg(unix)]\n#[cfg(a)]\nmod verify;\n#[cfg(d)] pub mod checks;\n",
    "src/verify.rs": "mod inner {\n    #[cfg(b)]\n    mod proofs;\n}\n",
    "src/verify/inner/proofs.rs": harness,
    "src/checks/mod.rs": harness,
  };
  assert.deepEqual(routes(nested, "src/verify/inner/proofs.rs").routes, [["src/lib.rs", "cfg(unix) cfg(a) cfg(b)", "verify::inner::proofs"]]);
  assert.deepEqual(routes(nested, "src/checks/mod.rs").routes, [["src/lib.rs", "cfg(unix) cfg(d)", "checks"]]);
  assert.deepEqual(routes({ "main.rs": "#[cfg(e)] mod outer {\n    #![cfg(f)]\n    mod proofs;\n}\n", "outer/proofs.rs": harness }, "outer/proofs.rs").routes, [["main.rs", "cfg(e) cfg(f)", "outer::proofs"]]);
  // An attribute that holds `mod` is read up to the declaration's own keyword.
  assert.deepEqual(routes({ "lib.rs": "#[cfg_attr(any(), doc(mod proofs))]\n#[cfg(c)]\nmod proofs;\n", "proofs.rs": harness }, "proofs.rs").routes, [["lib.rs", "cfg(c)", "proofs"]]);
  assert.deepEqual(routes({ "lib.rs": "#[doc(mod q)]\n#[cfg(o)]\nmod outer {\n    #[cfg(c)]\n    mod proofs;\n}\n", "outer/proofs.rs": harness }, "outer/proofs.rs").routes, [["lib.rs", "cfg(o) cfg(c)", "outer::proofs"]]);
  // A declaration in a file outside the crate's module tree is no route, and a file that does not parse hides no other.
  assert.deepEqual(routes({ "stray.rs": "#[cfg(g)] mod proofs;\n", "stray/Cargo.toml": "", "stray/lib.rs": "mod proofs;\n", "stray/proofs.rs": harness }, "stray/proofs.rs").routes, [["stray/lib.rs", "", "proofs"]]);
  assert.deepEqual(routes({ "lib.rs": "mod other;\nmod proofs;\n", "other.rs": "fn open() {\n", "proofs.rs": harness }, "proofs.rs").routes, [["lib.rs", "", "proofs"]]);
  assert.deepEqual(routes({ "lib.rs": "#[cfg(m)] mod r#match;\n", "match/mod.rs": harness }, "match/mod.rs").routes, [["lib.rs", "cfg(m)", "r#match"]]);
  // A file in no crate, and a crate root that no declaration reaches, are each their own crate root.
  assert.deepEqual(routes({ "mod.rs": "fn open() {\n", "loose/proofs.rs": harness }, "loose/proofs.rs"), { routes: [["loose/proofs.rs", "", ""]], label: "" });
  assert.deepEqual(routes({ "Cargo.toml": cargoToml, "src/main.rs": `fn main() { let path = "lib.rs"; }\n`, "src/lib.rs": harness }, "src/lib.rs"), { routes: [["src/lib.rs", "", ""]], label: "" });
});

test("the route reader follows #[path] and cfg_attr paths, and each crate root that Cargo names", () => {
  assert.deepEqual(routes({ "lib.rs": '#[path = "checks.rs"]\n#[cfg(feature = "slow")]\nmod proofs;\n', "checks.rs": harness }, "checks.rs").routes, [["lib.rs", 'cfg(feature = "slow")', "proofs"]]);
  assert.deepEqual(routes({ "lib.rs": '#[path = "x.rs"] mod y;\n', "x.rs": "#[cfg(c)] mod z;\n", "z.rs": harness }, "z.rs").routes, [["lib.rs", "cfg(c)", "y::z"]]);
  assert.deepEqual(routes({ "lib.rs": "mod a;\n", "a.rs": '#[cfg(b)] #[path = "d"] mod m {\n    mod q;\n}\n', "d/q.rs": harness }, "d/q.rs").routes, [["lib.rs", "cfg(b)", "a::m::q"]]);
  assert.deepEqual(routes({ "lib.rs": "mod a;\n", "a.rs": 'mod m {\n    #[cfg(e)] #[path = "p.rs"] mod p;\n}\n', "a/m/p.rs": harness }, "a/m/p.rs").routes, [["lib.rs", "cfg(e)", "a::m::p"]]);
  assert.deepEqual(routes({ "lib.rs": '#[cfg_attr(feature = "x", path = "other.rs")]\nmod proofs;\n', "proofs.rs": harness, "other.rs": "" }, "proofs.rs").routes, [["lib.rs", 'cfg_attr(feature = "x", path = "other.rs")', "proofs"]]);
  assert.deepEqual(routes({ "lib.rs": '#[path = "lib.rs"]\nmod again;\n#[cfg(w)] mod proofs;\n', "proofs.rs": harness }, "proofs.rs").routes, [["lib.rs", "cfg(w)", "proofs"]]);
  assert.deepEqual(routes({ "lib.rs": 'mod proofs;\n#[path = "sys\\\\win.rs"] mod sys;\n', "proofs.rs": harness }, "proofs.rs").routes, [["lib.rs", "", "proofs"]]);

  const cargo = { "Cargo.toml": cargoToml, "src/lib.rs": "" };
  assert.deepEqual(routes({ ...cargo, "tests/kani/main.rs": "#[cfg(t)] mod proofs;\n", "tests/kani/proofs.rs": harness }, "tests/kani/proofs.rs").routes, [["tests/kani/main.rs", "cfg(t)", "proofs"]]);
  assert.deepEqual(routes({ ...cargo, "src/bin/tool/main.rs": "#[cfg(u)] mod proofs;\n", "src/bin/tool/proofs.rs": harness }, "src/bin/tool/proofs.rs").routes, [["src/bin/tool/main.rs", "cfg(u)", "proofs"]]);
  const library = { "Cargo.toml": `${cargoToml}\n[lib]\npath = 'code/root.rs'\n`, "code/root.rs": "#[cfg(v)] mod proofs;\n", "code/proofs.rs": harness };
  assert.deepEqual(routes(library, "code/proofs.rs").routes, [["code/root.rs", "cfg(v)", "proofs"]]);
  assert.deepEqual(routes({ "Cargo.toml": "[workspace]\nmembers = []\n", "crates/foo/lib.rs": "#[cfg(w)] mod proofs;\n", "crates/foo/proofs.rs": harness }, "crates/foo/proofs.rs").routes, [["crates/foo/lib.rs", "cfg(w)", "proofs"]]);
  // A lib.rs that main.rs also declares is both a crate root and a module; a main.rs below a module is only a module.
  assert.deepEqual(routes({ ...cargo, "src/main.rs": `#[cfg(z)] #[path = "lib.rs"] mod lib;\nfn main() { let path = "lib.rs"; }\n`, "src/lib.rs": harness }, "src/lib.rs").routes, [["src/lib.rs", "", ""], ["src/main.rs", "cfg(z)", "lib"]]);
  const below = { ...cargo, "src/lib.rs": '#[cfg(feature = "x")] mod a;\n', "src/a/mod.rs": "mod main;\n", "src/a/main.rs": "mod proofs;\n", "src/a/main/proofs.rs": harness };
  assert.deepEqual(routes(below, "src/a/main/proofs.rs").routes, [["src/lib.rs", 'cfg(feature = "x")', "a::main::proofs"]]);
});

test("the route reader follows include! items outside macros and function bodies", () => {
  const items = { "sub/items.rs": '#[path = "proofs.rs"] mod again;\n', "sub/proofs.rs": harness };
  const twice = routes({ ...items, "lib.rs": '#[path = "sub/proofs.rs"] mod proofs;\ninclude!("sub/items.rs");\n' }, "sub/proofs.rs");
  assert.deepEqual(twice, { routes: [["lib.rs", "", "again"], ["lib.rs", "", "proofs"]], label: "routes(../lib.rs: unguarded; ../lib.rs: unguarded)" });
  const guarded = { ...items, "lib.rs": '#[path = "sub/proofs.rs"] mod proofs;\n#[cfg(feature = "slow")] include!("sub/items.rs");\n' };
  assert.deepEqual(routes(guarded, "sub/proofs.rs").routes, [["lib.rs", "", "proofs"], ["lib.rs", 'cfg(feature = "slow")', "again"]]);
  assert.deepEqual(routes({ "lib.rs": '#![cfg(f)]\n#[cfg(x)] include!("sub/items.rs");\n', "sub/items.rs": "#[cfg(y)] mod q;\n", "sub/q.rs": harness }, "sub/q.rs").routes, [["lib.rs", "cfg(f) cfg(x) cfg(y)", "q"]]);
  // An included file's items sit in the modules around the include!.
  assert.deepEqual(routes({ "lib.rs": '#[cfg(m)] mod m {\n    include!("items.rs");\n}\n', "items.rs": "mod q;\n", "q.rs": harness }, "q.rs").routes, [["lib.rs", "cfg(m)", "m::q"]]);
  const chained = { "lib.rs": "mod a;\n", "a.rs": 'include!("sub/one.rs");\n', "sub/one.rs": 'include!("two.rs");\n', "sub/two.rs": "#[cfg(t)] mod q;\n", "sub/q.rs": harness };
  assert.deepEqual(routes(chained, "sub/q.rs").routes, [["lib.rs", "cfg(t)", "a::q"]]);
  // include_str!, include_bytes!, a path built from OUT_DIR, and an include! in a macro or function body lead nowhere.
  const strings = { "lib.rs": 'mod proofs;\nconst SOURCE: &str = include_str!("proofs.rs");\nfn f() { let _ = include_bytes!("proofs.rs"); }\n', "proofs.rs": harness };
  assert.deepEqual(routes(strings, "proofs.rs").routes, [["lib.rs", "", "proofs"]]);
  assert.deepEqual(routes({ "lib.rs": 'mod proofs;\ninclude!(concat!(env!("OUT_DIR"), "/bindings.rs"));\n', "proofs.rs": harness }, "proofs.rs").routes, [["lib.rs", "", "proofs"]]);
  const wrapped = '#[path = "sub/proofs.rs"] mod proofs;\nmacro_rules! wrap { ($($t:tt)*) => { $($t)* } }\nwrap! { include!("sub/items.rs"); }\n';
  assert.deepEqual(routes({ ...items, "lib.rs": wrapped }, "sub/proofs.rs").routes, [["lib.rs", "", "proofs"]]);
  const manifest = 'include!(concat!(env!("CARGO_MANIFEST_DIR"), "/sub/items.rs"));\n';
  const cargo = { "Cargo.toml": cargoToml, ...items };
  assert.deepEqual(routes({ ...cargo, "lib.rs": `#[path = "sub/proofs.rs"] mod proofs;\nfn f() { ${manifest.trim()} }\n` }, "sub/proofs.rs").routes, [["lib.rs", "", "proofs"]]);
  // The brace form, a concat! of strings, and env!("CARGO_MANIFEST_DIR") lead to the file they name.
  assert.equal(routes({ ...items, "lib.rs": '#[path = "sub/proofs.rs"] mod proofs;\n#[cfg(b)] include! { "sub/items.rs" }\n' }, "sub/proofs.rs").label, "routes(../lib.rs: unguarded; ../lib.rs: cfg(b))");
  assert.equal(routes({ ...items, "lib.rs": '#[path = "sub/proofs.rs"] mod proofs;\n#[cfg(c)] include!(std::concat!("sub/", "items.rs",));\n' }, "sub/proofs.rs").label, "routes(../lib.rs: unguarded; ../lib.rs: cfg(c))");
  assert.equal(routes({ ...cargo, "lib.rs": `#[path = "sub/proofs.rs"] mod proofs;\n#[cfg(feature = "slow")]\n${manifest}` }, "sub/proofs.rs").label, 'routes(../lib.rs: unguarded; ../lib.rs: cfg(feature = "slow"))');
  const workspace = {
    "Cargo.toml": `${cargoToml}\n[workspace]\nmembers = ["sub"]\n`,
    "sub/Cargo.toml": '[package]\nname = "q"\nversion = "0.1.0"\n',
    "sub/src/lib.rs": "",
    "src/lib.rs": 'mod proofs;\ninclude!("../sub/shared.rs");\n',
    "sub/shared.rs": 'include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/items.rs"));\n',
    "src/items.rs": '#[path = "proofs.rs"] mod again;\n',
    "src/proofs.rs": harness,
  };
  assert.deepEqual(routes(workspace, "src/proofs.rs"), { routes: [["src/lib.rs", "", "again"], ["src/lib.rs", "", "proofs"]], label: "routes(lib.rs: unguarded; lib.rs: unguarded)" });
  const generated = { "Cargo.toml": cargoToml, "src/lib.rs": '#[cfg(kani)] mod tests;\n#[cfg(feature = "codegen")]\ninclude!("../tests/generated.rs");\n', "src/tests.rs": harness };
  assert.deepEqual(routes(generated, "src/tests.rs").routes, [["src/lib.rs", "", "tests"]]);
});

test("the record labels several routes to a Kani harness file by crate root, sorted, with unguarded for a route without guards", () => {
  const files = (lib, main) => ({ "Cargo.toml": cargoToml, "src/lib.rs": lib, "src/main.rs": `${main}fn main() {}\n`, "src/proofs.rs": harness });
  const label = (lib, main) => routes(files(lib, main), "src/proofs.rs").label;
  assert.equal(label("#[cfg(x)] mod proofs;\n", '#[cfg(feature = "slow")]\nmod proofs;\n'), 'routes(lib.rs: cfg(x); main.rs: cfg(feature = "slow"))');
  assert.equal(label('#[cfg(feature = "slow")]\nmod proofs;\n', "mod proofs;\n"), 'routes(lib.rs: cfg(feature = "slow"); main.rs: unguarded)');
  assert.equal(label("mod proofs;\n", "mod proofs;\n"), "routes(lib.rs: unguarded; main.rs: unguarded)");
  assert.equal(label("mod proofs;\n", ""), "");
  // The label sorts routes by their crate roots' paths relative to the file, so a root in a directory above it comes first.
  const replaced = routes({ ...files("", '#[cfg(feature = "slow")]\nmod proofs;\n'), "tests/t.rs": '#[path = "../src/proofs.rs"]\nmod proofs;\n' }, "src/proofs.rs");
  assert.deepEqual(replaced, { routes: [["src/main.rs", 'cfg(feature = "slow")', "proofs"], ["tests/t.rs", "", "proofs"]], label: 'routes(../tests/t.rs: unguarded; main.rs: cfg(feature = "slow"))' });
  const root = routes(files("mod proofs;\n", '#[cfg(z)] #[path = "lib.rs"] mod lib;\n'), "src/proofs.rs");
  assert.deepEqual(root, { routes: [["src/lib.rs", "", "proofs"], ["src/main.rs", "cfg(z)", "lib::proofs"]], label: "routes(lib.rs: unguarded; main.rs: cfg(z))" });
});

test("the route reader fails for a file that no route it reads reaches, and names what it could not read", () => {
  const unreached = "no module declaration that the record can read leads to this file from a crate root; declare it with `mod <name>;` or `#[path = \"...\"]` outside macros and function bodies, in a file that a crate root reaches";
  assert.deepEqual(routes({ "lib.rs": "", "stray.rs": harness }, "stray.rs"), { error: `<crate>/stray.rs: ${unreached}` });
  assert.deepEqual(routes({ "lib.rs": 'fn f() {\n    #[path = "checks.rs"] mod proofs;\n}\n', "checks.rs": harness }, "checks.rs"), { error: `<crate>/checks.rs: ${unreached}` });
  assert.match(routes({ "lib.rs": "mod proofs;\nfn open() {\n", "proofs.rs": harness }, "proofs.rs").error, /^<crate>\/proofs\.rs: no module declaration .*; <crate>\/lib\.rs: unbalanced \{/);
  assert.equal(routes({ "lib.rs": 'include!(concat!(env!("OUT_DIR"), "/proofs.rs"));\n', "proofs.rs": harness }, "proofs.rs").error,
    `<crate>/proofs.rs: ${unreached}; <crate>/lib.rs:1: cannot read the path in 'include!(concat!(env!("OUT_DIR"), "/proofs.rs"))'; write it as a string without escapes, or as concat! of such strings and env!("CARGO_MANIFEST_DIR")`);
  const manifest = { "lib.rs": 'include!(concat!(env!("CARGO_MANIFEST_DIR"), "/sub/items.rs"));\n', "sub/items.rs": '#[path = "proofs.rs"] mod again;\n', "sub/proofs.rs": harness };
  assert.equal(routes(manifest, "sub/proofs.rs").error,
    `<crate>/sub/proofs.rs: ${unreached}; <crate>/lib.rs:1: cannot read the path in 'include!(concat!(env!("CARGO_MANIFEST_DIR"), "/sub/items.rs"))': no Cargo.toml above the crate root sets env!("CARGO_MANIFEST_DIR"), so the record cannot tell which file it reads`);
});

test("only a cfg_attr whose own attribute list applies cfg guards a Kani harness", () => {
  const docs = ({ rust: path }) => writeFileSync(path, '#[cfg_attr(docsrs, doc(cfg(feature = "x")))]\nmod proofs {\n    #[kani::proof]\n    fn a() { kani::cover!(true); }\n}\n');
  assertUnchanged(recordedThenEdited(docs, "rust", rust('feature = "x"', 'feature = "y"')), "rust");
  const guards = (attributes) => {
    const files = models();
    writeFileSync(files.rust, `${attributes}\n#[kani::proof]\nfn a() {}\n`);
    assert.equal(baseline(files.dir, "record", files.record, files.rust).status, 0);
    return JSON.parse(readFileSync(files.record, "utf8")).models[files.rust].surface["harness a"];
  };
  assert.equal(guards('#[cfg_attr(docsrs, doc(cfg(feature = "x")))]'), "");
  assert.equal(guards('#[cfg_attr(feature = "a,cfg(b)", doc(hidden))]'), "");
  assert.equal(guards("#[my(#[cfg(z)] q)]"), "");
  assert.equal(guards("#![my(#[cfg(z)] q)]"), "");
  assert.equal(guards("#[cfg_attr(a, doc(hidden), cfg(b))]"), "cfg_attr(a, doc(hidden), cfg(b))");
  assert.equal(guards("#[cfg_attr(a, cfg_attr(b, cfg(c)))]"), "cfg_attr(a, cfg_attr(b, cfg(c)))");
  assert.equal(guards("#[cfg_attr(a, cfg_attr(b, doc(cfg(c))))]"), "");
});

test("moving a Kani assumption from a helper into a harness changes its owner", () => {
  const outcome = recordedThenEdited(null, "rust", ({ rust: path }) => {
    edit(path, "        kani::assume(window > 0 && window <= 2);\n", "");
    edit(path, "        let (window, state) = inputs();", "        let (window, state) = inputs();\n        kani::assume(window > 0 && window <= 2);");
  });
  assertChanged(outcome, "rust", "removed assume window > 0 && window <= 2", "added assume window > 0 && window <= 2");
});

test("Kani items retain qualified owners when equal function names occur in nested modules", () => {
  const setup = ({ rust: path }) => writeFileSync(path, [
    "mod outer { mod a { #[kani::proof] fn same() { kani::assume(true); } }",
    "mod b { #[kani::proof] fn same() {} } }", "",
  ].join("\n"));
  const outcome = recordedThenEdited(setup, "rust", ({ rust: path }) => {
    edit(path, "fn same() { kani::assume(true); }", "fn same() {}");
    edit(path, "mod b { #[kani::proof] fn same() {}", "mod b { #[kani::proof] fn same() { kani::assume(true); }");
  });
  assertChanged(outcome, "rust", "removed assume true in outer::a::same", "added assume true in outer::b::same");
});

test("moving a Kani cover or stub between functions changes its owner", () => {
  for (const [first, second, kind] of [
    ["fn a() { kani::cover!(true); } fn b() {}", "fn a() {} fn b() { kani::cover!(true); }", "cover true"],
    ["#[kani::stub(real, fake)] fn a() {} fn b() {}", "fn a() {} #[kani::stub(real, fake)] fn b() {}", "stub real, fake"],
  ]) {
    const setup = ({ rust: path }) => writeFileSync(path, first);
    const outcome = recordedThenEdited(setup, "rust", ({ rust: path }) => writeFileSync(path, second));
    assertChanged(outcome, "rust", `removed ${kind} in a`);
  }
});

test("reordering functions with identical Kani assumptions preserves their owners", () => {
  const a = "fn a() { kani::assume(true); kani::assume(true); }";
  const b = "fn b() { kani::assume(true); }";
  const setup = ({ rust: path }) => writeFileSync(path, `${a}\n${b}\n`);
  assertUnchanged(recordedThenEdited(setup, "rust", ({ rust: path }) => writeFileSync(path, `${b}\n${a}\n`)), "rust");
  const removed = recordedThenEdited(setup, "rust", ({ rust: path }) => edit(path, a, "fn a() { kani::assume(true); }"));
  assertChanged(removed, "rust", "removed assume true in a #2");
});

test("conditional definitions with the same qualified name retain separate Kani owners", () => {
  const setup = ({ rust: path }) => writeFileSync(path, "#[cfg(a)] fn same() { kani::assume(true); } #[cfg(b)] fn same() {}");
  const outcome = recordedThenEdited(setup, "rust", ({ rust: path }) => {
    edit(path, "{ kani::assume(true); }", "{}");
    edit(path, "#[cfg(b)] fn same() {}", "#[cfg(b)] fn same() { kani::assume(true); }");
  });
  assertChanged(outcome, "rust", "removed assume true in same", "added assume true in same[2]");
});

test("duplicate assumptions cannot stand in for a constraint on a different function definition", () => {
  const setup = ({ rust: path }) => writeFileSync(path,
    "#[cfg(a)] fn same() { kani::assume(true); kani::assume(true); } #[cfg(b)] fn same() { kani::assume(true); }");
  const outcome = recordedThenEdited(setup, "rust", ({ rust: path }) => writeFileSync(path,
    "#[cfg(a)] fn same() { kani::assume(true); } #[cfg(b)] fn same() { kani::assume(true); kani::assume(true); }"));
  assertChanged(outcome, "rust", "added assume true in same");
});

test("generic free functions and local blocks retain their Kani owner", () => {
  const setup = ({ rust: path }) => writeFileSync(path, "mod m { pub unsafe fn r#type<'a, const N: usize>(x: &'a [u8; N]) { if N > 0 { kani::assume(x[0] > 0); } } }");
  const outcome = recordedThenEdited(setup, "rust", ({ rust: path }) => edit(path, "x[0] > 0", "x[0] > 1"));
  assertChanged(outcome, "rust", "removed assume x[0] > 0 in m::r#type");
});

test("a Kani form in an unsupported Rust owner fails instead of being recorded without context", () => {
  for (const source of [
    "impl State { fn helper() { kani::assume(true); } }",
    "trait T { fn helper() { kani::assume(true); } }",
    "macro_rules! body { () => { kani::assume(true); } }",
    "fn helper() { wrapper! { kani::assume(true); } }",
    "fn helper() { wrapper!(kani::assume(true)); }",
    "fn helper() { macro_rules! body { () => { kani::assume(true); } } }",
    "fn helper() { impl State { fn local() { kani::assume(true); } } }",
    "kani::assume(true);",
  ]) {
    const files = models();
    writeFileSync(files.rust, source);
    const result = baseline(files.dir, "record", files.record, files.rust);
    assert.equal(result.status, 1, source);
    assert.ok(result.stdout.includes("cannot identify a function owner"), result.stdout);
  }
});

const multiline = rust("kani::assume(window > 0 && window <= 2);", "kani::assume(\n            window > 0\n            && window <= 2,\n        );");

test("an edit to one line of a multi-line Kani assume is changed", () => {
  const outcome = recordedThenEdited(multiline, "rust", rust("&& window <= 2,", "&& window <= 3,"));
  assertChanged(outcome, "rust", "removed assume window > 0 && window <= 2,", "added assume window > 0 && window <= 3,");
});

test("a reformatted Kani assume is unchanged", () => {
  assertUnchanged(recordedThenEdited(multiline, "rust", rust("window > 0\n            && window <= 2,", "window > 0 && window <= 2,")), "rust");
});

test("whitespace inside Rust string literals is part of a Kani assumption", () => {
  for (const literal of ['"a b"', 'b"a b"', 'r##"a b"##', 'br#"a b"#', String.raw`r#"a \" b"#`, 'cr#"a " b " c"#']) {
    const value = literal.startsWith("cr") ? `${literal}.to_bytes()` : literal;
    const assumption = `kani::assume(${value}.len() == usize::from(window));`;
    const setup = rust("kani::assume(window > 0 && window <= 2);", assumption);
    assertChanged(recordedThenEdited(setup, "rust", rust(literal, literal.replace(" b", "  b"))), "rust", "removed assume", "added assume");
    assertUnchanged(recordedThenEdited(setup, "rust", rust(assumption, `kani::assume(\n    ${value}.len() == usize::from(window)\n);`)), "rust");
  }
});

test("a removed Kani cover is changed and an added cover is not", () => {
  assertChanged(recordedThenEdited(null, "rust", rust('        kani::cover!(state.next == state.consumed, "queue empty");\n', "")), "rust", 'removed cover state.next == state.consumed, "queue empty"');
  assertUnchanged(recordedThenEdited(null, "rust", rust("        if let Some(after) = consume(state) {", '        kani::cover!(state.next == 3, "three");\n        if let Some(after) = consume(state) {')), "rust");
});

test("a removed Kani harness is changed", () => {
  const remove = rust("    #[kani::proof]\n    #[kani::unwind(2)]\n    fn consume_keeps_invariant", "    #[kani::unwind(2)]\n    fn consume_keeps_invariant");
  assertChanged(recordedThenEdited(null, "rust", remove), "rust", "removed harness proofs::consume_keeps_invariant");
});

test("a Kani body edit that touches no assume, cover, stub or harness is unchanged", () => {
  assertUnchanged(recordedThenEdited(null, "rust", rust("Some(State { next: state.next + 1, ..state })", "Some(State { next: state.next + 2, ..state })")), "rust");
  const commented = rust("kani::assume(invariant(window, state));", '// kani::assume(false);\n        let _text = "kani::assume(false)";\n        kani::assume(invariant(window, state));');
  assertUnchanged(recordedThenEdited(null, "rust", commented), "rust");
});

test("an added Kani stub is changed", () => {
  const outcome = recordedThenEdited(null, "rust", rust("    #[kani::proof]\n    #[kani::unwind(2)]\n    fn claim_keeps_invariant", "    #[kani::proof]\n    #[kani::stub(consume, claim)]\n    #[kani::unwind(2)]\n    fn claim_keeps_invariant"));
  assertChanged(outcome, "rust", "added stub consume, claim");
});

test("adding, removing or changing a harness's should_panic or unwind attribute is changed", () => {
  const unwind = "    #[kani::unwind(2)]\n    fn claim_keeps_invariant";
  const edits = [
    [unwind.replace("(2)", "(1)"), "    old: kani::unwind(2)", "    new: kani::unwind(1)"],
    ["    fn claim_keeps_invariant", "    old: kani::unwind(2)", "    new: "],
    [`    #[kani::should_panic]\n${unwind}`, "    old: kani::unwind(2)", "    new: kani::should_panic kani::unwind(2)"],
  ];
  for (const [to, ...values] of edits) {
    const outcome = recordedThenEdited(null, "rust", rust(unwind, to));
    assertChanged(outcome, "rust", "changed harness proofs::claim_keeps_invariant");
    assert.deepEqual(outcome.out.slice(2, 4), values, to);
  }
  const removed = recordedThenEdited(rust(unwind, `    #[cfg_attr(kani, kani::should_panic)]\n${unwind}`), "rust", rust("    #[cfg_attr(kani, kani::should_panic)]\n", ""));
  assertChanged(removed, "rust", "    old: kani::should_panic kani::unwind(2)");
  assertUnchanged(recordedThenEdited(null, "rust", rust(unwind, unwind.replace("#[kani::unwind(2)]", "#[cfg_attr(kani, kani::unwind( 2 ))]"))), "rust");
  // Kani also reads either attribute as any argument of cfg_attr(kani, ...), and with any delimiters.
  const surface = (form) => {
    const files = models();
    edit(files.rust, unwind, unwind.replace("#[kani::unwind(2)]", form));
    const result = baseline(files.dir, "record", files.record, files.rust);
    assert.equal(result.status, 0, result.stdout);
    return JSON.parse(readFileSync(files.record, "utf8")).models[files.rust].surface;
  };
  const stubbed = surface("#[cfg_attr(kani, kani::stub(consume, claim), kani::unwind(2))]");
  assert.equal(stubbed["harness proofs::claim_keeps_invariant"], "kani::unwind(2)");
  assert.ok("stub consume, claim in proofs::claim_keeps_invariant" in stubbed, JSON.stringify(stubbed));
  for (const [form, value] of [
    ["#[cfg_attr(kani, allow(unused), kani::unwind(2),)]", "kani::unwind(2)"],
    ["#[cfg_attr(kani, kani::unwind(2), allow(unused))]", "kani::unwind(2)"],
    ["#[kani::unwind[2]] #[kani::should_panic()]", "kani::should_panic() kani::unwind[2]"],
  ]) {
    assert.equal(surface(form)["harness proofs::claim_keeps_invariant"], value, form);
  }
});

test("an added kani::any_where narrows like an assume and is changed", () => {
  const outcome = recordedThenEdited(null, "rust", rust("let window: u16 = kani::any();", "let window: u16 = kani::any_where(|w: &u16| *w == 1);"));
  assertChanged(outcome, "rust", "added assume |w: &u16| *w == 1");
});

test("a harness and stub written under cfg_attr(kani, ...) are recorded", () => {
  const wrapped = rust("    #[kani::proof]\n    #[kani::unwind(2)]\n    fn claim_keeps_invariant", "    #[cfg_attr(kani, kani::proof)]\n    #[kani::unwind(2)]\n    fn claim_keeps_invariant");
  const removed = recordedThenEdited(wrapped, "rust", rust("    #[cfg_attr(kani, kani::proof)]\n", ""));
  assertChanged(removed, "rust", "removed harness proofs::claim_keeps_invariant");
  const stubbed = recordedThenEdited(null, "rust", rust("    #[kani::proof]\n    #[kani::unwind(2)]\n    fn claim_keeps_invariant", "    #[kani::proof]\n    #[cfg_attr(kani, kani::stub(consume, claim))]\n    #[kani::unwind(2)]\n    fn claim_keeps_invariant"));
  assertChanged(stubbed, "rust", "added stub consume, claim");
});

test("an any_where with a nested turbofish is read as an assume", () => {
  const outcome = recordedThenEdited(null, "rust", rust("let window: u16 = kani::any();", "let window: u16 = kani::any_where::<Option<u16>>(|w| w.is_some()).unwrap();"));
  assertChanged(outcome, "rust", "added assume |w| w.is_some()");
});

test("a Kani path under another crate and a precise capture record", () => {
  const files = models();
  edit(files.rust, "#[cfg(kani)]", "use crate::kani::helpers::proof_state;\nfn keep<'a>(x: &'a u8) -> impl Sized + use<'a> { x }\n#[cfg(kani)]");
  assert.equal(baseline(files.dir, "record", files.record, files.rust).status, 0);
});

test("a Kani form or import the record cannot read fails the record instead of passing unrecorded", () => {
  const forms = [
    ["#[cfg(kani)]", "use kani::assume;\n#[cfg(kani)]", "use kani::assume"],
    ["#[cfg(kani)]", "use ::kani::{any, assume as given};\n#[cfg(kani)]", "use ::kani::{any, assume"],
    ["#[cfg(kani)]", "extern crate kani as k;\n#[cfg(kani)]", "extern crate kani as"],
    ["#[cfg(kani)]", "use {kani as k};\n#[cfg(kani)]", "use {kani as"],
    ["    #[kani::unwind(2)]\n    fn claim_keeps_invariant", "    #[cfg_attr(all(kani, test), kani::stub(consume, claim))]\n    #[kani::unwind(2)]\n    fn claim_keeps_invariant", "kani::stub"],
    ["    #[kani::unwind(2)]\n    fn claim_keeps_invariant", "    #[cfg_attr(all(kani, test), kani::unwind(1))]\n    fn claim_keeps_invariant", "kani::unwind"],
    ["#[cfg(kani)]", "use kani::should_panic;\n#[cfg(kani)]", "use kani::should_panic"],
  ];
  for (const [from, to, named] of forms) {
    const files = models();
    edit(files.rust, from, to);
    const result = baseline(files.dir, "record", files.record, files.rust);
    assert.equal(result.status, 1, to);
    assert.ok(lines(result)[0].startsWith("FAIL baseline:"), result.stdout);
    assert.ok(result.stdout.includes(named), result.stdout);
  }
});

test("re-recording a changed file prints the previous digest, and compare then passes", () => {
  const files = models();
  const first = baseline(files.dir, "record", files.record, files.rust);
  const digest = lines(first)[0].split(" ").at(-1);
  edit(files.rust, "kani::assume(window > 0 && window <= 2);", "kani::assume(window > 0 && window <= 1);");
  const second = lines(baseline(files.dir, "record", files.record, files.rust));
  assert.ok(second[0].startsWith(`RECORDED ${files.rust} `));
  assert.equal(second[1], `  previous ${digest}`);
  assert.equal(baseline(files.dir, "compare", files.record).status, 0);
});

test("recording one file keeps the other entries, and a repeat record prints no previous digest", () => {
  const files = models();
  baseline(files.dir, "record", files.record, files.rust);
  const again = baseline(files.dir, "record", files.record, files.rust);
  assert.equal(lines(again).length, 1);
  baseline(files.dir, "record", files.record, files.matrix, files.statements);
  const result = baseline(files.dir, "compare", files.record);
  assert.equal(result.status, 0);
  assert.equal(lines(result).at(-1), "SUMMARY 3 unchanged, 0 changed");
});

test("a deleted model file is changed", () => {
  assertChanged(recordedThenEdited(null, "rust", ({ rust: path }) => rmSync(path)), "rust", "file is missing");
});

// A harness that an earlier run wrote at the root of a crate of its own, and the production file it
// moves into, where the same functions sit in `mod proofs`. A cover message holds " in ", and
// `inputs` repeats an assumption, so the record has a numbered duplicate.
const harnessBody = [
  "fn inputs() -> u8 { let n: u8 = kani::any(); kani::assume(n < 10); kani::assume(n < 10); n }",
  '#[kani::proof] #[kani::unwind(2)] fn first() { let n = inputs(); kani::cover!(n == 9, "n in range"); }',
  '#[kani::proof] #[kani::unwind(2)] fn second() { let n = inputs(); kani::cover!(n == 0, "n in range"); }',
].join("\n");
const production = "pub fn target(n: u8) -> u8 { n }\n";

function moved(change = (body) => body, module = ["--module", "crate", "proofs"]) {
  const files = models();
  const old = join(files.dir, "verify/lib.rs");
  mkdirSync(join(files.dir, "verify"));
  writeFileSync(old, `use prod::*;\n${harnessBody}\n`);
  assert.equal(baseline(files.dir, "record", files.record, old).status, 0);
  writeFileSync(files.rust, `${production}#[cfg(kani)]\nmod proofs {\n    use super::*;\n${change(harnessBody)}\n}\n`);
  rmSync(old);
  const move = baseline(files.dir, "move", files.record, old, files.rust, ...module);
  return { old, move, ...compared(files) };
}

function compared(files) {
  const result = baseline(files.dir, "compare", files.record);
  return { files, result, out: lines(result) };
}

test("a Kani harness moved into a module of its production file compares unchanged against its old record", () => {
  const outcome = moved();
  assert.equal(outcome.move.status, 0, outcome.move.stdout);
  assert.deepEqual(lines(outcome.move), [`MOVED ${outcome.old} -> ${outcome.files.rust}`]);
  assertUnchanged(outcome, "rust");
});

test("a moved Kani harness that gains an assumption or loses a harness is changed", () => {
  const narrowed = moved((body) => body.replace("let n = inputs();", "let n = inputs(); kani::assume(n == 9);"));
  assertChanged(narrowed, "rust", "added assume n == 9 in proofs::first");
  const dropped = moved((body) => body.split("\n").filter((line) => !line.includes("fn second")).join("\n"));
  assertChanged(dropped, "rust", "removed harness proofs::second", 'removed cover n == 0, "n in range" in proofs::second');
});

test("a move without --module keeps each recorded qualified name", () => {
  const files = models();
  const old = join(files.dir, "verify/lib.rs");
  mkdirSync(join(files.dir, "verify"));
  copyFileSync(files.rust, old);
  assert.equal(baseline(files.dir, "record", files.record, old).status, 0);
  rmSync(old);
  assert.equal(baseline(files.dir, "move", files.record, old, files.rust).status, 0);
  assertUnchanged(compared(files), "rust");
});

test("a move into a recorded production file compares both harness modules", () => {
  const files = models();
  const old = join(files.dir, "verify/lib.rs");
  mkdirSync(join(files.dir, "verify"));
  writeFileSync(old, `use prod::*;\n${harnessBody}\n`);
  const existing = "#[cfg(kani)]\nmod existing {\n    #[kani::proof] #[kani::unwind(2)] fn third() { kani::assume(true); kani::cover!(true); }\n}\n";
  writeFileSync(files.rust, production + existing);
  assert.equal(baseline(files.dir, "record", files.record, old, files.rust).status, 0);
  writeFileSync(files.rust, `${production}${existing}#[cfg(kani)]\nmod proofs {\n    use super::*;\n${harnessBody}\n}\n`);
  rmSync(old);
  assert.equal(baseline(files.dir, "move", files.record, old, files.rust, "--module", "crate", "proofs").status, 0);
  assertUnchanged(compared(files), "rust");
  edit(files.rust, "kani::assume(true);", "");
  assertChanged(compared(files), "rust", "removed assume true in existing::third");
});

test("a move of an unrecorded file or into another kind of model is a usage error", () => {
  const unrecorded = moved();
  const again = baseline(unrecorded.files.dir, "move", unrecorded.files.record, unrecorded.old, unrecorded.files.rust);
  assert.equal(again.status, 2);
  assert.ok(again.stdout.includes("has no record entry"), again.stdout);
  const kind = baseline(unrecorded.files.dir, "move", unrecorded.files.record, unrecorded.files.rust, unrecorded.files.matrix);
  assert.equal(kind.status, 2);
  assert.ok(kind.stdout.includes("not a kani model file"), kind.stdout);
});

test("a move --module of a recorded item that is not a Kani item fails, names the item and keeps the record", () => {
  const files = models();
  assert.equal(baseline(files.dir, "record", files.record, files.rust).status, 0);
  rewriteStatements(files.record, (record) => {
    record.models[files.rust].surface["edited by hand"] = "";
  });
  const before = readFileSync(files.record, "utf8");
  const result = baseline(files.dir, "move", files.record, files.rust, join(files.dir, "other.rs"), "--module", "crate", "inner");
  assert.equal(result.status, 1);
  assert.deepEqual(lines(result), ["FAIL baseline: cannot rename the recorded item 'edited by hand', which is not a Kani harness, assume, cover or stub"]);
  assert.equal(result.stderr, "");
  assert.equal(readFileSync(files.record, "utf8"), before);
});

test("a malformed record fails", () => {
  const files = models();
  writeFileSync(files.record, "{}\n");
  const result = baseline(files.dir, "compare", files.record);
  assert.equal(result.status, 1);
  assert.ok(lines(result)[0].startsWith("FAIL baseline:"));
});

test("records without execution context are rejected rather than compared as current records", () => {
  const files = models();
  writeFileSync(files.record, JSON.stringify({ format: 1, models: {} }));
  const result = baseline(files.dir, "compare", files.record);
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes("unsupported record format"));
});

test("an unknown extension and a missing record file are usage errors", () => {
  const files = models();
  writeFileSync(join(files.dir, "notes.txt"), "text\n");
  const unknown = baseline(files.dir, "record", files.record, join(files.dir, "notes.txt"));
  assert.equal(unknown.status, 2);
  assert.ok(unknown.stdout.includes("notes.txt"));
  const missing = baseline(files.dir, "compare", files.record);
  assert.equal(missing.status, 2);
  assert.ok(missing.stdout.includes("does not exist"));
  assert.equal(baseline(files.dir, "frobnicate").status, 2);
});
