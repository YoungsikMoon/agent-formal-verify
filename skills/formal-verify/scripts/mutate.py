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
Lean reports fully qualified theorem names from elaborated declarations.
This measures proof sensitivity, not whether a mutated statement is false or
its hypotheses can hold. Private theorems are proof helpers and need no mutation. Exits 1 on a MISSED or
UNCOVERED line, when a Lean model has no .statements file, or when a mutated
model fails for another reason, such as a syntax error or a definition that
no longer compiles.

Mutations file (a line starting with # is a comment):
  mutation <label>          starts a mutation
  detects <Property>        TLA+ property or fully qualified Rust harness that must fail
  detects reach:<Operator>  TLA+ only: the reach check that must fail
  only <label-substring>    TLA+ only, optional: limits the matrix runs
  - <text>                  a line of the model to replace; the text of
                            consecutive lines must occur exactly once
  + <text>                  a line of the replacement; none deletes the text

Usage: mutate.py <Name.mutations>
  The environment settings of tlc-matrix.sh apply to TLA+ mutations.
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path

# Importing kani must not write __pycache__ into the skill directory.
sys.dont_write_bytecode = True

import kani

HERE = Path(__file__).resolve().parent
LEAN_NOTE = "NOTE Lean detections mean existing proofs fail, not that theorem statements are false or hypotheses satisfiable."
# Fails the same way as lean-check.sh when the pin is not ready, without installing it.
LEAN = """source "$1/lean-tools.sh"
toolchain=$(lean_pin "$2") || { status=$?; echo "$toolchain"; exit "$status"; }
lean_pin_ready "$toolchain" || { echo "UNAVAILABLE $toolchain is not ready; run bash $1/setup.sh lean $2"; exit 3; }
elan run "$toolchain" lake --dir "$2" env lean --run "$1/lean-mutations.lean" "$3"
"""


@dataclass
class Mutation:
    label: str
    detects: str = ""
    only: str = ""
    old: list = field(default_factory=list)
    new: list = field(default_factory=list)
    failed: list = field(default_factory=list)


def stop(message, status=1):
    print(f"FAIL {message}")
    sys.exit(status)


def parse(path):
    if not path.is_file():
        stop(f"{path} does not exist")
    mutations = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        keyword, _, rest = line.partition(" ")
        if keyword == "mutation":
            mutations.append(Mutation(rest.strip()))
        elif not mutations:
            stop(f"{path}:{number}: '{line}' before any mutation line")
        elif keyword in ("detects", "only"):
            setattr(mutations[-1], keyword, rest.strip())
        elif keyword in ("-", "+"):
            (mutations[-1].old if keyword == "-" else mutations[-1].new).append(rest)
        else:
            stop(f"{path}:{number}: unknown directive: {line}")
    if not mutations:
        stop(f"{path} has no mutation")
    return mutations


def mutated(model, mutation):
    text, old = model.read_text(encoding="utf-8"), "\n".join(mutation.old)
    count = text.count(old) if old else 0
    if count != 1:
        stop(f"mutation '{mutation.label}': its - text occurs {count} times in {model}, want 1")
    return text.replace(old, "\n".join(mutation.new))


def matrix_of(spec):
    """Return property kinds, reach directives by operator, and run lines for spec."""
    matrix, kinds, reaches, runs, ours = spec.with_suffix(".matrix"), {}, {}, [], False
    if not matrix.is_file():
        stop(f"{matrix} is missing; mutations use its checks and runs")
    for line in matrix.read_text(encoding="utf-8").splitlines():
        keyword, _, rest = line.split("#")[0].strip().partition(" ")
        if keyword == "spec":
            ours = rest.strip() == spec.name
        elif ours and keyword == "check":
            parts = rest.split()
            if len(parts) < 2 or parts[0] not in ("INVARIANT", "INVARIANTS", "PROPERTY", "PROPERTIES"):
                stop(f"{matrix}: malformed check '{rest}'")
            kind, *names = parts
            kinds.update(dict.fromkeys(names, kind))
        elif ours and keyword == "run":
            runs.append(f"run {rest}")
        elif ours and keyword == "reach":
            operator, bar, label = rest.partition("|")
            operator = operator.strip()
            if not bar or not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", operator) or not label.strip():
                stop(f"{matrix}: malformed reach '{rest}'")
            reaches.setdefault(f"reach:{operator}", []).append(f"reach {rest}")
    return kinds, reaches, runs


def check_tla(spec, kinds, reaches, runs, mutation, work):
    """Return (verdict, detail) from the mutation's property or reach checks."""
    kind = kinds.get(mutation.detects, "")
    for module in spec.parent.glob("*.tla"):
        (work / module.name).write_text(module.read_text(encoding="utf-8"), encoding="utf-8")
    (work / spec.name).write_text(mutated(spec, mutation), encoding="utf-8")
    matrix = work / spec.with_suffix(".matrix").name
    checks = reaches.get(mutation.detects, [f"check {kind} {mutation.detects}"])
    matrix.write_text("\n".join([f"spec {spec.name}", *checks, *runs]) + "\n", encoding="utf-8")
    command = ["bash", str(HERE / "tlc-matrix.sh"), str(matrix), *([mutation.only] if mutation.only else [])]
    done = subprocess.run(command, capture_output=True, text=True, check=False)
    if done.returncode == 3:
        return "UNAVAILABLE", done.stdout + done.stderr
    if done.returncode == 0:
        return "MISSED", ""
    if mutation.detects in reaches:
        prefix = f"FAIL {spec.stem} reach {mutation.detects.removeprefix('reach:')} "
        suffix = ": the model never reaches this state"
        for line in done.stdout.splitlines():
            if line.startswith(prefix) and line.endswith(suffix):
                label = line[len(prefix):-len(suffix)]
                return "DETECTED", f"{mutation.detects} fails in run '{label}' (the model never reaches this state)"
        return "ERROR", done.stdout + done.stderr
    # A deadlock stops the system for good, so it breaks a temporal property but no invariant.
    signs = ["violated"] + (["Deadlock reached"] if kind.startswith("PROPERT") else [])
    for line in done.stdout.splitlines():
        if line.startswith("FAIL ") and any(sign in line for sign in signs):
            run, _, error = line.removeprefix(f"FAIL {spec.stem} ").partition(": Error: ")
            return "DETECTED", f"{mutation.detects} fails in run '{run}' ({error.rstrip('.')})"
    return "ERROR", done.stdout + done.stderr


def lean_analysis(model, project):
    """Get Lean's declaration identities and error positions, never infer them from source text."""
    done = subprocess.run(["bash", "-c", LEAN, "bash", str(HERE), str(project), str(model)],
                          capture_output=True, text=True, check=False)
    output = done.stdout + done.stderr
    if done.returncode == 3:
        print(output.strip())
        sys.exit(3)
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


def original_location(model, mutation, source, position):
    """Map an unchanged command back across the one replacement; label inserted commands explicitly."""
    original = model.read_text(encoding="utf-8")
    old, new = "\n".join(mutation.old), "\n".join(mutation.new)
    start = original.index(old)
    offset = sum(len(line) + 1 for line in source.split("\n")[:position[0] - 1]) + position[1]
    if offset < start:
        original_offset, suffix = offset, ""
    elif offset >= start + len(new):
        original_offset, suffix = offset + len(old) - len(new), ""
    else:
        original_offset, suffix = start, " (mutation replacement)"
    line = original.count("\n", 0, original_offset) + 1
    return f"{model}:{line}{suffix}"


def check_lean(model, project, mutation, work):
    """Attribute every error to an elaborated theorem or a parsed guard/example command."""
    copy = work / model.name
    source = mutated(model, mutation)
    copy.write_text(source, encoding="utf-8")
    analysis = lean_analysis(copy, project)
    if not analysis["errors"]:
        return "MISSED", ""
    failed = []
    for error in analysis["errors"]:
        position = [error["pos"]["line"], error["pos"]["column"]]
        names = ["theorem " + decl["name"] for decl in analysis["declarations"]
                 if decl["theorem"] and contains(decl, position)]
        if not names:
            names = [f"{cmd['property']} at {original_location(model, mutation, source, cmd['start'])}"
                     for cmd in analysis["commands"]
                     if cmd["property"] and contains(cmd, position)]
        if error["fileName"] != str(copy) or not names:
            return "ERROR", f"{error['fileName']}:{position[0]}:{position[1]}: {error['data']}"
        failed.extend(name for name in names if name not in failed)
    mutation.failed = failed
    return "DETECTED", "proof/check fails: " + "; ".join(failed)


def check_rust(model, project, verifier, bounds, mutation, work):
    """Return (verdict, detail) from Kani on the named harness in a mutated copy of the crate."""
    copy = work / "crate"
    shutil.copytree(project, copy, ignore=shutil.ignore_patterns("target", ".git"))
    (copy / model.relative_to(project)).write_text(mutated(model, mutation), encoding="utf-8")
    outcome = kani.verify(copy, work, verifier, mutation.detects, bounds[mutation.detects])
    if outcome.verdict is kani.Verdict.PASS:
        return "MISSED", ""
    if outcome.verdict is kani.Verdict.REFUTED:
        return "DETECTED", "; ".join(outcome.failures)
    return "ERROR", "\n".join(outcome.failures) + "\n" + outcome.output


def project_root(model, *markers):
    return next((parent for parent in model.parents if any((parent / marker).is_file() for marker in markers)), None)


def tla_runner(spec, mutations):
    kinds, reaches, runs = matrix_of(spec)
    for mutation in mutations:
        if mutation.detects not in kinds and mutation.detects not in reaches:
            stop(f"mutation '{mutation.label}': detects '{mutation.detects}', which {spec.with_suffix('.matrix')} does not check")
    return set(kinds), partial(check_tla, spec, kinds, reaches, runs)


def lean_theorems(model, project):
    """Intersect frozen identities with Lean's public source declarations, including their namespaces."""
    record = model.with_suffix(".statements")
    if not record.is_file():
        stop(f"{record} is missing; freeze the model with lean-check.sh --freeze before checking its mutations")
    try:
        frozen = {entry["name"] for entry in json.loads(record.read_text(encoding="utf-8"))["declarations"]
                  if entry["kind"] == "theorem"}
    except (OSError, ValueError, KeyError, TypeError) as error:
        stop(f"invalid statements record {record}: {error}")
    analysis = lean_analysis(model, project)
    if analysis["errors"]:
        stop(f"unmutated Lean model does not elaborate: {analysis['errors'][0]['data']}")
    return {"theorem " + decl["name"] for decl in analysis["declarations"]
            if decl["theorem"] and not decl["private"] and decl["name"] in frozen}


def lean_runner(model, mutations):
    project = project_root(model, "lakefile.toml", "lakefile.lean")
    if project is None:
        stop(f"{model} is in no Lake project")
    for mutation in mutations:
        if mutation.detects:
            stop(f"mutation '{mutation.label}': Lean mutations take no detects line; the runner names the theorems that fail")
    return lean_theorems(model, project), partial(check_lean, model, project)


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
        if mutation.only:
            stop("Rust mutations do not support 'only'")
    return set(bounds), partial(check_rust, model, project, verifier, bounds)


# Each runner validates the mutations, then returns the names they must cover and a check for one mutation.
# A TLA+ or Rust mutation covers the name it detects; a Lean mutation covers the theorems that fail on it.
RUNNERS = {".tla": tla_runner, ".lean": lean_runner, ".rs": rust_runner}


def main():
    if len(sys.argv) != 2:
        stop("usage: mutate.py <Name.mutations>", 2)
    path = Path(sys.argv[1]).resolve()
    mutations = parse(path)
    models = [path.with_suffix(suffix) for suffix in RUNNERS]
    model = next((model for model in models if model.is_file()), None)
    if model is None:
        stop(f"no {', '.join(model.name for model in models[:-1])} or {models[-1].name} beside {path}")
    targets, check = RUNNERS[model.suffix](model, mutations)

    detected = 0
    for mutation in mutations:
        with tempfile.TemporaryDirectory() as work:
            verdict, detail = check(mutation, Path(work))
        if verdict == "UNAVAILABLE":
            print(detail.strip())
            sys.exit(3)
        if verdict == "ERROR":
            stop(f"mutation '{mutation.label}' did not reach a verdict:\n{detail.strip()}")
        detected += verdict == "DETECTED"
        print(f"{verdict} {mutation.label}" + (f": {detail}" if detail else ""))
    covered = {mutation.detects for mutation in mutations}.union(*(mutation.failed for mutation in mutations))
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
