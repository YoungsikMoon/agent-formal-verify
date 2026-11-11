# Proposed verification assurance work

Status: proposed for review, 11 November 2026. This plan describes follow-up work; the coverage fix does not implement these capabilities.

## Goal and current boundary

Make every reported guarantee traceable to an accepted specification, an independently rerun check, and explicit evidence about the specification's strength. Preserve the existing lightweight workflow for projects that do not request stronger assurance.

The current fix obtains fully qualified Lean declaration names and ranges from the pinned frontend, checks mutation errors against those declarations, discloses that a broken proof does not establish a false statement, and allows justified corrections to existing specifications. It leaves the Lean baseline format and supported toolchain range unchanged.

The next work should add three distinct kinds of evidence:

| Evidence | Question answered | What it still does not establish |
| --- | --- | --- |
| Accepted specification comparison | Did the final proof establish the statement and definitions that were accepted? | That the accepted specification describes the intended software behavior |
| Satisfiability witness | Can the theorem's hypotheses hold together on an intended execution? | That every important input or behavior is represented |
| Checked mutant counterexample | Does this property reject the selected faulty implementation? | That it rejects every possible bug |

Keep production correspondence separate. A proof about a transcribed model still depends on that transcription, its arithmetic widths, and its assumptions. Differential vectors provide supporting evidence, not a proof of equivalence to the production program. This project will not claim the machine-code guarantees of the [DeepMind work](https://google-deepmind.github.io/code-verification/).

## Scope decisions recommended for approval

- Deliver the stages below as separate, independently testable PRs. Do not combine this work with another Lean upgrade or a release automation change.
- Retain Lean 4.20.0 support for the existing checker and mutation runner. Offer the stronger comparator mode only on supported pins starting at 4.35.0, with explicit unavailability elsewhere.
- Keep independent property review opt-in. When chosen, review the specification before expensive proof work; permit a final review of changes made after that point.
- Use a baseline controlled by the orchestrating checker, with an explicit amendment record. Never treat a second agent's self-report as an acceptance verdict.
- Require positive witnesses and checked counterexamples only when a user chooses the stronger mode. Always disclose missing evidence in ordinary mode.
- Preserve existing exit meanings: failed checks 1, usage errors 2, unavailable tools 3. Add structured evidence fields rather than inventing an overall score.

## Stage 1: independent baselines and specification amendments

### Deliverables

A deterministic baseline helper, kept under `skills/formal-verify/scripts/`, and a versioned manifest for each accepted target. The orchestrator creates the baseline before proof workers can change the accepted material and supplies workers with its identity, not a writable baseline path.

The manifest records the target and source commit, source paths, model files, fully qualified properties, toolchain, dependency lockfiles, relevant build/check configuration, and accepted assumptions. Record a content hash for each captured file. Include local imported definitions in the trusted scope; a root theorem's unchanged text is insufficient.

The helper has three operations: capture an accepted baseline, compare a candidate with it, and apply an accepted amendment. Each operation writes a structured result and a short human-readable explanation. A comparison may report unchanged, changed, or unavailable; missing evidence never becomes unchanged.

### Implementation steps

1. Inventory which files and configuration can affect each existing checker. Write fixtures for a transitive Lean helper, a TLA+ matrix property or fairness change, and a Kani assumption or cover change.
2. Define the manifest schema and supported path rules. Reject paths escaping the captured root, ambiguous identities, unexpected symlinks, and absent files. Capture required untracked new model files explicitly instead of silently omitting them.
3. Copy accepted material to a separate checker-owned directory and hash it. Use host-enforced write restrictions when available. A separate worktree or read-only permission bit alone is not an adversarial boundary against agents running as the same user; report the actual isolation provided.
4. Separate specification acceptance from proof completion in the skill. Align the model with source, draft properties, optionally review them, then accept the baseline and begin proof work. Do not require finished proofs before the property review.
5. Compare the final candidate with the baseline from the orchestrator. Keep exact file comparison for immutable configuration; use declaration-aware comparison for Lean so proof changes can be accepted without permitting statement or definition changes.
6. Add amendment records containing the baseline hash, old and new guarantees, evidence, reviewer decision, changed files, and resulting hash. Only the orchestrator applies accepted amendments. Reapplication must either recognize the same amendment or reject a stale baseline without partially writing it.
7. Require explicit production-contract evidence or user agreement for weakening. Permit independently justified corrections and strengthening without fabricating a production change.
8. Wire baseline identity and amendment decisions into final reporting and CI artifacts. Do not retain user source snapshots in this plugin's repository or upload them automatically.

### Acceptance criteria

- Changing a theorem's dependency, a property selection, fairness, an assumption, or a cover is detected even when the property name and top-level statement are unchanged.
- Proof-only changes pass; replacing or deleting the baseline, source, or record does not.
- Uncommitted and newly created targets receive the same checks as committed targets.
- Rejected or interrupted amendments leave the prior baseline intact; replay is deterministic.
- A realistic unchanged-production example can correct a vacuous specification, record the decision, re-freeze, and finish without the parent reverting the correction.

## Stage 2: native Lean comparator integration

### Deliverables

An optional checker mode that compares accepted challenge material with the candidate solution and rechecks proofs using Lean's supported validation tools. Keep the existing fingerprints as a fast local check; do not present them as equivalent to independent kernel replay.

Lean 4.35.0 introduced the relevant Lake commands. Verify the pinned command's configuration and platform support against the [4.35.0 release notes](https://lean-lang.org/doc/reference/latest/releases/v4.35.0/) and the installed toolchain before implementation. The [Lean validation guide](https://lean-lang.org/doc/reference/latest/ValidatingProofs/) explains the trust boundary between the challenge, untrusted build, export, and external validation.

### Implementation steps

1. Run a disposable comparison on the bundled queue example. Record required executables, sandbox support, import handling, output schema, runtime and memory on Linux and macOS. This is a feasibility gate, not a claim that both platforms already work.
2. Compare two approaches: separate challenge and solution projects, or independent exports consumed by the checker. Choose the approach that keeps accepted material outside the candidate build's write scope and preserves dependency identities.
3. Decide how to represent implementation definitions in the challenge. Compare the full dependency closure; do not substitute a weaker model or permit a changed helper merely because the final theorem text matches.
4. Integrate preparation into setup and capability checks into verification. Verification reports unavailable without installing tools. Never silently disable a required sandbox or downgrade to ordinary fingerprints while reporting comparator success.
5. Keep the standard axiom allowlist explicit. Report the checker actually used and whether optional independent kernels ran. Treat checker crashes, incomplete exports and malformed output as failures or unavailability according to the observed cause.
6. Add a versioned structured report containing baseline identity, compared properties, dependency comparison, kernel results and tool versions. Preserve concise terminal output.
7. Add Linux CI for the stronger mode. Add macOS execution when the feasibility result supports it; otherwise document the platform limitation and a supported Linux route without installing a VM automatically.

### Acceptance criteria

- A legitimate alternative proof passes.
- A weakened theorem, changed transitive definition, added axiom, unfinished proof, and replaced challenge each fail for the expected reason.
- Missing sandbox support and older toolchains are clearly unavailable; neither yields a stronger-mode pass.
- Existing Lean 4.20 projects continue to pass the ordinary checks.

## Stage 3: checked satisfiability witnesses

### Deliverables

An explicit mapping from each property to a Lean-checked witness that its hypotheses can hold together on relevant inputs. The witness is a proof, not a comment or a bounded search's exit status.

### Implementation steps

1. Start with the queue template and write a witness over the same definitions and assumptions as each property. For a transition property, exhibit an input state, a successor, and proofs of the invariant, guard and transition hypotheses.
2. Design a small sidecar format mapping a fully qualified property to witness declarations. Keep evidence declarations distinguishable from properties so mutation coverage does not incorrectly require every witness proof to break.
3. Bind witnesses to the accepted property statement and dependency hashes. Changing a hypothesis invalidates its prior witness mapping until checked again. Independently proving a similarly named proposition is insufficient.
4. Add requested witnesses for boundary behavior, such as an empty queue and a full window. Keep a minimal satisfiability witness distinct from coverage of all relevant boundary cases.
5. Audit witnesses with the same unfinished-proof and axiom checks as other declarations. An existential witness must actually prove all required premises together.
6. Extend the modelling and review briefs to ask which shipped inputs are excluded and which witnesses are still missing. Report checked, failed, unavailable, or absent per property.

### Acceptance criteria

- The review's contradictory-hypothesis example cannot supply a checked witness.
- A valid property with satisfiable premises can supply one, including in nested namespaces.
- A witness omitting one premise, proving a different property, relying on an added axiom, or predating a hypothesis change does not count.
- Reports distinguish satisfiability from bounded reachability and from production correspondence.

## Stage 4: checked counterexamples for Lean mutations

### Deliverables

A stronger mutation result only when Lean checks a concrete counterexample to the accepted property's statement under the mutated implementation. Preserve ordinary proof-sensitivity results as a separate evidence category.

### Implementation steps

1. Prototype the representation on the three queue mutations. For each, exhibit inputs satisfying all theorem hypotheses and a proof that the conclusion fails. Alternatively prove the negation of the complete mutated property, with the same accepted assumptions.
2. Define how a mutation identifies its implementation edit, property and refutation evidence. Mutations may change implementation definitions but may not edit accepted property statements, witnesses, proof obligations, or the gatekeeper configuration to earn detection.
3. Check the refutation in a fresh copy of the mutated project with accepted specification material supplied by the checker. Audit its complete axiom dependencies and reject unfinished proofs.
4. Use bounded search to discover candidate inputs where practical, then verify the candidate inside Lean. Failure to find a counterexample is inconclusive unless a separate proof establishes the mutant still satisfies the property.
5. Report proof broken, counterexample checked, mutant still satisfies property, and unresolved separately. A broken proof with no checked refutation never becomes a confirmed property violation.
6. Store reusable counterexamples next to the corresponding mutation and bind them to the implementation edit and property hashes. Invalidate them when either changes.
7. Apply the same evidence distinction to historical fixes. A restored pre-fix model plus a checked counterexample supports the claim that the property would reject that modeled bug. Replaying the actual production revision is a separate correspondence check.

### Acceptance criteria

- The three queue defects receive checked counterexamples.
- The vacuous theorem whose original proof breaks cannot receive a counterexample to its statement.
- A harmless reordered expression can break a tactic-dependent proof without becoming a confirmed bug.
- Syntax errors, compilation failures, changed property statements and stale evidence never count as checked counterexamples.
- Refutation attempts respect a configured resource budget and preserve unresolved obligations in the final report.

## Stage 5: reviewer workflow and evidence reporting

### Deliverables

A complete run that consumes the prior stages: specification drafting, optional independent review, accepted baseline, proof work, final gatekeeping and a readable evidence table.

### Implementation steps

1. Give the reviewer source, intended guarantees, assumptions, property statements and fix history. Preserve its independence from the modelling agent's completion report and choose another model family when the host supports that choice.
2. Ask for concrete counterexamples, satisfiability gaps and omitted caller guarantees, as well as mutation proposals. A finding that cannot be expressed as a one-file mutation remains actionable evidence for specification review.
3. Route proposed corrections through the amendment operation. Do not let a modelling agent update both the specification and its accepted baseline.
4. Keep a bounded review round and explicit proof/refutation budgets. When the budget ends, report remaining gaps and their evidence; avoid looping until an agent declares success.
5. Produce one per-target report showing source correspondence, baseline comparison, proof status, witness status, mutation proof sensitivity, checked refutations, historical replay and review status. Do not collapse these into a single confidence percentage.
6. Exercise normal interactive operation, already-authorized review, headless operation, interrupted runs and resume from existing evidence. Headless runs honor explicit review instructions and disclose when review was omitted.

### Acceptance criteria

- A reviewer-detected specification defect can be corrected without a production change and without an automatic approval loop.
- An attempted weakening is rejected unless the recorded policy or user decision permits it.
- An agent's claimed pass cannot override failing deterministic checks.
- A user can identify exactly what was proved, what was independently checked, and what remains assumed from the final table alone.

## Stage 6: compatibility, adoption and release

1. Run the ordinary helper and metadata tests, all lint hooks, bundled TLC/Lean/Kani examples and mutations, oldest-supported Lean checks, and the stronger-mode fixtures in CI.
2. Test three realistic repositories: an existing Lean model upgraded from an earlier template, a protocol with a past lost-wakeup fix, and a Kani harness that calls production code from another file. Report unsupported replay explicitly.
3. Measure added time and memory on the queue and one medium target. Record the measurement rather than promise a performance threshold before a baseline exists; agree acceptable budgets before making stronger checks default.
4. Document how existing records migrate. Avoid forcing a re-freeze solely to add reporting metadata; require review when trusted content or toolchain-dependent fingerprints change.
5. Update setup, references, templates, example reports and release notes together. Keep all runtime helpers and template assets under `skills/` so copied installations work.
6. Prepare the version bump and release PR only after the staged changes are accepted. After merge, follow the repository's tag-and-publish process and verify the publish run.

## Suggested order and review checkpoints

| PR | Scope | Depends on | Review checkpoint |
| --- | --- | --- | --- |
| A | Baseline manifest, capture/compare, amendment records and specification-first workflow | Coverage fix | Trust boundary and weakening policy are explicit and negative controls pass |
| B | Comparator feasibility spike and selected integration | A | Supported platforms, costs and dependency-closure behavior are demonstrated |
| C | Checked satisfiability witnesses and property mapping | A | Contradictory-premise negative fixture is rejected |
| D | Checked mutant counterexamples and historical replay evidence | B, C | Broken-proof false positives remain distinct from confirmed property violations |
| E | Reviewer orchestration, reporting and resume behavior | A–D | Complete runs succeed and incomplete runs disclose every gap |
| F | Compatibility migration, documentation and release | A–E | Cross-tool and cross-version checks pass; release scope is reviewed |

Comparator feasibility should be investigated early because platform support may affect B and D. No implementation estimate is reliable until that spike and the medium-target measurement have run. If cost is too high, ship A and C independently and retain an explicit unavailable or unresolved result for the stronger checks.

The decisions to review before implementation are the optional-mode policy, the required baseline isolation, supported comparator platforms, the scope of permitted specification amendments, and the proof/refutation resource budget. The recommendations above provide defaults; this document is not authorization to weaken those guarantees or implement the full plan.
