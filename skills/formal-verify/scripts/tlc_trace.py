#!/usr/bin/env python3
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Reduce the error trace in a TLC log to what each step changed.

Reads a TLC log (a file argument or stdin), finds the behaviour TLC prints
for an invariant violation, a deadlock or a temporal counter-example, and
prints one block per state: its number and action, then only the variables
whose value differs from the previous state. The first state prints every
variable. A "Back to state" line (a liveness lasso) is printed as is.
Exits 1 when the log holds no trace.

Usage: tlc_trace.py [tlc.log]
"""
from __future__ import annotations

import re
import sys
from contextlib import nullcontext
from dataclasses import dataclass

START = ("The behavior up to this point is", "constitutes a counter-example")
INITIAL_MARKER = "is violated by the initial state:"
STATE = re.compile(r"^State (\d+): <?(.*?)>?$")
LASSO = re.compile(r"^Back to state (\d+)(?::\s*<?(.*?)>?)?$")
LOCATION = re.compile(r" line \d+, col \d+ to line \d+, col \d+ of module \w+$")
# TLC omits the leading conjunction when the spec has one variable.
VAR = re.compile(r"^(?:/\\ )?(\w+) = (.*)$")


@dataclass(frozen=True)
class VarDiff:
    name: str
    old: str | None
    new: str


@dataclass(frozen=True)
class Step:
    number: int
    action: str
    values: tuple[tuple[str, str], ...]
    changed: tuple[VarDiff, ...]


@dataclass(frozen=True)
class Lasso:
    target: int
    action: str


@dataclass(frozen=True)
class Trace:
    steps: tuple[Step, ...]
    lasso: Lasso | None = None


def _build_step(number, action, values, prev):
    items = tuple(values.items())
    if prev is None:
        diffs = tuple(VarDiff(name, None, val) for name, val in items)
    else:
        diffs = tuple(VarDiff(name, prev.get(name), val) for name, val in items if prev.get(name) != val)
    return Step(number, action, items, diffs)


def _parse_initial(lines) -> Trace | None:
    values, var = {}, None
    for line in lines:
        if m := VAR.match(line):
            var = m[1]
            values[var] = m[2]
        elif var and line.startswith(" "):
            values[var] += "\n" + line
        else:
            break
    return Trace((_build_step(1, "Initial predicate", values, None),)) if values else None


def _parse_standard(lines) -> Trace | None:
    steps, prev, current, var, lasso = [], None, None, None, None
    for line in lines:
        if m := STATE.match(line):
            if current is not None:
                steps.append(_build_step(current[0], current[1], current[2], prev))
                prev = current[2] or prev
            current, var = (int(m[1]), LOCATION.sub("", m[2]), {}), None
        elif m := LASSO.match(line):
            if current is not None:
                steps.append(_build_step(current[0], current[1], current[2], prev))
                current = None
            lasso = Lasso(int(m[1]), LOCATION.sub("", m[2] or ""))
            break
        elif current is not None and (m := VAR.match(line)):
            var = m[1]
            current[2][var] = m[2]
        elif current is not None and var and line.startswith(" "):
            current[2][var] += "\n" + line
        elif current is not None:
            steps.append(_build_step(current[0], current[1], current[2], prev))
            prev, current, var = current[2] or prev, None, None
            if line.strip():
                break
        elif steps and line.strip():
            break
    if current is not None:
        steps.append(_build_step(current[0], current[1], current[2], prev))
    return Trace(tuple(steps), lasso) if steps else None


def parse(lines) -> Trace | None:
    """Parse the first TLC error trace into a Trace, or return None when absent."""
    stripped = (line.rstrip("\r\n") for line in lines)
    for line in stripped:
        if any(marker in line for marker in START):
            return _parse_standard(stripped)
        if INITIAL_MARKER in line:
            return _parse_initial(stripped)
    return None


def states(lines):
    """Yield (title, {var: value}) per state of the first error trace."""
    lines = (line.rstrip("\n") for line in lines)
    # any() stops on the marker line, so the loop below resumes just after it.
    if not any(marker in line for line in lines for marker in START):
        return
    title, values, var = None, {}, None
    for line in lines:
        if m := STATE.match(line):
            title, values, var = f"state {m[1]}: {LOCATION.sub('', m[2])}", {}, None
        elif line.startswith("Back to state"):
            yield line, {}
        elif title and (m := VAR.match(line)):
            var = m[1]
            values[var] = m[2]
        elif title and var and line.startswith(" "):
            values[var] += "\n" + line
        elif title:
            yield title, values
            title = None
    if title:
        yield title, values


def reduce(lines):
    """Return the printed lines of the first error trace, or None when the log holds no trace."""
    out, prev, found = [], {}, False
    for title, values in states(lines):
        found = True
        out.append(f"--- {title}")
        out += [f"    {var} = {value}" for var, value in values.items() if prev.get(var) != value]
        prev = values or prev
    return "\n".join(out).split("\n") if found else None


def main():
    with (open(sys.argv[1], encoding="utf-8") if len(sys.argv) > 1 else nullcontext(sys.stdin)) as src:
        reduced = reduce(src)
    if reduced is None:
        sys.exit(1)
    print("\n".join(reduced))


if __name__ == "__main__":
    main()
