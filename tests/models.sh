#!/bin/bash
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
# Runs the real TLC, Lean and Kani checkers and the mutation runner on the
# bundled examples, then on broken copies of them that they must reject.
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
# shellcheck source=tests/lib.sh
source "$ROOT/tests/lib.sh"

bash "$scripts/setup.sh" tla
bash "$scripts/setup.sh" lean "$examples/lean-template"

bash "$scripts/tlc-matrix.sh" "$examples/tla-template/BoundedQueue.matrix"
python3 "$scripts/mutate.py" "$examples/tla-template/BoundedQueue.mutations"
bash "$ROOT/tests/tla-mutations.sh"
cp -R "$examples/tla-template" "$work/unreachable"
sed -i.orig 's|next < consumed + Window|next < consumed + Window - 1|' "$work/unreachable/BoundedQueue.tla"
rejected bash "$scripts/tlc-matrix.sh" "$work/unreachable/BoundedQueue.matrix" | tee "$work/unreachable.out"
grep -q '^FAIL BoundedQueue reach WindowFull window=1 items=3 workers=1: the model never reaches this state$' "$work/unreachable.out"
cp -R "$examples/tla-template" "$work/tla"
sed -i.orig 's|next < consumed + Window|next <= consumed + Window|' "$work/tla/BoundedQueue.tla"
rejected bash "$scripts/tlc-matrix.sh" "$work/tla/BoundedQueue.matrix" window=1 | tee "$work/tla.out"
grep -q "Invariant InWindow is violated" "$work/tla.out"
grep -q "^--- state 2: Claim$" "$work/tla.out"

# A mutation that no property detects, and a property that no mutation targets.
cp -R "$examples/tla-template" "$work/tla-missed"
printf 'mutation reorder a sum\ndetects InWindow\n- next < consumed + Window\n+ next < Window + consumed\n' > "$work/tla-missed/BoundedQueue.mutations"
rejected python3 "$scripts/mutate.py" "$work/tla-missed/BoundedQueue.mutations" | tee "$work/tla.out"
grep -q "^MISSED reorder a sum$" "$work/tla.out"
grep -q "^UNCOVERED AllConsumed$" "$work/tla.out"

lean_project "$work/lean"
cp "$examples/lean-template/Model"/BoundedQueue.* "$work/lean/Model/"
bash "$scripts/lean-check.sh" "$work/lean" | tee "$work/vectors.out"
grep -qF "VECTOR w=0 input=0,0 claim=none consume=none" "$work/vectors.out"
grep -qF "VECTOR w=4 input=4,0 claim=none" "$work/vectors.out"
grep -qF "VECTOR w=4 input=3,0 claim=some(4,0)" "$work/vectors.out"
grep -q '^REPLAYED 1 modules through the Lean kernel$' "$work/vectors.out"
grep -q '^WITNESS checked BoundedQueue.claim_keeps_invariant$' "$work/vectors.out"
grep -q '^WITNESS checked BoundedQueue.consume_keeps_invariant$' "$work/vectors.out"
grep -q '^PASS .* kernel replay passed, 2 witnesses checked, 0 absent, 0 unavailable, 1 properties without hypotheses$' "$work/vectors.out"
python3 "$scripts/mutate.py" "$work/lean/Model/BoundedQueue.mutations"
bash "$ROOT/tests/lean-mutations.sh"

# Sets p to a fresh copy of the checked project, build included, so that no
# scenario sees another's edits.
scenario() {
  p=$work/$1
  cp -R "$work/lean" "$p"
}

# This proof uses contradictory hypotheses and is insensitive to the mutations.
scenario lean-vacuous
printf 'theorem vacuous (w : Nat) (s t : BoundedQueue.State) (hs : BoundedQueue.Invariant w s)\n    (hlt : s.next < s.consumed) (h : BoundedQueue.claim w s = some t) : BoundedQueue.Invariant w t := by\n  simp only [BoundedQueue.Invariant] at hs; omega\n' >> "$p/Model/BoundedQueue.lean"
bash "$scripts/lean-check.sh" "$p" --freeze Model/BoundedQueue.lean
rejected python3 "$scripts/mutate.py" "$p/Model/BoundedQueue.mutations" | tee "$work/lean.out"
grep -q "^UNCOVERED theorem vacuous$" "$work/lean.out"
bash "$scripts/lean-check.sh" "$p" | tee "$work/lean.out"
vacuous=$(sed -n 's/^WITNESS absent vacuous: no theorem vacuous.witness states //p' "$work/lean.out")
[ "$vacuous" = '∃ (w : Nat), ∃ (s : BoundedQueue.State), ∃ (t : BoundedQueue.State), BoundedQueue.Invariant w s ∧ s.next < s.consumed ∧ BoundedQueue.claim w s = some t' ]
printf 'private theorem vacuous.witness : %s := sorry\n' "$vacuous" >> "$p/Model/BoundedQueue.lean"
rejected bash "$scripts/lean-check.sh" "$p" | tee "$work/lean.out"
grep -q '1 unfinished proofs (sorry)' "$work/lean.out"
if grep -q '^WITNESS checked vacuous' "$work/lean.out"; then
  echo 'FAIL an unproved witness reported as checked'
  exit 1
fi

scenario lean-witness
cat > "$p/Model/Witness.lean" <<'EOF'
namespace Witness.Nested
theorem bounded (n m : Nat) (h : n < 3) (hm : m = n + 1) : m < 4 := by omega
private theorem bounded.witness : ∃ n m, n < 3 ∧ m = n + 1 := ⟨0, 1, by decide, rfl⟩
theorem narrow (x : UInt32) (h : x < 100) : x < 200 := Nat.lt_trans h (by decide)
theorem empty (n : Nat) (h : n < 0) : n = 7 := absurd h (Nat.not_lt_zero n)
axiom empty.witness : ∃ n : Nat, n < 0
theorem indexed (xs : Array Nat) (i : Nat) (h : i < xs.size) (hz : xs[i] = 0) : xs[i] + 1 = 1 := by omega
end Witness.Nested
EOF
bash "$scripts/lean-check.sh" "$p" Model/Witness.lean | tee "$work/lean.out"
grep -q '^WITNESS checked Witness.Nested.bounded$' "$work/lean.out"
grep -q '^WITNESS absent Witness.Nested.empty: ' "$work/lean.out"
grep -q '^WITNESS unavailable Witness.Nested.indexed: the type of hz uses the proof of a hypothesis$' "$work/lean.out"
narrow=$(sed -n 's/^WITNESS absent Witness.Nested.narrow: no theorem Witness.Nested.narrow.witness states //p' "$work/lean.out")
[ "$narrow" = '∃ (x : UInt32), x < 100' ]
printf 'private theorem Witness.Nested.narrow.witness : %s := ⟨0, by decide⟩\n' "$narrow" >> "$p/Model/Witness.lean"
bash "$scripts/lean-check.sh" "$p" Model/Witness.lean | tee "$work/lean.out"
grep -q '^WITNESS checked Witness.Nested.narrow$' "$work/lean.out"
sed -i.orig 's|∃ n m, n < 3 ∧|∃ n m, n < 5 ∧|' "$p/Model/Witness.lean"
rejected bash "$scripts/lean-check.sh" "$p" Model/Witness.lean | tee "$work/lean.out"
grep -qF 'WITNESS failed Witness.Nested.bounded: Witness.Nested.bounded.witness must state ∃ (n : Nat), ∃ (m : Nat), n < 3 ∧ m = n + 1' "$work/lean.out"

scenario lean-unreachable
sed -i.orig 's|if s.next < s.consumed + w then|if s.next < s.consumed + w - 1 then|' "$p/Model/BoundedQueue.lean"
rejected bash "$scripts/lean-check.sh" "$p" | tee "$work/lean.out"
grep -q 'did not evaluate to .true.' "$work/lean.out"

scenario lean-past-window
sed -i.orig 's|if s.next < s.consumed + w then|if s.next ≤ s.consumed + w then|' "$p/Model/BoundedQueue.lean"
rejected bash "$scripts/lean-check.sh" "$p" | tee "$work/lean.out"
grep -q 'did not evaluate to .true.' "$work/lean.out"

# A theorem resting on a declared axiom, with no #print axioms line to show it.
scenario lean-axiom
printf 'axiom cheat : ∀ n : Nat, n < 3\ntheorem bogus : (10 : Nat) < 3 := cheat 10\n' >> "$p/Model/BoundedQueue.lean"
rejected bash "$scripts/lean-check.sh" "$p" | tee "$work/lean.out"
grep -qF "AXIOMS 'bogus' depends on axioms: #[cheat]" "$work/lean.out"

# A theorem that a command adds to the environment without a kernel check
# builds and rests on no axiom; only the replay rejects it, also when the check
# names only a module that imports it.
scenario lean-unchecked
cat > "$p/Model/Unchecked.lean" <<'EOF'
import Lean
namespace Unchecked
open Lean Elab Command in
set_option debug.skipKernelTC true in
run_cmd liftCoreM do
  let value : TheoremVal := { name := `Unchecked.unsound, levelParams := [], type := mkConst ``False, value := mkConst ``True.intro }
  addDecl (.thmDecl value)
end Unchecked
EOF
printf 'import Model.Unchecked\nnamespace Uses\ntheorem uses : False := Unchecked.unsound\nend Uses\n' > "$p/Model/Uses.lean"
for files in "" Model/Uses.lean; do
  rejected bash "$scripts/lean-check.sh" "$p" ${files:+"$files"} | tee "$work/lean.out"
  grep -q '^FAIL .*: kernel replay rejected a built module$' "$work/lean.out"
  grep -q '^leanchecker found a problem in Model.Unchecked$' "$work/lean.out"
  if grep -q 'lake exit' "$work/lean.out"; then
    echo 'FAIL the unchecked theorem failed the build, not the kernel replay'
    exit 1
  fi
done

# A selected parent module must not pull a deleted child's cached object into replay.
scenario lean-deleted-replay
mkdir -p "$p/Model/Parent"
printf 'theorem parent : True := True.intro\n' > "$p/Model/Parent.lean"
cp "$work/lean-unchecked/Model/Unchecked.lean" "$p/Model/Parent/Ghost.lean"
elan run "$(cat "$p/lean-toolchain")" lake --dir "$p" build +Model.Parent.Ghost
rm "$p/Model/Parent/Ghost.lean"
for files in "" Model/Parent.lean; do
  bash "$scripts/lean-check.sh" "$p" ${files:+"$files"} | tee "$work/lean.out"
  count=1
  [ -n "$files" ] || count=2
  grep -q "^REPLAYED $count modules through the Lean kernel$" "$work/lean.out"
done

# Lake owns both the source-to-module mapping and the library output directory.
scenario lean-layout
{ printf 'buildDir = "custom build"\nleanLibDir = "objects"\n'; cat "$work/lean/lakefile.toml"; } > "$p/lakefile.toml"
printf 'theorem layout_dependency : True := trivial\n' > "$p/Model/Dependency.lean"
printf 'import Model.Dependency\ntheorem layout_ok : True := layout_dependency\n' > "$p/Model/Uses.lean"
bash "$scripts/lean-check.sh" "$p" Model/Uses.lean | tee "$work/layout.out"
grep -q '^REPLAYED 2 modules through the Lean kernel$' "$work/layout.out"
grep -q '^PASS ' "$work/layout.out"

# A source touched after its build still passes.
scenario lean-touched
bash "$scripts/lean-check.sh" "$p"
touch "$p/Model/BoundedQueue.lean"
bash "$scripts/lean-check.sh" "$p"

# A second model shares the project under its own namespace. In the first
# model's namespace, its names clash with that model's in the audit.
scenario lean-second
sed 's|BoundedQueue$|Second|' "$p/Model/BoundedQueue.lean" > "$p/Model/Second.lean"
bash "$scripts/lean-check.sh" "$p"
cp "$p/Model/BoundedQueue.lean" "$p/Model/Second.lean"
rejected bash "$scripts/lean-check.sh" "$p" | tee "$work/lean.out"
grep -q "put each model in a namespace of its own" "$work/lean.out"

# A module on a declared axiom fails the project but not a check limited to
# another file; once its source is deleted, the .olean it left in the build
# directory is not audited.
scenario lean-ghost
printf 'axiom ghost : False\ntheorem haunted : (1 : Nat) = 2 := ghost.elim\n' > "$p/Model/Ghost.lean"
rejected bash "$scripts/lean-check.sh" "$p" | tee "$work/lean.out"
grep -qF "AXIOMS 'haunted' depends on axioms: #[ghost]" "$work/lean.out"
bash "$scripts/lean-check.sh" "$p" Model/BoundedQueue.lean
rm "$p/Model/Ghost.lean"
bash "$scripts/lean-check.sh" "$p"

# Only the project's own lakefile is configuration. The library can own a module with that name.
scenario lean-nested-lakefile
echo 'theorem unfinished : False := by trivial' > "$p/Model/lakefile.lean"
rejected bash "$scripts/lean-check.sh" "$p" | tee "$work/lean.out"
grep -q 'Model/lakefile.lean:1:' "$work/lean.out"

# An unfinished proof in a file that no library owns, named like a built module.
scenario lean-unowned
mkdir -p "$p/Scratch/Model"
echo 'theorem unproved : (10 : Nat) < 3 := sorry' > "$p/Scratch/Model/BoundedQueue.lean"
rejected bash "$scripts/lean-check.sh" "$p" | tee "$work/lean.out"
grep -q "unknown module source path .*/Scratch/Model/BoundedQueue.lean" "$work/lean.out"

lean_project "$work/frozen"
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
# Freezing reports the record, not a proof.
grep -q '^FROZEN .*/Frozen.statements: statements recorded; proofs not checked$' "$work/frozen.out"
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

lean_project "$work/frozen-opaque"
cat > "$work/frozen-opaque/Model/Frozen.lean" <<'EOF'
namespace Frozen
opaque step : Nat := 1
theorem property : step = step := rfl
end Frozen
EOF
bash "$scripts/lean-check.sh" "$work/frozen-opaque" --freeze Model/Frozen.lean
bash "$scripts/lean-check.sh" "$work/frozen-opaque" Model/Frozen.lean
sed -i.orig 's|: Nat := 1|: Nat := 2|' "$work/frozen-opaque/Model/Frozen.lean"
rejected bash "$scripts/lean-check.sh" "$work/frozen-opaque" Model/Frozen.lean | tee "$work/frozen-opaque.out"
grep -q '^FROZEN Frozen.step: statement changed' "$work/frozen-opaque.out"
grep -q '^  definition value changed' "$work/frozen-opaque.out"
bash "$scripts/lean-check.sh" "$work/frozen-opaque" --freeze Model/Frozen.lean
bash "$scripts/lean-check.sh" "$work/frozen-opaque" Model/Frozen.lean

# Lean generates equation lemmas, induction principles and the equations of a
# private definition's matcher only when a proof uses them, so a proof edit can
# remove them. A recursive body sits in an auxiliary: _f for structural
# recursion, _unary or _mutual for well-founded recursion, _unsafe_rec for the
# code that runs, which a noncomputable definition lacks. Each edit below names
# the declaration that must report it; isOdd's body sits in isEven._mutual.
lean_project "$work/frozen-recursive"
cat > "$work/frozen-recursive/original" <<'EOF'
namespace Frozen
noncomputable def halve (a b : Nat) : Nat := if a < 2 then b else halve (a - 2) (b + 1)
termination_by a
decreasing_by omega
partial def countDown (n : Nat) : Nat := if n = 0 then 0 else countDown (n - 1) + 1
mutual
noncomputable def isEven (n : Nat) : Bool := if n = 0 then true else isOdd (n - 1)
termination_by n
noncomputable def isOdd (n : Nat) : Bool := if n = 0 then false else isEven (n - 1)
termination_by n
end
def double : Nat → Nat
  | 0 => 0
  | n + 1 => double n + 2
private def steps : Nat → Nat
  | 0 => 0
  | 1 => 1
  | n + 2 => steps n + 1
noncomputable def triple : Nat → Nat
  | 0 => 0
  | n + 1 => triple n + 3
theorem halve_small : halve 1 5 = 5 := by simp [halve]
theorem double_eq (n : Nat) : double n = 2 * n := by
  induction n using double.induct <;> simp [double, *] <;> omega
theorem steps_two : steps 2 = 1 := by simp [steps]
end Frozen
EOF
cp "$work/frozen-recursive/original" "$work/frozen-recursive/Model/Frozen.lean"
bash "$scripts/lean-check.sh" "$work/frozen-recursive" --freeze Model/Frozen.lean
sed -e 's|^decreasing_by omega$|decreasing_by all_goals omega|' -e 's|induction n using double.induct <;>|induction n <;>|' \
  -e 's|:= by simp \[steps\]|:= rfl|' "$work/frozen-recursive/original" > "$work/frozen-recursive/Model/Frozen.lean"
bash "$scripts/lean-check.sh" "$work/frozen-recursive" Model/Frozen.lean
for edit in 'halve s|(b + 1)|(b + 2)|' 'countDown s|countDown (n - 1) + 1|countDown (n - 1) + 2|' 'isEven s|then false|then true|' \
  'triple s|triple n + 3|triple n + 4|'; do
  sed "${edit#* }" "$work/frozen-recursive/original" > "$work/frozen-recursive/Model/Frozen.lean"
  rejected bash "$scripts/lean-check.sh" "$work/frozen-recursive" Model/Frozen.lean | tee "$work/frozen-recursive.out"
  grep -q "^FROZEN Frozen.${edit%% *}: statement changed" "$work/frozen-recursive.out"
done

bash "$scripts/setup.sh" rust
bash "$scripts/kani-check.sh" "$examples/kani-template"
python3 "$scripts/mutate.py" "$examples/kani-template/src/lib.mutations"
cp -R "$examples/kani-template" "$work/kani"
sed -i.orig 's|state.next < state.consumed + window|state.next <= state.consumed + window|' "$work/kani/src/lib.rs"
rejected bash "$scripts/kani-check.sh" "$work/kani" proofs::claim_keeps_invariant | tee "$work/kani.out"
grep -q '^FAIL proofs::claim_keeps_invariant' "$work/kani.out"
grep -q 'Concrete playback unit test' "$work/kani.out"
bash "$ROOT/tests/rust-mutations.sh"
python3 "$ROOT/tests/baseline-models.py"

echo "ok: the examples pass and detect their mutations, and every broken copy is rejected"
