#!/usr/bin/env python3
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Check that a model's properties detect the bugs in its mutations file.

Takes <Name>.mutations, which sits beside <Name>.tla and <Name>.matrix or
beside <Name>.lean in a Lake project or <Name>.rs in a Rust crate. Applies each mutation to a temporary
copy, so the model in the repository is never changed, and prints one line
per mutation:

  DETECTED <label>: <what failed>   the mutated model fails as it should
  MISSED <label>                    the mutated model still passes
  UNCOVERED <Property>              a TLA+ property or Rust harness no mutation
                                    targets, or a Lean proof no mutation breaks

A TLA+ mutation is checked against the property or reach operator it names,
using the matrix runs. A Lean mutation is elaborated in the project, the mutated
module alone, and reported with the theorems, lemmas, examples and #guard
lines that fail. Every public theorem recorded in the model's .statements file
must have its proof fail on some mutation; a failing #guard does not cover it.
An error counts only for an original theorem, example or #guard with the same
elaborated statement. A new example cannot count by repeating an existing one's
statement. A changed statement gives the mutation no verdict.
Lean reports fully qualified theorem names from elaborated declarations.
This measures proof sensitivity, not whether a mutated statement is false or
its hypotheses can hold. Private theorems are proof helpers and need no mutation. Exits 1 on a MISSED or
UNCOVERED line, when a Lean model has no .statements file, or when a mutated
model fails for another reason, such as a syntax error, a definition that
no longer compiles or a Lean theorem, example or #guard whose statement the
mutation changes.

Mutations file (a line starting with # is a comment):
  mutation <label>          starts a mutation
  detects <Property>        TLA+ property or fully qualified Rust harness that must fail
  detects reach:<Operator>  TLA+ only: the reach check that must fail
  only <label-substring>    TLA+ only, optional: limits the matrix runs
  - <text>                  a line of the model to replace; the text of
                            consecutive lines must occur exactly once
  + <text>                  a line of the replacement; none deletes the text

A TLA+ or Rust mutation needs one detects line, and a Lean mutation takes
none. The runner reads every mutation and applies it to the model's text
before it runs any tool, so a malformed mutation stops the run first.

Usage: mutate.py <Name.mutations>
  The environment settings of tlc-matrix.sh apply to TLA+ mutations.
"""
import signal

if __name__ == "__main__":
    # Python's SIGINT handler raises KeyboardInterrupt, which prints a traceback when it arrives during the imports.
    # Until runner.run installs its own handlers, the default action ends the process by the signal instead.
    if signal.getsignal(signal.SIGINT) is signal.default_int_handler:
        signal.signal(signal.SIGINT, signal.SIG_DFL)

import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from functools import partial
from pathlib import Path

# Copied skills can be read-only. Keep imported helpers from writing __pycache__ there.
sys.dont_write_bytecode = True

import kani
import lean_mutations
import runner
import storage
import tlc

LEAN_NOTE = "NOTE Lean detections mean existing proofs fail, not that theorem statements are false or hypotheses satisfiable."


DIRECTIVES = ("detects", "only", "-", "+")
SINGLE = ("detects", "only")


@dataclass(frozen=True)
class Language:
    name: str
    needs_detects: bool
    takes_only: bool
    runner: Callable


@dataclass(frozen=True)
class Mutation:
    label: str
    detects: str
    only: str
    old: str
    new: str
    original: str
    start: int

    def apply(self):
        return "".join((self.original[:self.start], self.new, self.original[self.start + len(self.old):]))


class Verdict(Enum):
    DETECTED = "DETECTED"
    MISSED = "MISSED"
    ERROR = "ERROR"


@dataclass(frozen=True)
class Result:
    verdict: Verdict
    detail: str = ""
    covers: frozenset = frozenset()


def stop(message, status=1):
    print(f"FAIL {message}")
    sys.exit(status)


def parse(path):
    """Return each mutation's label with its directives as (keyword, rest) pairs, in file order."""
    mutations = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        keyword, _, rest = line.partition(" ")
        if keyword == "mutation":
            mutations.append((rest.strip(), []))
        elif not mutations:
            stop(f"{path}:{number}: '{line}' before any mutation line")
        elif keyword in DIRECTIVES:
            mutations[-1][1].append((keyword, rest))
        else:
            stop(f"{path}:{number}: unknown directive: {line}")
    if not mutations:
        stop(f"{path} has no mutation")
    return mutations


def make_mutation(label, directives, model, text, language):
    """Validate one mutation and locate its edit in the original model."""
    lines = {keyword: [rest for word, rest in directives if word == keyword] for keyword in DIRECTIVES}
    for keyword in SINGLE:
        if len(lines[keyword]) > 1:
            stop(f"mutation '{label}' has two {keyword} lines")
    if lines["detects"] and not language.needs_detects:
        stop(f"mutation '{label}': {language.name} mutations take no detects line; the runner names the theorems that fail")
    if language.needs_detects and not lines["detects"]:
        stop(f"mutation '{label}' has no detects line")
    if lines["only"] and not language.takes_only:
        stop(f"mutation '{label}': {language.name} mutations do not support 'only'")
    old = "\n".join(lines["-"])
    start = text.find(old) if old else -1
    if start < 0 or text.find(old, start + len(old)) >= 0:
        count = text.count(old) if old else 0
        stop(f"mutation '{label}': its - text occurs {count} times in {model}, want 1")
    detects, only = (lines[keyword][0].strip() if lines[keyword] else "" for keyword in SINGLE)
    new = "\n".join(lines["+"])
    return Mutation(label, detects, only, old, new, text, start)


def check_tla(plan, checker, mutation, work):
    try:
        detection = plan.check(checker, mutation.detects, mutation.only, mutation.apply(), work)
    except ValueError as error:
        return Result(Verdict.ERROR, str(error))
    covers = frozenset({mutation.detects})
    if detection is None:
        return Result(Verdict.MISSED, covers=covers)
    return Result(Verdict.DETECTED, detection, covers)


def check_lean(broken_checks, mutation, work):
    try:
        failures = broken_checks(mutation, work)
    except ValueError as error:
        return Result(Verdict.ERROR, str(error))
    if not failures:
        return Result(Verdict.MISSED)
    return Result(Verdict.DETECTED, "proof/check fails: " + "; ".join(failures), frozenset(failures))


def check_rust(model, project, verifier, bounds, sources, mutation, work):
    """Run Kani on the named harness in a mutated copy of the crate; the mutation covers that harness."""
    copy = sources.stage(project, work)
    covers = frozenset({mutation.detects})
    (copy / model.relative_to(project)).write_text(mutation.apply(), encoding="utf-8")
    # Cargo resolves configuration from cwd, including paths outside the copied packages.
    outcome = kani.verify(copy, work, verifier, mutation.detects, bounds[mutation.detects].unwind, cwd=project)
    if outcome.verdict is kani.Verdict.PASS:
        return Result(Verdict.MISSED, covers=covers)
    if outcome.verdict is kani.Verdict.REFUTED:
        return Result(Verdict.DETECTED, "; ".join(outcome.failures), covers)
    return Result(Verdict.ERROR, "\n".join(outcome.failures) + "\n" + outcome.output)


def project_root(model, *markers):
    return next((parent for parent in model.parents if any((parent / marker).is_file() for marker in markers)), None)


def tla_runner(spec, mutations):
    """Preserve the execution plan of every matching spec section, check TLC once, and pass the unmutated
    spec on every run the mutations select."""
    matrix = spec.with_suffix(".matrix")
    if not matrix.is_file():
        stop(f"{matrix} is missing; mutations use its checks and runs")
    try:
        plan = tlc.MatrixPlan(matrix).mutations_for(spec)
    except ValueError as error:
        stop(str(error))
    for mutation in mutations:
        if mutation.detects not in plan.detectors:
            stop(f"mutation '{mutation.label}': detects '{mutation.detects}', which {matrix} does not check")
        try:
            plan.selected(mutation.detects, mutation.only)
        except ValueError as error:
            stop(f"mutation '{mutation.label}': {error}")
    checker = tlc.Tlc()
    with tempfile.TemporaryDirectory(prefix="formal-tlc-originals-", dir=storage.ensure_temp_root()) as temporary:
        try:
            plan.check_originals(checker, [(mutation.detects, mutation.only) for mutation in mutations], Path(temporary))
        except ValueError as error:
            stop(str(error))
    return plan.properties, partial(check_tla, plan, checker)


def lean_runner(model, mutations):
    """Target the frozen theorems that Lean finds public in the source, including their namespaces."""
    project = project_root(model, "lakefile.toml", "lakefile.lean")
    if project is None:
        stop(f"{model} is in no Lake project")
    targets, broken_checks = lean_mutations.prepare(model, project)
    return targets, partial(check_lean, broken_checks)


def rust_runner(model, mutations):
    project = project_root(model, "Cargo.toml")
    if project is None:
        stop(f"{model} is in no Rust crate")
    verifier = kani.Kani()
    with tempfile.TemporaryDirectory(prefix="formal-kani-discover-", dir=storage.ensure_temp_root()) as temporary:
        work = Path(temporary)
        try:
            bounds = kani.discover(project, work, verifier)
            sources = verifier.crate_sources(project)
            for mutation in mutations:
                if mutation.detects not in bounds:
                    stop(f"mutation '{mutation.label}': unknown harness '{mutation.detects}'")
            selected = {mutation.detects for mutation in mutations}
            kani.reject_should_panic(bounds, sorted(selected))
            for name in sorted(selected):
                outcome = kani.verify(project, work, verifier, name, bounds[name].unwind)
                if outcome.verdict is not kani.Verdict.PASS:
                    stop(f"unmutated Rust harness '{name}' did not pass: "
                         + "; ".join(outcome.failures) + "\n" + outcome.output)
        except kani.CheckError as error:
            stop(str(error))
    targets = {name for name, harness in bounds.items() if harness.source == model} | selected
    return targets, partial(check_rust, model, project, verifier, bounds, sources)


# Each runner checks the names the mutations detect and that the unmutated model passes the checks they select,
# then returns the names they must cover and a check for one mutation.
# A TLA+ or Rust mutation covers the name it detects; a Lean mutation covers the theorems that fail on it.
LANGUAGES = {
    ".tla": Language("TLA+", needs_detects=True, takes_only=True, runner=tla_runner),
    ".lean": Language("Lean", needs_detects=False, takes_only=False, runner=lean_runner),
    ".rs": Language("Rust", needs_detects=True, takes_only=False, runner=rust_runner),
}


def main():
    # A FAIL line can carry Lean's UTF-8 messages, so write them as UTF-8 whatever the locale, as lean.py does.
    sys.stdout.reconfigure(encoding="utf-8", errors="surrogateescape")
    # Users run this file directly, so no shell helper has checked the version for the Rust runner.
    if sys.version_info < (3, 9):  # noqa: UP036 -- ruff assumes the floor this line enforces
        print(f"UNAVAILABLE python3 is Python {'.'.join(map(str, sys.version_info[:3]))}; install Python 3.9 or later")
        sys.exit(3)
    if len(sys.argv) != 2:
        stop("usage: mutate.py <Name.mutations>", 2)
    path = Path(sys.argv[1]).resolve()
    if not path.is_file():
        stop(f"{path} does not exist")
    models = [path.with_suffix(suffix) for suffix in LANGUAGES]
    model = next((model for model in models if model.is_file()), None)
    if model is None:
        stop(f"no {', '.join(model.name for model in models[:-1])} or {models[-1].name} beside {path}")
    language, text = LANGUAGES[model.suffix], model.read_text(encoding="utf-8")
    mutations = [make_mutation(label, directives, model, text, language) for label, directives in parse(path)]
    targets, check = language.runner(model, mutations)
    storage.warn_runtime()
    temp_root = storage.ensure_temp_root()

    detected, covered = 0, set()
    for mutation in mutations:
        with tempfile.TemporaryDirectory(dir=temp_root) as work:
            result = check(mutation, Path(work))
        if result.verdict is Verdict.ERROR:
            stop(f"mutation '{mutation.label}' did not reach a verdict:\n{result.detail.strip()}")
        detected += result.verdict is Verdict.DETECTED
        covered |= result.covers
        print(f"{result.verdict.value} {mutation.label}" + (f": {result.detail}" if result.detail else ""), flush=True)
    uncovered = sorted(targets - covered)
    for name in uncovered:
        print(f"UNCOVERED {name}")
    if model.suffix == ".lean":
        print(LEAN_NOTE)
    print(f"SUMMARY {detected} of {len(mutations)} mutations detected"
          + (f", {len(uncovered)} properties without a mutation" if uncovered else ""))
    return 0 if detected == len(mutations) and not uncovered else 1


if __name__ == "__main__":
    try:
        runner.run(main)
    except lean_mutations.AnalysisError as error:
        print(error)
        sys.exit(error.status)
