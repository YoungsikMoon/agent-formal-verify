# Changes

## Unreleased

Lean mutation coverage now reads declaration identities and source ranges from the pinned Lean frontend. Indented public theorems remain covered, and equal short names in different namespaces remain separate targets. Structure and class projections and instance declarations are not property targets, including local and scoped instances. Wrapped guards and examples remain detectable, and their reported locations refer to the original model. Guard and example failures cannot cover named theorems; errors outside recognized properties are rejected. The runner checks that the original module elaborates before testing mutations.

Lean mutation results explicitly measure whether existing proofs break; they do not establish that a statement is false or its hypotheses can hold. The skill reports those evidence gaps separately. Existing properties may be corrected and re-frozen when the main thread accepts source-backed specification evidence, even when production code is unchanged; unsupported weakening remains prohibited.

The mutation runner reads and applies every mutation before it runs any tool. A mutation whose replaced text does not occur exactly once in the model used to be found only when its turn came, after every earlier mutation had run its checker; it now stops the run first. A TLA+ or Rust mutation without a `detects` line, and a mutation with two `detects` or two `only` lines, now fail by name instead of reporting a property named by an empty string or keeping the last line. A Lean mutation with an `only` line now fails instead of ignoring it. Because these checks run first, a malformed mutations file fails before a missing tool reports `UNAVAILABLE`.

The mutation runner checks that a Lean project's pinned toolchain is ready once per run, not once per mutation. The check and its remedy now live in `lean-tools.sh`, where `lean-check.sh` reads them too, and a Lean project without a pin reports that directly instead of as an analysis that did not complete.

The Lean checker derives each source's module name once and passes it to the frozen-statement step, which derived it a second time from the same path. When Lake reports a build file outside `.lake/build/lib/lean`, the checker now names it and stops instead of auditing a wrong import.

The TLA+ matrix runner moved from bash into `tlc.py`, and `tlc-matrix.sh` now checks for Python 3 and runs it, as `kani-check.sh` runs `kani.py`. Its output and exit status are unchanged. The mutation runner now reads the matrix with the same parser and runs each mutation through the same runner, instead of parsing the matrix a second time and reading verdicts back out of printed lines. So it now finds its spec's section when the `spec` line writes the path another way, such as `./Name.tla`, and it checks TLC once per run instead of once per mutation. Any line the matrix runner rejects now stops the mutation runner wherever it is in the matrix, including an unknown directive, a run before any `spec` line and a check after an empty `spec` line; before, it noticed only a malformed check or reach in its own spec's section. It also reads a matrix whose words are separated by tabs, as the matrix runner always did. A matrix saved with CRLF line ends now works in both runners, where before its spec was not found.

The Lean and Kani templates now ask the adapter to record the source files, line ranges, covered functions and `Source read at <commit>` line in the model's header, as the TLA+ template and all three briefs already did.

## 0.4.8 - pin Lean 4.35.0

The Lean template pins Lean 4.35.0 in place of 4.34.1. The template records the same 34 declarations with the same statement types under both versions. Lean 4.35.0 builds the bodies of three generated `match_1` matchers differently, so their value fingerprints changed, and the template's statements are re-frozen. A project copied from the template keeps its own pin. After its `lean-toolchain` changes, the checker asks for a review and a fresh `--freeze`, as before. The checker still supports pins from Lean 4.20.0.

## 0.4.7 - an optional review of each model's properties

A property can pass every check and still promise less than the code's callers rely on, and until now only the agent that wrote it read it. After writing the target table, the skill asks whether to add an independent review, one agent per target, and skips the question when the request already answers it. A headless run cannot answer, so it gets no review, and its reply says so. A reviewer follows the new review brief. It reads the source and the model's properties, assumptions and fix commits, without the modelling agent's report, and writes the bugs it expects to pass as mutations. The skill appends them to the model's mutations file and runs the mutation runner. It keeps the detected ones and gives a missed one to a new modelling agent. A finding that no mutation can express is reported as an open question. For each model, the reply says whether its properties were reviewed and how the reviewer's mutations fared.

## 0.4.6 - every Lean theorem must be breakable, past fixes become mutations, and agents' results are rechecked

A Lean theorem whose hypotheses can never all hold passes whatever the code does, and the mutation runner never required a Lean theorem to fail. It now reads each Lean model's `.statements` file and prints UNCOVERED for a public theorem that no mutation makes fail, as it already did for TLA+ properties and Kani harnesses. A failing `#guard` does not count for the theorem, and private theorems are proof helpers that need no mutation. A Lean model without a `.statements` file fails before its mutations run. So does a Lean mutation with a `detects` line, which would otherwise count as covering the theorem it names. The template's `invariant_init` named the literal state `⟨0, 0⟩`, so no mutation could break it. The template now transcribes the initial state as `init`, uses it in the reach search and adds a mutation that counts an item as consumed before any claim; its statements are re-frozen. Models copied from earlier templates report `UNCOVERED theorem invariant_init` until they gain such a mutation.

Step 1 lists the commits that fixed a bug in each target's code, and each brief replays them as mutations that restore the behaviour before the fix. A Kani mutation can replay a fix only in the file beside its mutations file. After the agents report, step 3 reruns every matrix, Lean check, Kani check and mutations file in the main thread and takes the verdicts from those runs. It reverts a changed property, theorem statement, statements record or Kani assumption on an existing model, or a theorem newly marked `private`, unless the row's evidence supports the change.

## 0.4.5 - follow renames before retiring a model

The 0.4.4 recheck could propose retiring a model whose code still exists, and could skip the commit that changed a guarantee on purpose. Its search for the covered functions left out each model's files. A Kani harness written inside a production file, as in the bundled template, took the production functions out of the search with it, and a function renamed in place matched nothing. Step 1 now leaves out only model files that hold no production code. When a covered name is found nowhere, it finds the commit that removed the name with `git log -S` and reads all of it, and proposes retiring the model only when that commit deleted the code. The history search read a source file's first and last paths only, so a commit made at an intermediate path was skipped, and a guarantee changed there on purpose kept its old property. Step 1 now follows each source file through every rename since the sync commit and reads the log over all of its paths.

## 0.4.4 - bring existing models back in line with the code

A TLA+ spec or Lean model keeps passing after the code it describes changes, because it never reads the code. When a repository already has models, the formal-verify skill now starts with them. It runs every one, finds where the functions it covers live now, and reads the commits that touched those files since the commit its header records as `Source read at`, so it follows code that moved to another file. It asks whether the model still describes the code and whether any of those commits says the guarantee changed; without that evidence the property stays, and a failure after the update is a bug candidate. Each brief has a section for an existing model: the agent edits the model's files, adds a mutation for each step the update adds, and records the commit it read the source at. When that commit is missing or no longer reachable from `HEAD`, as after a squash merge, the skill uses the last commit that touched the model. It proposes retiring a model whose functions are found nowhere and deletes it, with its CI steps and testing documentation row, when the user agrees. The reply keeps each model's verdict and adds whether it was unchanged or updated, or is proposed for retirement. A request to recheck only the existing models skips the search for new targets.

## 0.4.3 - clear the directory's credential and download-and-run holds

The Claude directory held every version since 0.3.3 for a credential read and a download-and-run command, and 0.3.2 stayed the version it served. Validating the tree one deletion at a time against a throwaway repository named each trigger. The credential rule matched a parameter named for a credential in `opencode.mjs` and in the metadata test, an environment lookup in the Kani helper's `search_path` whose variable name was an argument, and the test driver writing its whole environment to a file. `search_path` now takes the inherited value, which its two callers read by name, so the assembled `PATH` and `PYTHONPATH` are unchanged; the parameters are renamed; the fake kani-driver lives in `tests/fixtures/kani-driver.py` and checks `KANI_HOME` and the loader path against `driver.json` instead of writing its environment. The download-and-run rule matched the name of Lean's evaluation command in the Lean brief, which now says to evaluate `badPairs` at top level as the template does; the command stays in the template and the checker. The CI workflow's curl of the TLC release stays and shows as a warning, which does not hold a version. The 0.3.5 notes blamed the workflow token; it was never the trigger.

## 0.4.2 - OpenCode skips stray folders and rejects incomplete skills

The OpenCode plugin read every folder under `skills/` as a skill, so one folder without a `SKILL.md`, such as a scratch folder in a local checkout, failed the plugin and registered neither skill. It now skips such folders, as Pi does. A `SKILL.md` without a `name` or `description` used to register with that field undefined; the plugin now fails with the file's path and the missing field. A single-quoted `description` lost nothing but kept its quotes; it now reads as YAML does. The two bundled skills register exactly as before.

## 0.4.1 - install from npm

The package is publishable to npm as `agent-formal-verify`, so Pi installs it with `pi install npm:agent-formal-verify` and OpenCode with `opencode plugin add agent-formal-verify`. A `files` allowlist limits the tarball to `opencode.mjs`, `skills/`, the license, the README and the changelog, which drops it from 77 files and 2.86 MB to 34 files and 59 kB; it leaves out the README artwork, tests, CI configuration and the Claude Code and Codex manifests. A Lean build cache under `skills/` stays out. The metadata test pins the allowlist and fails when a new root file is neither shipped nor listed as repository-only. Pushing a `v*` tag runs a workflow that checks the tag against the package version, runs the metadata tests and publishes with npm trusted publishing and provenance; it skips a version that is already on npm. The skills, the OpenCode plugin and the Git installs are unchanged.

## 0.4.0 - install in OpenCode

The repository is now an OpenCode plugin for OpenCode 2.2 and later. `opencode plugin add 'git+https://github.com/michael-denyer/agent-formal-verify.git'` loads `opencode.mjs` through the package's `./server` export. It reads `skills/*/SKILL.md` and registers `setup` and `formal-verify` with their helpers, templates and references in place, and keeps any skill already registered under the same name. It has no dependencies, runs no commands and makes no network requests. The Pi package and the Claude Code and Codex plugins are unchanged.

## 0.3.5 - fetch TLC in CI without a token, and name no MCP package

The CI workflow downloads the pinned TLC JAR with curl and checks it against the pinned SHA256 through the shared helper before anything runs it, instead of fetching it with the GitHub CLI under the workflow's token. The Lean brief no longer links to a Lean language-server MCP package. Neither change cleared a directory hold; 0.4.3 names the triggers.

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
