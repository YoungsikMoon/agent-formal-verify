-- Copyright (c) 2026 Michael Denyer
-- SPDX-License-Identifier: GPL-3.0-only
/-!
This model checks the counters of a bounded queue with ordered output.
`next` counts claimed items, `consumed` counts consumed items, and at most
`w` items may be in flight. To adapt it:

1. Replace this description with the source files and line ranges the model
   follows, the functions it covers, the commit they were read at as
   `Source read at <commit>`, and each assumption it makes.
2. Transcribe the state and steps from the code with the same arithmetic.
3. State the invariant as a `Prop` with a `Decidable` instance.
4. Run `#eval badPairs` to find states where a step violates the invariant
   within the chosen bound, and keep the `#guard` that fails the build on one.
5. Prove the invariant for every size by cases on the step.

Name any unfinished proof that uses `sorry`. `lean-check.sh` fails on it, on
any declaration that rests on a declared axiom, and on a `.lean` file that no
library in the lakefile owns.

Each model is one file under `Model/` in a namespace named after it, so the
models of a repository share one Lake project and their names do not clash.
`BoundedQueue.mutations` lists the bugs this model must detect.
-/

namespace BoundedQueue

structure State where
  next : Nat
  consumed : Nat
deriving Repr, DecidableEq

def Invariant (w : Nat) (s : State) : Prop := s.consumed ≤ s.next ∧ s.next ≤ s.consumed + w

instance (w : Nat) (s : State) : Decidable (Invariant w s) := by unfold Invariant; infer_instance

/-- The state before any item is claimed. -/
def init : State := ⟨0, 0⟩

/-- Return the next state, or `none` when the guard fails. -/
def claim (w : Nat) (s : State) : Option State :=
  if s.next < s.consumed + w then some { s with next := s.next + 1 } else none

def consume (s : State) : Option State :=
  if s.consumed < s.next then some { s with consumed := s.consumed + 1 } else none

/-- Find counter-examples where one step breaks the invariant. Both counters
in the initial state are at most `n`; results contain `(before, after)` pairs. -/
def badPairs (w n : Nat) : List (State × State) :=
  (List.range (n + 1)).flatMap fun a =>
    (List.range (n + 1)).flatMap fun b =>
      let s : State := ⟨a, b⟩
      if Invariant w s then
        [claim w s, consume s].filterMap fun t =>
          match t with
          | some t' => if Invariant w t' then none else some (s, t')
          | none => none
      else []

-- `#eval badPairs 2 6` prints the counter-examples; `#guard` fails the build while any exist.
#eval badPairs 2 6   -- []
#guard (badPairs 2 6).isEmpty

def reachable (w : Nat) : Nat → List State
  | 0 => [init]
  | steps + 1 =>
    let states := reachable w steps
    states ++ states.flatMap fun s => [claim w s, consume s].filterMap id

#guard (reachable 2 6).any fun s => s.next == s.consumed + 2

theorem invariant_init (w : Nat) : Invariant w init := by
  simp [Invariant, init]

theorem claim_keeps_invariant (w : Nat) (s t : State) (hs : Invariant w s) (h : claim w s = some t) :
    Invariant w t := by
  unfold claim at h
  split at h
  · cases h
    simp only [Invariant] at *
    omega
  · cases h

theorem consume_keeps_invariant (w : Nat) (s t : State) (hs : Invariant w s) (h : consume s = some t) :
    Invariant w t := by
  unfold consume at h
  split at h
  · cases h
    simp only [Invariant] at *
    omega
  · cases h

def vectors : List (Nat × State) :=
  [(0, ⟨0, 0⟩), (1, ⟨0, 0⟩), (1, ⟨1, 0⟩), (1, ⟨1, 1⟩),
   (4, ⟨0, 0⟩), (4, ⟨3, 0⟩), (4, ⟨4, 0⟩), (4, ⟨5, 1⟩), (4, ⟨5, 5⟩)]

#eval do
  for (w, s) in vectors do
    let output := fun (t : Option State) => match t with
      | none => "none"
      | some t => s!"some({t.next},{t.consumed})"
    IO.println s!"VECTOR w={w} input={s.next},{s.consumed} claim={output (claim w s)} consume={output (consume s)}"

end BoundedQueue
