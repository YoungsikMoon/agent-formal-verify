// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { bundle, command, DRIVER, excludes, fixture, includes, installKani, KANI, logs, python, removeFixtures, run, scripts, TOOLCHAIN, writeJson } from "./helpers.mjs";

afterEach(removeFixtures);

const calls = (dir) => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "");
const runKani = (dir, script, args = [], extra = {}) => run(dir, script, args, { KANI_HOME: join(dir, "kani"), ...extra });

const kaniBundle = (config = {}) => installKani(fixture(), config);

function kaniFixture(outcome = "success", config = {}) {
  const report = JSON.parse(readFileSync(join(logs, `kani-${outcome}.json`), "utf8"));
  const name = report.verification_results.results[0].harness_id;
  const dir = kaniBundle({ harnesses: { [name]: 3 }, ...config });
  writeFileSync(join(dir, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
  writeJson(join(dir, "report.json"), report);
  command(dir, "cargo", `shift; if [ ! -x "$KANI_HOME/kani-${KANI}/bin/kani-driver" ]; then echo auto-install >> "$TASK_TRACE"; exit 99; fi; exec "$KANI_HOME/kani-${KANI}/bin/kani-driver" "$@"`);
  return { dir, name, report };
}

function rustMutation(dir, name, label = "guard") {
  writeFileSync(join(dir, "baseline.json"), readFileSync(join(logs, "kani-success.json")));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), "old\n");
  const mutations = join(dir, "src/lib.mutations");
  writeFileSync(mutations, `mutation ${label}\ndetects ${name}\n- old\n+ new\n`);
  return mutations;
}

test("Kani setup rejects a missing verifier without installing it", () => {
  const dir = kaniBundle();
  rmSync(join(bundle(dir), "bin/kani-driver"));
  command(dir, "cargo", 'echo auto-install >> "$TASK_TRACE"; exit 99');
  const result = runKani(dir, "setup.sh", ["rust"]);
  assert.equal(result.status, 3);
  includes(result.stdout, "UNAVAILABLE");
  includes(result.stdout, `--version ${KANI}`);
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("Kani setup accepts the pinned version", () => {
  const dir = kaniBundle();
  const result = runKani(dir, "setup.sh", ["rust"]);
  assert.equal(result.status, 0);
  includes(result.stdout, `READY Kani ${KANI}`);
});

test("Kani setup rejects a different verifier version", () => {
  const dir = kaniBundle({ version: "0.67.0" });
  const result = runKani(dir, "setup.sh", ["rust"]);
  assert.equal(result.status, 3);
  includes(result.stdout, "UNAVAILABLE");
});

test("Kani reports an unexecutable bundle as unavailable without a traceback", () => {
  const dir = kaniBundle();
  writeFileSync(join(bundle(dir), "bin/kani-driver"), "invalid executable\n");
  const result = runKani(dir, "setup.sh", ["rust"]);
  assert.equal(result.status, 3);
  includes(result.stdout, `UNAVAILABLE Kani ${KANI} cannot run`);
  excludes(result.stderr, "Traceback");
});

test("a second Ctrl-C while Kani's readiness check is stopped still stops the processes the driver started", async () => {
  const dir = kaniBundle();
  const sleepPid = join(dir, "sleep.pid");
  writeFileSync(join(bundle(dir), "bin/kani-driver"), `#!/bin/bash\nsleep 30 &\necho "$!" > "${sleepPid}"\nwait\n`);
  const realPs = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf8" }).stdout.trim();
  assert.ok(realPs, "ps must be on PATH");
  // Hold each listing back so the second Ctrl-C arrives while the runner is stopping the driver.
  command(dir, "ps", `sleep 0.5\nexec "${realPs}" "$@"`);
  const outcome = await new Promise((resolve) => {
    const child = spawn("python3", [join(scripts, "kani.py"), "ready"], {
      env: { ...process.env, KANI_HOME: join(dir, "kani"), PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    });
    const timer = setInterval(() => {
      if (existsSync(sleepPid) && readFileSync(sleepPid, "utf8").endsWith("\n")) {
        clearInterval(timer);
        child.kill("SIGINT");
        setTimeout(() => child.kill("SIGINT"), 500);
      }
    }, 20);
    child.on("close", (exitCode, signalName) => {
      clearInterval(timer);
      resolve({ exitCode, signalName });
    });
  });
  const pid = Number(readFileSync(sleepPid, "utf8"));
  const running = () => {
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    return state !== "" && !state.startsWith("Z");
  };
  try {
    const deadline = Date.now() + 1000;
    while (running() && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    assert.ok(!running(), `the driver's sleep ${pid} is still running`);
    assert.equal(outcome.signalName, "SIGINT", JSON.stringify(outcome));
  } finally {
    for (const signal of ["SIGCONT", "SIGKILL"]) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  }
});

for (const outcome of ["success", "failure", "unwind", "unsat", "unreachable"]) {
  test(`Kani ${outcome} has the expected wrapper verdict`, () => {
    const { dir, name } = kaniFixture(outcome);
    const result = runKani(dir, "kani-check.sh", [dir]);
    assert.equal(result.status, outcome === "success" ? 0 : 1, result.stdout + result.stderr);
    includes(result.stdout, `${outcome === "success" ? "PASS" : "FAIL"} ${name} unwind=3 checks=`);
    includes(result.stdout, `SUMMARY ${outcome === "success" ? 1 : 0} of 1 harnesses passed`);
    if (outcome === "unwind") includes(result.stdout, "bound too low");
    if (outcome !== "success") includes(result.stdout, "src/lib.rs:");
  });
}

for (const damage of ["unknown status", "wrong version", "wrong harness", "incomplete", "empty checks"]) {
  test(`Kani rejects ${damage}`, () => {
    const { dir, report } = kaniFixture();
    const result = report.verification_results.results[0];
    if (damage === "unknown status") result.checks[0].status = "Unknown";
    if (damage === "wrong version") report.metadata.kani_version = "0.1.0";
    if (damage === "wrong harness") result.harness_id = "other";
    if (damage === "incomplete") report.verification_results.summary.executed = 0;
    if (damage === "empty checks") result.checks = [];
    writeJson(join(dir, "report.json"), report);
    const done = runKani(dir, "kani-check.sh", [dir]);
    assert.equal(done.status, 1);
    excludes(done.stdout, "PASS ");
    includes(done.stdout, "verification did not complete");
  });
}

test("Kani rejects a crate without harnesses", () => {
  const { dir } = kaniFixture("success", { harnesses: {} });
  const result = runKani(dir, "kani-check.sh", [dir]);
  assert.equal(result.status, 1);
  includes(result.stdout, "no proof harnesses");
  excludes(result.stdout, "SUMMARY");
});

for (const script of ["kani-check.sh", "mutate.py"]) {
  test(`Kani ${script} reports malformed harness metadata as a failure without a traceback`, () => {
    const { dir, name } = kaniFixture("success", { metadata: [] });
    const result = runKani(dir, script, [script === "mutate.py" ? rustMutation(dir, name) : dir]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    includes(result.stdout, "FAIL malformed Kani discovery record");
    excludes(result.stderr, "Traceback");
  });
}

for (const script of ["kani-check.sh", "mutate.py"]) {
  test(`Kani ${script} names its bundled toolchain when the crate needs a newer library feature`, () => {
    const { dir, name } = kaniFixture("success", { listError: "error[E0658]: use of unstable library feature `drop_guard`" });
    const result = runKani(dir, script, [script === "mutate.py" ? rustMutation(dir, name) : dir]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    includes(result.stdout, "error[E0658]");
    includes(result.stdout, `bundled ${TOOLCHAIN}`);
    excludes(result.stderr, "Traceback");
  });
}

test("Kani adds no toolchain note to other discovery failures", () => {
  const { dir } = kaniFixture("success", { listError: "error[E0425]: cannot find value `x` in this scope" });
  const result = runKani(dir, "kani-check.sh", [dir]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stdout, "Kani discovery failed");
  excludes(result.stdout, TOOLCHAIN);
});

test("Kani distinguishes malformed projects from unavailable tools", () => {
  const { dir } = kaniFixture();
  const result = runKani(dir, "kani-check.sh", [join(dir, "missing")]);
  assert.equal(result.status, 1);
  includes(result.stdout, "Cargo.toml is missing");
});

test("Kani does not invoke cargo when its custom bundle is absent or incomplete", () => {
  const dir = fixture();
  command(dir, "cargo", 'echo invoked >> "$TASK_TRACE"; exit 99');
  for (const home of [join(dir, "absent"), join(dir, "incomplete")]) {
    mkdirSync(home, { recursive: true });
    const result = run(dir, "setup.sh", ["rust"], { KANI_HOME: home });
    assert.equal(result.status, 3);
    includes(result.stdout, "UNAVAILABLE");
    assert.equal(existsSync(join(dir, "calls")), false);
  }
});

test("Kani refuses an unfinished installer archive before invoking cargo", () => {
  const dir = kaniBundle();
  writeFileSync(join(dir, "kani/incomplete.tar.gz"), "archive");
  command(dir, "cargo", 'echo invoked >> "$TASK_TRACE"; exit 99');
  const result = runKani(dir, "setup.sh", ["rust"]);
  assert.equal(result.status, 3);
  includes(result.stdout, "incomplete Kani setup");
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("Kani uses the complete pinned bundle without a registered installer", () => {
  const dir = kaniBundle();
  command(dir, "cargo", 'echo auto-install >> "$TASK_TRACE"; exit 99');
  const result = runKani(dir, "setup.sh", ["rust"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  excludes(calls(dir), "auto-install");
});

test("temporary files that Kani's tools leave in TMPDIR go with the runner's work directory", () => {
  const { dir } = kaniFixture("success");
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  // A tool stopped partway, such as goto-cc, leaves its temporary file behind.
  const driver = join(bundle(dir), "bin/kani-driver");
  writeFileSync(driver, `#!${python}\nimport os, sys\nif sys.argv[1:] != ["--version"]:\n    open(os.path.join(os.environ.get("TMPDIR"), "goto-cc-left"), "w").close()\n${DRIVER}`);
  const result = runKani(dir, "kani-check.sh", [dir], { TMPDIR: tmp, FORMAL_MIN_FREE_GIB: "0" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readdirSync(tmp), []);
});

test("Kani keeps rustup toolchain libraries a parent cargo exports away from the bundled toolchain", () => {
  const { dir } = kaniFixture("success", { expectLibraryPath: "/opt/keep/lib" });
  const loader = process.platform === "darwin" ? "DYLD_FALLBACK_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  const result = runKani(dir, "kani.py", ["check", dir], { [loader]: "/home/.rustup/toolchains/stable/lib:/opt/keep/lib" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const outcome of ["success", "failure"]) {
  test(`Rust mutation is ${outcome === "success" ? "missed" : "detected"} by its named harness`, () => {
    const { dir, name } = kaniFixture(outcome);
    const mutations = rustMutation(dir, name);
    const result = runKani(dir, "mutate.py", [mutations]);
    assert.equal(result.status, outcome === "success" ? 1 : 0, result.stdout + result.stderr);
    includes(result.stdout, `${outcome === "success" ? "MISSED" : "DETECTED"} guard`);
    assert.equal(readFileSync(join(dir, "src/lib.rs"), "utf8"), "old\n");
  });
}

test("Rust mutations stage a workspace with its temporary root inside the crate", () => {
  const { dir, name } = kaniFixture("failure", { requiredCrateFiles: { "scratch/input": "keep" } });
  const mutations = rustMutation(dir, name);
  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  writeFileSync(join(scratch, "input"), "keep");
  symlinkSync(scratch, join(dir, "scratch-alias"));
  const result = runKani(dir, "mutate.py", [mutations], { TMPDIR: scratch });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  includes(result.stdout, "DETECTED guard");
  assert.deepEqual(readdirSync(scratch), ["input"]);
});

test("live staged crates omit mutation work trees through both paths to the temporary root", () => {
  const dir = fixture();
  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  writeFileSync(join(scratch, "input"), "keep");
  symlinkSync(scratch, join(dir, "alias"));
  const program = `
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from kani import CrateSources
crate = Path(sys.argv[2]).resolve()
sources = CrateSources({crate}, set())
for name in ("first", "second"):
    work = crate / "scratch" / name
    work.mkdir()
    copy = sources.stage(crate, work)
    for relative in ("scratch", "alias"):
        directory = copy / relative
        assert sorted(p.name for p in directory.iterdir()) == ["input"], list(directory.iterdir())
        assert (directory / "input").read_text() == "keep"
`;
  const result = spawnSync("python3", ["-B", "-c", program, scripts, dir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("Rust mutations copy a crate that holds a dangling symlink, such as an editor lock file", () => {
  const { dir, name } = kaniFixture("failure");
  const mutations = rustMutation(dir, name);
  symlinkSync("user@host.1234:1700000000", join(dir, "src/.#lib.rs"));
  const result = runKani(dir, "mutate.py", [mutations]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  includes(result.stdout, "DETECTED guard");
});

for (const workspace of [false, true]) {
  test(`Rust mutations preserve ${workspace ? "workspace inheritance and transitive" : "sibling"} path dependencies`, () => {
    const { dir, name } = kaniFixture("failure");
    const root = join(dir, "project");
    const crate = join(root, "proof");
    const shared = join(dir, "shared");
    const files = {
      "proof/Cargo.toml": '[package]\nname="proof"\nversion="0.1.0"\n[dependencies]\nlogic={path="../logic"}\n',
      "proof/src/target/mod.rs": "pub const STEP: u8 = 1;\n",
      "proof/custom-output/stale": "prior build\n",
      "proof/target/CACHEDIR.TAG": "Signature: 8a477f597d28d172789f06886806bc55\n",
      "proof/target/debug/stale": "build from before the output directory moved\n",
      "logic/Cargo.toml": '[package]\nname="logic"\nversion="0.1.0"\n[dependencies]\nshared={path="../../shared"}\n',
      "logic/src/lib.rs": "pub fn step(n: u8) -> u8 { shared::step(n) }\n",
    };
    if (workspace) {
      files["Cargo.toml"] = '[workspace]\nmembers=["proof","logic"]\n[workspace.package]\nedition="2021"\n';
      files["Cargo.lock"] = "# workspace lock\n";
      files["proof/Cargo.toml"] += "[package.edition]\nworkspace=true\n";
    }
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    mkdirSync(join(shared, "src"), { recursive: true });
    writeFileSync(join(shared, "Cargo.toml"), '[package]\nname="shared"\nversion="0.1.0"\n');
    writeFileSync(join(shared, "src/lib.rs"), "pub fn step(n: u8) -> u8 { n + 1 }\n");
    const mutations = rustMutation(crate, name);
    writeFileSync(join(dir, "baseline.json"), readFileSync(join(logs, "kani-success.json")));
    writeJson(join(dir, "driver.json"), {
      version: KANI, harnesses: { [name]: 3 },
      cargoMetadata: {
        version: 1, workspace_root: workspace ? root : crate, target_directory: join(crate, "custom-output"),
        packages: [
          { source: null, manifest_path: join(crate, "Cargo.toml"), dependencies: [{ path: join(root, "logic") }] },
          { source: null, manifest_path: join(root, "logic/Cargo.toml"), dependencies: [{ path: shared }] },
          { source: null, manifest_path: join(shared, "Cargo.toml"), dependencies: [] },
        ],
      },
      excludedCrateFiles: ["custom-output/stale", "target/debug/stale"],
      requiredCrateFiles: {
        "src/target/mod.rs": files["proof/src/target/mod.rs"],
        "src/lib.rs": "new\n",
        "../logic/src/lib.rs": files["logic/src/lib.rs"],
        "../../shared/src/lib.rs": "pub fn step(n: u8) -> u8 { n + 1 }\n",
        ...(workspace ? { "../Cargo.toml": files["Cargo.toml"], "../Cargo.lock": files["Cargo.lock"] } : {}),
      },
    });
    const result = runKani(dir, "mutate.py", [mutations]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    includes(result.stdout, "DETECTED guard");
    assert.equal(readFileSync(join(crate, "src/lib.rs"), "utf8"), "old\n");
    for (const [path, text] of Object.entries(files)) assert.equal(readFileSync(join(root, path), "utf8"), text);
  });
}

for (const [label, config, error] of [
  ["failed", { cargoMetadataStatus: 1 }, "Cargo metadata failed"],
  ["malformed", { cargoMetadata: [] }, "malformed Cargo metadata"],
  ["unsupported", { cargoMetadata: { version: 2 } }, "unsupported Cargo metadata version"],
  ["relative", { cargoMetadata: { version: 1, workspace_root: "relative", target_directory: "/build", packages: [] } }, "Cargo metadata returned a relative source path"],
]) {
  test(`Rust mutations reject ${label} Cargo metadata before checking a mutation`, () => {
    const { dir, name } = kaniFixture("failure", config);
    const result = runKani(dir, "mutate.py", [rustMutation(dir, name)]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    includes(result.stdout, `FAIL ${error}`);
    excludes(result.stdout, "DETECTED");
    excludes(result.stderr, "Traceback");
    excludes(calls(dir), "--export-json");
  });
}

for (const [label, directives, error] of [
  ["typo", () => "detects proofs::missing", "unknown harness 'proofs::missing'"],
  ["limited", (name) => `detects ${name}\nonly small`, "Rust mutations do not support 'only'"],
]) {
  test(`Rust mutation rejects ${label} before verifying any mutation`, () => {
    const { dir, name } = kaniFixture("failure");
    const mutations = rustMutation(dir, name);
    writeFileSync(mutations, readFileSync(mutations, "utf8") + `mutation ${label}\n${directives(name)}\n- old\n+ new\n`);
    const result = runKani(dir, "mutate.py", [mutations]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    includes(result.stdout, error);
    excludes(result.stdout, "DETECTED");
    excludes(calls(dir), "--export-json");
  });
}

test("a Rust compilation error never counts as a detected mutation", () => {
  const { dir, name } = kaniFixture("failure", { compileError: true });
  const mutations = rustMutation(dir, name, "invalid");
  const result = runKani(dir, "mutate.py", [mutations]);
  assert.equal(result.status, 1);
  includes(result.stdout, "did not reach a verdict");
  excludes(result.stdout, "DETECTED");
});

test("Kani reports unavailable Python before running a check", () => {
  const dir = kaniBundle();
  command(dir, "bash", 'exec /bin/bash "$@"');
  command(dir, "dirname", 'exec /usr/bin/dirname "$@"');
  const result = runKani(dir, "kani-check.sh", [dir], { PATH: join(dir, "bin") });
  assert.equal(result.status, 3);
  includes(result.stdout, "UNAVAILABLE python3");
  excludes(result.stdout, "SUMMARY");
});

test("Kani rejects a missing named harness before running verification", () => {
  const { dir } = kaniFixture();
  const result = runKani(dir, "kani-check.sh", [dir, "missing"]);
  assert.equal(result.status, 1);
  includes(result.stdout, "unknown harnesses: missing");
  excludes(calls(dir), "--export-json");
});

test("Kani requires an explicit unwind bound", () => {
  const { dir, name } = kaniFixture();
  writeJson(join(dir, "driver.json"), { version: KANI, harnesses: { [name]: null } });
  const result = runKani(dir, "kani-check.sh", [dir]);
  assert.equal(result.status, 1);
  includes(result.stdout, "needs #[kani::unwind(N)]");
});

function withShouldPanicHarness(fixture) {
  const harness = (name, file, shouldPanic) =>
    ({ pretty_name: name, original_file: file, attributes: { kind: "Proof", should_panic: shouldPanic, unwind_value: 3 } });
  writeJson(join(fixture.dir, "driver.json"), { version: KANI, harnesses: {}, metadata: { proof_harnesses: [
    harness(fixture.name, "src/lib.rs", false), harness("proofs::panics", "src/other.rs", true),
  ] } });
  return fixture;
}

test("Kani rejects a selected should_panic harness before running verification", () => {
  const { dir } = withShouldPanicHarness(kaniFixture());
  for (const harnesses of [[], ["proofs::panics"]]) {
    const result = runKani(dir, "kani-check.sh", [dir, ...harnesses]);
    assert.equal(result.status, 1);
    includes(result.stdout, "proofs::panics is marked #[kani::should_panic]");
    excludes(calls(dir), "--export-json");
  }
});

test("Kani checks the other harnesses of a crate that has a should_panic harness", () => {
  const { dir, name } = withShouldPanicHarness(kaniFixture());
  const result = runKani(dir, "kani-check.sh", [dir, name]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  includes(result.stdout, `PASS ${name}`);
});

test("Rust mutations reject a should_panic harness they name and check the others", () => {
  const { dir, name } = withShouldPanicHarness(kaniFixture("failure"));
  const detected = runKani(dir, "mutate.py", [rustMutation(dir, name)]);
  assert.equal(detected.status, 0, detected.stdout + detected.stderr);
  includes(detected.stdout, "DETECTED guard");
  const rejected = runKani(dir, "mutate.py", [rustMutation(dir, "proofs::panics")]);
  assert.equal(rejected.status, 1);
  includes(rejected.stdout, "FAIL proofs::panics is marked #[kani::should_panic]");
});

test("Rust mutation coverage reports harnesses no mutation targets", () => {
  const { dir, name } = kaniFixture("failure");
  writeJson(join(dir, "driver.json"), { version: KANI, harnesses: { [name]: 3, "proofs::other": 3 } });
  const mutations = rustMutation(dir, name);
  const result = runKani(dir, "mutate.py", [mutations]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stdout, "DETECTED guard");
  includes(result.stdout, "UNCOVERED proofs::other");
});

test("Kani limits each harness to five minutes unless KANI_HARNESS_TIMEOUT sets another limit", () => {
  const { dir } = kaniFixture();
  assert.equal(runKani(dir, "kani-check.sh", [dir]).status, 0);
  includes(calls(dir), "--harness-timeout 5m");
  assert.equal(runKani(dir, "kani-check.sh", [dir], { KANI_HARNESS_TIMEOUT: "90s" }).status, 0);
  includes(calls(dir), "--harness-timeout 90s");
  const zeros = `${"0".repeat(4300)}5m`;
  for (const [value, limit] of [["", "5m"], ["  ", "5m"], [" 2h\n", "2h"], ["+90", "+90"], [zeros, zeros]]) {
    const { dir: fresh } = kaniFixture();
    assert.equal(runKani(fresh, "kani-check.sh", [fresh], { KANI_HARNESS_TIMEOUT: value }).status, 0);
    includes(calls(fresh), `--harness-timeout ${limit} --export-json`);
  }
});

test("Kani reports a KANI_HARNESS_TIMEOUT that is not a positive Kani limit as unavailable before checking", () => {
  const { dir } = kaniFixture();
  for (const value of ["0", "0s", "+00", "1.5m", "-1s", "10min", "4294967296", "004294967296", "１０s"]) {
    const result = runKani(dir, "kani-check.sh", [dir], { KANI_HARNESS_TIMEOUT: value });
    assert.equal(result.status, 3, `${value}: ${result.stdout}${result.stderr}`);
    includes(result.stdout, `UNAVAILABLE KANI_HARNESS_TIMEOUT='${value}'`);
    excludes(result.stdout, "SUMMARY");
    excludes(result.stderr, "Traceback");
  }
  excludes(calls(dir), "--export-json");
  assert.equal(runKani(dir, "kani-check.sh", [dir], { KANI_HARNESS_TIMEOUT: "4294967295" }).status, 0);
  includes(calls(dir), "--harness-timeout 4294967295 --export-json");
});

test("Rust mutations and Kani setup report an unusable KANI_HARNESS_TIMEOUT as unavailable", () => {
  const { dir, name } = kaniFixture("failure");
  const mutations = rustMutation(dir, name);
  for (const [script, args] of [["mutate.py", [mutations]], ["setup.sh", ["rust"]]]) {
    const result = runKani(dir, script, args, { KANI_HARNESS_TIMEOUT: "0" });
    assert.equal(result.status, 3, `${script}: ${result.stdout}${result.stderr}`);
    includes(result.stdout, "UNAVAILABLE KANI_HARNESS_TIMEOUT='0'");
  }
  excludes(calls(dir), "--export-json");
});

test("Kani reports a harness that reaches its timeout with the limit in effect", () => {
  const { dir, name } = kaniFixture("timeout");
  const result = runKani(dir, "kani-check.sh", [dir]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stdout, `FAIL ${name}`);
  includes(result.stdout, "within the 5m harness limit");
  includes(result.stdout, "set KANI_HARNESS_TIMEOUT to a longer limit");
  excludes(result.stdout, "KANI_HARNESS_TIMEOUT=");
  excludes(result.stdout, "no property checks");
  for (const value of ["90s", "90", "+090"]) {
    includes(runKani(dir, "kani-check.sh", [dir], { KANI_HARNESS_TIMEOUT: value }).stdout, "within the 90s harness limit");
  }
});

test("a Rust mutation that reaches the harness timeout never counts as detected", () => {
  const { dir, name } = kaniFixture("timeout");
  const result = runKani(dir, "mutate.py", [rustMutation(dir, name)]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stdout, "within the 5m harness limit");
  excludes(result.stdout, "DETECTED");
});

test("an insufficient Rust unwind bound never counts as a detected mutation", () => {
  const { dir, name } = kaniFixture("unwind");
  const mutations = rustMutation(dir, name, "loop");
  const result = runKani(dir, "mutate.py", [mutations]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stdout, "did not reach a verdict");
  includes(result.stdout, "bound too low");
  excludes(result.stdout, "DETECTED");
});

for (const incomplete of [
  { category: "unwind", status: "Failure" },
  { category: "assertion", status: "Undetermined" },
  { category: "cover", status: "Success" },
  { category: "assertion", status: "Satisfied" },
]) {
  test(`Rust mutation rejects a counter-example accompanied by ${incomplete.category} ${incomplete.status}`, () => {
    const { dir, name, report } = kaniFixture("failure");
    const checks = report.verification_results.results[0].checks;
    checks.push({ ...checks[0], ...incomplete, id: 2 });
    writeJson(join(dir, "report.json"), report);
    const mutations = rustMutation(dir, name, "incomplete");
    const result = runKani(dir, "mutate.py", [mutations]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    includes(result.stdout, "did not reach a verdict");
    excludes(result.stdout, "DETECTED");
  });
}

for (const script of ["kani-check.sh", "mutate.py"]) {
  const target = (dir, name) => (script === "mutate.py" ? rustMutation(dir, name) : dir);

  test(`Kani ${script} reports a driver lost after discovery as a failed check`, () => {
    const { dir, name } = kaniFixture("failure", { deleteDriverAfterList: true });
    const result = runKani(dir, script, [target(dir, name)]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    includes(result.stdout, "cannot execute Kani");
    excludes(result.stdout, "DETECTED");
    excludes(result.stderr, "Traceback");
  });

  test(`Kani ${script} keeps a relative home valid in temporary work directories`, () => {
    const { dir, name } = kaniFixture(script === "mutate.py" ? "failure" : "success", { expectResolvedHome: true });
    const result = runKani(dir, script, [target(dir, name)], { KANI_HOME: relative(process.cwd(), join(dir, "kani")) });
    assert.equal(result.status, 0, result.stdout + result.stderr + calls(dir));
    excludes(calls(dir), "auto-install");
    includes(result.stdout, script === "mutate.py" ? "DETECTED guard" : "SUMMARY 1 of 1 harnesses passed");
  });

  test(`Kani ${script} bypasses a shadowed auto-installing cargo-kani wrapper`, () => {
    const { dir, name } = kaniFixture(script === "mutate.py" ? "failure" : "success");
    command(dir, "cargo-kani", 'echo auto-install >> "$TASK_TRACE"; exit 99');
    command(dir, "cargo", 'cargo-kani "$@"');
    const result = runKani(dir, script, [target(dir, name)]);
    assert.equal(result.status, 0, result.stdout + result.stderr + calls(dir));
    excludes(calls(dir), "auto-install");
  });
}

test("the Rust checker does not treat a crate argument as a readiness command", () => {
  const dir = kaniBundle();
  const result = runKani(dir, "kani-check.sh", ["--ready"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stdout, "Cargo.toml is missing");
  excludes(result.stdout, "READY");
  excludes(result.stdout, "SUMMARY");
});

for (const reachable of [false, true]) {
  test(`Kani requires a cover even with ${reachable ? "successful" : "unreachable"} assertions`, () => {
    const { dir, report } = kaniFixture();
    report.verification_results.results[0].checks = report.verification_results.results[0].checks
      .filter((check) => check.category !== "cover")
      .map((check) => ({ ...check, status: reachable ? "Success" : "Unreachable" }));
    writeJson(join(dir, "report.json"), report);
    const result = runKani(dir, "kani-check.sh", [dir]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    includes(result.stdout, "no satisfied kani::cover! witness");
  });
}

for (const script of ["kani-check.sh", "mutate.py"]) {
  test(`Kani ${script} rejects safety success before an unreachable property without a cover`, () => {
    const { dir, name, report } = kaniFixture();
    const checks = report.verification_results.results[0].checks;
    report.verification_results.results[0].checks = [
      { ...checks[0], status: "Success", category: "assertion", description: "attempt to add with overflow" },
      { ...checks[0], id: 2, status: "Unreachable", category: "assertion", description: "assertion failed: next > 0" },
    ];
    writeJson(join(dir, "report.json"), report);
    const result = runKani(dir, script, [script === "mutate.py" ? rustMutation(dir, name) : dir]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    includes(result.stdout, "no satisfied kani::cover! witness");
    excludes(result.stdout, "DETECTED");
  });
}

for (const outcome of ["unsat", "unreachable"]) {
  test(`an existing cover becoming ${outcome} detects a mutation only after the original passes`, () => {
    const { dir, name } = kaniFixture(outcome);
    const result = runKani(dir, "mutate.py", [rustMutation(dir, name)]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    includes(result.stdout, "DETECTED guard");
    assert.equal(calls(dir).split("--export-json").length - 1, 2);
  });
}

for (const outcome of ["failure", "unwind", "timeout"]) {
  test(`Rust mutations reject an original harness with ${outcome} before mutating`, () => {
    const { dir, name } = kaniFixture("failure");
    const mutations = rustMutation(dir, name);
    writeFileSync(join(dir, "baseline.json"), readFileSync(join(logs, `kani-${outcome}.json`)));
    const result = runKani(dir, "mutate.py", [mutations]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    includes(result.stdout, `unmutated Rust harness '${name}' did not pass`);
    excludes(result.stdout, "DETECTED");
    assert.equal(calls(dir).split("--export-json").length - 1, 1);
  });
}

test("Rust mutation coverage includes all harnesses in its file and excludes unrelated files", () => {
  const { dir, name } = kaniFixture("failure");
  const mutations = rustMutation(dir, name);
  writeJson(join(dir, "driver.json"), {
    version: KANI,
    harnesses: { [name]: 3, "same_file::other": 3, "another_file::proof": 3 },
    harnessSources: { "another_file::proof": "src/other.rs" },
  });
  const result = runKani(dir, "mutate.py", [mutations]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stdout, "UNCOVERED same_file::other");
  excludes(result.stdout, "UNCOVERED another_file::proof");
});

test("Rust mutations may explicitly target a harness declared in another file", () => {
  const { dir, name } = kaniFixture("failure");
  const mutations = rustMutation(dir, name);
  writeJson(join(dir, "driver.json"), {
    version: KANI, harnesses: { [name]: 3, "unrelated::proof": 3 },
    harnessSources: { [name]: "src/proofs.rs", "unrelated::proof": "src/other.rs" },
  });
  const result = runKani(dir, "mutate.py", [mutations]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  includes(result.stdout, "DETECTED guard");
  excludes(result.stdout, "UNCOVERED");
});

for (const script of ["kani-check.sh", "mutate.py"]) {
  test(`Kani ${script} keeps E0658 diagnostics when toolchain metadata is missing`, () => {
    const { dir, name } = kaniFixture("success", { listError: "error[E0658]: use of unstable feature at src/lib.rs:7" });
    rmSync(join(bundle(dir), "rust-toolchain-version"));
    const result = runKani(dir, script, [script === "mutate.py" ? rustMutation(dir, name) : dir]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    includes(result.stdout, "error[E0658]");
    includes(result.stdout, "src/lib.rs:7");
    includes(result.stdout, "version metadata unavailable");
    excludes(result.stderr, "Traceback");
  });
}

test("Kani codegen discovery and verification enable stubs and leave list reports untouched", () => {
  const { dir } = kaniFixture();
  writeFileSync(join(dir, "kani-list.json"), "existing report\n");
  const result = runKani(dir, "kani-check.sh", [dir]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const invocations = calls(dir).trim().split("\n").filter((line) => line.includes("--target-dir"));
  assert.equal(invocations.length, 2);
  for (const invocation of invocations) includes(invocation, "-Z stubbing");
  includes(invocations[0], "--only-codegen");
  assert.equal(readFileSync(join(dir, "kani-list.json"), "utf8"), "existing report\n");
});

test("Kani metadata discovery preserves the standard-harness filter", () => {
  const { dir, name } = kaniFixture();
  writeJson(join(dir, "driver.json"), {
    version: KANI, harnesses: { [name]: 3 },
    metadata: { proof_harnesses: [
      { pretty_name: name, original_file: "src/lib.rs", attributes: { kind: "Proof", unwind_value: 3 } },
      { pretty_name: "contract", original_file: "src/lib.rs", attributes: { kind: { ProofForContract: { target_fn: "target" } } } },
    ] },
  });
  const result = runKani(dir, "kani-check.sh", [dir]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  includes(result.stdout, "SUMMARY 1 of 1 harnesses passed");
  excludes(calls(dir), "--harness contract");
});
