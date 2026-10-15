# Lean modelling brief

Follow this brief to prove one sequential or arithmetic property with Lean 4. Your task gives the source files and line ranges, the functions with their integer types, the property, the model's `<Name>`, the absolute path of the Lake project and the absolute path `<skill-dir>`.

## Files

Write `Model/<Name>.lean`, `Model/<Name>.mutations` and `Model/<Name>.statements` in the Lake project. Start from the `BoundedQueue` files in `<skill-dir>/examples/lean-template/Model/`. Write no other file, so parallel agents share none. Put every declaration in `namespace <Name>`: the checker audits the project's modules together, and equal names clash. The header comment names the source files and line ranges the model follows and each assumption it makes.

Every `.lean` file in the project must belong to a library in the lakefile. With the template's lakefile, that is every file under `Model/`. Add Mathlib only when the arithmetic needs it, since its dependencies can increase setup and build time.

## Model

1. Transcribe the state type and functions with the code's integer widths, rounding, division and order of operations. Use `UInt32` or `Int` with explicit bounds where appropriate, and `Nat` only when values cannot go negative. Keep the source function names and cite `file:line` in doc comments. Preserve any bug during transcription so the model checks the code as written.
2. State the property as a `Prop` with a `Decidable` instance. It may describe an invariant, an encoder round trip, an index bound or states the machine must never reach.
3. Write every theorem statement with `sorry` for its proof, then freeze the model with `bash <skill-dir>/scripts/lean-check.sh <absolute-project-path> --freeze Model/<Name>.lean`. This records types and definition bodies even while proofs are unfinished. The FROZEN line confirms the record, not a proof. Added axioms still fail.
4. Write and evaluate a bounded exhaustive check before proving the theorem. The template's `badPairs` finds states where one step breaks the invariant; `#eval badPairs 2 6` prints concrete counter-examples and `#guard` fails the build while any exist. Set the bound above the code's slot count, batch size, window and other constants so it includes boundary cases. Add a `#guard` that a bounded search from the initial state reaches the states the property depends on. The template's `reachable` search requires a full window.
5. Prove one theorem per step or function for every size. Split on the guards, use `simp only [...]` to expose arithmetic, then use `omega` or `decide` for a finite type. If a proof needs a fact about the real code that the model lacks, state it as a theorem hypothesis and name it in a comment. Do not declare it as an `axiom`. An unfinished proof may use `sorry`, but the Lean checker reports it as a failure. The checker also fails every declaration that rests on an axiom beyond `propext`, `Classical.choice` and `Quot.sound`, which also rules out `native_decide`.

After a proof closes, print differential test vectors with `#eval`. Include boundary inputs and a spread of in-range inputs, with each input and the model's output on one line. Write a test in the target repository's own framework that calls the production function on those inputs and compares its output. A mismatch is a bug in the production code or the transcription; establish which before reporting. State how many vectors agree and the integer widths in both implementations. If the production comparison was not run, say so beside the proof verdict.

When a theorem needs a proof beyond bounded search and the host offers Lean language-server tools for goals and diagnostics, use them to shorten the loop. This plugin neither requires nor configures such a server.

## Keep the model small

Write each fact once.

- Define the bounded inputs once and filter that list for each property, instead of a new nested loop per property.
- When two proofs share steps, prove the shared fact as one lemma and use it in both.
- Keep mutations in the mutations file. The model has no flag or second definition for a planted bug.

## Check

Stay in the target repository and pass absolute paths:

```shell
bash <skill-dir>/scripts/lean-check.sh <absolute-project-path> Model/<Name>.lean
python3 <skill-dir>/scripts/mutate.py <absolute-project-path>/Model/<Name>.mutations
```

The checker enforces the `.statements` file beside each checked source. Changing a theorem type, a definition type or body, or deleting a frozen declaration fails with its name. Adding lemmas and definitions and changing proofs is allowed. Re-freeze only after the production code changes, after a production test contradicts the transcription, or after reviewing a toolchain bump, and explain why in the report. Records are specific to the pinned Lean toolchain. Fingerprints use structural expressions, including the module identity of private references. If two private declarations share a name in one model, give them distinct names before freezing. A project-wide check also rejects records whose source files were deleted. Named-file checks remain limited to those files. A model without a record retains the usual proof and axiom checks, so keep the records under version control. Deleting a record removes that protection.

The file name limits the Lean checker to your model, so another agent's unfinished file does not fail your check.

List plausible bugs in the mutations file, such as `<` instead of `≤`, a missing `+ 1` or a swapped argument. The mutation runner checks each on a copy of the file and names the theorems and `#guard` lines that fail. Expect both the bounded search's `#guard` and the theorem. It rejects a mutation that stops a definition compiling. Revise the properties behind each MISSED line.

Check the reach guard as well as the absence of bad pairs. A search that cannot reach a boundary state does not establish the intended coverage.

## Report

Report only after reading the output of both commands. If either exits 3 with `UNAVAILABLE`, report "not checked" with the printed remedy; do not claim a pass or a model failure. Give:

- the file paths, both commands, the checker's PASS or FAIL line and the mutation runner's output;
- the states required by the reach guard and the search bound;
- for each counter-example, concrete inputs to the code's function, the source line of the failing arithmetic, a unit test with those inputs and whether it fails on the production code, whether shipped callers can pass those inputs, and the proposed fix;
- the `.statements` path and any reason for re-freezing;
- for a closed proof, its assumptions, including integer widths, bounds and each theorem hypothesis;
- the number of differential vectors on which the model and production code agree, their integer widths, or an explicit statement that the comparison was not run.
