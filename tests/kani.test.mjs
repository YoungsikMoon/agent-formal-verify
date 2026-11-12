// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { command, excludes, fixture, includes, logs, removeFixtures, run } from "./helpers.mjs";

afterEach(removeFixtures);

const KANI = "0.68.0";
const bundle = (dir) => join(dir, `kani/kani-${KANI}`);
const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
const calls = (dir) => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "");
const runKani = (dir, script, args = [], extra = {}) => run(dir, script, args, { KANI_HOME: join(dir, "kani"), ...extra });

// Behaves as the pinned kani-driver, configured by driver.json and report.json in the fixture directory.
const DRIVER = readFileSync(join(logs, "kani-driver.py"), "utf8");

function kaniBundle(config = {}) {
  const dir = fixture();
  for (const path of ["bin/kani-compiler", "bin/cbmc", "toolchain/bin/rustc", "toolchain/bin/cargo"]) {
    const file = join(bundle(dir), path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  for (const executable of ["bin/kani-driver", "toolchain/bin/cargo"]) {
    const path = join(bundle(dir), executable);
    writeFileSync(path, `#!${python}\n${DRIVER}`);
    chmodSync(path, 0o755);
  }
  writeJson(join(dir, "driver.json"), { version: KANI, harnesses: {}, ...config });
  return dir;
}

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
  mkdirSync(join(dir, "src"));
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

for (const workspace of [false, true]) {
  test(`Rust mutations preserve ${workspace ? "workspace inheritance and transitive" : "sibling"} path dependencies`, () => {
    const { dir, name } = kaniFixture("failure");
    const root = join(dir, "project");
    const crate = join(root, "proof");
    const shared = join(dir, "shared");
    const files = {
      "proof/Cargo.toml": '[package]\nname="proof"\nversion="0.1.0"\n[dependencies]\nlogic={path="../logic"}\n',
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
    writeJson(join(dir, "driver.json"), {
      version: KANI, harnesses: { [name]: 3 },
      cargoMetadata: {
        version: 1, workspace_root: workspace ? root : crate,
        packages: [
          { source: null, manifest_path: join(crate, "Cargo.toml"), dependencies: [{ path: join(root, "logic") }] },
          { source: null, manifest_path: join(root, "logic/Cargo.toml"), dependencies: [{ path: shared }] },
          { source: null, manifest_path: join(shared, "Cargo.toml"), dependencies: [] },
        ],
      },
      requiredCrateFiles: {
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
  ["relative", { cargoMetadata: { version: 1, workspace_root: "relative", packages: [] } }, "Cargo metadata returned a relative source path"],
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

test("Rust mutation coverage reports harnesses no mutation targets", () => {
  const { dir, name } = kaniFixture("failure");
  writeJson(join(dir, "driver.json"), { version: KANI, harnesses: { [name]: 3, "proofs::other": 3 } });
  const mutations = rustMutation(dir, name);
  const result = runKani(dir, "mutate.py", [mutations]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stdout, "DETECTED guard");
  includes(result.stdout, "UNCOVERED proofs::other");
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
