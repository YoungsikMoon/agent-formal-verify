#!/usr/bin/env python3
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Model-check TLA+ specs with TLC over a matrix of constants read from a matrix file.

Prints one PASS or FAIL line per run with its distinct state count, then a
SUMMARY line with the totals. A failing run prints TLC's error and its error
trace reduced to the variables each step changed (tlc-trace.py).

Matrix file, one directive per line (# starts a comment):
  spec <path.tla>             the spec for the runs below, relative to the file;
                              TLC checks the formula it names Spec
  check <cfg line>            an INVARIANTS or PROPERTIES line, kept until the next spec
  reach <Operator> | <label-substring>   a witness in the first matching run
  run <label> | <Name=Value ...>   one TLC run with those CONSTANTS

A malformed directive prints a FAIL line and the runner goes on to the next.

Usage: tlc-matrix.sh <matrix-file> [label-substring]
  TLC_JAR=<path>     use this existing tla2tools.jar
  TLC_CACHE=<dir>    where the pinned jar lives (default ~/.cache/tla)
  JAVA=<path>        the java binary (default: java on PATH)
  TLC_WORKERS=<n>    TLC worker threads (default auto)
"""
import os
import re
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHECK_KINDS = ("INVARIANT", "INVARIANTS", "PROPERTY", "PROPERTIES")
REACH = re.compile(r"([a-zA-Z_][a-zA-Z_0-9]*)\s*\|\s*(.*\S)\s*")


@dataclass(frozen=True)
class Spec:
    path: str


@dataclass(frozen=True)
class Check:
    line: str
    kind: str
    names: tuple


@dataclass(frozen=True)
class Reach:
    operator: str
    match: str


@dataclass(frozen=True)
class Run:
    label: str
    constants: str


@dataclass(frozen=True)
class Malformed:
    message: str


def directives(lines):
    """Yield each directive of a matrix in file order, with a Malformed in place of a line it rejects."""
    seen_spec = False
    for raw in lines:
        line = raw.split("#", 1)[0]
        if not line.strip():
            continue
        keyword, rest = (line.split(None, 1) + [""])[:2]
        rest = rest.strip()
        if keyword == "spec":
            seen_spec = bool(rest)
            yield Spec(rest)
        elif keyword == "check":
            kind, names = (rest.split(None, 1) + ["", ""])[:2]
            if not seen_spec:
                yield Malformed(f"check '{rest}' before any spec line")
            elif kind not in CHECK_KINDS or not names.strip():
                yield Malformed(f"malformed check '{rest}'")
            else:
                yield Check(rest, kind, tuple(names.split()))
        elif keyword == "reach":
            match = REACH.fullmatch(rest)
            if not seen_spec:
                yield Malformed(f"reach '{rest}' before any spec line")
            elif not match:
                yield Malformed(f"malformed reach '{rest}': expected reach <Operator> | <label-substring>")
            else:
                yield Reach(match[1], match[2])
        elif keyword == "run":
            label, bar, constants = rest.partition("|")
            if not bar:
                yield Malformed(f"run '{rest}' has no | before its constants")
            elif not seen_spec:
                yield Malformed(f"run '{label.removesuffix(' ')}' before any spec line")
            else:
                yield Run(label.removesuffix(" "), constants)
        else:
            yield Malformed(f"unknown directive: {line}")


class Unavailable(Exception):
    pass


class Tlc:
    """The pinned TLC, checked once; tlc-tools.sh owns the pin and the readiness checks."""

    def __init__(self):
        done = subprocess.run(
            ["bash", "-c", 'source "$1/tlc-tools.sh" && require_tlc_runtime && tlc_jar_ready && printf "%s\\n%s\\n" "$JAVA" "$TLC_JAR"',
             "bash", str(HERE)], capture_output=True, text=True, check=False)
        if done.returncode:
            raise Unavailable(done.stdout.rstrip("\n"))
        self.java, self.jar = done.stdout.splitlines()[-2:]
        self.workers = os.environ.get("TLC_WORKERS") or "auto"

    def run(self, directory, module, config, reach):
        """Run TLC on module in directory with config; return its exit status and log."""
        log = directory / "tlc.log"
        (directory / "MC.cfg").write_text(config, encoding="utf-8")
        command = [self.java, "-XX:+UseParallelGC", "-cp", self.jar, "tlc2.TLC", "-workers", "1" if reach else self.workers,
                   *(["-deadlock"] if reach else []), "-cleanup", "-metadir", str(directory / "states"),
                   "-config", str(directory / "MC.cfg"), str(directory / f"{module}.tla")]
        with log.open("w", encoding="utf-8") as stream:
            status = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, check=False).returncode
        return status, log.read_text(encoding="utf-8", errors="replace")


class Outcome(Enum):
    PASS = "pass"
    FAIL = "fail"
    MISSING = "missing"
    WITNESS = "witness"
    UNREACHED = "unreached"
    INCOMPLETE = "incomplete"
    NO_RUN = "no run"
    MALFORMED = "malformed"


@dataclass(frozen=True)
class Result:
    """One line of the runner's report and the output printed under it."""
    outcome: Outcome
    name: str = ""
    label: str = ""
    operator: str = ""
    detail: str = ""
    states: int = 0
    lines: tuple = ()


def render(result):
    """Return the lines the matrix runner prints for one result."""
    name, label, operator = result.name, result.label, result.operator
    head = {
        Outcome.PASS: f"PASS {name} {label} {result.detail}",
        Outcome.FAIL: f"FAIL {name} {label}: {result.detail}",
        Outcome.MISSING: f"FAIL {name} {label}: spec {result.detail} not found",
        Outcome.WITNESS: f"PASS {name} reach {operator} {label}: shortest trace {result.detail}",
        Outcome.UNREACHED: f"FAIL {name} reach {operator} {label}: the model never reaches this state",
        Outcome.INCOMPLETE: f"FAIL {name} reach {operator} {label}: TLC did not complete the reach check",
        Outcome.NO_RUN: f"FAIL {name} reach {operator}: no run matching '{result.detail}'",
        Outcome.MALFORMED: f"FAIL {result.detail}",
    }[result.outcome]
    return [head, *result.lines]


def reduced_trace(log_path, log):
    done = subprocess.run([sys.executable, str(HERE / "tlc-trace.py"), str(log_path)], capture_output=True, text=True, check=False)
    lines = done.stdout.splitlines()
    if done.returncode:
        lines += [line for line in log.splitlines() if line.strip()][-40:]
    return lines


class Runner:
    """Runs a matrix's directives in order, as tlc-matrix.sh reads them, and reports each result to emit."""

    def __init__(self, tlc, matrix_dir, only, emit, work):
        self.tlc, self.matrix_dir, self.only, self.emit, self.work = tlc, matrix_dir, only, emit, work
        self.spec, self.checks, self.reaches, self.runs = "", [], [], []
        self.runs_total = self.passed = self.states = self.reach_total = self.reached = 0
        self.failed = False

    def feed(self, directive):
        if isinstance(directive, Spec):
            self.finish_spec()
            self.spec, self.checks, self.reaches, self.runs = directive.path, [], [], []
        elif isinstance(directive, Check):
            self.checks.append(directive.line)
        elif isinstance(directive, Reach):
            self.reaches.append(directive)
        elif isinstance(directive, Run):
            self.runs.append(directive)
            self.check_run(directive)
        else:
            self.report(Result(Outcome.MALFORMED, detail=directive.message))

    def finish_spec(self):
        """Run each reach check of the current spec in the first run whose label contains its substring."""
        for reach in self.reaches:
            run = next((run for run in self.runs if reach.match in run.label), None)
            if run is None:
                self.reach_total += 1
                self.report(Result(Outcome.NO_RUN, Path(self.spec).name.removesuffix(".tla"), operator=reach.operator, detail=reach.match))
            else:
                self.check_run(run, reach.operator)

    def report(self, result):
        self.failed |= result.outcome in (Outcome.FAIL, Outcome.MISSING, Outcome.UNREACHED, Outcome.INCOMPLETE, Outcome.NO_RUN, Outcome.MALFORMED)
        self.emit(result)

    def check_run(self, run, operator=""):
        if self.only not in run.label:
            return
        if operator:
            self.reach_total += 1
        else:
            self.runs_total += 1
        name = Path(self.spec).name.removesuffix(".tla")
        if not (self.matrix_dir / self.spec).is_file():
            self.report(Result(Outcome.MISSING, name, run.label, detail=self.spec))
            return
        directory = Path(tempfile.mkdtemp(prefix="run.", dir=self.work))
        for module in (self.matrix_dir / self.spec).parent.glob("*.tla"):
            (directory / module.name).write_bytes(module.read_bytes())
        constants = "".join(f"  {pair.partition('=')[0]} = {pair.partition('=')[2] if '=' in pair else pair}\n"
                            for pair in run.constants.split())
        config = f"CONSTANTS\n{constants}SPECIFICATION Spec\n"
        if not operator:
            status, log = self.tlc.run(directory, name, config + "\n".join(self.checks) + "\n", reach=False)
            self.report(self.ordinary(name, run, status, log, directory / "tlc.log"))
            return
        wrapper = f"Reach{uuid.uuid4().hex}"
        invariant = f"{wrapper}Negated"
        (directory / f"{wrapper}.tla").write_text(f"---- MODULE {wrapper} ----\nEXTENDS {name}\n{invariant} == ~{operator}\n====\n", encoding="utf-8")
        status, log = self.tlc.run(directory, wrapper, config + f"INVARIANT {invariant}\n", reach=True)
        self.report(self.witness(name, run, operator, invariant, status, log))

    def ordinary(self, name, run, status, log, log_path):
        if status == 0 and "No error has been found" in log:
            found = re.findall(r"[0-9,]* distinct states found", log)
            states = found[-1] if found else ""
            self.passed += 1
            count = states.partition(" ")[0].replace(",", "")
            self.states += int(count or 0)
            return Result(Outcome.PASS, name, run.label, detail=states)
        errors = [line for line in log.splitlines() if line.startswith("Error:")]
        return Result(Outcome.FAIL, name, run.label, detail=errors[0] if errors else "",
                      lines=(*errors[1:5], *reduced_trace(log_path, log)))

    def witness(self, name, run, operator, invariant, status, log):
        lines = log.splitlines()
        length = 0
        if status == 12 and f"Error: Invariant {invariant} is violated by the initial state:" in lines:
            length = 1
        elif status == 12 and f"Error: Invariant {invariant} is violated." in lines:
            length = sum(1 for line in lines if re.match(r"State [0-9]+:", line))
        if length:
            self.reached += 1
            return Result(Outcome.WITNESS, name, run.label, operator, f"{length} states ({length - 1} transitions)")
        if status == 0 and "No error has been found" in log:
            return Result(Outcome.UNREACHED, name, run.label, operator)
        return Result(Outcome.INCOMPLETE, name, run.label, operator, lines=tuple(log.removesuffix("\n").split("\n")) if log else ())


def main():
    if not 2 <= len(sys.argv) <= 3:
        print("usage: tlc-matrix.sh <matrix-file> [label-substring]")
        return 2
    matrix, only = sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else ""
    if not Path(matrix).is_file():
        print(f"FAIL {matrix} does not exist")
        return 1
    try:
        tlc = Tlc()
    except Unavailable as error:
        print(error)
        return 3
    with tempfile.TemporaryDirectory() as work:
        runner = Runner(tlc, Path(matrix).resolve().parent, only, lambda result: print("\n".join(render(result)), flush=True), Path(work))
        with open(matrix, encoding="utf-8") as stream:
            for directive in directives(stream.read().splitlines()):
                runner.feed(directive)
        runner.finish_spec()
    if runner.runs_total == 0:
        matching = f"matching '{only}' " if only else ""
        print(f"FAIL no run {matching}in {matrix}")
        return 1
    summary = f"SUMMARY {runner.passed} of {runner.runs_total} runs passed"
    if runner.reach_total:
        summary += f", {runner.reached} of {runner.reach_total} reach checks passed"
    print(f"{summary}, {runner.states} distinct states in total")
    return int(runner.failed)


if __name__ == "__main__":
    sys.exit(main())
