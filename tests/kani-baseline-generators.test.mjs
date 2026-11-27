// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fixture, removeFixtures, run } from "./helpers.mjs";

afterEach(removeFixtures);

test("a predicate-only record still requires review if a generator becomes a plain assumption", () => {
  const dir = realpathSync(fixture());
  const source = join(dir, "proof.rs");
  const record = join(dir, "record.json");
  const generator = "kani::any_where::<bool, _>(predicate)";
  const original = `let predicate = |_: &bool| true; let _: bool = ${generator};`;
  const write = body => writeFileSync(source, `#[kani::proof]\nfn verify() { ${body} kani::cover!(true); }\n`);
  const compare = () => run(dir, "baseline.py", ["compare", record]);
  const renew = () => run(dir, "baseline.py", ["record", record, source]);
  write(original);
  assert.equal(renew().status, 0);
  const stored = JSON.parse(readFileSync(record, "utf8"));
  const entry = stored.models[source];
  const full = `assume ${generator} in verify`;
  assert.equal(entry.surface[full], "");
  delete entry.surface[full];
  entry.surface["assume predicate in verify"] = "";
  delete entry.generator_types;
  writeFileSync(record, JSON.stringify(stored));
  for (const body of [original, "let predicate = false; kani::assume(predicate);"]) {
    write(body);
    const result = compare();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /review the original assumptions and record this file again/);
  }
  assert.equal(renew().status, 0);
  assert.equal(compare().status, 0);
});
