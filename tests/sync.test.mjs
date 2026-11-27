// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { command, excludes, fixture, keepFixture, removeFixtures, scripts } from "./helpers.mjs";

afterEach(removeFixtures);

// Git sets GIT_DIR and GIT_INDEX_FILE for a hook such as pre-commit, which runs these tests. Left in place, they
// would point every git command here at the repository being committed to. The developer's git configuration,
// such as commit signing, stays out of the fixture repositories too. git commit and git merge would also start a
// detached git maintenance run --auto. When git's estimate of the loose objects, taken from the objects/17
// directory alone, passes 100, that run repacks the fixture while the test goes on committing to it and reading
// it, and has lost objects that the test then failed to read (#201).
const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

// When git cannot read an object in a fixture, as "Could not read <commit>" or "unable to read tree (<tree>)",
// keep the fixture and say whether the object is missing or reads now.
function diagnosis(dir, output) {
  const unreadable = /(?:Could not read|unable to read tree \(?)\s*([0-9a-f]{40})/.exec(output);
  if (!unreadable) return "";
  keepFixture(dir);
  const [, oid] = unreadable;
  const object = spawnSync("git", ["-C", dir, "cat-file", "-t", oid], { encoding: "utf8", env: gitEnv });
  const found = object.status === 0 ? `is a ${object.stdout.trim()} that reads now` : `is missing: ${object.stderr.trim()}`;
  let file = "it has no loose file";
  try {
    file = `its loose file has ${statSync(join(dir, ".git/objects", oid.slice(0, 2), oid.slice(2))).size} bytes`;
  } catch {}
  return `DIAGNOSIS ${oid} ${found}; ${file}; fixture kept at ${dir}\n`;
}

function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv });
  if (result.status !== 0) assert.fail(result.stderr + diagnosis(dir, result.stderr));
  return result.stdout.trim();
}

function commit(dir, files, message) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

function sync(dir, args, cwd = dir) {
  const result = spawnSync("python3", [join(scripts, "sync.py"), ...args], { cwd, encoding: "utf8", env: gitEnv });
  if (result.status !== 0) result.stdout += diagnosis(dir, result.stdout + result.stderr);
  return result;
}

function lines(output, tag) {
  return output.split("\n").filter((line) => line.startsWith(tag + " "));
}

test("sync follows renames, finds where covered names live now, and names the commit that removed one", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const read = commit(dir, { "src/queue.c": "int claim(void);\nint consume(void);\nint drain(void);\n" }, "queue");
  commit(dir, { "tla/Queue.tla": `(* Source read at ${read} *)\nclaim consume drain\n` }, "model");
  git(dir, "mv", "src/queue.c", "src/core.c");
  git(dir, "commit", "-m", "rename");
  commit(dir, { "src/core.c": "int claim(void);\nint drain(void);\n", "src/consume.c": "int consume(void);\n" }, "move consume");
  commit(dir, { "src/core.c": "int claim(void);\n" }, "remove drain");
  const removed = git(dir, "rev-parse", "--short", "HEAD");

  const result = sync(dir, ["tla/Queue.tla", "--source", "src/queue.c", "--name", "claim", "--name", "consume", "--name", "drain"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout, "SYNC"), [`SYNC ${read} from the Source read at line in Queue.tla`]);
  assert.deepEqual(lines(result.stdout, "PATH"), ["PATH src/consume.c", "PATH src/core.c", "PATH src/queue.c"]);
  assert.deepEqual(lines(result.stdout, "MISSING"), [`MISSING drain: ${removed}`]);
  const root = git(dir, "rev-parse", "--show-toplevel");
  assert.deepEqual(lines(result.stdout, "READ"), [`READ git -C ${root} log -p ${read}..HEAD -- src/consume.c src/core.c src/queue.c`]);
});

test("sync's search for files that held a name runs as many git commands for many commits as for a few", () => {
  // Count the git commands sync runs for a history in which a few or many commits move claim between files.
  const calls = (moves) => {
    const dir = fixture();
    git(dir, "init", "-b", "main");
    const read = commit(dir, { "src/queue.c": "int claim(void);\n" }, "queue");
    commit(dir, { "tla/Queue.tla": `(* Source read at ${read} *)\n` }, "model");
    // Each step file holds claim for one commit only, so only the search for files that held it finds them.
    for (let move = 0; move < moves; move++) {
      commit(dir, { [`src/step${move}.c`]: "int claim(void);\n" }, `step ${move}`);
      commit(dir, { [`src/step${move}.c`]: "int other(void);\n" }, `step ${move} done`);
    }
    const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8", env: gitEnv }).stdout.trim();
    const log = join(dir, "git-calls");
    command(dir, "git", `echo "$*" >> "${log}"\nexec "${real}" "$@"`);
    const result = spawnSync("python3", [join(scripts, "sync.py"), "tla/Queue.tla", "--source", "src/queue.c", "--name", "claim"],
      { cwd: dir, encoding: "utf8", env: { ...gitEnv, PATH: `${join(dir, "bin")}:${gitEnv.PATH}` } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(lines(result.stdout, "PATH").length, moves + 1);
    return readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  };
  assert.equal(calls(12), calls(2));
});

test("sync's search for files that held a name finds every file when one commit's paths need several git grep calls", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const read = commit(dir, { "src/queue.c": "int claim(void);\n" }, "queue");
  commit(dir, { "tla/Queue.tla": `(* Source read at ${read} *)\n` }, "model");
  // 600 paths of about 200 bytes are more than one grep call takes, and none holds claim at HEAD.
  const deep = `src/${"d".repeat(190)}`;
  const paths = Array.from({ length: 600 }, (_, file) => `${deep}/${String(file).padStart(4, "0")}.c`);
  commit(dir, Object.fromEntries(paths.map((path) => [path, "int claim(void);\n"])), "add");
  commit(dir, Object.fromEntries(paths.map((path) => [path, "int other(void);\n"])), "rewrite");

  const result = sync(dir, ["tla/Queue.tla", "--source", "src/queue.c", "--name", "claim"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout, "PATH"), [...paths, "src/queue.c"].map((path) => `PATH ${path}`));
});

test("sync's search for files that held a name reads any path, skips a merged history's root and ignores textconv", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const read = commit(dir, { "src/queue.c": "int claim(void);\n", ".gitattributes": "*.t diff=up\n", "src/t.t": "int claim(void);\nclm\n" }, "queue");
  git(dir, "config", "diff.up.textconv", "sed s/clm/claim/g");
  commit(dir, { "tla/Queue.tla": `(* Source read at ${read} *)\n` }, "model");
  // A byte 0x01 and a leading newline are valid in a path.
  const odd = { "src/a\u0001b.c": "int claim(void);\n", "\nlead.c": "int claim(void);\n", "src/plain.c": "int claim(void);\n" };
  commit(dir, odd, "add");
  git(dir, "rm", "-q", ...Object.keys(odd));
  git(dir, "commit", "-m", "remove");
  // Only textconv changes the count of claim here, and a later commit leaves only a longer word.
  commit(dir, { "src/t.t": "int claim(void);\n" }, "textconv only");
  commit(dir, { "src/t.t": "int claimed(void);\n" }, "claimed");
  // An unrelated history whose root commit holds claim, merged in.
  git(dir, "checkout", "-q", "--orphan", "lib");
  git(dir, "rm", "-q", "-r", "--cached", ".");
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib/x.c"), "int claim(void);\n");
  git(dir, "add", "lib/x.c");
  git(dir, "commit", "-m", "lib root");
  writeFileSync(join(dir, "lib/x.c"), "int claimed(void);\n");
  git(dir, "commit", "-am", "lib claimed");
  git(dir, "checkout", "-q", "-f", "main");
  git(dir, "merge", "-q", "--allow-unrelated-histories", "-m", "merge lib", "lib");

  const result = sync(dir, ["tla/Queue.tla", "--source", "src/queue.c", "--name", "claim"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // The leading newline splits that PATH line in two, so match the PATH lines as one run of text.
  assert.ok(result.stdout.includes("\nPATH \nlead.c\nPATH src/a\u0001b.c\nPATH src/plain.c\nPATH src/queue.c\nREAD "), result.stdout);
});

test("sync reads a file that held a covered name only between the sync and now", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const read = commit(dir, { "src/queue.c": "int claim(void) { return 1; }\nint drain(void) { return 0; }\n" }, "queue");
  commit(dir, { "tla/Queue.tla": `(* Source read at ${read} *)\n` }, "model");
  const other = "int reset(void) { return 0; }\nint flush(void) { return 0; }\n";
  commit(dir, { "src/queue.c": "int drain(void) { return 0; }\n", "src/core.c": other + "int claim(void) { return 1; }\n" }, "copy claim to core.c");
  const changed = commit(dir, { "src/core.c": other + "int claim(void) { return 2; }\n" }, "change claim in core.c");
  commit(dir, { "src/core.c": other, "src/claim.c": "int claim(void) { return 2; }\n" }, "move claim to claim.c");
  // A longer word that contains the name does not make a file one that held it.
  commit(dir, { "src/log.c": "int claimed(void);\n" }, "log");

  const result = sync(dir, ["tla/Queue.tla", "--source", "src/queue.c", "--name", "claim"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout, "PATH"), ["PATH src/claim.c", "PATH src/core.c", "PATH src/queue.c"]);
  const root = git(dir, "rev-parse", "--show-toplevel");
  assert.deepEqual(lines(result.stdout, "READ"), [`READ git -C ${root} log -p ${read}..HEAD -- src/claim.c src/core.c src/queue.c`]);
  const log = git(dir, "log", "--format=%H", `${read}..HEAD`, "--", "src/claim.c", "src/core.c", "src/queue.c");
  assert.ok(log.split("\n").includes(changed), log);
});

test("sync finds a file renamed away without a content change, and reads changed paths literally", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const read = commit(dir, { "src/queue.c": "int claim(void);\n", "src/util.c": "void use(void) { claim(); }\n" }, "queue");
  commit(dir, { "tla/Queue.tla": `(* Source read at ${read} *)\n`, "src/i.c": "void model(void) { claim(); }\n" }, "model");
  const call = commit(dir, { "src/util.c": "void use(int x) { claim(); }\n" }, "change the caller");
  git(dir, "mv", "src/util.c", "src/helpers.c");
  git(dir, "commit", "-m", "rename util.c");
  commit(dir, { "src/helpers.c": "void use(void) {}\n" }, "drop the call");
  // A glob character in a changed path matches only that path, not the model file src/i.c.
  commit(dir, { "src/[id].c": "int route(void) { return claim(); }\n" }, "route");

  const result = sync(dir, ["tla/Queue.tla", "src/i.c", "--source", "src/queue.c", "--name", "claim"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout, "PATH"), ["PATH src/[id].c", "PATH src/helpers.c", "PATH src/queue.c", "PATH src/util.c"]);
  const log = git(dir, "log", "--format=%H", `${read}..HEAD`, "--", "src/[id].c", "src/helpers.c", "src/queue.c", "src/util.c");
  assert.ok(log.split("\n").includes(call), log);
});

test("sync reports a name as missing when only documents and other models still mention it", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const read = commit(dir, {
    "src/queue.c": "int claim(void);\nint drain(void);\n",
    "docs/queue.md": "drain empties the queue\n",
    "tla/Other.tla": "(* Covers claim and drain. *)\n",
    "lean/Model/Queue.lean": "-- drain\n",
  }, "queue");
  commit(dir, { "tla/Queue.tla": `(* Source read at ${read} *)\n` }, "model");
  commit(dir, { "src/queue.c": "int claim(void);\n" }, "remove drain");
  const removed = git(dir, "rev-parse", "--short", "HEAD");

  const result = sync(dir, ["tla/Queue.tla", "--source", "src/queue.c", "--name", "claim", "--name", "drain"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout, "PATH"), ["PATH src/queue.c"]);
  assert.deepEqual(lines(result.stdout, "MISSING"), [`MISSING drain: ${removed}`]);
  const root = git(dir, "rev-parse", "--show-toplevel");
  assert.deepEqual(lines(result.stdout, "READ"), [`READ git -C ${root} log -p ${read}..HEAD -- src/queue.c`]);
});

test("sync reports a name as missing when only extensionless documents and data files mention it, and reads the data files", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const docs = ["README", "CHANGELOG", ".github/CODEOWNERS", "docs/queue.tex"];
  const data = ["Makefile", ".github/workflows/ci.yml", "docs/queue.html", "notes/queue.ipynb", "docs/api.json"];
  const read = commit(dir, { "src/queue.c": "int claim(void);\nint drain(void);\n", ...Object.fromEntries([...docs, ...data].map((doc) => [doc, "claim and drain the queue\n"])) }, "queue");
  commit(dir, { "tla/Queue.tla": `(* Source read at ${read} *)\n` }, "model");
  commit(dir, { "src/queue.c": "int claim(void);\n" }, "remove drain");
  const removed = git(dir, "rev-parse", "--short", "HEAD");

  const result = sync(dir, ["tla/Queue.tla", "--source", "src/queue.c", "--name", "claim", "--name", "drain"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout, "PATH"), [...data, "src/queue.c"].sort().map((path) => `PATH ${path}`));
  assert.deepEqual(lines(result.stdout, "MISSING"), [`MISSING drain: ${removed}`]);

  const reversed = sync(dir, ["tla/Queue.tla", "--source", "src/queue.c", "--name", "drain", "--name", "claim"]);
  assert.equal(reversed.status, 0, reversed.stderr);
  assert.equal(reversed.stdout, result.stdout);

  // An extensionless file is searched when a source has no extension either.
  const tool = commit(dir, { "bin/tool": "drain() { :; }\n" }, "tool");
  commit(dir, { "tla/Tool.tla": `(* Source read at ${tool} *)\n` }, "tool model");
  const script = sync(dir, ["tla/Tool.tla", "--source", "bin/tool", "--name", "drain"]);
  assert.equal(script.status, 0, script.stdout + script.stderr);
  assert.deepEqual(lines(script.stdout, "MISSING"), []);
  assert.ok(lines(script.stdout, "PATH").includes("PATH bin/tool"), script.stdout);
});

test("sync reports a name as missing when Rust code mentions it only in comments and strings, and still reads those files", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const trace = [
    "// drain",
    "/* outer /* drain */ still a comment */",
    "fn trace() { println!(\"drain {}\", r#\"drain \"quoted\"\"#); let c = 'd'; }",
    "",
  ].join("\n");
  const read = commit(dir, { "src/queue.rs": "pub fn claim() {}\npub fn drain() {}\n", "src/trace.rs": trace }, "queue");
  commit(dir, { "tla/Queue.tla": `(* Source read at ${read} *)\n` }, "model");
  commit(dir, { "src/queue.rs": "pub fn claim() {}\n// one entry point left\n" }, "remove drain");
  const removed = git(dir, "rev-parse", "--short", "HEAD");

  const result = sync(dir, ["tla/Queue.tla", "--source", "src/queue.rs", "--name", "claim", "--name", "drain"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout, "MISSING"), [`MISSING drain: ${removed}`]);
  assert.deepEqual(lines(result.stdout, "PATH"), ["PATH src/queue.rs", "PATH src/trace.rs"]);

  // Rust code that calls it, or a comment in another language, whose comments the helper does not read, still finds it.
  // A C comment with a glob would open a nested comment in Rust's reading and hide the definition after it.
  for (const [path, text] of [["src/use.rs", "fn use_it() { drain(); }\n"], ["tools/drain.py", "# drain\n"],
    ["src/glob.c", "/* matches src/*/drain.c */\nint drain(void);\n"], ["web/app.js", "var a = '/*'; function drain() {}\n"]]) {
    commit(dir, { [path]: text }, `add ${path}`);
    const found = sync(dir, ["tla/Queue.tla", "--source", "src/queue.rs", "--name", "drain"]);
    assert.deepEqual(lines(found.stdout, "MISSING"), [], path);
    git(dir, "rm", "-q", path);
    git(dir, "commit", "-qm", `remove ${path}`);
  }
});

test("sync searches files with a source's extension even when other models use it", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const read = commit(dir, { "lean/Queue.lean": "def claim := 1\n" }, "queue");
  commit(dir, { "tla/Queue.tla": `(* Source read at ${read} *)\n` }, "model");
  git(dir, "rm", "lean/Queue.lean");
  commit(dir, { "lean/Claim.lean": "namespace Slots\nopen Nat\ndef claim := 1\ntheorem one : claim = 1 := rfl\nend Slots\n" }, "move claim");
  const result = sync(dir, ["tla/Queue.tla", "--source", "lean/Queue.lean", "--name", "claim"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout, "PATH"), ["PATH lean/Claim.lean", "PATH lean/Queue.lean"]);
  assert.deepEqual(lines(result.stdout, "MISSING"), []);
});

test("sync falls back to the last commit of the model files when the header's commit is not in HEAD's history", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  commit(dir, { "src/queue.c": "int claim(void);\n" }, "queue");
  const model = commit(dir, { "tla/Queue.tla": "(* Source read at 0123456789abcdef0123456789abcdef01234567 *)\n" }, "model");
  const result = sync(dir, ["tla/Queue.tla", "--source", "src/queue.c"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout, "SYNC"), [
    `SYNC ${model} from the last commit of the model files; the Source read at commit 0123456789abcdef0123456789abcdef01234567 in Queue.tla is not in HEAD's history`,
  ]);
  assert.deepEqual(lines(result.stdout, "PATH"), ["PATH src/queue.c"]);

  const quoted = commit(dir, { "tla/Queue.tla": "(* Source read at `abc1234` *)\n" }, "quoted");
  const off = sync(dir, ["tla/Queue.tla"]);
  assert.equal(off.status, 0, off.stdout + off.stderr);
  assert.equal(off.stdout, `SYNC ${quoted} from the last commit of the model files; the Source read at line in Queue.tla names no commit hash\n`);
});

test("sync reports a model with no sync commit, and searches a model file only when it is also a source", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const start = commit(dir, { "src/lib.rs": "pub fn claim() {}\n" }, "start");
  commit(dir, { "tla/Queue.tla": `(* Source read at ${start} *)\nclaim\n` }, "model");
  writeFileSync(join(dir, "tla/New.tla"), "claim\n");
  const none = sync(dir, ["tla/New.tla", "--name", "claim"]);
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.equal(none.stdout, "SYNC none: the model files have no commit and no Source read at line in HEAD's history; compare the model with the code in full\n");

  const rust = sync(dir, ["src/lib.rs", "tla/Queue.tla", "--source", "src/lib.rs", "--name", "claim"]);
  assert.equal(rust.status, 0, rust.stdout + rust.stderr);
  assert.deepEqual(lines(rust.stdout, "PATH"), ["PATH src/lib.rs"]);
});

test("sync falls back past production edits to a model file that is also a source", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const proofs = "\n// Harnesses for claim.\n#[cfg(kani)]\nmod proofs {\n    #[kani::proof]\n    fn check() { assert!(super::claim() == 1); }\n}\n";
  commit(dir, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" }, "production");
  const harness = commit(dir, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + proofs }, "harness");
  commit(dir, { "src/lib.rs": "pub fn claim() -> u8 { 2 }\n" + proofs }, "production edit");
  commit(dir, { "src/lib.rs": "// Returns the next slot.\npub fn claim() -> u8 { 2 }\n" + proofs }, "comment");

  const result = sync(dir, ["src/lib.rs", "--source", "src/lib.rs", "--name", "claim"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout, "SYNC"), [`SYNC ${harness} from the last commit of the model files that changed no production code in lib.rs`]);
  const root = git(dir, "rev-parse", "--show-toplevel");
  assert.deepEqual(lines(result.stdout, "READ"), [`READ git -C ${root} log -p ${harness}..HEAD -- src/lib.rs`]);

  // A commit that changed another model file together with the production code is not one either.
  commit(dir, { "src/lib.rs": "pub fn claim() -> u8 { 3 }\n" + proofs, "tla/Queue.tla": "claim\n" }, "model and production");
  const mixed = sync(dir, ["src/lib.rs", "tla/Queue.tla", "--source", "src/lib.rs"]);
  assert.equal(mixed.status, 0, mixed.stdout + mixed.stderr);
  assert.deepEqual(lines(mixed.stdout, "SYNC"), [`SYNC ${harness} from the last commit of the model files that changed no production code in lib.rs`]);

  // A commit that changed only another model file never synced the harness, so it is not one either (#203).
  const queue = fixture();
  git(queue, "init", "-b", "main");
  commit(queue, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + proofs, "tla/Queue.tla": "claim\n" }, "production, harness and model");
  commit(queue, { "src/lib.rs": "pub fn claim() -> u8 { 2 }\n" + proofs }, "production edit");
  commit(queue, { "tla/Queue.tla": "claim, edited\n" }, "model edit");
  const other = sync(queue, ["src/lib.rs", "tla/Queue.tla", "--source", "src/lib.rs", "--name", "claim"]);
  assert.equal(other.status, 0, other.stdout + other.stderr);
  assert.equal(other.stdout, "SYNC none: no commit of the model files changed only the #[cfg(kani)] items of lib.rs; compare the model with the code in full\n");
  // A harness edit made with a model edit still counts, and the later model-only commit does not hide it.
  const both = commit(queue, { "src/lib.rs": "pub fn claim() -> u8 { 2 }\n" + proofs.replace("== 1", "== 2"), "tla/Queue.tla": "claim, twice\n" }, "harness and model");
  commit(queue, { "tla/Queue.tla": "claim, again\n" }, "model edit again");
  const together = sync(queue, ["src/lib.rs", "tla/Queue.tla", "--source", "src/lib.rs", "--name", "claim"]);
  assert.deepEqual(lines(together.stdout, "SYNC"), [`SYNC ${both} from the last commit of the model files that changed no production code in lib.rs`]);

  // The harness came with the production code, so no commit changed the harness alone.
  const fresh = fixture();
  git(fresh, "init", "-b", "main");
  commit(fresh, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + proofs }, "production and harness");
  commit(fresh, { "src/lib.rs": "pub fn claim() -> u8 { 2 }\n" + proofs }, "production edit");
  const none = sync(fresh, ["src/lib.rs", "--source", "src/lib.rs", "--name", "claim"]);
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.equal(none.stdout, "SYNC none: no commit of the model files changed only the #[cfg(kani)] items of lib.rs; compare the model with the code in full\n");
});

test("sync's fallback counts #[cfg(kani)] on an item only, follows a rename, and says when it stops after the last 100 commits", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const proofs = "\n#[cfg(kani)]\nmod proofs {\n    #[kani::proof]\n    fn check() { assert!(super::claim() == 1); }\n}\n";
  const event = "pub enum Event {\n    #[cfg(kani)]\n    Ghost,\n    Release,\n}\n";
  commit(dir, { "src/lib.rs": event + "pub fn claim() -> u8 { 1 }\n" }, "production");
  const harness = commit(dir, { "src/lib.rs": event + "pub fn claim() -> u8 { 1 }\n" + proofs }, "harness");
  commit(dir, { "src/lib.rs": event + "pub fn claim() -> u8 { 2 }\n" + proofs }, "production edit");
  const variant = sync(dir, ["src/lib.rs", "--source", "src/lib.rs"]);
  assert.equal(variant.status, 0, variant.stdout + variant.stderr);
  assert.deepEqual(lines(variant.stdout, "SYNC"), [`SYNC ${harness} from the last commit of the model files that changed no production code in lib.rs`]);

  // The fallback follows the source back through renames to the harness commit under its old name.
  git(dir, "mv", "src/lib.rs", "src/core.rs");
  git(dir, "commit", "-m", "rename");
  commit(dir, { "src/core.rs": event + "pub fn claim() -> u8 { 3 }\n" + proofs }, "production edit after the rename");
  git(dir, "mv", "src/core.rs", "src/queue.rs");
  git(dir, "commit", "-m", "second rename");
  const renamed = sync(dir, ["src/queue.rs", "--source", "src/queue.rs"]);
  assert.equal(renamed.status, 0, renamed.stdout + renamed.stderr);
  assert.deepEqual(lines(renamed.stdout, "SYNC"), [`SYNC ${harness} from the last commit of the model files that changed no production code in queue.rs`]);
  assert.deepEqual(lines(renamed.stdout, "PATH"), ["PATH src/core.rs", "PATH src/lib.rs", "PATH src/queue.rs"]);

  // A rename that also edits the harness alone is a harness commit.
  const both = event + "pub fn claim() -> u8 { 3 }\n" + proofs.replace("== 1", "== 3");
  git(dir, "mv", "src/queue.rs", "src/slots.rs");
  writeFileSync(join(dir, "src/slots.rs"), both);
  git(dir, "commit", "-am", "rename and harness");
  const edited = git(dir, "rev-parse", "HEAD");
  const moved = sync(dir, ["src/slots.rs", "--source", "src/slots.rs"]);
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.deepEqual(lines(moved.stdout, "SYNC"), [`SYNC ${edited} from the last commit of the model files that changed no production code in slots.rs`]);
  // A path may begin with a newline.
  git(dir, "mv", "src/slots.rs", "\nlead.rs");
  git(dir, "commit", "-m", "rename to a path that begins with a newline");
  commit(dir, { "\nlead.rs": event + "pub fn claim() -> u8 { 4 }\n" + proofs.replace("== 1", "== 3") }, "production edit");
  git(dir, "mv", "\nlead.rs", "src/core.rs");
  git(dir, "commit", "-m", "rename back");
  const lead = sync(dir, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(lead.status, 0, lead.stdout + lead.stderr);
  assert.deepEqual(lines(lead.stdout, "SYNC"), [`SYNC ${edited} from the last commit of the model files that changed no production code in core.rs`]);

  for (let edit = 5; edit < 106; edit++) {
    writeFileSync(join(dir, "src/core.rs"), event + `pub fn claim() -> u8 { ${edit} }\n` + proofs.replace("== 1", "== 3"));
    git(dir, "commit", "-am", `edit ${edit}`);
  }
  const long = sync(dir, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(long.status, 0, long.stdout + long.stderr);
  assert.equal(long.stdout, "SYNC none: no commit of the last 100 commits of the model files changed only the #[cfg(kani)] items of core.rs; compare the model with the code in full\n");
});

test("sync's SYNC none says when the fallback did not follow a rename into a branch merged after it (#220)", () => {
  const proofs = "\n#[cfg(kani)]\nmod proofs {\n    #[kani::proof]\n    fn check() { assert!(super::claim() == 1); }\n}\n";
  // The harness commit is on a branch merged after the rename, under the old name.
  const side = fixture();
  git(side, "init", "-b", "main");
  commit(side, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" }, "production");
  git(side, "switch", "-c", "side");
  commit(side, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + proofs }, "harness");
  git(side, "switch", "main");
  git(side, "mv", "src/lib.rs", "src/core.rs");
  git(side, "commit", "-m", "rename");
  const rename = git(side, "rev-parse", "HEAD");
  git(side, "merge", "--no-edit", "side");
  const merged = sync(side, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert.equal(merged.stdout, `SYNC none: no commit of the model files changed only the #[cfg(kani)] items of core.rs; it did not follow the rename of src/lib.rs in ${rename} into a branch merged after it; compare the model with the code in full\n`);

  // The mirror case: the rename is on the branch and the harness commit on main.
  const mirror = fixture();
  git(mirror, "init", "-b", "main");
  commit(mirror, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" }, "production");
  git(mirror, "switch", "-c", "side");
  git(mirror, "mv", "src/lib.rs", "src/core.rs");
  git(mirror, "commit", "-m", "rename");
  const moved = git(mirror, "rev-parse", "HEAD");
  git(mirror, "switch", "main");
  commit(mirror, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + proofs }, "harness");
  git(mirror, "merge", "--no-edit", "side");
  const both = sync(mirror, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(both.status, 0, both.stdout + both.stderr);
  assert.equal(both.stdout, `SYNC none: no commit of the model files changed only the #[cfg(kani)] items of core.rs; it did not follow the rename of src/lib.rs in ${moved} into a branch merged after it; compare the model with the code in full\n`);

  // A rename merged from its own branch, and a later file at the old path, leave no branch unfollowed.
  const plain = fixture();
  git(plain, "init", "-b", "main");
  commit(plain, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + proofs }, "production and harness");
  git(plain, "switch", "-c", "rename");
  git(plain, "mv", "src/lib.rs", "src/core.rs");
  git(plain, "commit", "-m", "rename");
  git(plain, "switch", "main");
  git(plain, "merge", "--no-ff", "--no-edit", "rename");
  commit(plain, { "src/lib.rs": "mod core;\n" }, "a new crate root at the old path");
  const linear = sync(plain, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(linear.status, 0, linear.stdout + linear.stderr);
  assert.equal(linear.stdout, "SYNC none: no commit of the model files changed only the #[cfg(kani)] items of core.rs; compare the model with the code in full\n");

  // Of two renames, SYNC none names the one whose old path the merged branch changed.
  const twice = fixture();
  git(twice, "init", "-b", "main");
  commit(twice, { "src/a.rs": "pub fn claim() -> u8 { 1 }\n" }, "production");
  git(twice, "mv", "src/a.rs", "src/b.rs");
  git(twice, "commit", "-m", "first rename");
  git(twice, "switch", "-c", "side");
  commit(twice, { "src/b.rs": "pub fn claim() -> u8 { 1 }\n" + proofs }, "harness");
  git(twice, "switch", "main");
  git(twice, "mv", "src/b.rs", "src/c.rs");
  git(twice, "commit", "-m", "second rename");
  const second = git(twice, "rev-parse", "HEAD");
  git(twice, "merge", "--no-edit", "side");
  const later = sync(twice, ["src/c.rs", "--source", "src/c.rs"]);
  assert.equal(later.status, 0, later.stdout + later.stderr);
  assert.equal(later.stdout, `SYNC none: no commit of the model files changed only the #[cfg(kani)] items of c.rs; it did not follow the rename of src/b.rs in ${second} into a branch merged after it; compare the model with the code in full\n`);
});

test("sync's fallback follows a rename made in a merge commit into each of its parents (#253)", () => {
  const proofs = "\n#[cfg(kani)]\nmod proofs {\n    #[kani::proof]\n    fn check() { assert!(super::claim() == 1); }\n}\n";
  // The harness commit is on the merged branch, which the file matches only under its old name.
  const side = fixture();
  git(side, "init", "-b", "main");
  commit(side, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" }, "production");
  git(side, "switch", "-c", "side");
  const harness = commit(side, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + proofs }, "harness");
  git(side, "switch", "main");
  git(side, "merge", "--no-commit", "--no-ff", "side");
  git(side, "mv", "src/lib.rs", "src/core.rs");
  git(side, "commit", "-m", "merge and rename");
  const merged = sync(side, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert.equal(lines(merged.stdout, "SYNC")[0], `SYNC ${harness} from the last commit of the model files that changed no production code in core.rs`);

  // The harness commit is on the first parent, and the merged branch changed another file.
  const first = fixture();
  git(first, "init", "-b", "main");
  commit(first, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" }, "production");
  git(first, "switch", "-c", "side");
  commit(first, { "README.md": "notes\n" }, "notes");
  git(first, "switch", "main");
  const kept = commit(first, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + proofs }, "harness");
  git(first, "merge", "--no-commit", "--no-ff", "side");
  git(first, "mv", "src/lib.rs", "src/core.rs");
  git(first, "commit", "-m", "merge and rename");
  const parent = sync(first, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(parent.status, 0, parent.stdout + parent.stderr);
  assert.equal(lines(parent.stdout, "SYNC")[0], `SYNC ${kept} from the last commit of the model files that changed no production code in core.rs`);

  // The READ range keeps the old path, so it shows the production change that main made before the merge.
  const later = fixture();
  git(later, "init", "-b", "main");
  const rest = "\npub fn other() -> u8 { 0 }\n";
  commit(later, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + rest }, "production");
  git(later, "switch", "-c", "side");
  const branch = commit(later, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + rest + proofs }, "harness");
  git(later, "switch", "main");
  commit(later, { "src/lib.rs": "pub fn claim() -> u8 { 2 }\n" + rest }, "production change");
  git(later, "merge", "--no-commit", "--no-ff", "side");
  git(later, "mv", "src/lib.rs", "src/core.rs");
  git(later, "commit", "-m", "merge and rename");
  const read = sync(later, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(read.status, 0, read.stdout + read.stderr);
  assert.equal(lines(read.stdout, "SYNC")[0], `SYNC ${branch} from the last commit of the model files that changed no production code in core.rs`);
  assert.deepEqual(lines(read.stdout, "PATH"), ["PATH src/core.rs", "PATH src/lib.rs"]);
  assert.deepEqual(lines(read.stdout, "READ"), [`READ git -C ${git(later, "rev-parse", "--show-toplevel")} log -p ${branch}..HEAD -- src/core.rs src/lib.rs`]);

  // A merge that changed only the harness against its first parent is not the sync commit, since it joins main's code.
  const body = Array.from({ length: 12 }, (_, at) => `pub fn step${at}() -> u8 { ${at} }\n`).join("");
  const merging = fixture();
  git(merging, "init", "-b", "main");
  commit(merging, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + body }, "production");
  git(merging, "switch", "-c", "side");
  const written = commit(merging, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + body + proofs }, "harness");
  git(merging, "switch", "main");
  git(merging, "merge", "--no-commit", "--no-ff", "side");
  git(merging, "mv", "src/lib.rs", "src/core.rs");
  git(merging, "commit", "-m", "merge and rename");
  const joined = sync(merging, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  assert.equal(lines(joined.stdout, "SYNC")[0], `SYNC ${written} from the last commit of the model files that changed no production code in core.rs`);
});

// Run git with a committer date one second after the last in this fixture, so git log's order is the order here.
function clocked(dir) {
  let second = 1_700_000_000;
  return (...args) => {
    const stamp = `@${++second} +0000`;
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...gitEnv, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } });
    if (result.status !== 0) assert.fail(result.stderr);
    return result.stdout.trim();
  };
}

test("sync's SYNC none says when the fallback stops at a merge's rename it cannot follow, and keeps reading other sources (#255)", () => {
  const proofs = "\n#[cfg(kani)]\nmod proofs {\n    #[kani::proof]\n    fn check() { assert!(super::claim() == 1); }\n}\n";
  const body = Array.from({ length: 12 }, (_, at) => `pub fn step${at}() -> u8 { ${at} }\n`).join("");
  const grow = Array.from({ length: 30 }, (_, at) => `pub fn more${at}() -> u8 { ${at} }\n`).join("");
  const status = (dir, parent) => git(dir, "diff-tree", "-M", "-r", "--name-status", parent, "HEAD").split("\n").map((line) => line.split("\t")[0].replace(/[0-9]+$/, ""));

  // The parents hold the file under different old names, and the harness commit on the first parent under its old
  // name is found.
  const fork = fixture();
  const forkAt = clocked(fork);
  forkAt("init", "-b", "main");
  writeFileSync(join(mkdirSync(join(fork, "src"), { recursive: true }), "lib.rs"), "pub fn claim() -> u8 { 1 }\n" + body);
  forkAt("add", "-A");
  forkAt("commit", "-m", "production");
  forkAt("branch", "side");
  writeFileSync(join(fork, "src/lib.rs"), "pub fn claim() -> u8 { 1 }\n" + body + proofs);
  forkAt("commit", "-am", "harness");
  const kept = forkAt("rev-parse", "HEAD");
  forkAt("switch", "side");
  forkAt("mv", "src/lib.rs", "src/old.rs");
  writeFileSync(join(fork, "src/old.rs"), "pub fn extra() -> u8 { 9 }\npub fn claim() -> u8 { 1 }\n" + body);
  forkAt("commit", "-am", "rename and production edit");
  forkAt("switch", "main");
  forkAt("merge", "--no-commit", "--no-ff", "side");
  forkAt("mv", "src/old.rs", "src/core.rs");
  forkAt("commit", "-m", "merge and rename");
  assert.deepEqual([status(fork, "HEAD^1"), status(fork, "HEAD^2")], [["R"], ["R"]]);
  const first = sync(fork, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(lines(first.stdout, "SYNC")[0], `SYNC ${kept} from the last commit of the model files that changed no production code in core.rs`);

  // The merge grows the file past git's rename similarity against every parent, so the walk has no old path to follow.
  const grown = fixture();
  git(grown, "init", "-b", "main");
  commit(grown, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" }, "production");
  git(grown, "switch", "-c", "side");
  commit(grown, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + proofs }, "harness");
  git(grown, "switch", "main");
  git(grown, "merge", "--no-commit", "--no-ff", "side");
  git(grown, "mv", "src/lib.rs", "src/core.rs");
  writeFileSync(join(grown, "src/core.rs"), "pub fn claim() -> u8 { 1 }\n" + proofs + grow);
  git(grown, "commit", "-am", "merge, rename and grow");
  const merge = git(grown, "rev-parse", "HEAD");
  assert.deepEqual([status(grown, "HEAD^1"), status(grown, "HEAD^2")], [["A", "D"], ["A", "D"]]);
  const none = sync(grown, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.equal(none.stdout, `SYNC none: no commit of the model files changed only the #[cfg(kani)] items of core.rs; it stopped following src/core.rs at the merge ${merge}, since none of its parents has src/core.rs and git finds no rename to it; compare the model with the code in full\n`);

  // With a second source, the walk stops following only the first, and a branch merged later adds no rename to SYNC none.
  const two = fixture();
  const twoAt = clocked(two);
  twoAt("init", "-b", "main");
  writeFileSync(join(mkdirSync(join(two, "src"), { recursive: true }), "lib.rs"), "pub fn claim() -> u8 { 1 }\n");
  writeFileSync(join(two, "src/b.rs"), "pub fn other() -> u8 { 2 }\n");
  writeFileSync(join(two, "README"), "notes\n");
  twoAt("add", "-A");
  twoAt("commit", "-m", "production");
  twoAt("branch", "late");
  twoAt("switch", "-c", "side");
  writeFileSync(join(two, "src/lib.rs"), "pub fn claim() -> u8 { 1 }\n" + proofs);
  twoAt("commit", "-am", "harness");
  twoAt("switch", "main");
  twoAt("merge", "--no-commit", "--no-ff", "side");
  twoAt("mv", "src/lib.rs", "src/core.rs");
  writeFileSync(join(two, "src/core.rs"), "pub fn claim() -> u8 { 1 }\n" + proofs + grow);
  twoAt("commit", "-am", "merge, rename and grow");
  const grew = twoAt("rev-parse", "HEAD");
  twoAt("switch", "late");
  writeFileSync(join(two, "README"), "more notes\n");
  twoAt("commit", "-am", "notes");
  twoAt("switch", "main");
  twoAt("merge", "--no-ff", "--no-edit", "late");
  const both = sync(two, ["src/core.rs", "src/b.rs", "--source", "src/core.rs", "--source", "src/b.rs"]);
  assert.equal(both.status, 0, both.stdout + both.stderr);
  assert.equal(both.stdout, `SYNC none: no commit of the model files changed only the #[cfg(kani)] items of core.rs, b.rs; it stopped following src/core.rs at the merge ${grew}, since none of its parents has src/core.rs and git finds no rename to it; compare the model with the code in full\n`);

  // A source added after a merge is not one that the merge holds, so the walk reads on past that merge.
  const added = fixture();
  const addedAt = clocked(added);
  addedAt("init", "-b", "main");
  writeFileSync(join(mkdirSync(join(added, "src"), { recursive: true }), "a.rs"), "pub fn claim() -> u8 { 1 }\n" + body);
  addedAt("add", "-A");
  addedAt("commit", "-m", "production");
  addedAt("branch", "late");
  addedAt("switch", "-c", "side");
  writeFileSync(join(added, "src/a.rs"), "pub fn claim() -> u8 { 1 }\n" + body.replace("{ 5 }", "{ 55 }"));
  addedAt("commit", "-am", "production on the branch");
  addedAt("switch", "late");
  writeFileSync(join(added, "src/a.rs"), "pub fn claim() -> u8 { 1 }\n" + body + proofs);
  addedAt("commit", "-am", "harness");
  const harness = addedAt("rev-parse", "HEAD");
  addedAt("switch", "main");
  writeFileSync(join(added, "src/a.rs"), "pub fn m() -> u8 { 3 }\npub fn claim() -> u8 { 1 }\n" + body);
  addedAt("commit", "-am", "production on main");
  addedAt("merge", "--no-ff", "--no-edit", "side");
  writeFileSync(join(added, "src/b.rs"), "pub fn other() -> u8 { 2 }\n");
  addedAt("add", "-A");
  addedAt("commit", "-m", "second source");
  addedAt("merge", "--no-ff", "--no-edit", "late");
  const later = sync(added, ["src/a.rs", "src/b.rs", "--source", "src/a.rs", "--source", "src/b.rs"]);
  assert.equal(later.status, 0, later.stdout + later.stderr);
  assert.equal(lines(later.stdout, "SYNC")[0], `SYNC ${harness} from the last commit of the model files that changed no production code in a.rs, b.rs`);
});

const mergeProofs = "\n#[cfg(kani)]\nmod proofs {\n    #[kani::proof]\n    fn check() { assert!(super::claim() == 1); }\n}\n";
const mergeBody = Array.from({ length: 12 }, (_, at) => `pub fn step${at}() -> u8 { ${at} }\n`).join("");
const mergeGrow = Array.from({ length: 30 }, (_, at) => `pub fn more${at}() -> u8 { ${at} }\n`).join("");
// The status letters of git diff-tree -M between a parent and HEAD, such as ["R"] for a rename or ["A", "D"] for none.
const mergeStatus = (dir, parent) => git(dir, "diff-tree", "-M", "-r", "--name-status", parent, "HEAD").split("\n").map((line) => line.split("\t")[0].replace(/[0-9]+$/, ""));

// A fixture whose branch renames src/lib.rs to src/old.rs, and whose merge renames both to src/core.rs. The first
// parent and the branch each make a harness commit when given one, in the order given.
function renamedApart(order) {
  const dir = fixture();
  const at = clocked(dir);
  at("init", "-b", "main");
  writeFileSync(join(mkdirSync(join(dir, "src"), { recursive: true }), "lib.rs"), "pub fn claim() -> u8 { 1 }\n" + mergeBody);
  at("add", "-A");
  at("commit", "-m", "production");
  at("switch", "-c", "side");
  at("mv", "src/lib.rs", "src/old.rs");
  at("commit", "-m", "rename on the branch");
  const harness = {};
  for (const where of order) {
    at("switch", where);
    const file = where === "main" ? "src/lib.rs" : "src/old.rs";
    writeFileSync(join(dir, file), "pub fn claim() -> u8 { 1 }\n" + mergeBody + (where === "main" ? mergeProofs : mergeProofs.replace("== 1", "> 0")));
    at("commit", "-am", `harness on ${where}`);
    harness[where] = at("rev-parse", "HEAD");
  }
  at("switch", "main");
  at("merge", "--no-commit", "--no-ff", "-X", "theirs", "side");
  at("mv", "src/old.rs", "src/core.rs");
  at("commit", "-m", "merge and rename");
  assert.deepEqual([mergeStatus(dir, "HEAD^1"), mergeStatus(dir, "HEAD^2")], [["R"], ["R"]]);
  return { dir, harness };
}

test("sync's fallback reads each parent of a merge-made rename under that parent's own old path (#260)", () => {
  // The harness commit is on the branch, under the branch's old name.
  const apart = renamedApart(["side"]);
  const other = sync(apart.dir, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(other.status, 0, other.stdout + other.stderr);
  assert.equal(lines(other.stdout, "SYNC")[0], `SYNC ${apart.harness.side} from the last commit of the model files that changed no production code in core.rs`);
  assert.deepEqual(lines(other.stdout, "PATH"), ["PATH src/core.rs", "PATH src/lib.rs", "PATH src/old.rs"]);

  // Both parents have a harness commit under their own old names, and the later one is the sync commit.
  for (const order of [["main", "side"], ["side", "main"]]) {
    const both = renamedApart(order);
    const later = sync(both.dir, ["src/core.rs", "--source", "src/core.rs"]);
    assert.equal(later.status, 0, later.stdout + later.stderr);
    assert.equal(lines(later.stdout, "SYNC")[0], `SYNC ${both.harness[order[1]]} from the last commit of the model files that changed no production code in core.rs`);
  }

  // The first parent's walk reads main's commit made after the branch's rename, so SYNC none does not name that rename.
  const after = fixture();
  git(after, "init", "-b", "main");
  commit(after, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + mergeBody }, "production");
  git(after, "switch", "-c", "side");
  git(after, "mv", "src/lib.rs", "src/old.rs");
  git(after, "commit", "-m", "rename on the branch");
  git(after, "switch", "main");
  commit(after, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + mergeBody + "pub fn later() -> u8 { 7 }\n" }, "production on main");
  git(after, "merge", "--no-commit", "--no-ff", "side");
  git(after, "mv", "src/old.rs", "src/core.rs");
  git(after, "commit", "-m", "merge and rename");
  assert.deepEqual([mergeStatus(after, "HEAD^1"), mergeStatus(after, "HEAD^2")], [["R"], ["R"]]);
  const read = sync(after, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(read.status, 0, read.stdout + read.stderr);
  assert.equal(read.stdout, "SYNC none: no commit of the model files changed only the #[cfg(kani)] items of core.rs; compare the model with the code in full\n");
});

test("sync's fallback reads the walks of a merge-made rename together, newest first, and each commit once (#260)", () => {
  // Run git with a committer date one second after the last in this fixture, for histories of more than 59 commits.
  // A history of src/lib.rs on main with count production commits, after a harness commit when withHarness is set, a
  // branch that renames the file to src/old.rs, after a harness commit of its own when withBranchHarness is set, and a
  // merge that renames both to src/core.rs.
  const build = (count, withHarness, withBranchHarness) => {
    const dir = fixture();
    const at = clocked(dir);
    const code = (step) => "pub fn claim() -> u8 { 1 }\n" + mergeBody + Array.from({ length: step }, (_, n) => `pub fn extra${n}() -> u8 { ${n} }\n`).join("");
    const write = (text) => writeFileSync(join(dir, "src/lib.rs"), text);
    at("init", "-b", "main");
    mkdirSync(join(dir, "src"));
    write(code(0));
    at("add", "-A");
    at("commit", "-m", "production");
    const harness = withHarness ? mergeProofs : "";
    if (withHarness) {
      write(code(0) + harness);
      at("commit", "-am", "harness on main");
    }
    for (let step = 1; step <= count; step++) {
      write(code(step) + harness);
      at("commit", "-am", `production ${step}`);
    }
    at("switch", "-c", "side");
    let branch;
    if (withBranchHarness) {
      write(code(count) + mergeProofs.replace("== 1", "> 0"));
      at("commit", "-am", "harness on the branch");
      branch = at("rev-parse", "HEAD");
    }
    at("mv", "src/lib.rs", "src/old.rs");
    at("commit", "-m", "rename on the branch");
    at("switch", "main");
    at("merge", "--no-commit", "--no-ff", "side");
    at("mv", "src/old.rs", "src/core.rs");
    at("commit", "-m", "merge and rename");
    assert.deepEqual([mergeStatus(dir, "HEAD^1"), mergeStatus(dir, "HEAD^2")], [["R"], ["R"]]);
    return { dir, branch };
  };

  // A harness commit on main 99 commits deep, and a later one on the branch: the later one is the sync commit, though
  // the first parent's walk alone would spend the 100 commits before the branch's.
  const deep = build(98, true, true);
  const later = sync(deep.dir, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(later.status, 0, later.stdout + later.stderr);
  assert.equal(lines(later.stdout, "SYNC")[0], `SYNC ${deep.branch} from the last commit of the model files that changed no production code in core.rs`);

  // 60 commits that both parents share are read once, so SYNC none does not say the walk stopped at 100 commits.
  const shared = build(60, false, false);
  const none = sync(shared.dir, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.equal(none.stdout, "SYNC none: no commit of the model files changed only the #[cfg(kani)] items of core.rs; compare the model with the code in full\n");
});

test("sync's SYNC none names a parent of a merge-made rename that git finds no rename against and that lacks the old path (#260)", () => {
  // Code the branch adds, so that git finds no rename between the branch's file and the merge's.
  const large = mergeGrow + mergeGrow.replaceAll("more", "most");

  // A parent that still holds the other parent's old name is read under it, and SYNC none adds nothing.
  const kept = fixture();
  git(kept, "init", "-b", "main");
  commit(kept, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + mergeBody }, "production");
  git(kept, "switch", "-c", "side");
  commit(kept, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + mergeBody + large }, "grow on the branch");
  const held = commit(kept, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + mergeBody + large + mergeProofs }, "harness");
  git(kept, "switch", "main");
  git(kept, "merge", "--no-commit", "--no-ff", "side");
  git(kept, "rm", "-f", "src/lib.rs");
  commit(kept, { "src/core.rs": "pub fn claim() -> u8 { 1 }\n" + mergeBody + mergeProofs }, "merge and rename");
  assert.deepEqual([mergeStatus(kept, "HEAD^1"), mergeStatus(kept, "HEAD^2")], [["R"], ["A", "D"]]);
  const read = sync(kept, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(read.status, 0, read.stdout + read.stderr);
  assert.equal(lines(read.stdout, "SYNC")[0], `SYNC ${held} from the last commit of the model files that changed no production code in core.rs`);

  // git finds the rename against the first parent only, and the branch no longer holds the first parent's old name.
  const hybrid = fixture();
  git(hybrid, "init", "-b", "main");
  commit(hybrid, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" + mergeBody }, "production");
  git(hybrid, "switch", "-c", "side");
  git(hybrid, "mv", "src/lib.rs", "src/old.rs");
  commit(hybrid, { "src/old.rs": "pub fn claim() -> u8 { 1 }\n" + mergeBody + large }, "rename and grow on the branch");
  commit(hybrid, { "src/old.rs": "pub fn claim() -> u8 { 1 }\n" + mergeBody + large + mergeProofs }, "harness");
  const branch = git(hybrid, "rev-parse", "HEAD");
  git(hybrid, "switch", "main");
  git(hybrid, "merge", "--no-commit", "--no-ff", "side");
  git(hybrid, "rm", "-f", "src/old.rs");
  commit(hybrid, { "src/core.rs": "pub fn claim() -> u8 { 1 }\n" + mergeBody + mergeProofs }, "merge and rename");
  const merge = git(hybrid, "rev-parse", "HEAD");
  assert.deepEqual([mergeStatus(hybrid, "HEAD^1"), mergeStatus(hybrid, "HEAD^2")], [["R"], ["A", "D"]]);
  const named = sync(hybrid, ["src/core.rs", "--source", "src/core.rs"]);
  assert.equal(named.status, 0, named.stdout + named.stderr);
  assert.equal(named.stdout, `SYNC none: no commit of the model files changed only the #[cfg(kani)] items of core.rs; it read the parent ${branch} of the merge ${merge} under src/lib.rs, which that parent does not hold, since git finds no rename to src/core.rs against it; compare the model with the code in full\n`);
});

test("sync leaves a model file out of the name search when it is not also a source", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  // The harness in its own file still calls a function that the production code no longer has.
  commit(dir, { "src/lib.rs": "pub fn claim() {}\n", "verify/src/harness.rs": "fn check() { claim(); drain(); }\n" }, "start");
  const harness = sync(dir, ["verify/src/harness.rs", "--name", "claim", "--name", "drain"]);
  assert.equal(harness.status, 0, harness.stdout + harness.stderr);
  assert.deepEqual(lines(harness.stdout, "PATH"), ["PATH src/lib.rs"]);
  assert.deepEqual(lines(harness.stdout, "MISSING"), ["MISSING drain: no commit since the sync removed it"]);
});

test("sync follows a rename between non-ASCII paths and searches for a name as a fixed string", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const read = commit(dir, { "src/café.cpp": "int operator[](int);\n" }, "queue");
  commit(dir, { "tla/Queue.tla": `(* Source read at ${read} *)\n` }, "model");
  git(dir, "mv", "src/café.cpp", "src/naïve.cpp");
  git(dir, "commit", "-m", "rename");
  const result = sync(dir, ["tla/Queue.tla", "--source", "src/café.cpp", "--name", "operator[]"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout, "PATH"), ["PATH src/café.cpp", "PATH src/naïve.cpp"]);
  assert.deepEqual(lines(result.stdout, "MISSING"), []);
});

test("sync's tests keep a fixture whose object git cannot read and say whether the object is missing", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  commit(dir, { "src/lib.rs": "pub fn claim() -> u8 { 1 }\n" }, "production");
  const lost = commit(dir, { "src/lib.rs": "pub fn claim() -> u8 { 2 }\n" }, "edit");
  commit(dir, { "src/lib.rs": "pub fn claim() -> u8 { 3 }\n" }, "edit again");
  rmSync(join(dir, ".git/objects", lost.slice(0, 2), lost.slice(2)));
  const result = sync(dir, ["src/lib.rs", "--source", "src/lib.rs"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`\nDIAGNOSIS ${lost} is missing: .+; it has no loose file; fixture kept at ${dir}\n$`));
  try {
    removeFixtures();
    assert.ok(existsSync(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git in sync's fixtures starts no background maintenance, which repacked a fixture under a running test (#201)", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  const trace = join(dir, ".git", "trace");
  const result = spawnSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "empty"], { encoding: "utf8", env: { ...gitEnv, GIT_TRACE: trace } });
  assert.equal(result.status, 0, result.stderr);
  excludes(readFileSync(trace, "utf8"), "maintenance run");
});

test("sync fails for a source path that no commit has", () => {
  const dir = fixture();
  git(dir, "init", "-b", "main");
  commit(dir, { "src/queue.c": "int claim(void);\n", "tla/Queue.tla": "claim\n" }, "start");
  const result = sync(dir, ["../tla/Queue.tla", "--source", "src/queue.c"], join(dir, "src"));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^SYNC [0-9a-f]{40} from the last commit of the model files\nFAIL --source src\/queue\.c is .*src\/src\/queue\.c, which no commit in .* has\n$/);
});

test("sync fails outside a git repository", () => {
  const dir = fixture();
  writeFileSync(join(dir, "Queue.tla"), "\n");
  const result = sync(dir, ["Queue.tla"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL .*Queue\.tla is in no git repository\n$/);
});
