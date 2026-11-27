# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Attribute Lean mutation failures to the original model's frozen theorems and anonymous checks."""
import json
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

sys.dont_write_bytecode = True
import lean
import processes
from lean_records import read_record

HERE = Path(__file__).resolve().parent


class AnalysisError(Exception):
    """The original model, its frozen declarations or the pinned frontend could not be read."""

    def __init__(self, diagnostic, status=1):
        super().__init__(diagnostic)
        self.status = status


def _checked_record(model, project):
    """Check the original once with the same frozen declaration audit as lean-check."""
    path = model.with_suffix(".statements")
    if not path.is_file():
        raise AnalysisError(f"FAIL {path} is missing; freeze the model with lean-check.sh --freeze before checking its mutations")
    try:
        record = read_record(path)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise AnalysisError(f"FAIL invalid statements record {path}: {error}") from error
    output = []
    status = lean.check(str(project), [str(model)], False, output.append)
    if status:
        raise AnalysisError("\n".join(output).strip(), status)
    return record


def _analyze(model, project, toolchain):
    """Get Lean's declaration identities and error positions, never infer them from source text."""
    done = processes.run_captured(["elan", "run", toolchain, "lake", "--dir", str(project), "env", "lean", "--run",
                                   str(HERE / "lean-analysis.lean"), "analyze", str(model)],
                                  encoding="utf-8", errors="replace")
    output = done.stdout + done.stderr
    records = [line.removeprefix("AFV_LEAN ") for line in done.stdout.splitlines() if line.startswith("AFV_LEAN ")]
    if done.returncode != 0 or len(records) != 1:
        raise AnalysisError(f"FAIL Lean declaration analysis did not complete:\n{output.strip()}")
    try:
        analysis = json.loads(records[0])
        for field in ("declarations", "commands", "errors"):
            if not isinstance(analysis[field], list):
                raise TypeError(f"{field} must be a list")
    except (ValueError, KeyError, TypeError) as error:
        raise AnalysisError(f"FAIL invalid Lean declaration analysis: {error}") from error
    return analysis


@dataclass
class _Check:
    start: list
    end: list
    label: str
    problem: str
    witness: bool = False

    def contains(self, position):
        return self.start <= position < self.end


def _command_sites(source, commands, edit_start, edit_end):
    """Identify anonymous checks by the source that survives the edit on either side."""
    line_starts = [0]
    for line in source.split("\n"):
        line_starts.append(line_starts[-1] + len(line) + 1)
    for cmd in commands:
        if not cmd["property"]:
            continue
        first, last = (line_starts[line - 1] + column for line, column in (cmd["start"], cmd["end"]))
        if last <= edit_start:
            site = ("before", first)
        elif first >= edit_end:
            site = ("after", first - edit_end)
        else:
            # An edit can split a check in two. Either surviving endpoint alone could name the new check.
            site = ("restated", source[first:last])
        yield (cmd["property"], site), cmd, first


def _compare_commands(model, before, mutation, source, after):
    start = mutation.start
    end = start + len(mutation.new)
    originals = {}
    for site, cmd, _ in _command_sites(mutation.original, before, start, start + len(mutation.old)):
        originals.setdefault(site, []).append(cmd["statement"])
    commands = list(_command_sites(source, after, start, end))
    counts = Counter(site for site, _, _ in commands)
    line_shift = mutation.old.count("\n") - mutation.new.count("\n")
    edit_line = mutation.original.count("\n", 0, start) + 1
    for site, cmd, offset in commands:
        candidates = originals.get(site, [])
        if len(candidates) != 1 or counts[site] != 1:
            reason = f"cannot match this {cmd['property']} to a single original check"
        elif cmd["statement"] is None or candidates[0] != cmd["statement"]:
            reason = "the mutation changes its statement"
        else:
            reason = ""
        line = cmd["start"][0]
        if start <= offset < end:
            location = f"{edit_line} (mutation replacement)"
        else:
            location = str(line + line_shift if offset >= end else line)
        yield _Check(cmd["start"], cmd["end"], f"{cmd['property']} at {model}:{location}", reason)


def _position(source, offset):
    """Return the [line, column] that Lean reports for a character offset into source."""
    return [source.count("\n", 0, offset) + 1, offset - source.rfind("\n", 0, offset) - 1]


def _is_witness(name, theorem_names):
    parent, _, last = name.rpartition(".")
    return last == "witness" and parent in theorem_names


class OriginalChecks:
    """Attribute errors using the original source and the two frontend analyses."""

    def __init__(self, path, frozen, original):
        self._path = path
        if original["errors"]:
            raise AnalysisError(f"FAIL unmutated Lean model does not elaborate: {original['errors'][0]['data']}")
        theorems = [decl for decl in original["declarations"] if decl["theorem"]]
        names = {decl["name"] for decl in theorems}
        self.targets = {"theorem " + decl["name"] for decl in theorems
                        if not decl["private"] and decl["name"] in frozen and not _is_witness(decl["name"], names)}
        self._theorems = {(decl["name"], decl["type"]) for decl in theorems}
        self._commands = original["commands"]

    def _theorem_checks(self, declarations, mutation, source):
        edit_start = _position(source, mutation.start)
        edit_end = _position(source, mutation.start + len(mutation.new))
        theorems = [decl for decl in declarations if decl["theorem"]]
        names = {decl["name"] for decl in theorems}
        for decl in theorems:
            name = decl["name"]
            if (name, decl["type"]) not in self._theorems:
                problem = "the mutation changes its statement"
            elif decl["start"] <= edit_end and edit_start <= decl["end"]:
                # A broken proof shows the model changed only when the edit lies outside that theorem.
                problem = "the mutation edits this theorem"
            else:
                problem = ""
            yield _Check(decl["start"], decl["end"], "theorem " + name, problem, _is_witness(name, names))

    def broken_checks(self, mutation, source, copy, analysis):
        """Return the original checks that fail, or raise ValueError if any error cannot be attributed."""
        if not analysis["errors"]:
            return []
        theorems = list(self._theorem_checks(analysis["declarations"], mutation, source))
        commands = list(_compare_commands(self._path, self._commands, mutation, source, analysis["commands"]))
        failed = []
        for error in analysis["errors"]:
            position = [error["pos"]["line"], error["pos"]["column"]]
            where = f"{error['fileName']}:{position[0]}:{position[1]}: {error['data']}"
            checks = [check for check in theorems if check.contains(position)]
            if not checks:
                checks = [check for check in commands if check.contains(position)]
            for check in checks:
                if check.problem:
                    raise ValueError(f"{check.label}: {check.problem}, so this error does not show its proof or check failing\n{where}")
            if error["fileName"] != str(copy) or not checks:
                raise ValueError(where)
            for check in checks:
                if not check.witness and check.label not in failed:
                    failed.append(check.label)
        return failed


def prepare(model, project):
    """Elaborate the original once and return its coverage targets and a check for each mutant."""
    record = _checked_record(model, project)
    pin = record["toolchain"]
    frozen = {entry["name"] for entry in record["declarations"] if entry["kind"] == "theorem"}
    original = OriginalChecks(model, frozen, _analyze(model, project, pin))

    def check(mutation, work):
        copy = work / model.name
        source = mutation.apply()
        copy.write_text(source, encoding="utf-8")
        return original.broken_checks(mutation, source, copy, _analyze(copy, project, pin))

    return original.targets, check
