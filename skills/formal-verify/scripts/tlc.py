#!/usr/bin/env python3
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Model-check TLA+ specs with TLC over a matrix of constants read from a matrix file.

Prints one PASS or FAIL line per run with its distinct state count, then a
SUMMARY line with the totals. A failing run prints TLC's error and its error
trace reduced to the variables each step changed (tlc_trace.py).

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
  TLC_TIMEOUT=<lim>  per-run time limit, e.g. 90s, 30m, 1h (default 60m)
  TLC_HTML_REPORT=<path>  write a self-contained HTML report to this path

Usage: tlc.py ready
  Checks TLC_TIMEOUT, that Java runs, and that the JAR is the pinned release or the one TLC_JAR names, then reports
  the temporary directory's free space as storage.py report does. setup.sh tla runs it.
"""
from __future__ import annotations

import signal

if __name__ == "__main__":
    # Python's SIGINT handler raises KeyboardInterrupt, which prints a traceback when it arrives during the imports.
    # Until runner.run installs its own handlers, the default action ends the process by the signal instead.
    if signal.getsignal(signal.SIGINT) is signal.default_int_handler:
        signal.signal(signal.SIGINT, signal.SIG_DFL)

import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path

sys.dont_write_bytecode = True
import processes
import runner
import storage
import tlc_report
import tlc_trace

CHECK_KINDS = ("INVARIANT", "INVARIANTS", "PROPERTY", "PROPERTIES")
REACH = re.compile(r"([a-zA-Z_][a-zA-Z_0-9]*)\s*\|\s*(.*\S)\s*")


def read_raw(path):
    """Return a file's text as bash reads it: line ends untouched, a byte that is not UTF-8 replaced."""
    with open(path, encoding="utf-8", errors="replace", newline="") as stream:
        return stream.read()


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


def _directives(lines):
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
                yield Malformed(f"run '{label.rstrip()}' before any spec line")
            else:
                yield Run(label.rstrip(), constants)
        else:
            yield Malformed(f"unknown directive: {line}")


DEFAULT_TIMEOUT = "60m"
PROGRESS_DELAY = 15.0
PROGRESS_INTERVAL = 30.0


def _read_progress(log_path, offset, partial):
    """Read newly written complete lines from tlc.log and return (new_offset, new_partial, latest_progress)."""
    latest = ""
    try:
        with log_path.open("r", encoding="utf-8", errors="replace") as stream:
            stream.seek(offset)
            chunk = stream.read()
            new_offset = stream.tell()
    except OSError:
        return offset, partial, ""
    if not chunk:
        return new_offset, partial, ""
    text = partial + chunk
    lines = text.splitlines(keepends=True)
    if lines and not lines[-1].endswith(("\n", "\r")):
        new_partial = lines.pop()
    else:
        new_partial = ""
    for line in lines:
        stripped = line.strip()
        if "Progress(" in stripped:
            latest = stripped
    return new_offset, new_partial, latest


class Tlc:
    """The pinned TLC, checked once. Nothing here downloads it."""
    version = "v1.7.4"
    sha256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
    release = f"https://github.com/tlaplus/tlaplus/releases/tag/{version}"

    @classmethod
    def cached_jar(cls):
        """Return the path where the pinned JAR must be saved, under TLC_CACHE."""
        return Path(os.environ.get("TLC_CACHE") or Path.home() / ".cache/tla") / f"tla2tools-{cls.version}.jar"

    def __init__(self):
        timeout_raw = os.environ.get("TLC_TIMEOUT", "").strip() or DEFAULT_TIMEOUT
        self.limit, self.timeout_seconds = runner.parse_limit("TLC_TIMEOUT", timeout_raw, "run time limit", "sixty minutes")
        self.java = os.environ.get("JAVA") or "java"
        try:
            # The JVM prints in the platform encoding, which need not be UTF-8.
            runtime = processes.run_captured([self.java, "-version"], errors="replace").returncode
        except OSError:
            runtime = 127
        if runtime:
            raise runner.Unavailable(f"UNAVAILABLE {self.java} has no runtime; install a JDK and set JAVA to its java binary")
        # A JAR the user supplies is trusted; the cached one must match the pin.
        supplied = os.environ.get("TLC_JAR")
        self.jar = supplied or str(self.cached_jar())
        if not supplied:
            self._check_pinned_jar()
        elif not Path(supplied).is_file():
            raise runner.Unavailable(f"UNAVAILABLE supplied TLC_JAR {supplied} does not exist")
        try:
            probe = processes.run_captured([self.java, "-cp", self.jar, "tlc2.TLC", "-help"], errors="replace")
            status, output = probe.returncode, probe.stdout + probe.stderr
        except OSError as error:
            status, output = 127, str(error)
        if status and "TLC - provides model checking" not in output:
            raise runner.Unavailable(f"UNAVAILABLE tlc2.TLC cannot run from {self.jar}; save a working JAR from {self.release} "
                                     f"or set TLC_JAR\n{output.rstrip()}")
        self.workers = os.environ.get("TLC_WORKERS") or "auto"
        self._warned_disk = False

    def _check_pinned_jar(self):
        if not Path(self.jar).is_file():
            raise runner.Unavailable(f"UNAVAILABLE {self.jar} is missing; save tla2tools.jar from {self.release} there, or set TLC_JAR")
        try:
            got = hashlib.sha256(Path(self.jar).read_bytes()).hexdigest()
        except OSError as error:
            raise runner.Unavailable(f"UNAVAILABLE cannot read {self.jar}; check its permissions") from error
        if got != self.sha256:
            raise runner.Unavailable(f"UNAVAILABLE {self.jar} has sha256 {got}, want {self.sha256}")

    def run(self, directory, module, config, reach, workers=None, progress_label=""):
        """Run TLC on module in directory with config; return (exit_status, log, timed_out)."""
        if not self._warned_disk:
            self._warned_disk = True
            storage.warn_runtime()
        log = directory / "tlc.log"
        (directory / "MC.cfg").write_text(config, encoding="utf-8")
        chosen_workers = workers if workers is not None else ("1" if reach else self.workers)
        # TLC unpacks its standard modules into java.io.tmpdir and deletes them on exit, so concurrent runs must not share it.
        java_tmp = directory / "java"
        java_tmp.mkdir(exist_ok=True)
        command = [self.java, "-XX:+UseParallelGC", f"-Djava.io.tmpdir={java_tmp}", "-cp", self.jar, "tlc2.TLC", "-workers", chosen_workers,
                   *(["-deadlock"] if reach else []), "-cleanup", "-metadir", str(directory / "states"),
                   "-config", str(directory / "MC.cfg"), str(directory / f"{module}.tla")]
        start = time.monotonic()
        deadline = start + self.timeout_seconds

        def watch(process):
            """Wait for TLC, report its progress and stop it at the deadline; return its status and whether it timed out."""
            next_report = start + PROGRESS_DELAY
            offset, partial, latest = 0, "", ""
            while True:
                now = time.monotonic()
                remaining = deadline - now
                if remaining <= 0:
                    processes.stop_process(process)
                    return process.returncode, True
                if now >= next_report:
                    offset, partial, found = _read_progress(log, offset, partial)
                    if found:
                        latest = found
                    elapsed = int(now - start)
                    prefix = f"[tlc] {progress_label}: " if progress_label else "[tlc] "
                    body = f"{elapsed}s elapsed: {latest}" if latest else f"{elapsed}s elapsed"
                    sys.stderr.write(f"{prefix}{body}\n")
                    sys.stderr.flush()
                    next_report = now + PROGRESS_INTERVAL
                wait_for = min(remaining, max(0.05, next_report - time.monotonic()))
                try:
                    process.wait(timeout=wait_for)
                    return process.returncode, False
                except subprocess.TimeoutExpired:
                    continue

        with log.open("w", encoding="utf-8") as stream:
            returncode, timed_out = processes.guarded(command, watch, stdout=stream, stderr=subprocess.STDOUT)
        return returncode, read_raw(log), timed_out


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
class Violation:
    """A property violation as TLC's first error line names it."""
    kind: str
    name: str | None
    initial: bool


# TLC names the property it found violated in one of these lines; a temporal violation names none.
VIOLATION = re.compile(r"Error: (?:(Invariant|Property|Action property) (.+) is violated(\.| by the initial state:)"
                       r"|(Temporal) properties were violated\.)")


def violation(error):
    """Return the violation that TLC's error line reports, or None for any other error."""
    match = VIOLATION.fullmatch(error)
    if not match:
        return None
    return Violation(match[1] or match[4], match[2], match[3] == " by the initial state:")


@dataclass(frozen=True)
class Result:
    """One line of the runner's report and the output printed under it.

    detail is the text printed after the label; states and violation hold what callers count and match on.
    """
    outcome: Outcome
    name: str = ""
    label: str = ""
    operator: str = ""
    detail: str = ""
    lines: tuple = ()
    states: int = 0
    violation: Violation | None = None
    constants: str = ""
    checks: tuple[str, ...] = ()
    duration_s: float = 0.0
    trace: tlc_trace.Trace | None = None


@dataclass(frozen=True)
class Task:
    spec: str
    run: Run
    checks: tuple = ()
    reach: Reach | None = None
    check_deadlock: bool = True


class _Section:
    """A spec occurrence owns its declared checks and the runs to which each applies."""

    def __init__(self, spec, directives):
        self.spec = spec
        self.properties = set()
        self.reaches = set()
        self.tasks = []
        checks, reaches, runs = [], [], []
        for directive in directives:
            if isinstance(directive, Check):
                checks.append(directive)
                self.properties.update(directive.names)
            elif isinstance(directive, Reach):
                reaches.append(directive)
                self.reaches.add(f"reach:{directive.operator}")
            elif isinstance(directive, Run):
                runs.append(directive)
                self.tasks.append(Task(spec, directive, tuple(checks)))
            else:
                self.tasks.append(Result(Outcome.MALFORMED, detail=directive.message))
        for reach in reaches:
            run = next((run for run in runs if reach.match in run.label), None)
            if run is None:
                self.tasks.append(Result(Outcome.NO_RUN, Path(spec).name.removesuffix(".tla"), operator=reach.operator, detail=reach.match))
            else:
                self.tasks.append(Task(spec, run, reach=reach))


class MatrixPlan:
    """Compile a matrix once for execution, specification recording or mutation selection."""

    def __init__(self, path):
        self.path = Path(path)
        self._sections = []
        spec, body = None, []
        for directive in _directives(read_raw(self.path).split("\n")):
            if isinstance(directive, Spec):
                self._sections.append(_Section(spec, body))
                spec, body = directive.path, []
            else:
                body.append(directive)
        self._sections.append(_Section(spec, body))

    def __iter__(self):
        for section in self._sections:
            yield from section.tasks

    @property
    def specs(self):
        return [section.spec for section in self._sections if section.spec is not None]

    def checked_tasks(self):
        """A baseline needs every task to be resolved, including every reach."""
        errors = ["; ".join(render(task)) for task in self if isinstance(task, Result)]
        if errors:
            raise ValueError(f"{self.path}: {'; '.join(errors)}")
        if "" in self.specs:
            raise ValueError(f"{self.path}: spec line has no path")
        return iter(self)

    def mutations_for(self, spec):
        spec = Path(spec).resolve()
        for task in self:
            if isinstance(task, Result) and task.outcome is Outcome.MALFORMED:
                raise ValueError(f"{self.path}: {task.detail}")
        sections = [section for section in self._sections
                    if section.spec and (self.path.parent / section.spec).resolve() == spec]
        return MutationPlan(spec, sections)


class MutationPlan:
    """Run a named detector on exactly the tasks selected for a copied spec."""

    def __init__(self, spec, sections):
        self._spec = spec
        self.properties = {name for section in sections for name in section.properties}
        self.detectors = self.properties | {name for section in sections for name in section.reaches}
        self._tasks = [task for section in sections for task in section.tasks]

    def _select(self, detector):
        for task in self._tasks:
            if isinstance(task, Result):
                if f"reach:{task.operator}" == detector:
                    yield task
            elif task.reach:
                if f"reach:{task.reach.operator}" == detector:
                    yield replace(task, spec=self._spec.name)
            else:
                checks = tuple(Check(f"{check.kind} {detector}", check.kind, (detector,))
                               for check in task.checks if detector in check.names)
                if checks:
                    yield Task(self._spec.name, task.run, checks,
                               check_deadlock=not any(check.kind.startswith("PROPERT") for check in checks))

    def selected(self, detector, only):
        """Return the tasks that check a mutation naming detector and only; raise ValueError when none can."""
        tasks = list(self._select(detector))
        unresolved = [line for task in tasks if isinstance(task, Result) for line in render(task)]
        if unresolved:
            raise ValueError("\n".join(unresolved))
        tasks = [task for task in tasks if only in task.run.label]
        if not tasks:
            raise ValueError(f"no run matches '{only}' for '{detector}'")
        return tasks

    def check_originals(self, checker, selections, work):
        """Run every task that the (detector, only) selections name on the unmutated spec, each once.

        Raise ValueError when a task does not pass, and before running any task when a selection has none to run.
        """
        chosen = [(detector, task) for detector, only in selections for task in self.selected(detector, only)]
        passed = set()
        for detector, task in chosen:
            if task in passed:
                continue
            original = run_task(checker, self._spec.parent, task, work)
            if original.outcome not in (Outcome.PASS, Outcome.WITNESS):
                raise ValueError(f"unmutated model did not pass {detector}: " + "\n".join(render(original)))
            passed.add(task)

    def check(self, checker, detector, only, source, work):
        """Return the first confirmed detection, None for a miss, or raise on inconclusive evidence.

        The caller has passed the same detector and only to check_originals.
        """
        results = [(run_task(checker, self._spec.parent, task, work, source),
                    any(check.kind.startswith("PROPERT") for check in task.checks))
                   for task in self.selected(detector, only)]
        detections, errors = [], []
        for result, temporal in results:
            if result.outcome is Outcome.UNREACHED:
                detections.append((result.label, "the model never reaches this state"))
            elif result.outcome is Outcome.FAIL and result.violation and detects(result.violation, detector, temporal):
                detections.append((result.label, result.detail.removeprefix("Error: ").rstrip(".")))
            elif result.outcome not in (Outcome.PASS, Outcome.WITNESS):
                errors.extend(render(result))
        if errors:
            raise ValueError("\n".join(errors))
        if detections:
            label, reason = detections[0]
            return f"{detector} fails in run '{label}' ({reason})"
        return None


def detects(found, detector, temporal):
    """Return whether TLC's violation shows the detector failing, in the forms TLC reports for each kind."""
    if found.kind == "Temporal":
        return True
    if found.kind == "Invariant":
        # TLC checks a property such as []P as the invariant P and names P. The config holds only the detector.
        return found.name == detector or temporal
    if found.kind == "Property":
        return found.name == detector and found.initial
    return found.name == detector and not found.initial


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


def reduced_trace(log):
    """Return the error trace reduced to what each step changed, or the end of the log when it holds no trace."""
    lines = tlc_trace.reduce(re.split(r"\r\n|\r|\n", log))
    return lines if lines is not None else [line for line in log.split("\n") if line.strip()][-40:]


def run_task(checker, matrix_dir, task, work, source=None):
    """Execute a resolved matrix task, optionally replacing its spec in the private run directory."""
    spec, run = task.spec, task.run
    operator = task.reach.operator if task.reach else ""
    name = Path(spec).name.removesuffix(".tla")
    run_constants = run.constants.strip()
    run_checks = tuple(check.line for check in task.checks)
    if not (matrix_dir / spec).is_file():
        return Result(Outcome.MISSING, name, run.label, detail=spec, constants=run_constants, checks=run_checks)
    directory = Path(tempfile.mkdtemp(prefix="run.", dir=work))
    try:
        for module in (matrix_dir / spec).parent.glob("*.tla"):
            dest = directory / module.name
            if source is not None and module.name == Path(spec).name:
                dest.write_text(source, encoding="utf-8")
            else:
                dest.write_bytes(module.read_bytes())
        constants = "".join(f"  {pair.split('=')[0]} = {pair.split('=', 1)[-1]}\n" for pair in run.constants.split())
        config = f"CONSTANTS\n{constants}SPECIFICATION Spec\n"
        if not task.check_deadlock:
            config += "CHECK_DEADLOCK FALSE\n"
        if not operator:
            start = time.monotonic()
            status, log, timed_out = checker.run(
                directory, name, config + "\n".join(check.line for check in task.checks) + "\n",
                reach=False, progress_label=f"{name} {run.label}",
            )
            elapsed = time.monotonic() - start
            shutil.rmtree(directory / "states", ignore_errors=True)
            result = ordinary(name, run, status, log, checker.limit if timed_out else None)
            return replace(result, constants=run_constants, checks=run_checks, duration_s=elapsed)
        wrapper = f"Reach{uuid.uuid4().hex}"
        invariant = f"{wrapper}Negated"
        (directory / f"{wrapper}.tla").write_text(f"---- MODULE {wrapper} ----\nEXTENDS {name}\n{invariant} == ~{operator}\n====\n", encoding="utf-8")
        # Exhaustive UNREACHED checks in reach: mutations do not depend on shortest-trace determinism.
        reach_workers = checker.workers if source is not None else "1"
        start = time.monotonic()
        status, log, timed_out = checker.run(
            directory, wrapper, config + f"INVARIANT {invariant}\n",
            reach=True, workers=reach_workers, progress_label=f"{name} reach {operator} {run.label}",
        )
        elapsed = time.monotonic() - start
        result = witness(name, run, operator, invariant, status, log, checker.limit if timed_out else None)
        return replace(result, constants=run_constants, checks=run_checks, duration_s=elapsed)
    finally:
        shutil.rmtree(directory, ignore_errors=True)



def ordinary(name, run, status, log, timeout_limit=None):
    if timeout_limit:
        tail = tuple(line for line in log.split("\n") if line.strip())[-10:]
        return Result(Outcome.FAIL, name, run.label,
                      detail=f"TLC timed out after {timeout_limit}; set TLC_TIMEOUT to change the limit", lines=tail)
    if status == 0 and "No error has been found" in log:
        found = re.findall(r"[0-9,]* distinct states found", log)
        states = found[-1] if found else ""
        return Result(Outcome.PASS, name, run.label, detail=states, states=int(states.partition(" ")[0].replace(",", "") or 0))
    errors = [line for line in log.split("\n") if line.startswith("Error:")]
    first = errors[0] if errors else ""
    return Result(Outcome.FAIL, name, run.label, detail=first, lines=(*errors[1:5], *reduced_trace(log)),
                  violation=violation(first), trace=tlc_trace.parse(re.split(r"\r\n|\r|\n", log)))


def witness(name, run, operator, invariant, status, log, timeout_limit=None):
    if timeout_limit:
        tail = tuple(line for line in log.split("\n") if line.strip())[-10:]
        return Result(Outcome.INCOMPLETE, name, run.label, operator,
                      lines=(f"TLC timed out after {timeout_limit}; set TLC_TIMEOUT to change the limit", *tail))
    lines = log.split("\n")
    length = 0
    if status == 12 and f"Error: Invariant {invariant} is violated by the initial state:" in lines:
        length = 1
    elif status == 12 and f"Error: Invariant {invariant} is violated." in lines:
        length = sum(1 for line in lines if re.match(r"State [0-9]+:", line))
    if length:
        return Result(Outcome.WITNESS, name, run.label, operator, f"{length} states ({length - 1} transitions)",
                      trace=tlc_trace.parse(re.split(r"\r\n|\r|\n", log)))
    if status == 0 and "No error has been found" in log:
        return Result(Outcome.UNREACHED, name, run.label, operator)
    return Result(Outcome.INCOMPLETE, name, run.label, operator, lines=tuple(log.removesuffix("\n").split("\n")) if log else ())


class Runner:
    """Run the selected tasks and report each result to emit."""

    def __init__(self, tlc, matrix_dir, only, emit, work):
        self.tlc, self.matrix_dir, self.only, self.emit, self.work = tlc, matrix_dir, only, emit, work
        self.runs_total = self.passed = self.states = self.reach_total = self.reached = 0
        self.failed = False
        self.results = []

    def report(self, result):
        self.results.append(result)
        self.failed |= result.outcome not in (Outcome.PASS, Outcome.WITNESS)
        self.emit(result)

    def check(self, task):
        if isinstance(task, Result):
            self.reach_total += task.outcome is Outcome.NO_RUN
            self.report(task)
            return
        if self.only not in task.run.label:
            return
        if task.reach:
            self.reach_total += 1
        else:
            self.runs_total += 1
        result = run_task(self.tlc, self.matrix_dir, task, self.work)
        if result.outcome is Outcome.PASS:
            self.passed += 1
            self.states += result.states
        elif result.outcome is Outcome.WITNESS:
            self.reached += 1
        self.report(result)


def validate_report_path(raw: str) -> Path | None:
    """Validate TLC_HTML_REPORT path upfront before running TLC, or return None when unset."""
    trimmed = raw.strip()
    if not trimmed:
        return None
    seps = tuple(dict.fromkeys(s for s in ("/", os.sep, os.altsep) if s))
    dot_suffixes = tuple(f"{sep}." for sep in seps) + tuple(f"{sep}.." for sep in seps)
    if trimmed in (".", "..") or trimmed.endswith(seps + dot_suffixes):
        raise ValueError(f"TLC_HTML_REPORT {trimmed} is a directory")
    path = Path(trimmed)
    try:
        is_dir = path.is_dir()
        parent_is_dir = path.parent.is_dir()
        exists = path.exists()
        is_file = path.is_file() if exists else False
    except OSError as error:
        raise ValueError(f"TLC_HTML_REPORT {trimmed} is not accessible: {error}") from error
    if is_dir:
        raise ValueError(f"TLC_HTML_REPORT {path} is a directory")
    if not parent_is_dir:
        raise ValueError(f"TLC_HTML_REPORT parent directory {path.parent} does not exist")
    if exists and not is_file:
        raise ValueError(f"TLC_HTML_REPORT {path} is not a regular file")
    try:
        fd, temp_path = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    except OSError as error:
        raise ValueError(f"TLC_HTML_REPORT {path} is not writable: {error}") from error
    try:
        os.close(fd)
    finally:
        Path(temp_path).unlink(missing_ok=True)
    return path


def main():
    if sys.argv[1:] == ["ready"]:
        print(f"READY TLC {Tlc().jar}")
        storage.report()
        return 0
    if not 2 <= len(sys.argv) <= 3:
        print("usage: tlc-matrix.sh <matrix-file> [label-substring]")
        return 2
    matrix, only = sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else ""
    if not Path(matrix).is_file():
        print(f"FAIL {matrix} does not exist")
        return 1
    try:
        report_path = validate_report_path(os.environ.get("TLC_HTML_REPORT", ""))
    except ValueError as error:
        print(f"FAIL {error}")
        return 1
    tlc = Tlc()
    with tempfile.TemporaryDirectory(dir=storage.ensure_temp_root()) as work:
        matrix_runner = Runner(tlc, Path(matrix).resolve().parent, only, lambda result: print("\n".join(render(result)), flush=True), Path(work))
        for task in MatrixPlan(matrix):
            matrix_runner.check(task)
    if matrix_runner.runs_total == 0:
        matching = f"matching '{only}' " if only else ""
        print(f"FAIL no run {matching}in {matrix}")
        return 1
    summary = f"SUMMARY {matrix_runner.passed} of {matrix_runner.runs_total} runs passed"
    if matrix_runner.reach_total:
        summary += f", {matrix_runner.reached} of {matrix_runner.reach_total} reach checks passed"
    summary_line = f"{summary}, {matrix_runner.states} distinct states in total"
    print(summary_line)
    if report_path is not None:
        try:
            tlc_report.write_html(report_path, Path(matrix).name, matrix_runner.results, summary_line, only=only)
        except OSError as error:
            print(f"FAIL TLC_HTML_REPORT {report_path}: {error}")
            return 1
    return int(matrix_runner.failed)


if __name__ == "__main__":
    runner.run(main)
