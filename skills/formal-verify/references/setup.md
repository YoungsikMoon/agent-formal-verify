# Tool setup

Run `/agent-formal-verify:setup` once to prepare Java, Python, TLC, elan, Lean, Rust and Kani. In Codex, request this plugin's `setup` skill. The [setup skill](../../setup/SKILL.md) prepares all three verification tools independently of any repository and reuses existing runtimes and caches.

The formal-verify skill selects tools from the current repository on every invocation. It reuses prepared tools and installs a missing Lean toolchain through the setup helper when a Lean pin changes. Repository changes do not require the user to rerun the full setup.

## Running the helpers

The helpers are in the `scripts/` directory of the installed `formal-verify` skill, including a copied skills-only installation. `<skill-dir>` below stands for that skill's absolute path.

Stay in the target repository and run each helper with `bash` and its absolute path. Pass absolute paths to model projects and matrices. Keep the installed skill files read-only, and create models and build outputs in the target repository. Shared tool caches can serve several repositories; each repository determines its own tool requirements and Lean pins.

Every runner writes its temporary state into `TMPDIR` (failing cleanly with `FAIL` if an explicitly set `TMPDIR` cannot be created or written) and removes its working directories between matrix runs and on `SIGINT`, `SIGTERM` or `SIGHUP`. `setup.sh tla`, `setup.sh rust` and `setup.sh lean` stop their readiness check on these signals too, including one sent to the `setup.sh` process alone, and end by the signal. Lean builds write into the model project's `.lake` directory, while `lean-check.sh` places its module lists for the audit and the kernel replay in `TMPDIR`. `setup.sh` (`tla`, `rust`, `lean`, and `storage`) reports `TEMP_DIR` free space, and `SYSTEM_DISK` free space when the temporary directory is on another device. It warns when the active temporary volume, or the system disk while it holds the temporary directory, has less than `FORMAL_MIN_FREE_GIB` free (default `64` GiB). It also lists larger writable `EXTERNAL_VOLUME` mounts so heavy runs can redirect `TMPDIR` onto an external disk. `bash <skill-dir>/scripts/setup.sh storage` runs this storage check alone. Checkers also warn once on `stderr` before starting when active temporary space drops below `10` GiB (or `FORMAL_MIN_FREE_GIB` when set).

To stop a checker, a runner suspends the checker and every process it started, then sends them `SIGTERM` and resumes them, so none can start another process meanwhile. This takes a few `ps` calls, a few tens of milliseconds on an idle machine and longer under load. A runner ended in that time by a signal it does not handle, such as `SIGKILL` or `SIGQUIT`, cannot resume them. The checker and the processes suspended so far then stay suspended until something ends them, and the processes it started that were not yet suspended keep running. `SIGINT`, `SIGTERM` and `SIGHUP` do not cause this, because the runner holds them back until the stop finishes and then ends by the signal.

The left-behind processes share the process group of the runner that ended. To find them, list the suspended processes, whose state starts with `T`, with their process group:

```shell
ps -A -o stat,pid,ppid,pgid,command | grep '^T'
```

A left-behind checker has lost its runner, so its parent is process 1 or a service manager such as `systemd --user`, and it runs a command such as TLC's `java`, `cargo-kani`, `cbmc`, `cargo`, `elan`, `lake` or `lean`. A job that you suspended yourself, such as an editor stopped with Ctrl-Z, has your shell as its parent; leave it alone. To list every process in a left-behind checker's group, including those still running, run `ps -A -o stat,pid,ppid,pgid,command` and keep the rows whose group matches the checker's. End each one with `kill -KILL <pid>`, or with `kill -TERM <pid>` followed by `kill -CONT <pid>` to let it clean up first. Do not signal the whole group, which can also hold the shell or job that started the runner.

## TLA+ and TLC

The setup helper needs a JDK and Python 3.9 or later as `python3`. If `java` on PATH has no runtime, as with the macOS stub, set `JAVA` to a working JDK's `java` binary. Copy the [TLA+ template](../examples/tla-template/BoundedQueue.tla) with its `BoundedQueue.matrix` and `BoundedQueue.mutations` into the project to start a spec.

```shell
bash <skill-dir>/scripts/setup.sh tla
bash <skill-dir>/scripts/tlc-matrix.sh /path/to/models/Name.matrix
python3 <skill-dir>/scripts/mutate.py /path/to/models/Name.mutations
```

The plugin does not download TLC. Save `tla2tools.jar` from the [TLA+ release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4) pinned in `scripts/tlc.py` as `~/.cache/tla/tla2tools-v1.7.4.jar`; the setup helper verifies its pinned SHA256 and names that path and release when the file is missing or does not match. Set `TLC_CACHE` to choose another cache directory. Set `TLC_JAR` to use an existing JAR; an explicitly supplied JAR is trusted and must already exist.

The matrix runner requires the JAR and a working Java runtime. It checks for Python 3.9 or later before running, so a failing model can always print its reduced trace. It does not download tools. Each run checks the formula its spec names `Spec` and sees only the modules beside that spec. `TLC_WORKERS` controls the TLC worker count. Set `TLC_HTML_REPORT=<path>` to write a self-contained offline HTML report (matrix summary, interactive SVG state chain, variable diffs, and copyable Mermaid source for failing and `reach` witness traces) via `scripts/tlc_report.py`; the runner validates the target path before starting TLC and writes it atomically without changing `stdout` or exit status on success (`tlc.py ready` and `mutate.py` ignore `TLC_HTML_REPORT`). Each run stops after sixty minutes by default; set `TLC_TIMEOUT` to change the limit using a whole number from 1 to 4294967295 with an optional unit `s`, `m` or `h`, such as `90s` or `1h`. For any other value, `setup.sh tla`, the matrix runner and the mutation runner print `UNAVAILABLE` and exit 3 without running TLC. A run that reaches the limit fails with a message naming the limit and `TLC_TIMEOUT`, and a mutation run that reaches it reaches no verdict. During long runs, the runner forwards periodic elapsed-time and `Progress(...)` updates from `tlc.log` to `stderr`. Each run gives the JVM its own `java.io.tmpdir` inside the run directory, so TLC runs started at the same time do not delete each other's copy of the standard modules. A `-Djava.io.tmpdir` in `_JAVA_OPTIONS` overrides it, because the JVM reads that variable after the command line; set the temporary directory with `TMPDIR` instead.

The mutation runner reads `Name.mutations` beside `Name.tla` and `Name.matrix`. For each mutation it copies the spec, replaces the listed text, and runs the matrix runner with the one property the mutation names, so it needs the same tools and settings.

## Rust and Kani

Install Rust and Cargo, then install Kani 0.68.0, the version pinned in [`scripts/kani.py`](../scripts/kani.py):

```shell
cargo install --locked kani-verifier --version 0.68.0
cargo kani setup
bash <skill-dir>/scripts/setup.sh rust
bash <skill-dir>/scripts/kani-check.sh /path/to/crate
bash <skill-dir>/scripts/kani-check.sh /path/to/crate proofs::claim_keeps_invariant
python3 <skill-dir>/scripts/mutate.py /path/to/crate/src/lib.mutations
```

Kani supports Linux and macOS on x86_64 and aarch64. See the [pinned installation guide](https://github.com/model-checking/kani/blob/kani-0.68.0/docs/src/install-guide.md) for system prerequisites. The plugin downloads and installs no Kani runtime. `setup.sh rust` checks the complete pinned bundle and invokes its driver directly. Verification and mutations reuse that driver with its bundled Rust toolchain. They never invoke the auto-installing Cargo wrapper, so the Cargo installer registration is unnecessary after setup. A relative `KANI_HOME` resolves against the caller's directory.

The Rust checker discovers proof harnesses and checks each selected harness separately. It reports the unwind bound and check count, rejects an insufficient bound and any cover condition that was not satisfied, and prints a concrete playback test for a failed assertion when Kani can produce one. Larger inputs and loops remain outside the reported bounds. Crate builds may obtain dependencies declared in Cargo; the template has none.

Kani stops each harness after five minutes. Set `KANI_HARNESS_TIMEOUT` to change the limit to a whole number from 1 to 4294967295 with an optional unit `s`, `m` or `h`, such as `90s` or `20m`. A number with no unit counts seconds. The limit cannot be turned off, so set a long one, such as `24h`, instead. For any other value, the Rust checker, the mutation runner and `setup.sh rust` print `UNAVAILABLE` and check no harness. A harness that reaches the limit fails with a message that names the limit and the setting, and a mutation that reaches it gets no verdict. Each harness check can take up to the limit, so run the command in the background or give it a timeout longer than the total.

The mutation runner reads `Name.mutations` beside `Name.rs`, uses the bundled Cargo to find the crate's workspace and local dependencies, and copies them to a temporary directory with their relative paths intact. It checks the harness named by `detects` and leaves the source crate unchanged. Each harness must have a mutation that its property detects.

## Lean 4

Install [elan](https://github.com/leanprover/elan#installation) through your normal package manager or its documented installer. Copy the Lean template's `lakefile.toml`, `lake-manifest.json` and pinned `lean-toolchain` file into the project once. Each model is one file under `Model/`, started from the [template model](../examples/lean-template/Model/BoundedQueue.lean) and its `BoundedQueue.mutations`.

```shell
bash <skill-dir>/scripts/setup.sh lean /path/to/lean-project
bash <skill-dir>/scripts/lean-check.sh /path/to/lean-project
bash <skill-dir>/scripts/lean-check.sh /path/to/lean-project Model/Name.lean
python3 <skill-dir>/scripts/mutate.py /path/to/lean-project/Model/Name.mutations
```

The setup helper and the Lean checker need Python 3.9 or later as `python3`. The Lean pin lookup and readiness check live in [`scripts/lean.py`](../scripts/lean.py), with the checker's steps. The setup helper runs `lean.py ready`, which checks the version in the project's current `lean-toolchain` and installs it only when it is not ready; it leaves the global default unchanged. `elan run` installs a toolchain that is not installed, even without its install flag, so the Lean checker and the mutation runner first look for the pin in `elan toolchain list` and report a missing toolchain as UNAVAILABLE instead of downloading it. A `lean-toolchain` names a release, such as `leanprover/lean4:v4.35.0`, a toolchain that `elan toolchain link` added, or an absolute path to a toolchain directory. A channel, `stable`, `beta` or `nightly`, or a repository's `lean-toolchain` release name, fails, because elan resolves it to a release online. Lake builds may fetch dependencies declared by the model project. The supplied template has no external Lean packages.

The Lean checker builds every `.lean` file in the project by its path, so a file that no Lake library owns fails the build instead of going unchecked. It then runs the audit in [`scripts/lean-analysis.lean`](../scripts/lean-analysis.lean) against the modules Lake reports for those files. The checker needs a pin of Lean 4.20.0 or later, the first whose Lake builds a module by its source path, and says so when an older pin fails. The audit lists every declaration that rests on an axiom beyond `propext`, `Classical.choice` and `Quot.sound`, so a model needs no `#print axioms` lines. The audit imports the project's modules together, so each model declares its names in a namespace of its own. A file name after the project limits the build and the audit to that file.

The mutation runner reads `Name.mutations` beside `Name.lean`. It elaborates each mutated copy with the project's toolchain and built modules, outside the project, and does not install a toolchain.

Helpers print `UNAVAILABLE` and exit 3 when a required tool is missing, unusable or unverified. Report the target as "not checked" and give the printed remedy. A model or input error prints `FAIL` and exits 1; a usage error exits 2. An unavailable run prints no PASS or SUMMARY line. One line reuses the token for an optional part of a check that passed: `lean-check.sh` prints `UNAVAILABLE kernel replay` when the pin ships no `leanchecker`, then its `PASS` line, and exits 0.

## CI

The helpers live in this plugin, not in the target repository. In CI, check out `michael-denyer/agent-formal-verify` at a pinned commit into a separate directory and run the helpers from its `skills/formal-verify/scripts/`. Update that pin deliberately, as for any other tool. A repository that vendors the scripts instead must keep their GPL-3.0-only license headers.

Install the chosen runtime and the pinned TLC JAR, and for Rust the pinned Kani, in the CI environment, run the setup helper, then run the matrix runner, Lean checker, Rust checker or mutation runner as a separate step. Cache elan's toolchain directory if useful, and keep the version pins with the models. Use the same `TLC_JAR` and `JAVA` settings in setup and verification.

```yaml
- uses: actions/checkout@<commit>
  with:
    repository: michael-denyer/agent-formal-verify
    ref: <pinned-commit>
    path: .formal-verify
- run: bash .formal-verify/skills/formal-verify/scripts/setup.sh tla
- run: bash .formal-verify/skills/formal-verify/scripts/tlc-matrix.sh "$GITHUB_WORKSPACE/tla/Name.matrix"
- run: python3 .formal-verify/skills/formal-verify/scripts/mutate.py "$GITHUB_WORKSPACE/tla/Name.mutations"
- run: bash .formal-verify/skills/formal-verify/scripts/setup.sh lean "$GITHUB_WORKSPACE/lean"
- run: bash .formal-verify/skills/formal-verify/scripts/lean-check.sh "$GITHUB_WORKSPACE/lean"
- run: python3 .formal-verify/skills/formal-verify/scripts/mutate.py "$GITHUB_WORKSPACE/lean/Model/Name.mutations"
- run: cargo install --locked kani-verifier --version 0.68.0 && cargo kani setup
- run: bash .formal-verify/skills/formal-verify/scripts/setup.sh rust
- run: bash .formal-verify/skills/formal-verify/scripts/kani-check.sh "$GITHUB_WORKSPACE/verify"
- run: python3 .formal-verify/skills/formal-verify/scripts/mutate.py "$GITHUB_WORKSPACE/verify/src/lib.mutations"
```
