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
