// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { assertProcessStopped, command, excludes, fakeTlc, fixture, includes, logs, removeFixtures, root, run, scripts } from "./helpers.mjs";

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

test("TLC setup reports a Java that does not run, and a JAR from which TLC does not start", () => {
  const dir = fixture();
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const noTlc = command(dir, "no-tlc", '[ "$1" = -version ] && exit 0\necho "Error: Could not find or load main class tlc2.TLC"; exit 1');
  for (const [java, reason] of [
    [join(dir, "absent-java"), "absent-java has no runtime; install a JDK"],
    [command(dir, "no-runtime", "exit 1"), "no-runtime has no runtime; install a JDK"],
    [noTlc, `tlc2.TLC cannot run from ${join(dir, "tools.jar")}`],
  ]) {
    const result = run(dir, "setup.sh", ["tla"], { JAVA: java, TLC_JAR: join(dir, "tools.jar") });
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.ok(result.stdout.startsWith("UNAVAILABLE "), result.stdout);
    includes(result.stdout, reason);
  }
  const result = run(dir, "setup.sh", ["tla"], { JAVA: noTlc, TLC_JAR: join(dir, "tools.jar") });
  includes(result.stdout, "\nError: Could not find or load main class tlc2.TLC\n");
  const timeout = run(dir, "setup.sh", ["tla"], { TLC_JAR: join(dir, "tools.jar"), TLC_TIMEOUT: "bogus" });
  assert.equal(timeout.status, 3, timeout.stdout + timeout.stderr);
  assert.ok(timeout.stdout.startsWith("UNAVAILABLE TLC_TIMEOUT="), timeout.stdout);
});

test("TLC setup accepts a JAR whose TLC prints its help and exits non-zero", () => {
  const dir = fixture();
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = command(dir, "java", '[ "$1" = -version ] && exit 0\necho "TLC - provides model checking and simulation"; exit 1');
  const result = run(dir, "setup.sh", ["tla"], { JAVA: java, TLC_JAR: join(dir, "tools.jar") });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  includes(result.stdout, "READY TLC " + join(dir, "tools.jar"));
});

test("TLC setup accepts a Java whose output is not UTF-8", () => {
  const dir = fixture();
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = command(dir, "latin1-java", "printf 'Picked up _JAVA_OPTIONS: -Dx=\\351\\n' >&2\n[ \"$1\" = -version ] && exit 0\necho \"TLC - provides model checking and simulation\"");
  const result = run(dir, "setup.sh", ["tla"], { JAVA: java, TLC_JAR: join(dir, "tools.jar") });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  includes(result.stdout, "READY TLC " + join(dir, "tools.jar"));
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
  return spawnSync("python3", [join(scripts, "tlc_trace.py"), join(logs, log)], { encoding: "utf8" });
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

function parseTraceFile(path) {
  const script = [
    "import dataclasses, json, sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc_trace",
    `with open(${JSON.stringify(path)}, encoding="utf-8", newline="") as f:`,
    "    trace = tlc_trace.parse(f)",
    "print(json.dumps(None if trace is None else dataclasses.asdict(trace)))",
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function parseTraceText(text) {
  const script = [
    "import dataclasses, json, re, sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc_trace",
    `trace = tlc_trace.parse(re.split(r"\\r\\n|\\r|\\n", ${JSON.stringify(text)}))`,
    "print(json.dumps(None if trace is None else dataclasses.asdict(trace)))",
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", script], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("tlc_trace.parse parses an invariant violation trace with changed diffs", () => {
  const trace = parseTraceFile(join(logs, "tlc-invariant.log"));
  assert.deepEqual(trace, {
    lasso: null,
    steps: [
      {
        number: 1,
        action: "Initial predicate",
        values: [["x", "0"], ["y", "0"]],
        changed: [
          { name: "x", old: null, new: "0" },
          { name: "y", old: null, new: "0" },
        ],
      },
      {
        number: 2,
        action: "Step",
        values: [["x", "1"], ["y", "0"]],
        changed: [{ name: "x", old: "0", new: "1" }],
      },
      {
        number: 3,
        action: "Step",
        values: [["x", "2"], ["y", "1"]],
        changed: [
          { name: "x", old: "1", new: "2" },
          { name: "y", old: "0", new: "1" },
        ],
      },
      {
        number: 4,
        action: "Step",
        values: [["x", "3"], ["y", "1"]],
        changed: [{ name: "x", old: "2", new: "3" }],
      },
    ],
  });
});

test("tlc_trace.parse parses liveness lasso with action and location stripped", () => {
  const trace = parseTraceFile(join(logs, "tlc-liveness.log"));
  assert.equal(trace.steps.length, 3);
  assert.deepEqual(trace.lasso, { target: 1, action: "Wrap" });
});

test("tlc_trace.parse parses Back to state without action label", () => {
  const trace = parseTraceText([
    "Error: Temporal properties were violated.",
    "Error: The following behavior constitutes a counter-example:",
    "State 1: <Init>",
    "/\\ x = 0",
    "State 2: <Step>",
    "/\\ x = 1",
    "Back to state 2",
  ].join("\n"));
  assert.equal(trace.steps.length, 2);
  assert.deepEqual(trace.lasso, { target: 2, action: "" });
});

test("tlc_trace.parse parses one-variable multi-line values, deadlock, reach, and returns None when absent", () => {
  const oneVar = parseTraceFile(join(logs, "tlc-one-variable.log"));
  assert.equal(oneVar.steps.length, 3);
  assert.deepEqual(oneVar.steps[0].values, [["x", "<<>>"]]);
  assert.ok(oneVar.steps[1].values[0][1].startsWith("<< [ id |-> 0,\n     payload |->"));
  assert.equal(oneVar.steps[1].changed[0].old, "<<>>");

  const deadlock = parseTraceFile(join(logs, "tlc-deadlock.log"));
  assert.deepEqual(deadlock, {
    lasso: null,
    steps: [{
      number: 1,
      action: "Initial predicate",
      values: [["x", "0"]],
      changed: [{ name: "x", old: null, new: "0" }],
    }],
  });

  const reach = parseTraceFile(join(logs, "tlc-reach.log"));
  assert.equal(reach.steps.length, 2);
  assert.equal(reach.steps[1].action, "Claim");
  assert.deepEqual(reach.steps[1].changed, [{ name: "next", old: "0", new: "1" }]);

  assert.equal(parseTraceFile(join(logs, "lake-sorry.log")), null);
});

test("tlc_trace.parse parses initial-state violations into a 1-step trace", () => {
  const trace = parseTraceFile(join(logs, "tlc-reach-initial.log"));
  assert.deepEqual(trace, {
    lasso: null,
    steps: [{
      number: 1,
      action: "Initial predicate",
      values: [["consumed", "0"], ["next", "0"]],
      changed: [
        { name: "consumed", old: null, new: "0" },
        { name: "next", old: null, new: "0" },
      ],
    }],
  });
});

test("tlc_trace.parse parses single-variable initial-state violation with CRLF endings", () => {
  const trace = parseTraceText([
    "Error: Invariant Inv is violated by the initial state:",
    "x = << 1,",
    "       2 >>",
    "",
    "Finished in 00s",
  ].join("\r\n"));
  assert.deepEqual(trace, {
    lasso: null,
    steps: [{
      number: 1,
      action: "Initial predicate",
      values: [["x", "<< 1,\n       2 >>"]],
      changed: [{ name: "x", old: null, new: "<< 1,\n       2 >>" }],
    }],
  });
});

test("tlc_trace.parse stops at post-trace text without appending trailing states or lassos", () => {
  const afterBlank = parseTraceText([
    "Error: Invariant Inv is violated.",
    "Error: The behavior up to this point is:",
    "State 1: <Init>",
    "/\\ x = 0",
    "",
    "State 2: <Step>",
    "/\\ x = 1",
    "",
    "2 states generated, 2 distinct states found, 0 states left on queue.",
    "Error: The following behavior constitutes a counter-example:",
    "State 3: <Bogus>",
    "/\\ x = 99",
    "Back to state 1: <BogusLoop>",
  ].join("\n"));
  assert.equal(afterBlank.steps.length, 2);
  assert.equal(afterBlank.lasso, null);

  const direct = parseTraceText([
    "Error: Invariant Inv is violated.",
    "Error: The behavior up to this point is:",
    "State 1: <Init>",
    "/\\ x = 0",
    "2 states generated, 1 distinct states found.",
    "State 2: <Bogus>",
    "/\\ x = 99",
  ].join("\n"));
  assert.equal(direct.steps.length, 1);
  assert.equal(direct.lasso, null);
});

test("tlc_trace.parse preserves previous variable values across an empty state", () => {
  const withBlank = parseTraceText([
    "Error: Temporal properties were violated.",
    "Error: The following behavior constitutes a counter-example:",
    "State 1: <Init>",
    "/\\ x = 0",
    "/\\ y = 1",
    "",
    "State 2: <Stuttering>",
    "",
    "State 3: <Step>",
    "/\\ x = 2",
    "/\\ y = 1",
  ].join("\n"));
  assert.equal(withBlank.steps.length, 3);
  assert.deepEqual(withBlank.steps[1].values, []);
  assert.deepEqual(withBlank.steps[1].changed, []);
  assert.deepEqual(withBlank.steps[2].changed, [{ name: "x", old: "0", new: "2" }]);

  const adjacent = parseTraceText([
    "Error: Temporal properties were violated.",
    "Error: The following behavior constitutes a counter-example:",
    "State 1: <Init>",
    "/\\ x = 0",
    "/\\ y = 1",
    "State 2: <Stuttering>",
    "State 3: <Step>",
    "/\\ x = 2",
    "/\\ y = 1",
  ].join("\n"));
  assert.equal(adjacent.steps.length, 3);
  assert.deepEqual(adjacent.steps[2].changed, [{ name: "x", old: "0", new: "2" }]);
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

test("matrix checks affect only subsequent runs and reset at the next spec", () => {
  const { dir, matrix } = matrixFixture([
    "spec a/One.tla", "check INVARIANTS Early", "run first | N=1",
    "check PROPERTIES Later", "run second | N=2", "spec a/One.tla", "run third | N=3",
  ], [
    "for last; do :; done",
    'grep -E "^(INVARIANTS|PROPERTIES)" "$(dirname "$last")/MC.cfg" >> "$TASK_TRACE"',
    'echo END >> "$TASK_TRACE"',
    'echo "Model checking completed. No error has been found."',
  ].join("\n"));
  assert.equal(matrix().status, 0);
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "INVARIANTS Early\nEND\nINVARIANTS Early\nPROPERTIES Later\nEND\nEND\n");
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

test("each TLC run gets its own existing java.io.tmpdir", () => {
  const { dir, matrix } = matrixFixture(["spec a/One.tla", "run first | N=1", "run second | N=2"], [
    'for arg; do case "$arg" in -Djava.io.tmpdir=*) tmp=${arg#-Djava.io.tmpdir=}; [ -d "$tmp" ] && echo "$tmp" >> "$TASK_TRACE";; esac; done',
    'echo "Model checking completed. No error has been found."',
    'echo "4 distinct states found"',
  ].join("\n"));
  assert.equal(matrix().status, 0);
  const tmpdirs = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : [];
  assert.equal(tmpdirs.length, 2, `java.io.tmpdir per launch: ${JSON.stringify(tmpdirs)}`);
  assert.notEqual(tmpdirs[0], tmpdirs[1]);
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

test("the matrix runner strips trailing spaces and tabs before | in run labels", () => {
  const { matrix } = matrixFixture([
    "run before-spec   \t | N=1",
    "spec a/One.tla",
    "run small-case     | N=1",
    "run multi  word\t  | N=2",
  ]);
  const result = matrix();
  assert.equal(result.status, 1);
  includes(result.stdout, "FAIL run 'before-spec' before any spec line\n");
  includes(result.stdout, "PASS One small-case 4 distinct states found\n");
  includes(result.stdout, "PASS One multi  word 4 distinct states found\n");
  const filtered = matrix(["small-case"]);
  assert.equal(filtered.stdout, "FAIL run 'before-spec' before any spec line\nPASS One small-case 4 distinct states found\nSUMMARY 1 of 1 runs passed, 4 distinct states in total\n");
});

test("invalid TLC_TIMEOUT settings are reported as unavailable without starting TLC", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun n=1 | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  for (const value of ["0", "-5", "abc", "4294967296"]) {
    const result = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix")], {
      JAVA: fakeTlc(dir, 'echo started >> "$TASK_TRACE"'),
      TLC_JAR: join(dir, "tools.jar"),
      TLC_TIMEOUT: value,
    });
    assert.equal(result.status, 3, value);
    assert.ok(result.stdout.startsWith("UNAVAILABLE "), result.stdout);
    includes(result.stdout, "TLC_TIMEOUT");
  }
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("the matrix runner deletes each run directory as soon as the run finishes", () => {
  const dir = fixture();
  const customTmp = join(dir, "work-tmp");
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun first | N=1\nrun second | N=2\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = fakeTlc(dir, [
    'for last; do :; done',
    'run_dir=$(dirname "$last")',
    'work_dir=$(dirname "$run_dir")',
    'mkdir -p "$run_dir/states"',
    'echo state-data > "$run_dir/states/mock.fp"',
    'ls -1 "$work_dir" | wc -l | tr -d " " >> "$TASK_TRACE"',
    'echo "Model checking completed. No error has been found."',
    'echo "4 distinct states found"',
  ].join("\n"));
  const result = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix")], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
    TMPDIR: customTmp,
    FORMAL_MIN_FREE_GIB: "0",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Each run sees only its own single run.* dir because the prior run.* was deleted.
  assert.equal(readFileSync(join(dir, "calls"), "utf8"), "1\n1\n");
  assert.deepEqual(readdirSync(customTmp), []);
});

test("timed-out TLC runs terminate their child process and report ordinary failure or incomplete reach", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nreach Full | n=1\nrun n=1 | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const pidFile = join(dir, "child.pid");
  const java = fakeTlc(dir, [
    'echo "Progress(1) at 2026-11-18 00:00:01: 100 states generated"',
    'echo "$$" > "$TASK_PID_FILE"',
    'exec sleep 30',
  ].join("\n"));
  const result = run(dir, "tlc-matrix.sh", [join(dir, "One.matrix")], {
    JAVA: java,
    TLC_JAR: join(dir, "tools.jar"),
    TLC_TIMEOUT: "1s",
    TASK_PID_FILE: pidFile,
  });
  assert.equal(result.status, 1);
  includes(result.stdout, "FAIL One n=1: TLC timed out after 1s; set TLC_TIMEOUT to change the limit");
  includes(result.stdout, "Progress(1)");
  includes(result.stdout, "FAIL One reach Full n=1: TLC did not complete the reach check");
  excludes(result.stdout, "the model never reaches this state");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assertProcessStopped(pid);
});

test("long TLC runs forward elapsed time and Progress updates to stderr without changing stdout parsing", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  writeFileSync(join(dir, "One.matrix"), "spec One.tla\nrun n=1 | N=1\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = fakeTlc(dir, [
    'echo "Progress(42) at 2026-11-18 00:00:01: 1,000 states generated, 500 distinct states found, 100 states left on queue."',
    'sleep 0.25',
    'echo "Model checking completed. No error has been found."',
    'echo "500 distinct states found"',
  ].join("\n"));
  const script = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import tlc",
    "tlc.PROGRESS_DELAY = 0.05",
    "tlc.PROGRESS_INTERVAL = 0.05",
    `sys.argv = ['tlc.py', ${JSON.stringify(join(dir, "One.matrix"))}]`,
    "sys.exit(tlc.main())",
  ].join("; ");
  const result = spawnSync("python3", ["-B", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, JAVA: java, TLC_JAR: join(dir, "tools.jar") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "PASS One n=1 500 distinct states found\nSUMMARY 1 of 1 runs passed, 500 distinct states in total\n");
  assert.match(result.stderr, /\[tlc\] One n=1: \d+s elapsed: Progress\(42\)/);
});

function runTlcRunner(dir, javaBody, matrixLines, extraEnv = {}) {
  writeFileSync(join(dir, "checks.matrix"), matrixLines.join("\n") + "\n");
  writeFileSync(join(dir, "tools.jar"), "user supplied");
  const java = fakeTlc(dir, javaBody);
  const script = [
    "import dataclasses, json, sys, tempfile",
    "from pathlib import Path",
    `sys.path.insert(0, ${JSON.stringify(scripts)})`,
    "import storage, tlc",
    "checker = tlc.Tlc()",
    "rendered = []",
    "with tempfile.TemporaryDirectory(dir=storage.ensure_temp_root()) as work:",
    `    r = tlc.Runner(checker, Path(${JSON.stringify(dir)}), "", lambda res: rendered.extend(tlc.render(res)), Path(work))`,
    `    for task in tlc.MatrixPlan(${JSON.stringify(join(dir, "checks.matrix"))}):`,
    "        r.check(task)",
    "def encode(obj):",
    "    if isinstance(obj, tlc.Outcome):",
    "        return obj.value",
    "    raise TypeError(type(obj))",
    "payload = {'failed': r.failed, 'rendered': rendered, 'results': [dataclasses.asdict(res) for res in r.results]}",
    "print(json.dumps(payload, default=encode))",
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, JAVA: java, TLC_JAR: join(dir, "tools.jar"), ...extraEnv },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}

test("tlc.Runner captures constants, checks, duration_s, and traces across PASS, FAIL (invariant and liveness), and MISSING", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  const java = [
    'for last; do :; done',
    'cfg="$(dirname "$last")/MC.cfg"',
    'if grep -q "N = 1" "$cfg"; then',
    '  echo "Model checking completed. No error has been found."',
    '  echo "4 distinct states found"',
    'elif grep -q "N = 2" "$cfg"; then',
    `  cat ${JSON.stringify(join(logs, "tlc-invariant.log"))}`,
    '  exit 12',
    'else',
    `  cat ${JSON.stringify(join(logs, "tlc-liveness.log"))}`,
    '  exit 12',
    'fi',
  ].join("\n");
  const out = runTlcRunner(dir, java, [
    "spec One.tla",
    "check INVARIANTS Small",
    "run ok |   N=1  ",
    "check PROPERTIES Live",
    "run inv | N=2",
    "run live | N=3",
    "spec Gone.tla",
    "check INVARIANTS MissingCheck",
    "run gone | N=4",
  ]);
  assert.equal(out.failed, true);
  assert.equal(out.results.length, 4);

  const [passRes, invRes, liveRes, missingRes] = out.results;
  assert.equal(passRes.outcome, "pass");
  assert.equal(passRes.constants, "N=1");
  assert.deepEqual(passRes.checks, ["INVARIANTS Small"]);
  assert.ok(passRes.duration_s >= 0);
  assert.equal(passRes.trace, null);

  assert.equal(invRes.outcome, "fail");
  assert.equal(invRes.constants, "N=2");
  assert.deepEqual(invRes.checks, ["INVARIANTS Small", "PROPERTIES Live"]);
  assert.ok(invRes.duration_s >= 0);
  assert.equal(invRes.trace.steps.length, 4);
  assert.equal(invRes.trace.lasso, null);

  assert.equal(liveRes.outcome, "fail");
  assert.equal(liveRes.constants, "N=3");
  assert.deepEqual(liveRes.checks, ["INVARIANTS Small", "PROPERTIES Live"]);
  assert.ok(liveRes.duration_s >= 0);
  assert.equal(liveRes.trace.steps.length, 3);
  assert.deepEqual(liveRes.trace.lasso, { target: 1, action: "Wrap" });

  assert.equal(missingRes.outcome, "missing");
  assert.equal(missingRes.constants, "N=4");
  assert.deepEqual(missingRes.checks, ["INVARIANTS MissingCheck"]);
  assert.equal(missingRes.duration_s, 0);
  assert.equal(missingRes.trace, null);

  assert.ok(out.rendered.includes("PASS One ok 4 distinct states found"));
  assert.ok(out.rendered.includes("FAIL One inv: Error: Invariant Small is violated."));
  assert.ok(out.rendered.includes("FAIL One live: Error: Temporal properties were violated."));
  assert.ok(out.rendered.includes("FAIL Gone gone: spec Gone.tla not found"));
});

test("tlc.Runner captures traces and metadata for multi-state and initial-state reach witnesses", () => {
  const dir = fixture();
  writeFileSync(join(dir, "One.tla"), "---- MODULE One ----\n====\n");
  const java = [
    'for last; do :; done',
    'cfg="$(dirname "$last")/MC.cfg"',
    'if grep -q "^INVARIANT Reach" "$cfg"; then',
    '  name=$(sed -n "s/^INVARIANT //p" "$cfg")',
    '  if grep -q "N = 1" "$cfg"; then',
    `    sed "s/ReachNegated/$name/g" ${JSON.stringify(join(logs, "tlc-reach.log"))}`,
    '  else',
    `    sed "s/ReachNegated/$name/g" ${JSON.stringify(join(logs, "tlc-reach-initial.log"))}`,
    '  fi',
    '  exit 12',
    'fi',
    'echo "Model checking completed. No error has been found."',
    'echo "4 distinct states found"',
  ].join("\n");
  const out = runTlcRunner(dir, java, [
    "spec One.tla",
    "reach Multi | multi",
    "reach Init | init",
    "run multi | N=1",
    "run init | N=2",
  ]);
  assert.equal(out.failed, false);
  assert.equal(out.results.length, 4);
  const multiWitness = out.results[2];
  const initWitness = out.results[3];
  assert.equal(multiWitness.outcome, "witness");
  assert.equal(multiWitness.constants, "N=1");
  assert.deepEqual(multiWitness.checks, []);
  assert.ok(multiWitness.duration_s >= 0);
  assert.equal(multiWitness.trace.steps.length, 2);
  assert.equal(multiWitness.trace.steps[1].action, "Claim");

  assert.equal(initWitness.outcome, "witness");
  assert.equal(initWitness.constants, "N=2");
  assert.deepEqual(initWitness.checks, []);
  assert.ok(initWitness.duration_s >= 0);
  assert.equal(initWitness.trace.steps.length, 1);
  assert.equal(initWitness.trace.steps[0].action, "Initial predicate");
  assert.deepEqual(initWitness.trace.steps[0].values, [["consumed", "0"], ["next", "0"]]);

  assert.ok(out.rendered.includes("PASS One reach Multi multi: shortest trace 2 states (1 transitions)"));
  assert.ok(out.rendered.includes("PASS One reach Init init: shortest trace 1 states (0 transitions)"));
});
