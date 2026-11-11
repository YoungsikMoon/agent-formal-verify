#!/bin/bash
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
# Real Lean regressions for declaration discovery and proof-sensitivity reporting.
# Optionally pass an installed toolchain pin to exercise an older supported Lean.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
scripts=$ROOT/skills/formal-verify/scripts
template=$ROOT/skills/formal-verify/examples/lean-template
work=$(mktemp -d)
work=$(cd "$work" && pwd -P)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/Model"
cp "$template"/{lakefile.toml,lake-manifest.json,lean-toolchain} "$work/"
if [ "$#" -gt 0 ]; then printf '%s\n' "$1" > "$work/lean-toolchain"; fi

cat > "$work/Model/Step.lean" <<'EOF'
namespace Step
def step (n : Nat) : Nat := n + 1
namespace Live
  @[simp] theorem property (n : Nat) : n < step n := by simp [step]
end Live
namespace Vacuous
  theorem property (n : Nat) (h : n < 0) : n < step n := absurd h (Nat.not_lt_zero n)
end Vacuous
private theorem helper : True := trivial
end Step
EOF
printf 'mutation no increment\n- n + 1\n+ n\n' > "$work/Model/Step.mutations"
bash "$scripts/lean-check.sh" "$work" --freeze Model/Step.lean
bash "$scripts/lean-check.sh" "$work"
if python3 "$scripts/mutate.py" "$work/Model/Step.mutations" > "$work/result"; then
  echo 'FAIL indented, same-name vacuous theorem escaped coverage'
  exit 1
fi
cat "$work/result"
grep -q '^DETECTED no increment: proof/check fails: theorem Step.Live.property$' "$work/result"
grep -q '^UNCOVERED theorem Step.Vacuous.property$' "$work/result"
if grep -q '^UNCOVERED theorem Step.helper$' "$work/result"; then
  echo 'FAIL private helper counted as a coverage target'
  exit 1
fi

# Proposition-valued projections and instances are not property declarations.
cat > "$work/Model/Step.lean" <<'EOF'
namespace Step
def step (n : Nat) : Nat := n + 1
theorem property (n : Nat) : n < step n := by simp [step]
private theorem premises_hold : ∃ n : Nat, 0 < n := ⟨1, by decide⟩
example : ∃ n : Nat, 0 < n := ⟨1, by decide⟩
structure Pos where
  n : Nat
  pos : 0 < n
class Good (n : Nat) : Prop where
  ok : 0 < n
instance globalGood : Good 1 := ⟨by decide⟩
section
local instance localGood : Good 2 := ⟨by decide⟩
end
namespace Scoped
scoped instance scopedGood : Good 3 := ⟨by decide⟩
end Scoped
end Step
EOF
bash "$scripts/lean-check.sh" "$work" --freeze Model/Step.lean
python3 "$scripts/mutate.py" "$work/Model/Step.mutations" > "$work/result"
cat "$work/result"
grep -q '^DETECTED no increment: proof/check fails: theorem Step.property$' "$work/result"
if grep -q '^UNCOVERED' "$work/result"; then
  echo 'FAIL projection or instance counted as a coverage target'
  exit 1
fi

# Option and section-variable wrappers must preserve guard attribution.
cat > "$work/Model/Step.lean" <<'EOF'
namespace Step
def step (n : Nat) : Nat := n + 1
set_option maxRecDepth 2048 in
#guard step 0 == 1
set_option maxRecDepth 2048 in
set_option maxHeartbeats 400000 in
#guard step 0 == 1
variable (n : Nat) in
#guard step 0 == 1
end Step
EOF
bash "$scripts/lean-check.sh" "$work" --freeze Model/Step.lean
python3 "$scripts/mutate.py" "$work/Model/Step.mutations" > "$work/result"
cat "$work/result"
grep -q '^SUMMARY 1 of 1 mutations detected$' "$work/result"
grep -Fqx "DETECTED no increment: proof/check fails: #guard at $work/Model/Step.lean:4; #guard at $work/Model/Step.lean:7; #guard at $work/Model/Step.lean:9" "$work/result"

# Errors in a wrapper must not be attributed to the check it contains.
printf 'mutation invalid option\n- set_option maxRecDepth 2048 in\n- #guard step 0 == 1\n+ set_option maxRecDepth true in\n+ #guard step 0 == 1\n' > "$work/Model/Step.mutations"
if python3 "$scripts/mutate.py" "$work/Model/Step.mutations" > "$work/result"; then
  echo 'FAIL invalid wrapper option counted as a detected mutation'
  exit 1
fi
cat "$work/result"
grep -q "^FAIL mutation 'invalid option' did not reach a verdict:" "$work/result"
printf 'mutation no increment\n- n + 1\n+ n\n' > "$work/Model/Step.mutations"

# Proof sensitivity alone cannot establish non-vacuity. The same statement
# remains provable on the mutant by using its contradictory hypothesis.
cat > "$work/Model/Step.lean" <<'EOF'
namespace Step
def step (n : Nat) : Nat := n + 1
theorem vacuous (n : Nat) (_h : n < 0) : n < step n := by simp [step]
end Step
EOF
bash "$scripts/lean-check.sh" "$work" --freeze Model/Step.lean
python3 "$scripts/mutate.py" "$work/Model/Step.mutations" > "$work/result"
cat "$work/result"
grep -q '^DETECTED no increment: proof/check fails: theorem Step.vacuous$' "$work/result"
grep -q '^NOTE Lean detections mean existing proofs fail, not that theorem statements are false or hypotheses satisfiable\.$' "$work/result"
cat > "$work/Model/Step.lean" <<'EOF'
namespace Step
def step (n : Nat) : Nat := n
theorem vacuous (n : Nat) (h : n < 0) : n < step n := absurd h (Nat.not_lt_zero n)
end Step
EOF
bash "$scripts/lean-check.sh" "$work" --freeze Model/Step.lean
bash "$scripts/lean-check.sh" "$work"

cat > "$work/Model/Step.lean" <<'EOF'
namespace Step
def step (n : Nat) : Nat := n + 1
theorem property (n : Nat) : n < step n := by simp [step]
example : step 0 = 1 := by rfl
#guard step 0 == 1
end Step
EOF
bash "$scripts/lean-check.sh" "$work" --freeze Model/Step.lean
printf 'mutation no increment\n- n + 1\n+ n\n+ -- extra line\n' > "$work/Model/Step.mutations"
python3 "$scripts/mutate.py" "$work/Model/Step.mutations" > "$work/result"
cat "$work/result"
grep -Fqx "DETECTED no increment: proof/check fails: theorem Step.property; example at $work/Model/Step.lean:4; #guard at $work/Model/Step.lean:5" "$work/result"

# A syntax error in a definition must never count as a detected bug.
printf 'mutation invalid definition\n- n + 1\n+ n +\n' > "$work/Model/Step.mutations"
if python3 "$scripts/mutate.py" "$work/Model/Step.mutations" > "$work/result"; then
  echo 'FAIL invalid definition counted as a detected mutation'
  exit 1
fi
cat "$work/result"
grep -q "^FAIL mutation 'invalid definition' did not reach a verdict:" "$work/result"
if grep -q '^DETECTED' "$work/result"; then
  echo 'FAIL invalid definition reported as a detected mutation'
  exit 1
fi
echo 'ok: qualified coverage and proof-sensitivity reporting checked with real Lean'
