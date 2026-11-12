# Rust and Kani brief

Use Kani for a Rust function whose inputs and loops can be bounded. Call the real
function from one `#[kani::proof]` harness per property. Do not transcribe its
implementation. Edit an existing harness in place, and start a new one from
[the bounded queue template](../examples/kani-template/src/lib.rs).

## Files

Work in the target repository. `<skill-dir>` means the absolute path to this
plugin's `skills/formal-verify` directory, not a directory in the target crate.
Own only the assigned harness file and its adjacent `<Name>.mutations` file.
Coordinate any shared crate or module wiring with its owner. Keep production
files untouched unless the user has authorized a production fix.

Cite the production source paths and line numbers that each property models in
the harness header, the functions it calls, and the commit they were read at as
`Source read at <commit>`. List caller constraints, bounds and stub assumptions
there, with source citations or an explicit statement that each is an
assumption. Call the production function through its real crate or module
interface.

## Existing model

The row in your task gives the commits since the harness was last synced and
says whether any of them changed the guarantee on purpose. The harness calls the
production code, so drift shows as a compile error or a failed check. Update its
bounds, stubs, contracts and covers where they no longer fit the code. Change a
property only with that evidence or a specification correction accepted by the
main thread under step 3 of the skill. Add a mutation, with `detects`
naming the harness, for each branch or step the update adds. Update the header
to the code you read.

## Model

Use `kani::any()` for inputs and `kani::assume` for caller constraints. Record
integer widths, input bounds and each assumption beside the harness. If a callee
needs a stub or a function contract, name that assumption in the header comment.
Put `#[kani::unwind(N)]` on every harness, above its real loop bounds. The checker
requires this explicit bound and passes it to Kani. A failed unwinding assertion
means the bound is too low and fails the check.

Add `kani::cover!` witnesses for the boundary or blocking states each property
depends on, such as a full window or an empty queue. The checker rejects
unsatisfiable, unreachable and undetermined covers, even when Kani exits
successfully. Ordinary unreachable assertions are allowed because they describe
impossible panic branches. Every cover must have status `Satisfied`.

## Check

Stay in the target repository and use absolute paths:

```sh
bash <skill-dir>/scripts/kani-check.sh /absolute/path/to/crate
python3 <skill-dir>/scripts/mutate.py /absolute/path/to/crate/src/Name.mutations
```

Append fully qualified harness names to check only those properties. The helper
prints one verdict per harness with the unwind bound and number of checks. It
requires a complete Kani 0.68.0 bundle and Python 3. It checks and invokes the
bundle's driver directly, without invoking the auto-installing Cargo wrapper.
A registered Cargo installer is not required after setup. Relative `KANI_HOME`
paths resolve against the caller's directory before any temporary work begins.
The helper installs no Kani runtime. `UNAVAILABLE` means not checked; follow the
printed installation remedy before making any claim about the code. A compilation
error, missing harness or incomplete verifier report fails.

Put `<Name>.mutations` beside the assigned `<Name>.rs`. Use
`detects <fully-qualified-harness>` for each mutation. The mutation runner uses
the bundled Cargo to find the crate's workspace and local dependencies, copies
them to temporary storage with their relative paths intact, and checks the named harness. A compiler
error never counts as detection. Every discovered harness needs a mutation.

For each fix commit in your row whose fixed code is in the file beside the
mutations file, add a mutation that restores the code before the fix, with the
commit's short hash in its label. The runner edits only that file, so report a
fix in any other file as not replayed.

## Counter-examples

The helper prints failed checks with source locations and Kani's generated
concrete playback test when available. Copy that test into the harness module in
a temporary crate copy. Stay in the target repository and run:

```sh
cargo kani playback --manifest-path /absolute/path/to/temporary-crate/Cargo.toml -Z concrete-playback -- <generated-test-name>
```

A printed test has not yet reproduced the failure. Record whether this command
actually fails on the expected assertion. Kani cannot generate playback for
every failure, including unwinding failures; report that limitation explicitly.
Never disable unwinding checks to obtain a pass.

## Report

Report each property, input bounds, integer widths, unwind bound, assumptions,
cover witnesses, mutation results and source location. Give each fix commit from
the row with the verdict of its mutation, or say it was not replayed. For each
counter-example, include its inputs and reproducing test and say whether shipped
callers can pass those inputs. Use `reproduced`, `reachable at shipped settings` or `model-only`
as appropriate. A pass covers the stated bounded inputs only. Report unavailable
tools as not checked with the remedy, never as a pass or a model failure.
