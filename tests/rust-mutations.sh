#!/bin/bash
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
# Real Kani regressions for crate copies with local dependencies.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
scripts=$ROOT/skills/formal-verify/scripts
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

for layout in standalone workspace; do
  p=$work/$layout/project
  mkdir -p "$p/proof/src" "$p/logic/src" "$p/../shared/src" "$p/../optional/src"
  if [ "$layout" = workspace ]; then
    cat > "$p/Cargo.toml" <<'EOF'
[workspace]
members = ["proof", "logic"]
resolver = "2"
[workspace.package]
version = "0.1.0"
edition = "2021"
[workspace.dependencies]
logic = { path = "logic" }
EOF
    cat > "$p/proof/Cargo.toml" <<'EOF'
[package]
name = "proof"
version.workspace = true
edition.workspace = true
[dependencies]
logic.workspace = true
EOF
  else
    cat > "$p/proof/Cargo.toml" <<'EOF'
[package]
name = "proof"
version = "0.1.0"
edition = "2021"
[dependencies]
logic = { path = "../logic" }
EOF
  fi
  printf 'optional = { path = "../../optional", optional = true }\n' >> "$p/proof/Cargo.toml"
  cat > "$p/logic/Cargo.toml" <<'EOF'
[package]
name = "logic"
version = "0.1.0"
edition = "2021"
[dependencies]
shared = { path = "../../shared" }
EOF
  printf '[package]\nname="shared"\nversion="0.1.0"\nedition="2021"\n' > "$p/../shared/Cargo.toml"
  printf 'pub fn step(n: u8) -> u8 { n.saturating_add(1) }\n' > "$p/../shared/src/lib.rs"
  printf '[package]\nname="optional"\nversion="0.1.0"\n' > "$p/../optional/Cargo.toml"
  touch "$p/../optional/src/lib.rs"
  printf 'pub fn step(n: u8) -> u8 { shared::step(n) }\n' > "$p/logic/src/lib.rs"
  cat > "$p/proof/src/lib.rs" <<'EOF'
pub fn step(n: u8) -> u8 { logic::step(n) }
#[cfg(kani)]
mod proofs {
    #[kani::proof]
    #[kani::unwind(2)]
    fn increments() {
        let n: u8 = kani::any();
        kani::assume(n < 255);
        assert!(super::step(n) > n);
    }
}
EOF
  printf 'mutation no increment\ndetects proofs::increments\n- logic::step(n)\n+ n\n' > "$p/proof/src/lib.mutations"
  bash "$scripts/kani-check.sh" "$p/proof"
  python3 "$scripts/mutate.py" "$p/proof/src/lib.mutations" | tee "$work/result"
  grep -q '^DETECTED no increment: assertion Failure:' "$work/result"
  grep -q '^SUMMARY 1 of 1 mutations detected$' "$work/result"
  grep -qF 'logic::step(n)' "$p/proof/src/lib.rs"
  if [ -f "$p/../shared/Cargo.lock" ] || [ -f "$p/../optional/Cargo.lock" ]; then
    echo 'FAIL mutation discovery wrote a lockfile into a dependency'
    exit 1
  fi
done
echo 'ok: Rust mutations preserve sibling and transitive dependencies and workspace inheritance'
