# Changes

## 0.4.0 - install in OpenCode

The repository is now an OpenCode plugin for OpenCode 2.2 and later. `opencode plugin add 'git+https://github.com/michael-denyer/agent-formal-verify.git'` loads `opencode.mjs` through the package's `./server` export. It reads `skills/*/SKILL.md` and registers `setup` and `formal-verify` with their helpers, templates and references in place, and keeps any skill already registered under the same name. It has no dependencies, runs no commands and makes no network requests. The Pi package and the Claude Code and Codex plugins are unchanged.

## 0.3.5 - fetch TLC in CI without a token, and name no MCP package

The CI workflow fetched the pinned TLC JAR with the GitHub CLI under the workflow's token, the only credential variable in the repository. The Claude directory scans every tracked file and read that as a credential taken from the environment and sent to a server. The workflow now downloads the release asset with curl and checks it against the pinned SHA256 through the shared helper before anything runs it. The Lean brief no longer links to a Lean language-server MCP package; the directory counts package launchers as download-and-run commands, and that link was the plugin's only reference to installable software. The 0.3.4 strip of the image manifests cleared the image hold and one of two credential findings; the token read was the other.

## 0.3.4 - keep image references out of release-note code

Removed the obsolete icon path from a release-note code span. The Claude directory treats bundled image paths in backticks as possible executable references, even in historical prose. The two README images added in 0.3.3 carried signed C2PA provenance manifests from the image generator; the `caBX` chunk is stripped from both, leaving the pixels unchanged, which cleared the directory's image hold. Metadata tests now reject bundled image and font paths in documentation code, reject provenance and text chunks in bundled PNGs, and guard the plugin's absence of automatic hooks and MCP or LSP servers. The README makes explicit that the plugin configures no servers or hooks and requires no credentials.

## 0.3.3 - fix only what reproduces, and name the property in the PR

The skill fixes only a counter-example that shipped settings can reach, and only with a reproduction unless none is practical. When a unit test for a Lean or Kani counter-example passes on the production code, the agent corrects the model or harness, and the Lean brief permits that re-freeze. A fix PR includes any reproducing test and names the theorem, `#guard`, TLC property or Kani harness that failed. The agent uses a tool the request names and reports what it leaves unchecked.

## 0.3.2 - install in Pi

The repository is now a Pi package. `package.json` points Pi at the existing `skills/` tree, so `pi install git:github.com/michael-denyer/agent-formal-verify` provides the `setup` and `formal-verify` skills with their helpers, templates and references, without a copy. The plugin test checks that the package version, license and skills path agree with the other manifests.

## 0.3.1 - name the Rust commands after the language and the tool

`setup.sh rust` prepares Kani and `scripts/kani-check.sh` runs it. They replace `setup.sh bmc` and `bmc-check.sh`, and the Rust brief moves to `references/rust-brief.md`. As with TLA+ and TLC, the setup command and brief take the language's name and the scripts take the tool's. Rust mutations reject an unknown harness or an `only` line before any mutation runs. A refuted property no longer counts as a detected mutation when Kani also reports a status that the check's category does not use.

## 0.3.0 - check bounded Rust functions with Kani

The Rust checker runs Kani 0.68.0 on actual functions through proof harnesses. It reports each harness's unwind bound and check count, rejects failed checks and unsatisfied cover witnesses, and prints generated concrete playback tests when available. Incomplete verification, insufficient unwinding bounds and unsatisfied covers fail. Rust mutations copy the whole crate and require detection by the named harness; compiler errors and incomplete verification do not count as detection.

Setup verifies a separately installed pinned Kani bundle and invokes its verifier driver directly with the bundled toolchain. Verification and mutations use that same absolute installation, so a relative KANI_HOME or a shadowed Cargo wrapper cannot trigger Kani's automatic setup. The dependency-free bounded-queue template, setup instructions, modelling brief and CI demonstrate the Rust path.

## 0.2.8 - compare models with code and label counter-examples

The Lean template prints boundary and in-range test vectors. The brief requires comparing them with the production function in its native tests before reporting that a proof describes the code, or stating that the comparison was not run. Reports label counter-examples as reproduced, reachable at shipped settings, or model-only. Lean goal and diagnostics tools remain optional.

## 0.2.7 - require reachable boundary states

A TLA+ matrix can require a state with `reach <Operator> | <label>`. The checker searches the first matching run and reports the shortest witness, or fails when no state satisfies the predicate. Reach checks have separate summary counts and can detect mutations with `detects reach:<Operator>`. The templates require a full-window state in TLC and Lean so a property cannot pass by avoiding its boundary.

## 0.2.6 - freeze Lean statements before proving them

`lean-check.sh <project> --freeze [<file.lean> ...]` records each checked source's declaration types and definition values in a `.statements` file beside it. Later checks reject a changed statement, a changed definition or a deleted declaration. Proof changes and added declarations remain allowed. Freeze can record statements whose proofs use `sorry`, but it does not report a proof pass; the final check still rejects unfinished proofs and extra axioms. Fingerprints use SHA256 of structural expressions and belong to the recorded Lean pin. A toolchain change requires review and a fresh freeze.

## 0.2.5 - unavailable tools are not model failures

Helpers now print `UNAVAILABLE` and exit 3 when TLC or Lean cannot run because a prerequisite is missing, unusable or unverified. The remedy stays with that result. Mutation checks preserve the status and stop without a MISSED or SUMMARY line. Model and input errors remain `FAIL` with exit 1; usage errors exit 2. Reports mark an unavailable target as "not checked".

## 0.2.4 - no listing fields in `plugin.json`

The Claude `plugin.json` no longer carries `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, or `termsOfServiceUrl`. Claude Code ignores all five at load time. The Claude plugin directory read the icon path as an image the plugin's code could run and held the version for review. The directory icon stays in the repository.

## 0.2.3 - TLC comes from the user, verified by setup

The plugin no longer carries `tla2tools.jar`. Save the JAR from the TLA+ release pinned in `scripts/tlc-tools.sh` as `~/.cache/tla/tla2tools-v1.7.4.jar`, or point `TLC_JAR` at one. `setup.sh tla` verifies the pinned SHA256, names the release and path when the file is missing, and rejects a file that does not match. `TLC_CACHE` chooses another cache directory. No helper downloads anything.

## 0.2.2 - the TLC JAR ships inside the plugin

The plugin bundles the TLC v1.7.4 release JAR at `skills/formal-verify/vendor/tla2tools.jar` with its MIT license. `setup.sh tla` checks that JAR against the pinned SHA256 and no longer downloads anything, so TLA+ setup needs no curl and no network. The `~/.cache/tla` cache and the `TLC_CACHE` setting are gone; `TLC_JAR` still selects another JAR. Lean setup is unchanged.

The plugin has an icon for the Claude plugin directory.

## 0.2.1 - reports for readers new to the tools, and briefs read from a file

The formal-verify skill writes its reply, pull requests and documents for a reader who knows the code and has used neither tool. A report leads with what goes wrong in the code, states each property as what it guarantees, and says what a TLC pass, a Lean proof, a bounded search and a detected mutation each mean.

The modelling requirements moved from `SKILL.md` to `references/tla-brief.md` and `references/lean-brief.md`. An agent's brief names the file to read, where the skill previously had the requirements copied into every brief. `SKILL.md` is about a fifth shorter.

The briefs tell agents to write each fact once: named variable groups for `UNCHANGED`, one operator for a shared guard, one bounded input list per Lean model, and no mutation switches in a model. The skill gives each result one home and rules out a report file per bug and machine-specific paths in committed commands.

## 0.2.0 - one Lean project per repository and a mutation runner

Lean models share one Lake project: each target is a file `lean/Model/<Name>.lean` in its own namespace, where each previously copied the whole template to `lean/<Name>/`. The Lean template moved to `examples/lean-template/Model/BoundedQueue.lean`, and its lakefile builds every file under `Model/`. Existing projects with their own layout still check.

`lean-check.sh` takes file names after the project and then builds and audits only those files, so agents that share a project can each check their own model. It names the cause when two modules declare the same name. Its result lines read `declarations checked, no unfinished proof (sorry), no added axiom`.

Added `mutate.py`. It reads a model's `<Name>.mutations` file, applies each listed bug to a temporary copy, and prints DETECTED or MISSED with what failed. A TLA+ mutation names the one property that must fail; a property that no mutation targets is reported as UNCOVERED. A Lean mutation is reported with the declarations that fail. Specs no longer need a constant or branches for their mutations. Both templates include a mutations file, and the TLA+ template's matrix is now `BoundedQueue.matrix`.

`tlc-matrix.sh` ends with a SUMMARY line that counts the passing runs and totals their distinct states.

## 0.1.11 - Lean checker works from Lean 4.20.0 and ignores leftover modules

`lean-check.sh` takes the modules to audit from `lake query`, so a `.olean` left in the build directory by a deleted source is no longer audited. The audit skips the compiler's auxiliary declarations, which made every model fail on Lean 4.20.0. The checker supports pins from Lean 4.20.0, the first whose Lake builds a module by its source path, and names that minimum when an older pin fails.

## 0.1.10 - sound Lean audit and clearer agent instructions

`lean-check.sh` audits every declaration of every built module with Lean, so a theorem that rests on a declared axiom, `native_decide` or `sorry` fails even when the model has no `#print axioms` line. It builds every `.lean` file in the project by path, so an unimported module is checked and a file that no Lake library owns fails; a default build skipped both. A project with no declarations fails. A long theorem name no longer causes a false failure. The Lean template drops its `#print axioms` lines.

The matrix runner reports the final state count; it previously reported the count from TLC's first progress line on longer runs.

`setup.sh tla` replaces a cached JAR that does not match the pin. `setup.sh lean` prints a `FAIL` line when an installed toolchain does not run.

The formal-verify skill prepares tools after picking targets, tells each agent brief to carry the helper paths, uses one matrix file per spec, and requires mutations for both tools on a copy or reverted. It changes code, commits and opens pull requests only when the user asked for fixes. Tool setup explains how CI obtains the helpers. Both skills run helpers by absolute path with `bash`.

Removed `.codex-plugin/prompts/`, which the Codex plugin manifest never loaded.

## 0.1.9 - verifier fixes and worked TLA+ example

The matrix runner now reduces the trace of an invariant violation or a deadlock; it previously reduced only temporal counter-examples and printed the raw log for the rest. The reducer reads one-variable specs and exits 1 on a log without a trace.

Each matrix run gets its own directory, so a spec no longer resolves modules left by an earlier spec. A missing spec is reported in one line.

The matrix runner fails a `check` line placed before any `spec` line, which it previously dropped while the run still passed, and a `run` line without a `|`, which it previously turned into a constant named after the label.

`lean-check.sh` prints multi-line #eval output whole, no longer counts `error:` text in output as a build error, and fails a theorem that `#print axioms` shows resting on a declared axiom. The Lean template guards its bounded search with `#guard`, so a counter-example fails the build.

Added a TLA+ template beside the Lean one; it replaces `examples/template.matrix`. CI runs both checkers on the examples and on mutated copies.

The tests run under `node --test` and include the metadata checks that `tools/check.mjs` held, so development no longer needs Bun.

## 0.1.8 - validation and simpler metadata

Removed the separate root version file. Validation compares the plugin manifests, marketplace entry and release notes directly.

Added prek hooks shared with CI, including Python and workflow linting. Dependabot proposes weekly updates for lint tools, prek and GitHub Actions.

CI checks local documentation links and heading anchors offline and audits workflow security with zizmor.

## 0.1.7 - simplify contribution guidance

Removed the separate reporting document and contact fields from plugin metadata.

## 0.1.6 - clarify the workflow diagram and method

Moved the diagram subtitle into a README heading and added a short workflow explanation. The introduction credits Boris Cherny's targeted formal-verification method.

## 0.1.5 - workflow graphic and shorter README

Added a workflow diagram and a getting-started example. Moved detailed installation, update and verification guidance into a reference page.

## 0.1.4 - GPLv3 and contributor documentation

The plugin uses GPL-3.0-only. Added contributor guidance, issue forms and a pull request template. The README now explains the verification workflow and updates for Claude Code and Codex. Edited the skills and template comments for clearer prose.

## 0.1.3 - set up all tools once, select them during verification

Setup prepares the complete shared toolset independently of any repository. Formal verification selects tools from its current targets and prepares any missing pinned artifacts before modelling. Repository changes and new Lean pins do not require a manual setup rerun. Lean preparation reuses a working pinned toolchain without calling the installer. CI runners still require a separate preparation step.

## 0.1.2 - clarify global setup scope

Setup resolves the invocation's repository before running helpers from the installed plugin. Global installations share tool caches while selecting tools and respecting Lean pins separately for each repository. Installed helpers and templates remain read-only; model files and build outputs belong in the target repository.

## 0.1.1 - add an agent setup command

`/agent-formal-verify:setup` inspects the repository's thread protocols, sequential invariants and existing models, then prepares TLA+, Lean, or both before verification. Explicit tool arguments are overrides. It reuses existing runtimes, installs missing required prerequisites through the user's package manager when available, and runs the pinned setup helper. Lean setup uses an existing project's pin or the bundled template; setup reports tool readiness without creating a model project or changing the global Lean default.

## 0.1.0 - formal verification with TLA+ and Lean

A standalone plugin for modelling thread protocols with TLA+ and TLC and proving sequential invariants with Lean 4. It includes matrix and proof runners, templates, and explicit tool preparation. Verification checks require prepared tools; they do not install a JDK, elan, TLC, or a Lean toolchain. TLC downloads use unique temporary files and verify the checksum before publishing to the cache.
