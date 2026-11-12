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
Errors in a theorem, example or #guard count only when the unmutated model has
the same statement as Lean elaborates it; renaming a definition that a statement
names, for example, changes that statement and gives the mutation no verdict.
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
import json
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from functools import partial
from pathlib import Path

# Importing kani and tlc must not write __pycache__ into the skill directory.
sys.dont_write_bytecode = True

import kani
import tlc

HERE = Path(__file__).resolve().parent
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
    source: str


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
    """Check one mutation's directives against its language and apply it to the model's text."""
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
    count = text.count(old) if old else 0
    if count != 1:
        stop(f"mutation '{label}': its - text occurs {count} times in {model}, want 1")
    detects, only = (lines[keyword][0].strip() if lines[keyword] else "" for keyword in SINGLE)
    new = "\n".join(lines["+"])
    return Mutation(label, detects, only, old, new, text.replace(old, new))


def check_tla(spec, checker, kinds, section, mutation, work):
    """Run the mutated spec through tlc-matrix.sh's runner with only the mutation's check; it covers the name it detects."""
    for module in spec.parent.glob("*.tla"):
        (work / module.name).write_text(module.read_text(encoding="utf-8"), encoding="utf-8")
    (work / spec.name).write_text(mutation.source, encoding="utf-8")
    kind, covers = kinds.get(mutation.detects, ""), frozenset({mutation.detects})
    if kind:
        checks = [tlc.Check(f"{kind} {mutation.detects}", kind, (mutation.detects,))]
    else:
        checks = [d for d in section if isinstance(d, tlc.Reach) and f"reach:{d.operator}" == mutation.detects]
    results = []
    runner = tlc.Runner(checker, work, mutation.only, results.append, work)
    for directive in [tlc.Spec(spec.name), *checks, *(d for d in section if isinstance(d, tlc.Run))]:
        runner.feed(directive)
    runner.finish_spec()
    if runner.runs_total == 0:
        return Result(Verdict.ERROR, f"no run matches '{mutation.only}'")
    if not runner.failed:
        return Result(Verdict.MISSED, covers=covers)
    if kind:
        # A deadlock stops the system for good, so it breaks a temporal property but no invariant.
        signs = ["violated"] + (["Deadlock reached"] if kind.startswith("PROPERT") else [])
        for result in results:
            if result.outcome is tlc.Outcome.FAIL and any(sign in result.detail for sign in signs):
                error = result.detail.removeprefix("Error: ").rstrip(".")
                return Result(Verdict.DETECTED, f"{mutation.detects} fails in run '{result.label}' ({error})", covers)
    else:
        for result in results:
            if result.outcome is tlc.Outcome.UNREACHED:
                return Result(Verdict.DETECTED, f"{mutation.detects} fails in run '{result.label}' (the model never reaches this state)", covers)
    return Result(Verdict.ERROR, "\n".join(line for result in results for line in tlc.render(result)))


def lean_toolchain(project):
    """Return the project's Lean pin once it is ready; lean-tools.sh owns the check and its remedy."""
    done = subprocess.run(["bash", "-c", 'source "$1/lean-tools.sh" && lean_ready_pin "$2"', "bash", str(HERE), str(project)],
                          capture_output=True, text=True, check=False)
    if done.returncode:
        print(done.stdout.strip())
        sys.exit(done.returncode)
    return done.stdout.strip()


def lean_analysis(model, project, toolchain):
    """Get Lean's declaration identities and error positions, never infer them from source text."""
    done = subprocess.run(["elan", "run", toolchain, "lake", "--dir", str(project), "env", "lean", "--run",
                           str(HERE / "lean-mutations.lean"), str(model)], capture_output=True, text=True, check=False)
    output = done.stdout + done.stderr
    records = [line.removeprefix("AFV_LEAN ") for line in done.stdout.splitlines() if line.startswith("AFV_LEAN ")]
    if done.returncode != 0 or len(records) != 1:
        stop(f"Lean declaration analysis did not complete:\n{output.strip()}")
    try:
        analysis = json.loads(records[0])
        for field in ("declarations", "commands", "errors"):
            if not isinstance(analysis[field], list):
                raise TypeError(f"{field} must be a list")
    except (ValueError, KeyError, TypeError) as error:
        stop(f"invalid Lean declaration analysis: {error}")
    return analysis


def contains(item, position):
    return item["start"] <= position < item["end"]


def original_location(model, mutation, position):
    """Map an unchanged command back across the one replacement; label inserted commands explicitly."""
    original, old, new = model.read_text(encoding="utf-8"), mutation.old, mutation.new
    start = original.index(old)
    offset = sum(len(line) + 1 for line in mutation.source.split("\n")[:position[0] - 1]) + position[1]
    if offset < start:
        original_offset, suffix = offset, ""
    elif offset >= start + len(new):
        original_offset, suffix = offset + len(old) - len(new), ""
    else:
        original_offset, suffix = start, " (mutation replacement)"
    line = original.count("\n", 0, original_offset) + 1
    return f"{model}:{line}{suffix}"


def check_lean(model, project, toolchain, unmutated_statements, mutation, work):
    """Attribute every error to an elaborated theorem, or else a guard/example command, whose statement the unmutated model also has; the mutation covers those."""
    copy = work / model.name
    copy.write_text(mutation.source, encoding="utf-8")
    analysis = lean_analysis(copy, project, toolchain)
    if not analysis["errors"]:
        return Result(Verdict.MISSED)
    failed = []
    for error in analysis["errors"]:
        position = [error["pos"]["line"], error["pos"]["column"]]
        where = f"{error['fileName']}:{position[0]}:{position[1]}: {error['data']}"
        checks = [("theorem " + decl["name"], (decl["name"], decl["type"]))
                  for decl in analysis["declarations"] if decl["theorem"] and contains(decl, position)]
        if not checks:
            checks = [(f"{cmd['property']} at {original_location(model, mutation, cmd['start'])}",
                       (cmd["property"], cmd["statement"]))
                      for cmd in analysis["commands"] if cmd["property"] and contains(cmd, position)]
        for name, key in checks:
            if key not in unmutated_statements:
                return Result(Verdict.ERROR, f"{name}: the mutation changes its statement, "
                                             f"so this error does not show its proof or check failing\n{where}")
        if error["fileName"] != str(copy) or not checks:
            return Result(Verdict.ERROR, where)
        failed.extend(name for name, _ in checks if name not in failed)
    return Result(Verdict.DETECTED, "proof/check fails: " + "; ".join(failed), frozenset(failed))


def check_rust(model, project, verifier, bounds, mutation, work):
    """Run Kani on the named harness in a mutated copy of the crate; the mutation covers that harness."""
    copy, covers = work / "crate", frozenset({mutation.detects})
    shutil.copytree(project, copy, ignore=shutil.ignore_patterns("target", ".git"))
    (copy / model.relative_to(project)).write_text(mutation.source, encoding="utf-8")
    outcome = kani.verify(copy, work, verifier, mutation.detects, bounds[mutation.detects])
    if outcome.verdict is kani.Verdict.PASS:
        return Result(Verdict.MISSED, covers=covers)
    if outcome.verdict is kani.Verdict.REFUTED:
        return Result(Verdict.DETECTED, "; ".join(outcome.failures), covers)
    return Result(Verdict.ERROR, "\n".join(outcome.failures) + "\n" + outcome.output)


def project_root(model, *markers):
    return next((parent for parent in model.parents if any((parent / marker).is_file() for marker in markers)), None)


def tla_runner(spec, mutations):
    """Take the checks, reach operators and runs of spec's section of its matrix, and check TLC once."""
    matrix = spec.with_suffix(".matrix")
    if not matrix.is_file():
        stop(f"{matrix} is missing; mutations use its checks and runs")
    section, ours = [], False
    for directive in tlc.directives(tlc.read_raw(matrix).split("\n")):
        if isinstance(directive, tlc.Malformed):
            stop(f"{matrix}: {directive.message}")
        if isinstance(directive, tlc.Spec):
            ours = (matrix.parent / directive.path).resolve() == spec
        elif ours:
            section.append(directive)
    kinds = {name: d.kind for d in section if isinstance(d, tlc.Check) for name in d.names}
    reaches = {f"reach:{d.operator}" for d in section if isinstance(d, tlc.Reach)}
    for mutation in mutations:
        if mutation.detects not in kinds and mutation.detects not in reaches:
            stop(f"mutation '{mutation.label}': detects '{mutation.detects}', which {matrix} does not check")
    try:
        checker = tlc.Tlc()
    except tlc.Unavailable as error:
        print(error)
        sys.exit(3)
    return set(kinds), partial(check_tla, spec, checker, kinds, section)


def frozen_theorems(model):
    """Return the theorem names the model's .statements record holds."""
    record = model.with_suffix(".statements")
    if not record.is_file():
        stop(f"{record} is missing; freeze the model with lean-check.sh --freeze before checking its mutations")
    try:
        return {entry["name"] for entry in json.loads(record.read_text(encoding="utf-8"))["declarations"]
                if entry["kind"] == "theorem"}
    except (OSError, ValueError, KeyError, TypeError) as error:
        stop(f"invalid statements record {record}: {error}")


def lean_runner(model, mutations):
    """Target the frozen theorems that Lean finds public in the source, including their namespaces."""
    project = project_root(model, "lakefile.toml", "lakefile.lean")
    if project is None:
        stop(f"{model} is in no Lake project")
    frozen = frozen_theorems(model)
    toolchain = lean_toolchain(project)
    analysis = lean_analysis(model, project, toolchain)
    if analysis["errors"]:
        stop(f"unmutated Lean model does not elaborate: {analysis['errors'][0]['data']}")
    targets = {"theorem " + decl["name"] for decl in analysis["declarations"]
               if decl["theorem"] and not decl["private"] and decl["name"] in frozen}
    statements = {(decl["name"], decl["type"]) for decl in analysis["declarations"] if decl["theorem"]}
    statements |= {(cmd["property"], cmd["statement"]) for cmd in analysis["commands"]
                   if cmd["property"] and cmd["statement"] is not None}
    return targets, partial(check_lean, model, project, toolchain, statements)


def rust_runner(model, mutations):
    project = project_root(model, "Cargo.toml")
    if project is None:
        stop(f"{model} is in no Rust crate")
    try:
        verifier = kani.Kani()
    except kani.Unavailable as error:
        print(f"UNAVAILABLE {error}")
        sys.exit(3)
    with tempfile.TemporaryDirectory(prefix="formal-kani-discover-") as temporary:
        try:
            bounds = kani.discover(project, Path(temporary), verifier)
        except kani.CheckError as error:
            stop(str(error))
    for mutation in mutations:
        if mutation.detects not in bounds:
            stop(f"mutation '{mutation.label}': unknown harness '{mutation.detects}'")
    return set(bounds), partial(check_rust, model, project, verifier, bounds)


# Each runner checks the names the mutations detect, then returns the names they must cover and a check for one mutation.
# A TLA+ or Rust mutation covers the name it detects; a Lean mutation covers the theorems that fail on it.
LANGUAGES = {
    ".tla": Language("TLA+", needs_detects=True, takes_only=True, runner=tla_runner),
    ".lean": Language("Lean", needs_detects=False, takes_only=False, runner=lean_runner),
    ".rs": Language("Rust", needs_detects=True, takes_only=False, runner=rust_runner),
}


def main():
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

    detected, covered = 0, set()
    for mutation in mutations:
        with tempfile.TemporaryDirectory() as work:
            result = check(mutation, Path(work))
        if result.verdict is Verdict.ERROR:
            stop(f"mutation '{mutation.label}' did not reach a verdict:\n{result.detail.strip()}")
        detected += result.verdict is Verdict.DETECTED
        covered |= result.covers
        print(f"{result.verdict.value} {mutation.label}" + (f": {result.detail}" if result.detail else ""))
    uncovered = sorted(targets - covered)
    for name in uncovered:
        print(f"UNCOVERED {name}")
    if model.suffix == ".lean":
        print(LEAN_NOTE)
    print(f"SUMMARY {detected} of {len(mutations)} mutations detected"
          + (f", {len(uncovered)} properties without a mutation" if uncovered else ""))
    sys.exit(0 if detected == len(mutations) and not uncovered else 1)


if __name__ == "__main__":
    main()
