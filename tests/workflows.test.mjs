// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { command, fixture, removeFixtures, root } from "./helpers.mjs";

afterEach(removeFixtures);

const mirror = "https://ftpmirror.gnu.org/bash/bash-3.2.57.tar.gz";
const origin = "https://ftp.gnu.org/gnu/bash/bash-3.2.57.tar.gz";
const urls = (calls) => calls.map((call) => call.split(" ").at(-1));

const sha256 = "a".repeat(64);

// Run the download with a curl that times out for each unreachable URL and serves other bytes for each junk URL,
// and a sha256sum that accepts only the bytes curl serves for the other URLs. A cached string is the tarball the cache restored.
function fetch(unreachable, junk = [], cached) {
  const dir = fixture();
  const cache = join(dir, "cache");
  if (cached !== undefined) {
    mkdirSync(cache);
    writeFileSync(join(cache, "bash-3.2.57.tar.gz"), cached);
  }
  command(dir, "curl", `printf '%s\\n' "$*" >> "${dir}/curl.log"
prev=
for arg; do [ "$prev" = -o ] && out=$arg; prev=$arg; done
case " ${unreachable.join(" ")} " in *" $arg "*) exit 28;; esac
case " ${junk.join(" ")} " in *" $arg "*) printf junk > "$out"; exit 0;; esac
printf tarball > "$out"`);
  command(dir, "sha256sum", `read -r line
printf '%s\\n' "$line" >> "${dir}/sha256sum.log"
[ "$(cat "\${line##* }")" = tarball ]`);
  const result = spawnSync("bash", [join(root, ".github/fetch-bash.sh")], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, BASH_TARBALL_DIR: cache, BASH_TARBALL_SHA256: sha256, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
  });
  const log = (name) => {
    try {
      return readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  return { status: result.status, stderr: result.stderr, calls: log("curl.log"), checked: log("sha256sum.log") };
}

test("the Bash 3.2 job falls back to ftp.gnu.org when ftpmirror.gnu.org is unreachable or serves other bytes, and checks the tarball", () => {
  const checksum = /^[0-9a-f]{64} {2}bash-3\.2\.57\.tar\.gz$/;
  const fallback = fetch([mirror]);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.deepEqual(urls(fallback.calls), [mirror, origin]);
  for (const call of fallback.calls) assert.match(call, /^-fL .*--connect-timeout 30 --retry 3 /);
  assert.match(fallback.checked[0], checksum);
  const corrupt = fetch([], [mirror]);
  assert.equal(corrupt.status, 0, corrupt.stderr);
  assert.deepEqual(urls(corrupt.calls), [mirror, origin]);
  assert.equal(corrupt.checked.length, 2);
  const direct = fetch([]);
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(urls(direct.calls), [mirror]);
  assert.match(direct.checked[0], checksum);
  const neither = fetch([mirror, origin]);
  assert.notEqual(neither.status, 0);
  assert.deepEqual(urls(neither.calls), [mirror, origin]);
});

test("the Bash 3.2 job uses a checked tarball the cache restored without reaching gnu.org, and downloads one when the cached bytes differ", () => {
  const restored = fetch([mirror, origin], [], "tarball");
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(restored.calls, []);
  assert.deepEqual(restored.checked, [`${sha256}  bash-3.2.57.tar.gz`]);
  const stale = fetch([], [], "junk");
  assert.equal(stale.status, 0, stale.stderr);
  assert.deepEqual(urls(stale.calls), [mirror]);
  assert.equal(stale.checked.length, 2);
});
