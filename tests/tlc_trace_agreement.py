# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Compare the trace that tlc_trace.parse() reads for the HTML report with the one reduce() prints.

parse() and reduce() walk a TLC log separately. They must agree on each state's number and action, on the
variables of each state that lists them, and on the state that a liveness lasso goes back to. reduce() prints
only the variables that change, so the variables are compared with states(), which reduce() prints from.
They differ on purpose in three ways, which differences() names instead of reporting:

- "lasso location": reduce() prints a "Back to state" line as TLC wrote it, with the source location of its
  action, while parse() keeps only the action, which the report names.
- "initial state": for a violation by the initial state, reduce() finds no trace, so the matrix runner prints
  the end of the log, while parse() returns a trace of that one state for the report.
- "stuttering values": TLC prints a stuttering step with no variables. reduce() prints it with none, while
  parse() gives it the values of the step before, so the report lists the state that the step repeats.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills/formal-verify/scripts"))
import tlc_trace

LASSO = "Back to state"


def differences(lines):
    """Return the named differences between parse() and reduce() on a log, and every other difference."""
    lines = list(lines)
    trace = tlc_trace.parse(lines)
    printed = tlc_trace.reduce(lines) or []
    headers = [line.removeprefix("--- ") for line in printed if line.startswith("--- ")]
    titles = [header for header in headers if not header.startswith(LASSO)]
    lassos = [header for header in headers if header.startswith(LASSO)]
    named, other = set(), []
    if trace is None:
        if headers:
            other.append(f"reduce() prints {headers} and parse() finds no trace")
        return sorted(named), other
    if not headers:
        if len(trace.steps) == 1 and any(tlc_trace.INITIAL_MARKER in line for line in lines):
            named.add("initial state")
        else:
            other.append(f"parse() finds {len(trace.steps)} states and reduce() prints none")
        return sorted(named), other
    expected = [f"state {step.number}: {step.action}" for step in trace.steps]
    if titles != expected:
        other.append(f"reduce() prints the states {titles} and parse() reads {expected}")
        return sorted(named), other
    walked = [values for title, values in tlc_trace.states(lines) if not title.startswith(LASSO)]
    previous = ()
    for step, values in zip(trace.steps, walked):
        if values and step.values != tuple(values.items()):
            other.append(f"state {step.number}: reduce() prints from {values} and parse() reads {dict(step.values)}")
        elif not values and (step.values != previous or step.changed):
            other.append(f"state {step.number} lists no variables and parse() reads {dict(step.values)}")
        elif not values and step.values:
            named.add("stuttering values")
        previous = step.values
    if trace.lasso is None:
        if lassos:
            other.append(f"reduce() prints {lassos} and parse() finds no lasso")
    elif len(lassos) != 1 or not re.match(rf"{LASSO} {trace.lasso.target}\b", lassos[0]) or trace.lasso.action not in lassos[0]:
        other.append(f"reduce() prints {lassos} and parse() reads back to state {trace.lasso.target}: {trace.lasso.action}")
    elif lassos[0] != f"{LASSO} {trace.lasso.target}" + (f": {trace.lasso.action}" if trace.lasso.action else ""):
        named.add("lasso location")
    return sorted(named), other
