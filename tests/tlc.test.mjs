// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { command, excludes, fakeTlc, fixture, includes, logs, removeFixtures, run, scripts } from "./helpers.mjs";

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

function matrixFixture(lines, java, log = "tlc-invariant.log") {
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
      JAVA: fakeTlc(dir, java ?? passing),
      TLC_JAR: join(dir, "tools.jar"),
      TLC_LOG: join(logs, log),
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

test("the matrix runner reads a matrix that holds bytes that are not UTF-8", () => {
  const { dir, matrix } = matrixFixture([]);
  writeFileSync(join(dir, "checks.matrix"), Buffer.concat([Buffer.from("# caf"), Buffer.from([0xe9]), Buffer.from("\nspec a/One.tla\nrun n=1 | N=1\n")]));
  const result = matrix();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  includes(result.stdout, "PASS One n=1 4 distinct states found\n");
});

test("the matrix runner fails a run line without a bar instead of inventing a constant", () => {
  const { dir, matrix } = matrixFixture(["spec a/One.tla", "run n=4"], 'echo started >> "$TASK_TRACE"');
  const result = matrix();
  assert.equal(result.status, 1);
  includes(result.stdout, "FAIL run 'n=4' has no | before its constants");
  assert.equal(existsSync(join(dir, "calls")), false);
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

test("the pinned TLC help command may return 1 after printing its help", () => {
  const dir = fixture();
  const jar = join(dir, "tools.jar");
  writeFileSync(jar, "supplied");
  const java = command(dir, "help-java", '[ "$1" = "-version" ] && exit 0\necho "TLC - provides model checking and simulation of TLA+ specifications - Version 2.19"; exit 1');
  const result = run(dir, "setup.sh", ["tla"], { JAVA: java, TLC_JAR: jar });
  assert.equal(result.status, 0, result.stdout);
  includes(result.stdout, "READY TLC");
});

const reachJava = [
  'for last; do :; done',
  'dir=$(dirname "$last")',
  'if grep -q "^INVARIANT Reach" "$dir/MC.cfg"; then',
  '  name=$(sed -n "s/^INVARIANT //p" "$dir/MC.cfg")',
  '  sed "s/ReachNegated/$name/g" "$TLC_LOG"',
  '  exit 12',
  'fi',
  'echo "Model checking completed. No error has been found."',
  'echo "4 distinct states found"',
].join("\n");

const reachFixture = (lines, java = reachJava, log = "tlc-reach.log") => matrixFixture(lines, java, log);

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

test("the matrix runner rejects empty or unsupported checks", () => {
  for (const check of ["check", "check INVARIANTS", "check UNKNOWN Small"]) {
    const { matrix } = matrixFixture(["spec a/One.tla", check, "run n=1 | N=1"]);
    const result = matrix();
    assert.equal(result.status, 1);
    includes(result.stdout, "malformed check");
  }
});
