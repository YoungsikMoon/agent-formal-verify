# Evidence meanings

Include the matching meaning from this table where each kind of evidence first appears in a reply, pull request or document:

| Evidence | Meaning to give |
| --- | --- |
| TLC passes | TLC tried every ordering of the modelled steps at the listed small sizes and found none that breaks the property. The SUMMARY line's state total is the size of that search, not a count of real runs. |
| Kani passes | Kani checked every input within the stated bounds and found no violation. Larger inputs are not covered. |
| Lean passes | Lean proved the property for every input, under the listed assumptions. |
| Kernel replay passed | Lean's kernel checked every declaration of the built modules a second time, including any that a command added without a check. `unavailable` means the pinned Lean has no `leanchecker`, so this second check did not run. |
| Witness checked | A Lean proof shows that some concrete values satisfy all of a property's hypotheses at once, so the property is not true merely because nothing meets its conditions. `absent` and `unavailable` mean this was not checked. |
| A bounded search passes | Every input up to the stated bound was tried. |
| Mutations detected | Deliberate bugs were planted in copies of the model, and the checks caught each one. For Lean, this shows that existing proofs fail, not that the mutated statements are false. |
| Past fix detected | The checks fail on the behaviour before a recorded bug fix. For Lean, report proof sensitivity separately from whether a checked counterexample establishes that the property rules out that bug. |
| Specification unchanged | The baseline comparison preserved each recorded run's inputs and checks, reach check's selected inputs, property and fairness definition, action subscript such as `vars`, statement record, qualified Kani harness name with its `should_panic` and `unwind` attributes and the `cfg` attributes that can switch it off on each route the record reads, and function-owned assumption, cover and stub. It does not cover a Kani harness's assertions, input construction, the conditions around its assertions, calls to assumption helpers or the `cfg` attributes on a route that its record value lists under `unread(...)`; `git diff` does. |
| UNAVAILABLE | The tool could not run. This target was not checked; give the printed remedy. |
| reproduced | A deterministic test or race-detector run fails on the production code. |
| reachable at shipped settings | The shipped constants and callers permit the counter-example, but no production reproduction has confirmed it yet. |
| model-only | The counter-example needs a configuration or caller the shipped code does not use. |
| Counter-example | A step-by-step schedule or an input that breaks the property. |
