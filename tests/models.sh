#!/bin/bash
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
# Runs the real TLC and Lean checkers and the mutation runner on the bundled
# examples, then on copies with one guard weakened, a hidden axiom, clashing
# names, an unowned file, an undetected mutation or a theorem no mutation
# breaks, which they must reject.
# Needs the tools that setup.sh prepares; see
# skills/formal-verify/references/setup.md.
#
# Usage: models.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
scripts=$ROOT/skills/formal-verify/scripts
examples=$ROOT/skills/formal-verify/examples
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Prints the output of a checker that must fail, and stops if it passes.
rejected() {
  local out
  if out=$("$@"); then
    echo "FAIL a check that must fail passed: $*"
    exit 1
  fi
  printf '%s\n' "$out"
}

bash "$scripts/setup.sh" tla
bash "$scripts/setup.sh" lean "$examples/lean-template"

bash "$scripts/tlc-matrix.sh" "$examples/tla-template/BoundedQueue.matrix"
python3 "$scripts/mutate.py" "$examples/tla-template/BoundedQueue.mutations"
cp -R "$examples/tla-template" "$work/unreachable"
sed -i.orig 's|next < consumed + Window|next < consumed + Window - 1|' "$work/unreachable/BoundedQueue.tla"
rejected bash "$scripts/tlc-matrix.sh" "$work/unreachable/BoundedQueue.matrix" | tee "$work/unreachable.out"
grep -q '^FAIL BoundedQueue reach WindowFull window=1 items=3: the model never reaches this state$' "$work/unreachable.out"
cp -R "$examples/tla-template" "$work/tla"
sed -i.orig 's|next < consumed + Window|next <= consumed + Window|' "$work/tla/BoundedQueue.tla"
rejected bash "$scripts/tlc-matrix.sh" "$work/tla/BoundedQueue.matrix" window=1 | tee "$work/tla.out"
grep -q "Invariant InWindow is violated" "$work/tla.out"
grep -q "^--- state 2: Claim$" "$work/tla.out"

# A mutation that no property detects, and a property that no mutation targets.
printf 'mutation reorder a sum\ndetects InWindow\n- next < consumed + Window\n+ next < Window + consumed\n' > "$work/tla/BoundedQueue.mutations"
cp "$work/tla/BoundedQueue.tla.orig" "$work/tla/BoundedQueue.tla"
rejected python3 "$scripts/mutate.py" "$work/tla/BoundedQueue.mutations" | tee "$work/tla.out"
grep -q "^MISSED reorder a sum$" "$work/tla.out"
grep -q "^UNCOVERED AllConsumed$" "$work/tla.out"

model=$work/lean/Model/BoundedQueue.lean
mkdir -p "$work/lean/Model"
cp "$examples/lean-template"/{lakefile.toml,lake-manifest.json,lean-toolchain} "$work/lean/"
cp "$examples/lean-template/Model"/BoundedQueue.* "$work/lean/Model/"
bash "$scripts/lean-check.sh" "$work/lean" | tee "$work/vectors.out"
grep -qF "VECTOR w=0 input=0,0 claim=none consume=none" "$work/vectors.out"
grep -qF "VECTOR w=4 input=4,0 claim=none" "$work/vectors.out"
grep -qF "VECTOR w=4 input=3,0 claim=some(4,0)" "$work/vectors.out"
python3 "$scripts/mutate.py" "$work/lean/Model/BoundedQueue.mutations"
bash "$ROOT/tests/lean-mutations.sh"

# This proof uses contradictory hypotheses and is insensitive to the mutations.
cp -R "$work/lean" "$work/lean-vacuous"
printf 'theorem vacuous (w : Nat) (s t : BoundedQueue.State) (hs : BoundedQueue.Invariant w s)\n    (hlt : s.next < s.consumed) (h : BoundedQueue.claim w s = some t) : BoundedQueue.Invariant w t := by\n  simp only [BoundedQueue.Invariant] at hs; omega\n' >> "$work/lean-vacuous/Model/BoundedQueue.lean"
bash "$scripts/lean-check.sh" "$work/lean-vacuous" --freeze Model/BoundedQueue.lean
rejected python3 "$scripts/mutate.py" "$work/lean-vacuous/Model/BoundedQueue.mutations" | tee "$work/lean.out"
grep -q "^UNCOVERED theorem vacuous$" "$work/lean.out"

cp -R "$work/lean" "$work/lean-unreachable"
sed -i.orig 's|if s.next < s.consumed + w then|if s.next < s.consumed + w - 1 then|' "$work/lean-unreachable/Model/BoundedQueue.lean"
rejected bash "$scripts/lean-check.sh" "$work/lean-unreachable" | tee "$work/lean-unreachable.out"
grep -q 'did not evaluate to .true.' "$work/lean-unreachable.out"
sed -i.orig 's|if s.next < s.consumed + w then|if s.next ≤ s.consumed + w then|' "$model"
rejected bash "$scripts/lean-check.sh" "$work/lean" | tee "$work/lean.out"
grep -q "did not evaluate to .true." "$work/lean.out"

# A theorem resting on a declared axiom, with no #print axioms line to show it.
cp "$model.orig" "$model"
printf 'axiom cheat : ∀ n : Nat, n < 3\ntheorem bogus : (10 : Nat) < 3 := cheat 10\n' >> "$model"
rejected bash "$scripts/lean-check.sh" "$work/lean" | tee "$work/lean.out"
grep -qF "AXIOMS 'bogus' depends on axioms: #[cheat]" "$work/lean.out"

# A source touched after its build still passes.
cp "$model.orig" "$model"
bash "$scripts/lean-check.sh" "$work/lean"
touch "$model"
bash "$scripts/lean-check.sh" "$work/lean"

# A second model shares the project under its own namespace. In the first
# model's namespace, its names clash with that model's in the audit.
sed 's|BoundedQueue$|Second|' "$model" > "$work/lean/Model/Second.lean"
bash "$scripts/lean-check.sh" "$work/lean"
cp "$model" "$work/lean/Model/Second.lean"
rejected bash "$scripts/lean-check.sh" "$work/lean" | tee "$work/lean.out"
grep -q "put each model in a namespace of its own" "$work/lean.out"
rm "$work/lean/Model/Second.lean"

# A module on a declared axiom fails the project but not a check limited to
# another file; once its source is deleted, the .olean it left in the build
# directory is not audited.
printf 'axiom ghost : False\ntheorem haunted : (1 : Nat) = 2 := ghost.elim\n' > "$work/lean/Model/Ghost.lean"
rejected bash "$scripts/lean-check.sh" "$work/lean" | tee "$work/lean.out"
grep -qF "AXIOMS 'haunted' depends on axioms: #[ghost]" "$work/lean.out"
bash "$scripts/lean-check.sh" "$work/lean" Model/BoundedQueue.lean
rm "$work/lean/Model/Ghost.lean"
bash "$scripts/lean-check.sh" "$work/lean"

# An unfinished proof in a file that no library owns, named like a built module.
mkdir -p "$work/lean/Scratch/Model"
echo 'theorem unproved : (10 : Nat) < 3 := sorry' > "$work/lean/Scratch/Model/BoundedQueue.lean"
rejected bash "$scripts/lean-check.sh" "$work/lean" | tee "$work/lean.out"
grep -q "unknown module source path .*/Scratch/Model/BoundedQueue.lean" "$work/lean.out"

mkdir -p "$work/frozen/Model"
cp "$examples/lean-template"/{lakefile.toml,lake-manifest.json,lean-toolchain} "$work/frozen/"
cat > "$work/frozen/Model/Frozen.lean" <<'EOF'
namespace Frozen
def step (n : Nat) : Nat := n + 1
theorem property : (n : Nat) → n = n
  | 0 => rfl
  | _ + 1 => rfl
end Frozen
EOF
cp "$work/frozen/Model/Frozen.lean" "$work/frozen/original"
bash "$scripts/lean-check.sh" "$work/frozen" --freeze Model/Frozen.lean
cp "$work/frozen/Model/Frozen.statements" "$work/frozen/first-record.json"
bash "$scripts/lean-check.sh" "$work/frozen" --freeze Model/Frozen.lean
cmp "$work/frozen/first-record.json" "$work/frozen/Model/Frozen.statements"
bash "$scripts/lean-check.sh" "$work/frozen" Model/Frozen.lean

# Replacing an equation proof removes its generated matcher, not its statement.
cat > "$work/frozen/Model/Frozen.lean" <<'EOF'
namespace Frozen
def step (n : Nat) : Nat := n + 1
theorem property : (n : Nat) → n = n := fun _ => rfl
theorem added : True := by trivial
end Frozen
EOF
bash "$scripts/lean-check.sh" "$work/frozen" Model/Frozen.lean
cp "$work/frozen/Model/Frozen.lean" "$work/frozen/proved"

sed 's|: (n : Nat) → n = n := fun _ => rfl|: True := by trivial|' "$work/frozen/proved" > "$work/frozen/Model/Frozen.lean"
rejected bash "$scripts/lean-check.sh" "$work/frozen" Model/Frozen.lean | tee "$work/frozen.out"
grep -q '^FROZEN Frozen.property: statement changed' "$work/frozen.out"
sed 's|n + 1|n + 2|' "$work/frozen/proved" > "$work/frozen/Model/Frozen.lean"
rejected bash "$scripts/lean-check.sh" "$work/frozen" Model/Frozen.lean | tee "$work/frozen.out"
grep -q '^FROZEN Frozen.step: statement changed' "$work/frozen.out"
sed '/^theorem property/d' "$work/frozen/proved" > "$work/frozen/Model/Frozen.lean"
rejected bash "$scripts/lean-check.sh" "$work/frozen" Model/Frozen.lean | tee "$work/frozen.out"
grep -q '^FROZEN Frozen.property: statement changed' "$work/frozen.out"
grep -q '(deleted)' "$work/frozen.out"
printf '\n' > "$work/frozen/Model/Frozen.lean"
rejected bash "$scripts/lean-check.sh" "$work/frozen" Model/Frozen.lean | tee "$work/frozen.out"
grep -q '^FROZEN Frozen.property: statement changed' "$work/frozen.out"
grep -q '^FROZEN Frozen.step: statement changed' "$work/frozen.out"

sed 's|fun _ => rfl|sorry|' "$work/frozen/proved" > "$work/frozen/Model/Frozen.lean"
bash "$scripts/lean-check.sh" "$work/frozen" --freeze Model/Frozen.lean | tee "$work/frozen.out"
if grep -q '^PASS ' "$work/frozen.out"; then
  echo 'FAIL freezing an unfinished proof reported PASS'
  exit 1
fi
rejected bash "$scripts/lean-check.sh" "$work/frozen" Model/Frozen.lean | tee "$work/frozen.out"
grep -q 'sorryAx' "$work/frozen.out"
cp "$work/frozen/proved" "$work/frozen/Model/Frozen.lean"
bash "$scripts/lean-check.sh" "$work/frozen" Model/Frozen.lean
printf 'axiom cheat : False\ntheorem bogus : False := cheat\n' >> "$work/frozen/Model/Frozen.lean"
rejected bash "$scripts/lean-check.sh" "$work/frozen" --freeze Model/Frozen.lean | tee "$work/frozen.out"
grep -q '^AXIOMS ' "$work/frozen.out"

cat > "$work/frozen/Model/Frozen.lean" <<'EOF'
namespace Frozen
private def step (n : Nat) : Nat := n + 1
theorem property : step 1 = 2 := by rfl
end Frozen
EOF
bash "$scripts/lean-check.sh" "$work/frozen" --freeze Model/Frozen.lean
sed -i.orig '/namespace Frozen/a\
private def earlier : Nat := 7
' "$work/frozen/Model/Frozen.lean"
bash "$scripts/lean-check.sh" "$work/frozen" Model/Frozen.lean

cat > "$work/frozen/Model/Frozen.lean" <<'EOF'
namespace Frozen
theorem property : True := by trivial
def property.match_99 : Nat := 1
end Frozen
EOF
bash "$scripts/lean-check.sh" "$work/frozen" --freeze Model/Frozen.lean
sed -i.orig 's|: Nat := 1|: Nat := 2|' "$work/frozen/Model/Frozen.lean"
rejected bash "$scripts/lean-check.sh" "$work/frozen" Model/Frozen.lean | tee "$work/frozen.out"
grep -q '^FROZEN Frozen.property.match_99: statement changed' "$work/frozen.out"
cp "$work/frozen/Model/Frozen.lean.orig" "$work/frozen/Model/Frozen.lean"

printf 'namespace Other\ntheorem property : True := by trivial\nend Other\n' > "$work/frozen/Model/Other.lean"
bash "$scripts/lean-check.sh" "$work/frozen" --freeze
rm "$work/frozen/Model/Other.lean"
rejected bash "$scripts/lean-check.sh" "$work/frozen" | tee "$work/frozen.out"
grep -q '^FROZEN Other.property: statement changed (source deleted)' "$work/frozen.out"
bash "$scripts/lean-check.sh" "$work/frozen" Model/Frozen.lean

bash "$scripts/setup.sh" rust
bash "$scripts/kani-check.sh" "$examples/kani-template"
python3 "$scripts/mutate.py" "$examples/kani-template/src/lib.mutations"
cp -R "$examples/kani-template" "$work/kani"
sed -i.orig 's|state.next < state.consumed + window|state.next <= state.consumed + window|' "$work/kani/src/lib.rs"
rejected bash "$scripts/kani-check.sh" "$work/kani" proofs::claim_keeps_invariant | tee "$work/kani.out"
grep -q '^FAIL proofs::claim_keeps_invariant' "$work/kani.out"
grep -q 'Concrete playback unit test' "$work/kani.out"

echo "ok: all examples pass and detect their mutations; the weakened guards, a hidden axiom, clashing names, an unowned file and a vacuous theorem are rejected"
