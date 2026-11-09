---- MODULE BoundedQueue ----
(* Copyright (c) 2026 Michael Denyer
   SPDX-License-Identifier: GPL-3.0-only

   The counters of a bounded queue with ordered output: `next` counts claimed
   items, `consumed` counts consumed items, and at most `Window` items may be
   in flight. It is the same model as ../lean-template/Model/BoundedQueue.lean.
   TLC checks it for the instances in BoundedQueue.matrix; Lean proves it for
   every size. BoundedQueue.mutations lists the bugs its properties must detect.

   To adapt it, replace the header with the source files and line ranges the
   model follows, the functions and shared variables it covers, and the commit
   they were read at as `Source read at <commit>`. Give each thread a program
   counter, and keep the top-level formula named Spec, which tlc-matrix.sh
   checks. *)
EXTENDS Naturals

CONSTANTS Window, Items
VARIABLES next, consumed
vars == <<next, consumed>>

Init == next = 0 /\ consumed = 0

Claim == /\ next < Items
         /\ next < consumed + Window
         /\ next' = next + 1
         /\ UNCHANGED consumed

Consume == /\ consumed < next
           /\ consumed' = consumed + 1
           /\ UNCHANGED next

\* Stutter at the end so that termination is not reported as a deadlock.
Done == consumed = Items /\ UNCHANGED vars

Next == Claim \/ Consume \/ Done

Spec == Init /\ [][Next]_vars /\ WF_vars(Claim) /\ WF_vars(Consume)

TypeOK == next \in 0..Items /\ consumed \in 0..Items
InWindow == consumed <= next /\ next <= consumed + Window
WindowFull == next = consumed + Window
AllConsumed == <>(consumed = Items)
====
