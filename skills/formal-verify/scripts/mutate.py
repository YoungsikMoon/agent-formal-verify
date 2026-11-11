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
                                    targets, or a Lean theorem no mutation breaks

A TLA+ mutation is checked against the property or reach operator it names,
using the matrix runs. A Lean mutation is elaborated in the project, the mutated
module alone, and reported with the theorems, lemmas, examples and #guard
lines that fail. Every public theorem recorded in the model's .statements file
must fail on some mutation itself; a failing #guard does not cover it. Private
theorems are proof helpers and need no mutation. Exits 1 on a MISSED or
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
LEAN_PROPERTY = ("theorem", "lemma", "example", "#guard")
LEAN_DECLARATION = re.compile(r"^(?:@\[.*?\] |private |protected |noncomputable )*((?:theorem|lemma|def|abbrev|instance|example|structure|inductive)\b(?: [^\s:(\[{]+)?|#guard.*|#eval.*)")
# Fails the same way as lean-check.sh when the pin is not ready, without installing it.
LEAN = """source "$1/lean-tools.sh"
toolchain=$(lean_pin "$2") || { status=$?; echo "$toolchain"; exit "$status"; }
lean_pin_ready "$toolchain" || { echo "UNAVAILABLE $toolchain is not ready; run bash $1/setup.sh lean $2"; exit 3; }
elan run "$toolchain" lake --dir "$2" env lean "$3"
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


def check_lean(model, project, mutation, work):
    """Return (verdict, detail) from Lean on the mutated module."""
    source, copy = mutated(model, mutation), work / model.name
    copy.write_text(source, encoding="utf-8")
    done = subprocess.run(["bash", "-c", LEAN, "bash", str(HERE), str(project), str(copy)],
                          capture_output=True, text=True, check=False)
    output = done.stdout + done.stderr
    if done.returncode == 3:
        return "UNAVAILABLE", done.stdout + done.stderr
    if done.returncode == 0:
        return "MISSED", ""
    lines, failed = source.splitlines(), []
    for match in re.finditer(rf"^{re.escape(str(copy))}:(\d+):\d+: error", output, re.MULTILINE):
        for line in reversed(lines[:int(match[1])]):
            if declaration := LEAN_DECLARATION.match(line):
                if declaration[1] not in failed:
                    failed.append(declaration[1])
                break
    if not failed or not all(name.startswith(LEAN_PROPERTY) for name in failed):
        return "ERROR", output
    mutation.failed = failed
    return "DETECTED", "fails " + "; ".join(failed)


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


def lean_theorems(model):
    """Return the public theorems of model that its .statements file records, as check_lean names them."""
    record = model.with_suffix(".statements")
    if not record.is_file():
        stop(f"{record} is missing; freeze the model with lean-check.sh --freeze before checking its mutations")
    frozen = [entry["name"] for entry in json.loads(record.read_text(encoding="utf-8"))["declarations"]
              if entry["kind"] == "theorem"]
    theorems = set()
    for line in model.read_text(encoding="utf-8").splitlines():
        declaration = LEAN_DECLARATION.match(line)
        if not declaration or not declaration[1].startswith(("theorem ", "lemma ")) or "private " in line[:declaration.start(1)]:
            continue
        # The record holds full names and the source the name inside its namespace.
        name = declaration[1].partition(" ")[2]
        if any(full == name or full.endswith("." + name) for full in frozen):
            theorems.add(declaration[1])
    return theorems


def lean_runner(model, mutations):
    project = project_root(model, "lakefile.toml", "lakefile.lean")
    if project is None:
        stop(f"{model} is in no Lake project")
    return lean_theorems(model), partial(check_lean, model, project)


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
    print(f"SUMMARY {detected} of {len(mutations)} mutations detected"
          + (f", {len(uncovered)} properties without a mutation" if uncovered else ""))
    sys.exit(0 if detected == len(mutations) and not uncovered else 1)


if __name__ == "__main__":
    main()
