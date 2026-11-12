# Tool setup

Run `/agent-formal-verify:setup` once to prepare Java, Python, TLC, elan, Lean, Rust and Kani. In Codex, request this plugin's `setup` skill. The [setup skill](../../setup/SKILL.md) prepares all three verification tools independently of any repository and reuses existing runtimes and caches.

The formal-verify skill selects tools from the current repository on every invocation. It reuses prepared tools and installs a missing Lean toolchain through the setup helper when a Lean pin changes. Repository changes do not require the user to rerun the full setup.

## Running the helpers

The helpers are in the `scripts/` directory of the installed `formal-verify` skill, including a copied skills-only installation. `<skill-dir>` below stands for that skill's absolute path.

Stay in the target repository and run each helper with `bash` and its absolute path. Pass absolute paths to model projects and matrices. Keep the installed skill files read-only, and create models and build outputs in the target repository. Shared tool caches can serve several repositories; each repository determines its own tool requirements and Lean pins.

## TLA+ and TLC

The setup helper needs a JDK, Python 3, and `sha256sum` or `shasum` to verify the TLC JAR. If `java` on PATH has no runtime, as with the macOS stub, set `JAVA` to a working JDK's `java` binary. Copy the [TLA+ template](../examples/tla-template/BoundedQueue.tla) with its `BoundedQueue.matrix` and `BoundedQueue.mutations` into the project to start a spec.

```shell
bash <skill-dir>/scripts/setup.sh tla
bash <skill-dir>/scripts/tlc-matrix.sh /path/to/models/Name.matrix
python3 <skill-dir>/scripts/mutate.py /path/to/models/Name.mutations
```

The plugin does not download TLC. Save `tla2tools.jar` from the [TLA+ release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4) pinned in `scripts/tlc-tools.sh` as `~/.cache/tla/tla2tools-v1.7.4.jar`; the setup helper verifies its pinned SHA256 and names that path and release when the file is missing or does not match. Set `TLC_CACHE` to choose another cache directory. Set `TLC_JAR` to use an existing JAR; an explicitly supplied JAR is trusted and must already exist.

The matrix runner requires the JAR and a working Java runtime. It checks Python 3 before running, so a failing model can always print its reduced trace. It does not download tools. Each run checks the formula its spec names `Spec` and sees only the modules beside that spec. `TLC_WORKERS` controls the TLC worker count.

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

The mutation runner reads `Name.mutations` beside `Name.rs`, uses the bundled Cargo to find the crate's workspace and local dependencies, and copies them to a temporary directory with their relative paths intact. It checks the harness named by `detects` and leaves the source crate unchanged. Each harness must have a mutation that its property detects.

## Lean 4

Install [elan](https://github.com/leanprover/elan#installation) through your normal package manager or its documented installer. Copy the Lean template's `lakefile.toml`, `lake-manifest.json` and pinned `lean-toolchain` file into the project once. Each model is one file under `Model/`, started from the [template model](../examples/lean-template/Model/BoundedQueue.lean) and its `BoundedQueue.mutations`.

```shell
bash <skill-dir>/scripts/setup.sh lean /path/to/lean-project
bash <skill-dir>/scripts/lean-check.sh /path/to/lean-project
bash <skill-dir>/scripts/lean-check.sh /path/to/lean-project Model/Name.lean
python3 <skill-dir>/scripts/mutate.py /path/to/lean-project/Model/Name.mutations
```

The setup helper checks the version in the project's current `lean-toolchain` and installs it only when it is not ready; it leaves the global default unchanged. The Lean checker uses `elan run` without its install flag, so a missing toolchain is UNAVAILABLE instead of downloading inside the checker. Lake builds may fetch dependencies declared by the model project. The supplied template has no external Lean packages.

The Lean checker builds every `.lean` file in the project by its path, so a file that no Lake library owns fails the build instead of going unchecked. It then compiles a short audit against the modules Lake reports for those files. The checker needs a pin of Lean 4.20.0 or later, the first whose Lake builds a module by its source path, and says so when an older pin fails. The audit lists every declaration that rests on an axiom beyond `propext`, `Classical.choice` and `Quot.sound`, so a model needs no `#print axioms` lines. The audit imports the project's modules together, so each model declares its names in a namespace of its own. A file name after the project limits the build and the audit to that file.

The mutation runner reads `Name.mutations` beside `Name.lean`. It elaborates each mutated copy with the project's toolchain and built modules, outside the project, and does not install a toolchain.

Helpers print `UNAVAILABLE` and exit 3 when a required tool is missing, unusable or unverified. Report the target as "not checked" and give the printed remedy. A model or input error prints `FAIL` and exits 1; a usage error exits 2. An unavailable run prints no PASS or SUMMARY line.

## CI

The helpers live in this plugin, not in the target repository. In CI, check out `michael-denyer/agent-formal-verify` at a pinned commit into a separate directory and run the helpers from its `skills/formal-verify/scripts/`. Update that pin deliberately, as for any other tool. A repository that vendors the scripts instead must keep their GPL-3.0-only license headers.

Install the chosen runtime and the pinned TLC JAR in the CI environment, run the setup helper, then run the matrix runner, Lean checker or mutation runner as a separate step. Cache elan's toolchain directory if useful, and keep the version pins with the models. Use the same `TLC_JAR` and `JAVA` settings in setup and verification.

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
```
