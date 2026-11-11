# Property review brief

Follow this brief to review one model's properties against the code it describes. A property can pass every check and still promise less than the code's callers rely on, so this review reads the properties, not the proofs. Your task gives the target's row, the source files with their line ranges, the model's files and the absolute path `<skill-dir>`. You did not write the model, and you do not get the report of the agent that did. Write no files.

## Read

Read each source file in full, then the model:

- for TLA+, the spec's properties, its fairness conditions and the `check` lines of its matrix;
- for Lean, the public theorems with their hypotheses and the definitions they mention;
- for Kani, each harness's `kani::assume` calls, assertions and `kani::cover!` witnesses.

Read the assumptions in the model's header and the fix commits in the row.

## Questions

Ask each of these about every property:

1. Does a caller of this code rely on a guarantee that no property states? Name the guarantee and the function.
2. Does an assumption, hypothesis, `kani::assume` or fairness condition exclude inputs or schedules that shipped callers produce? Cite the caller's `file:line`.
3. Would a plausible bug still pass, such as an off-by-one at a boundary, a lost wakeup, a double free, results in the wrong order, or a fix commit from the row undone?
4. Does the model leave out a branch, error path or step that the code has? Name the code line.

## Proposed mutations

Write each finding that a bug in the model can show as a mutation, in the syntax that `<skill-dir>/scripts/mutate.py` documents at its top:

```text
mutation <what goes wrong, in the code's terms>
detects <property or fully qualified harness, for TLA+ and Kani only>
- <a line of the model file, quoted exactly; together the lines occur once>
+ <the line with the bug>
```

A mutation edits only the model file beside the mutations file. For a Kani harness kept apart from the production code, a bug in the code cannot be written this way; report it as an open finding.

## Report

Give:

- each proposed mutation, with the question it answers and the source `file:line` it rests on;
- each finding that no mutation can express, such as a guarantee that no property states or a code path the model leaves out, with its source `file:line`;
- "no findings" when there are none.

Do not restate the model, grade it or propose rewrites of its proofs.
