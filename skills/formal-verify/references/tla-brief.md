# TLA+ modelling brief

Follow this brief to model one thread protocol with TLA+ and TLC. Your task gives the source files and line ranges, the threads and shared variables, the model's `<Name>`, the absolute path `<skill-dir>` and any `JAVA` setting. Read the whole of each source file so the model follows the code.

## Files

Write `tla/<Name>.tla`, `tla/<Name>.matrix` and `tla/<Name>.mutations` in the target repository, or the same names in its existing model directory. Start a new model from the three `BoundedQueue` files in `<skill-dir>/examples/tla-template/`, and edit an existing model's files in place. Write no other file, so parallel agents share none. Name the top-level formula `Spec`. The header comment names the source files and line ranges the spec follows, the functions and shared variables it covers, the commit they were read at as `Source read at <commit>`, and each assumption it makes.

## Existing model

The row in your task gives the commits since the model was last synced and says whether any of them changed the guarantee on purpose. Change the spec where it no longer describes the code. Change a property only where the row cites that evidence. Add a mutation for each step, branch or wait the update adds, naming the property that must fail on it. Update the header to the code you read.

## Model

Apply each requirement that fits the protocol, and say in the report which did not.

- Use one step per critical section under the mutex and one per unlocked phase, such as build, parse or consume. Add an explicit `lock` variable when multiple lock acquisitions can race.
- Use a program counter per thread. Represent a condition-variable wait as a pc value in the wait set. Only a broadcast, signal or spurious wakeup can leave that set. The woken thread must retake the mutex and reread the state before acting. Give spurious wakeups no fairness requirement. In this encoding, a lost wakeup appears as a liveness violation rather than a TLC deadlock. Explain that in the header and check liveness.
- Model resource ownership as a variable. Each slot or buffer must be free, in exactly one queue, or held by exactly one thread. Each produced item must be recorded by the consumer, awaiting hand-over, or freed.
- When `longjmp`, an exception, a panic or `exit()` can leave a critical section without unlocking, use separate variables for the mutex's actual owner and the lock ownership recorded in the thread's live frames. An unwind can leave these inconsistent and block later acquisitions. Preserve that state so the model can detect the hang. List every allocation and exit call that can run under each lock, including out-of-memory exits.
- Let the consumer call `next` any number of times, stop calling, or call `close` from any idle point. Include close before the first call, after the last item and after an error. When the producer has a failure path, let it fail at any item through a constant set `FailAt`.
- Check small instances and boundary cases. Use slot counts of 1, 2 and the shipped count, item counts of 0, 1, 3 and 5, and one, two and three workers.
- Name a reachable state predicate for each blocking or boundary behaviour the properties depend on, such as a full window, an empty queue, a parked waiter or an injected failure. Add `reach <Operator> | <label-substring>` to its matrix section. It selects the first run whose label contains the substring. A command-line filter skips the reach check if it excludes that selected run.
- Check `TypeOK`, the ownership partition, delivery order, no delivery after end or error, the documented error-ordering guarantee, and no double free or leak at `closed`. For liveness, check that each blocking call returns, `close` terminates from every allowed calling state, and a run without `close` reaches the end. Require weak fairness on thread steps except consumer choices and spurious wakeups. Add strong fairness on a mutex acquisition only when a counter-example shows pure starvation by a spuriously waking peer. Name that assumption in the spec.

## Keep the spec small

Write each fact once.

- Group the variables that one thread owns and name the group. An action then lists the groups it leaves alone, not every variable:

  ```tla
  worker == <<wpc, box>>
  consumer == <<pc, display>>
  vars == <<worker, consumer, done>>
  Notify == /\ wpc = "notify" /\ wpc' = "exit" /\ done' = TRUE
            /\ UNCHANGED <<box, consumer>>
  ```

- Define a guard or expression that two actions or properties share as one operator.
- Keep mutations in the mutations file. The spec has no `Mutation` constant and no branch for a planted bug. When one replacement restores the behaviour before a fix, list it as a mutation instead of adding a constant that switches the fix off.

## Check

Stay in the target repository and pass absolute paths:

```shell
bash <skill-dir>/scripts/tlc-matrix.sh <absolute-path>/tla/<Name>.matrix
python3 <skill-dir>/scripts/mutate.py <absolute-path>/tla/<Name>.mutations
```

The matrix runner prints PASS or FAIL per run and a SUMMARY line. A failing run prints its error trace, reduced to the variables each step changed.

Each reach check prints its own PASS with the shortest witness length in states and transitions, or FAIL when the model never reaches the state. Reach searches use one worker and ignore deadlock so they can finish exploring a stopped model. The SUMMARY counts reach checks separately; its state total covers ordinary runs only. Use `detects reach:<Operator>` for a mutation that removes a required state. Reach checks do not count as properties for mutation coverage.

Before reporting a pass, list mutations that represent plausible code bugs in the mutations file. Try replacing `while` with `if`, removing a broadcast, replacing FIFO order with stack order, leaving a flag set, or taking an item without removing it. Each mutation names the one property that must fail on it. The mutation runner applies each to a copy of the spec. Revise a property it reports as UNCOVERED, and the property or the mutation behind each MISSED line.

## Report

Report only after reading the output of both commands. If either exits 3 with `UNAVAILABLE`, report "not checked" with the printed remedy; do not claim a pass or a model failure. Give:

- the file paths, both commands and their SUMMARY lines;
- each reach predicate, its selected run and witness length;
- each FAIL line, with every step of its trace mapped to a code event and `file:line`;
- for each counter-example, whether the shipped constants and callers can reach it;
- the real-code constraints the model lacks and the properties it could not express.
