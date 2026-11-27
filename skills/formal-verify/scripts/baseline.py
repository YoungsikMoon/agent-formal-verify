#!/usr/bin/env python3
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Record what each model specifies before agents edit it, and compare it afterwards.

A model's surface is a mapping from item name to a canonical value. Every tool
uses one rule to compare surfaces: a removed item or a changed value is a
change, and so is an added item whose kind narrows what is checked.

  .statements  Lean. The toolchain, and each declaration's kind, type hash and value hash.
               Added declarations are allowed.
  .matrix      TLA+. Each run's effective checks and each reach check's selected inputs,
               and the normalized definitions of Spec,
               of each operator a check or reach line names, and of the operators those
               reference through local EXTENDS. Local INSTANCE substitutions retain their whole module tree.
  .rs          Kani. Each qualified harness name with its #[kani::should_panic] and
               #[kani::unwind(...)] attributes and the #[cfg(...)] attributes other
               than cfg(kani), and the #[cfg_attr(..., cfg(...))] ones, on it, its enclosing
               items, the file and each out-of-line mod declaration that leads to the file from a crate root, through
               #[path], with each route in the file's crates that the record cannot read, such as a mod
               declaration inside a macro, and each kani::assume, kani::any_where, kani::cover! and
               #[kani::stub] with its owning free function, under inline modules. Unsupported owners fail. Added covers and harnesses are allowed.
               Added assumes and stubs are changes.
               In a Cargo package, also the recorded harnesses that Kani compiles from the file; Kani must give
               each harness it compiles there a module path that a route the record reads gives, and a harness
               that no longer compiles is a change.

Usage:
  baseline.py record <record-file> <model-file>...   record these files, keep the other entries
  baseline.py compare <record-file>                  exit 1 when a recorded file changed
  baseline.py move <record-file> <old> <new> [--module OLD NEW]
                                                     compare old's entry with new from now on

Compare prints UNCHANGED or CHANGED per file, indented lines for each item that
changed, and a SUMMARY line. It prints NOT CHECKED for an unchanged Kani file in a
Cargo package that record could not check against Kani. Move prints MOVED; it reads only the record, never
the new file, and with --module renames the recorded Kani owners under module
OLD to sit under NEW. Exit codes: 0 unchanged, 1 changed or a record or model
file that fails to parse, 2 usage error.
"""
import argparse
import fcntl
import hashlib
import json
import re
import sys
from contextlib import contextmanager
from pathlib import Path

sys.dont_write_bytecode = True

import runner
import tlc
from kani_reader import KANI_KEY, RouteReader, compiled_problems, kani_surface
from lean_records import read_record as read_lean_record
from surface import STRING, Surface, collapse

FORMAT = 2


def lean_surface(path):
    record = read_lean_record(path)
    surface = Surface()
    surface.add("toolchain", record["toolchain"])
    for entry in record["declarations"]:
        surface.add(f"declaration {entry['name']}", f"{entry['kind']} {entry['typeHash']} {entry['valueHash'] or '-'}")
    return surface


def tla_text(text):
    """Columns can group TLA+ conjunctions and disjunctions across lines."""
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    return "\n".join(lines) if len(lines) > 1 else collapse("".join(lines))


def blank_tla_comments(text):
    out, i = [], 0
    while i < len(text):
        if text[i] == '"':
            string = STRING.match(text, i)
            if string is None:
                raise ValueError("unterminated TLA+ string")
            out.append(string[0])
            i = string.end()
        elif text.startswith("(*", i):
            start, depth = i, 0
            while i < len(text):
                if text.startswith("(*", i):
                    depth += 1
                    i += 2
                elif text.startswith("*)", i):
                    depth -= 1
                    i += 2
                    if not depth:
                        break
                else:
                    i += 1
            # A following token keeps its source column, even after a nested comment.
            out.append(re.sub(r"[^\s]", " ", text[start:i]))
        elif text.startswith("\\*", i):
            end = text.find("\n", i)
            i = len(text) if end < 0 else end
            out.append(" ")
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


DEFINITION = re.compile(r"(?:LOCAL\s+)?(\w*[A-Za-z]\w*)\s*(?:\((?:[^()]|\([^()]*\))*\)|\[(?:[^\[\]]|\[[^\[\]]*\])*\])?\s*==")
MODULE_LEVEL = re.compile(r"-{4,}|={4,}|(?:EXTENDS|VARIABLES?|CONSTANTS?|ASSUME|ASSUMPTION|AXIOM|THEOREM|LEMMA|PROPOSITION|COROLLARY|INSTANCE|RECURSIVE|USE|HIDE)\b")
IDENTIFIER = re.compile(r"\w*[A-Za-z]\w*")
SUBSCRIPT = r"_(\w+|<<[^>]*>>)"
SPEC_ACTIONS = re.compile(rf"\[\]\[[^\]]*\]{SUBSCRIPT}|[WS]F{SUBSCRIPT}\s*\([^()]*\)")
# The prefix that joins a subscript, such as vars in WF_vars, [A]_vars or <<A>>_vars, to one token.
SUBSCRIPT_PREFIX = re.compile(r"\b[WS]F_|\]_|>>_")


def begins_in_column_zero(line):
    return line[:1].strip() != ""


DEFINITION_TOKENS = re.compile(r"\b(?:LET|IN)\b|(?<!=)==(?!=)")


def has_unplaced_definition(code):
    """Return whether a definition can lie outside the column-0 headers that tla_definitions splits on.

    An indented `==` inside an open LET defines a LET-local operator. Any other indented `==`, a line
    that starts with `==`, or a column-0 header while a LET is open can define a module operator.
    """
    open_lets = 0
    for line in code.split("\n"):
        indented = not begins_in_column_zero(line)
        if open_lets and not indented and ("==" in line or MODULE_LEVEL.match(line)):
            return True
        for token in DEFINITION_TOKENS.finditer(line):
            if token[0] == "LET":
                open_lets += 1
            elif token[0] == "IN":
                open_lets = max(open_lets - 1, 0)
            elif not open_lets and (indented or token.start() == 0):
                return True
    return False


def tla_definitions(text):
    found, unreadable, name, lines = {}, set(), None, []
    for line in text.split("\n"):
        if begins_in_column_zero(line):
            match = DEFINITION.match(line)
            header = None if match or MODULE_LEVEL.match(line) or "==" not in line else collapse(line.partition("==")[0])
            if match or header or MODULE_LEVEL.match(line):
                if name:
                    found[name] = tla_text("\n".join(lines))
                name, lines = (match[1] if match else header), ([line] if match or header else [])
                if header:
                    unreadable.add(header)
                continue
        if name:
            lines.append(line)
    if name:
        found[name] = tla_text("\n".join(lines))
    return found, unreadable


EXTENDS = re.compile(r"\bEXTENDS\s+(\w+(?:\s*,\s*\w+)*)")
INSTANCE = re.compile(r"\bINSTANCE\s+(\w+)")
INDENTED_DEFINITION = re.compile(r"^[ \t]*" + DEFINITION.pattern, re.MULTILINE)


def tla_module_surface(directory, spec, operators):
    """Resolve operator references in the module that defines them, including sibling imports."""
    root = Path(spec)
    texts, bodies, scopes, exports = {}, {}, {}, {}
    required, visiting = set(), set()
    whole_modules = False

    def load(path):
        nonlocal whole_modules
        if path in exports:
            return exports[path]
        if path in visiting:
            raise ValueError(f"cyclic TLA+ import at {path}")
        visiting.add(path)
        text = blank_tla_comments(tlc.read_raw(directory / path))
        texts[path] = text
        code = STRING.sub('""', text)
        if has_unplaced_definition(code):
            whole_modules = True
        scope = {}
        for group in EXTENDS.findall(code):
            for name in IDENTIFIER.findall(group):
                sibling = path.with_name(f"{name}.tla")
                if (directory / sibling).is_file():
                    scope.update(load(sibling))
        for name in INSTANCE.findall(code):
            sibling = path.with_name(f"{name}.tla")
            if (directory / sibling).is_file():
                whole_modules = True
                load(sibling)
        definitions, unreadable = tla_definitions(text)
        for name, body in definitions.items():
            key = (path, name)
            bodies[key] = body
            scope[name] = key
        required.update((path, name) for name in unreadable)
        scopes[path] = scope
        exports[path] = {name: key for name, key in scope.items() if not re.match(r"LOCAL\s", bodies[key])}
        visiting.remove(path)
        return exports[path]

    load(root)
    surface = {f"imports {spec}": sorted(str(path) for path in texts if path != root)}
    fallback_names = set()
    if whole_modules:
        fallback_names = {match[1] for text in texts.values() for match in INDENTED_DEFINITION.finditer(text)}
    for name in sorted({"Spec", *operators}):
        if name in scopes[root]:
            required.add(scopes[root][name])
        elif name.rpartition("!")[2] not in fallback_names:
            raise ValueError(f"{name} is named in the {spec} section but no definition was found in it or its local imports")
    if whole_modules:
        # Preserve substitutions and dependencies whose operator scope cannot be resolved.
        for path, text in texts.items():
            surface[f"module text {spec} | {path}"] = tla_text(text)
        return surface

    seen = set()
    while required:
        key = required.pop()
        if key in seen:
            continue
        seen.add(key)
        owner, name = key
        surface[f"definition {owner} {name}"] = bodies[key]
        header, _, body = bodies[key].partition("==")
        body = STRING.sub('""', body)
        if key == scopes[root]["Spec"]:
            # Keep the subscript, such as vars: it decides which steps may stutter and what fairness requires.
            body = SPEC_ACTIONS.sub(lambda form: f" {form[1] or form[2]} ", body)
        body = SUBSCRIPT_PREFIX.sub(" ", body)
        if "[" in header:
            # A function definition such as F[x \in S] == ... references S in its header.
            body = f"{header} {body}"
        required.update(scopes[owner][word] for word in IDENTIFIER.findall(body) if word in scopes[owner])
    return surface


def tla_surface(path):
    surface = Surface()
    surface.add("TLA+ layout version", 1)
    specs = {}
    plan = tlc.MatrixPlan(path)
    tasks = plan.checked_tasks()
    for spec in plan.specs:
        surface.add(f"spec {spec}")
        specs.setdefault(spec, set())
    for task in tasks:
        if task.reach:
            surface.add(f"reach {task.spec} {task.reach.operator} | {collapse(task.reach.match)}",
                        {"run": collapse(task.run.label), "constants": task.run.constants})
            specs[task.spec].add(task.reach.operator)
        else:
            run = surface.add(f"run {task.spec} {collapse(task.run.label)}", task.run.constants)
            for check in task.checks:
                for name in check.names:
                    surface.add(f"check {task.spec} {check.kind} {name} | [{run}]")
                specs[task.spec].update(check.names)
    for spec, operators in specs.items():
        source = path.parent / spec
        if not source.is_file():
            raise ValueError(f"{path}: spec {spec} not found")
        surface.update(tla_module_surface(path.parent, spec, operators))
    return surface


class LeanKind:
    """Record, compare and move the toolchain and declarations of a Lean statements file."""

    name, suffix, renames = "lean", ".statements", False

    def entry(self, path):
        return model_entry(self.name, lean_surface(path)), None

    def changes(self, entry, path):
        return differences(entry["surface"], lean_surface(path), ()), []

    def valid(self, entry):
        return True

    def moved(self, entry, module, new, existing):
        return model_entry(self.name, joined(entry["surface"], new, existing))


class TlaKind:
    """Record, compare and move the checks of a TLA+ matrix and the specs it runs."""

    name, suffix, renames = "tla", ".matrix", False

    def entry(self, path):
        return model_entry(self.name, tla_surface(path)), None

    def changes(self, entry, path):
        old, new = entry["surface"], tla_surface(path)
        lines = []
        if not any(name.startswith("imports ") for name in old):
            lines.append("  previous baseline did not track imported modules; review and record this matrix again")
        if "TLA+ layout version" not in old:
            lines.append("  previous baseline did not preserve TLA+ layout; review and record this matrix again")
        return lines + differences(old, new, ()), []

    def valid(self, entry):
        return True

    def moved(self, entry, module, new, existing):
        return model_entry(self.name, joined(entry["surface"], new, existing))


def may_omit_generator_types(entry):
    # Older entries used the same keys for plain assumptions and generator predicates.
    return not entry.get("generator_types") and any(key.startswith("assume ") for key in entry["surface"])


class KaniKind:
    """Record, compare and move the harnesses, assumptions, covers and stubs of a Kani file, checked against what Kani compiles."""

    name, suffix, renames = "kani", ".rs", True

    def __init__(self):
        self.reader = RouteReader()

    def entry(self, path):
        surface = kani_surface(path, self.reader)
        entry = model_entry(self.name, surface)
        entry["generator_types"] = True
        notes = [f"  route not read: {route.message}" for route in self.reader.unread(path)]
        # A harness that no longer compiles is recorded from its text alone; compare asks Kani again.
        try:
            problems, names = compiled_problems(path, surface, self.reader)
        except ValueError as error:
            return entry, "\n".join([*notes, f"  not checked against Kani: {error}"])
        if problems:
            raise ValueError(f"{path}: " + "; ".join(problem.strip().removeprefix("FAIL ") for problem in problems))
        if names is not None:
            entry["compiled"] = names
        return entry, "\n".join(notes) or None

    def changes(self, entry, path):
        surface = kani_surface(path, self.reader)
        lines = differences(entry["surface"], surface, ("assume", "stub"))
        if may_omit_generator_types(entry):
            lines.insert(0, "  previous baseline stored assumptions without distinguishing any_where input types; review the original assumptions and record this file again")
        unchecked = ("  not checked against Kani at record, so compare cannot tell a harness that "
                     "stopped compiling from one that never compiled")
        try:
            problems, names = compiled_problems(path, surface, self.reader, entry.get("compiled"))
        except ValueError as error:
            if "compiled" in entry:
                return [*lines, f"  FAIL {error}"], []
            return lines, [unchecked, f"  {error}"]
        if names is None or "compiled" in entry and not entry.get("partial"):
            return lines + problems, []
        # Name each recorded harness that Kani does not compile now; a harness behind a feature that is not a
        # default never compiles, so this cannot count as a change.
        recorded = {"harness " + re.sub(r"\[\d+\]$", "", KANI_KEY.fullmatch(item)[2])
                    for item in entry["surface"] if item.startswith("harness ") and item in surface}
        missing = sorted(recorded - set(names) - set(entry.get("compiled", ())))
        return lines + problems, [unchecked, *(f"  not compiled now {item}" for item in missing)]

    def valid(self, entry):
        compiled = entry.get("compiled", [])
        return (isinstance(compiled, list) and all(isinstance(name, str) for name in compiled)
                and isinstance(entry.get("partial", False), bool) and isinstance(entry.get("generator_types", False), bool))

    def moved(self, entry, module, new, existing):
        surface, compiled = entry["surface"], entry.get("compiled")
        if module:
            surface = renamed(surface, *module)
            compiled = compiled and list(renamed(dict.fromkeys(compiled), *module))
        surface = joined(surface, new, existing)
        partial = compiled is None or entry.get("partial", False)
        if existing is not None:
            # The merged list keeps the harnesses of each entry checked against Kani at record, and is partial when
            # either entry was not checked.
            other = existing.get("compiled") if existing["kind"] == self.name else None
            partial = partial or other is None or existing.get("partial", False)
            compiled = None if compiled is None and other is None else [*(other or []), *(compiled or [])]
        result = model_entry(self.name, surface)
        if not any(may_omit_generator_types(part) for part in (entry, existing) if part is not None):
            result["generator_types"] = True
        if compiled is not None:
            result["compiled"] = sorted(compiled)
            if partial:
                result["partial"] = True
        return result


def model_kinds():
    """Return a fresh adapter for each model kind, by the name a record entry gives as its kind."""
    return {kind.name: kind for kind in (LeanKind(), TlaKind(), KaniKind())}


def digest(surface):
    return hashlib.sha256(json.dumps(surface, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


def model_entry(kind, surface):
    return {"kind": kind, "digest": digest(surface), "surface": surface}


def joined(surface, new, existing):
    """Add the items that the entry existing records for the file new, which must not repeat an item of surface."""
    if existing is None:
        return surface
    if overlap := surface.keys() & existing["surface"].keys():
        raise ValueError(f"{new} already records {', '.join(sorted(overlap))}")
    return {**existing["surface"], **surface}


def read_record(path, kinds):
    record = json.loads(path.read_text(encoding="utf-8"))
    models = record.get("models") if isinstance(record, dict) else None
    if not isinstance(models, dict) or record.get("format") != FORMAT:
        raise ValueError(f"{path}: unsupported record format; run record with a new record file")
    for model, entry in models.items():
        if (not isinstance(entry, dict) or entry.get("kind") not in kinds or not isinstance(entry.get("surface"), dict)
                or not kinds[entry["kind"]].valid(entry)):
            raise ValueError(f"{path}: malformed entry for {model}")
    return models


@contextmanager
def locked_models(path, kinds):
    """Lock a stable sibling across the read and replacement of a record."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_name(f".{path.name}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield read_record(path, kinds) if path.exists() else {}


def write_record(path, models):
    runner.atomic_write(path, json.dumps({"format": FORMAT, "models": models}, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def record(record_path, files):
    kinds = model_kinds()
    by_suffix = {kind.suffix: kind for kind in kinds.values()}
    for file in files:
        if file.suffix not in by_suffix:
            print(f"usage: {file} has no model surface; expected one of {', '.join(by_suffix)}")
            return 2
    updates, notes = {}, {}
    for file in files:
        model = str(file.resolve())
        updates[model], note = by_suffix[file.suffix].entry(file.resolve())
        if note:
            notes[model] = note
    with locked_models(record_path, kinds) as models:
        write_record(record_path, {**models, **updates})
    for model, entry in updates.items():
        print(f"RECORDED {model} {entry['digest']}")
        previous = models.get(model, {}).get("digest")
        if previous and previous != entry["digest"]:
            print(f"  previous {previous}")
        if model in notes:
            print(notes[model])
    return 0


def renamed(surface, old_module, new_module):
    """Rewrite each Kani owner under old_module to sit under new_module, where `crate` is the file's root."""
    old, new = ([] if path == "crate" else path.split("::") for path in (old_module, new_module))
    result = {}
    for name, value in surface.items():
        if (item := KANI_KEY.fullmatch(name)) is None:
            raise ValueError(f"cannot rename the recorded item '{name}', which is not a Kani harness, assume, cover or stub")
        head, owner, duplicate = item.groups()
        parts = owner.split("::")
        if parts[:len(old)] == old:
            owner = "::".join(new + parts[len(old):])
        result[f"{head}{owner}{duplicate or ''}"] = value
    if len(result) != len(surface):
        raise ValueError(f"renaming {old_module} to {new_module} merges recorded items")
    return result


def move(record_path, old_file, new_file, module):
    kinds = model_kinds()
    old, new = str(old_file.resolve()), str(new_file.resolve())
    with locked_models(record_path, kinds) as models:
        if old not in models:
            print(f"usage: {old} has no record entry; record it before the move")
            return 2
        kind = kinds[models[old]["kind"]]
        if new_file.suffix != kind.suffix:
            print(f"usage: {new} is not a {kind.name} model file")
            return 2
        if module and not kind.renames:
            print("usage: --module applies only to a Kani harness file")
            return 2
        entry = models.pop(old)
        models[new] = kind.moved(entry, module, new, models.get(new))
        write_record(record_path, models)
    print(f"MOVED {old} -> {new}")
    return 0


def differences(old, new, narrowing):
    lines = []
    for name in old:
        if name not in new:
            lines.append(f"  removed {name}")
        elif old[name] != new[name]:
            lines += [f"  changed {name}", f"    old: {old[name]}", f"    new: {new[name]}"]
    lines += [f"  added {name}" for name in new if name not in old and name.split(" ", 1)[0] in narrowing]
    return lines


def compare(record_path):
    if not record_path.is_file():
        print(f"usage: record file {record_path} does not exist; run record first")
        return 2
    kinds = model_kinds()
    models = read_record(record_path, kinds)
    changed = unchecked = 0
    for model, entry in models.items():
        try:
            if not Path(model).is_file():
                lines, notes = ["  file is missing"], []
            else:
                lines, notes = kinds[entry["kind"]].changes(entry, Path(model))
        except (OSError, ValueError, KeyError, TypeError) as error:
            lines, notes = [f"  FAIL {error}"], []
        changed += bool(lines)
        unchecked += bool(notes) and not lines
        if lines:
            status = "CHANGED"
        elif notes:
            status = "NOT CHECKED"
        else:
            status = "UNCHANGED"
        print(f"{status} {model}")
        if lines or notes:
            print("\n".join(lines + notes))
    not_checked = f", {unchecked} not checked" if unchecked else ""
    print(f"SUMMARY {len(models) - changed - unchecked} unchanged, {changed} changed{not_checked}")
    return int(changed > 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    recording = commands.add_parser("record", help="record or update the entries for these model files")
    recording.add_argument("record_file", type=Path)
    recording.add_argument("models", nargs="+", type=Path)
    commands.add_parser("compare", help="compare every recorded model with its file").add_argument("record_file", type=Path)
    moving = commands.add_parser("move", help="move a model's recorded entry to the file it moved to")
    moving.add_argument("record_file", type=Path)
    moving.add_argument("old_file", type=Path)
    moving.add_argument("new_file", type=Path)
    moving.add_argument("--module", nargs=2, metavar=("OLD", "NEW"),
                        help="the Kani harnesses moved from module OLD to NEW; crate names the file's root")
    arguments = parser.parse_args()
    if arguments.command == "record":
        return record(arguments.record_file, arguments.models)
    if arguments.command == "move":
        return move(arguments.record_file, arguments.old_file, arguments.new_file, arguments.module)
    return compare(arguments.record_file)


def guarded_main():
    try:
        return main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"FAIL baseline: {error}")
        return 1


if __name__ == "__main__":
    # The runner turns a stopping signal into an exception, so Kani's work directory is removed before the exit.
    runner.run(guarded_main)
