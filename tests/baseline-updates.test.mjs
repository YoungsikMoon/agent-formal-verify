// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fixture, removeFixtures, root, run, scripts } from "./helpers.mjs";

afterEach(removeFixtures);

test("a slow record preserves a move and another record completed during extraction", () => {
  const dir = realpathSync(fixture());
  const record = join(dir, "baseline.json");
  const [old, moved, first, second] = ["Old", "Moved", "First", "Second"].map(name => join(dir, name + ".statements"));
  const source = join(root, "skills/formal-verify/examples/lean-template/Model/BoundedQueue.statements");
  for (const path of [old, first, second]) copyFileSync(source, path);
  assert.equal(run(dir, "baseline.py", ["record", record, old]).status, 0);

  // Interleave two real CLI writers after the first writer has extracted its entry.
  const program = `
import subprocess, sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import baseline
record, old, moved, first, second = map(Path, sys.argv[2:])
extract = baseline.LeanKind.entry
def interleave(kind, path):
    entry = extract(kind, path)
    for args in (["move", record, old, moved], ["record", record, second]):
        subprocess.run([sys.executable, baseline.__file__, *args], check=True, timeout=10)
    return entry
with patch.object(baseline.LeanKind, "entry", interleave):
    sys.exit(baseline.record(record, [first]))
`;
  const result = spawnSync("python3", ["-B", "-c", program, scripts, record, old, moved, first, second], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(record, "utf8")).models).sort(), [moved, first, second].sort());
});

test("two writers contending between the record read and replacement preserve both entries", () => {
  const dir = realpathSync(fixture());
  const record = join(dir, "baseline.json");
  const first = join(dir, "A.statements");
  const second = join(dir, "B.statements");
  const source = join(root, "skills/formal-verify/examples/lean-template/Model/BoundedQueue.statements");
  for (const path of [first, second]) copyFileSync(source, path);
  const program = `
import multiprocessing, sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import baseline
record, first, second = map(Path, sys.argv[2:])
ctx = multiprocessing.get_context("fork")
holding, extracted, finished = (ctx.Event() for _ in range(3))
write = baseline.write_record
def pause_before_replace(path, models):
    holding.set()
    assert extracted.wait(10)
    # Without the lock the contender can publish its stale snapshot before this replacement.
    finished.wait(0.5)
    write(path, models)
def first_writer():
    with patch.object(baseline, "write_record", pause_before_replace):
        sys.exit(baseline.record(record, [first]))
writer = ctx.Process(target=first_writer)
writer.start()
assert holding.wait(10)
entry = baseline.LeanKind.entry
def signal_extraction(kind, path):
    result = entry(kind, path)
    extracted.set()
    return result
with patch.object(baseline.LeanKind, "entry", signal_extraction):
    assert baseline.record(record, [second]) == 0
finished.set()
writer.join(10)
assert writer.exitcode == 0
`;
  const result = spawnSync("python3", ["-B", "-c", program, scripts, record, first, second], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(record, "utf8")).models).sort(), [first, second]);
});
