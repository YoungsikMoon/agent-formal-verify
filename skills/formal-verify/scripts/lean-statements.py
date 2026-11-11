#!/usr/bin/env python3
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Store or check declaration fingerprints emitted by the Lean audit."""

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path


def fingerprint(expression):
    return hashlib.sha256(expression.encode("utf-8")).hexdigest()


def declarations(audit):
    modules = {}
    for line in audit.read_text(encoding="utf-8").splitlines():
        if not line.startswith("STATEMENT "):
            continue
        raw = json.loads(line.removeprefix("STATEMENT "))
        record = {key: raw[key] for key in ("name", "kind", "type")}
        record["type"] = " ".join(record["type"].split())
        record["typeHash"] = fingerprint(raw["typeExpr"])
        record["valueHash"] = None if raw["valueExpr"] is None else fingerprint(raw["valueExpr"])
        modules.setdefault(raw["module"], []).append(record)
    return modules


def records_by_name(modules, module):
    """Return the module's audited records by name, refusing two declarations with one name."""
    records = {}
    for record in modules.get(module, []):
        if record["name"] in records:
            raise ValueError(f"ambiguous declaration identity {record['name']} in {module}")
        records[record["name"]] = record
    return records


def read_record(path):
    record = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or record.get("format") != 1:
        raise ValueError(f"{path}: unsupported statements format")
    if not isinstance(record.get("toolchain"), str) or not isinstance(record.get("module"), str):
        raise TypeError(f"{path}: missing toolchain or module")
    entries = record.get("declarations")
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"{path}: missing declarations")
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict) or not all(isinstance(entry.get(key), str) for key in ("name", "kind", "type", "typeHash")):
            raise ValueError(f"{path}: malformed declaration")
        if "valueHash" not in entry or entry["valueHash"] is not None and not isinstance(entry["valueHash"], str):
            raise ValueError(f"{path}: malformed value hash")
        if entry["name"] in seen:
            raise ValueError(f"{path}: duplicate declaration {entry['name']}")
        seen.add(entry["name"])
    return record


def check_orphans(project):
    failed = False
    for path in sorted(project.rglob("*.statements")):
        if ".lake" in path.relative_to(project).parts or path.with_suffix(".lean").is_file():
            continue
        record = read_record(path)
        print(f"FROZEN {path}: source file is missing")
        for declaration in record["declarations"]:
            print(f"FROZEN {declaration['name']}: statement changed (source deleted)")
        failed = True
    return int(failed)


def freeze(toolchain, modules, sources):
    """Record every source's statements, writing none unless all of them can be recorded."""
    pending = []
    for module, source in sources:
        records = records_by_name(modules, module)
        if not records:
            raise ValueError(f"no declaration records for {source}")
        record = {"format": 1, "toolchain": toolchain, "module": module,
                  "declarations": [records[name] for name in sorted(records)]}
        pending.append((source.with_suffix(".statements"), json.dumps(record, ensure_ascii=False, indent=2) + "\n"))
    for path, contents in pending:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(contents)
            temporary.replace(path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        print(f"FROZEN {path}: statements recorded; proofs not checked")
    return 0


def check(toolchain, modules, sources):
    """Compare every recorded source's statements with the audit; a source without a record passes."""
    failed = False
    for module, source in sources:
        path = source.with_suffix(".statements")
        if not path.exists():
            continue
        records = records_by_name(modules, module)
        frozen = read_record(path)
        if frozen["toolchain"] != toolchain:
            print(f"FROZEN {path}: toolchain changed from {frozen['toolchain']} to {toolchain}; review and run --freeze")
            failed = True
            continue
        if frozen["module"] != module:
            raise ValueError(f"{path}: expected module {module}, found {frozen['module']}")
        changed = 0
        for old in frozen["declarations"]:
            new = records.get(old["name"])
            if new is not None and all(old[key] == new[key] for key in ("kind", "typeHash", "valueHash")):
                continue
            changed += 1
            print(f"FROZEN {old['name']}: statement changed")
            print(f"  old: {old['type']}")
            print(f"  new: {new['type'] if new else '(deleted)'}")
            if new and old["valueHash"] != new["valueHash"]:
                print("  definition value changed")
        if changed == len(frozen["declarations"]):
            print(f"FROZEN {path}: every recorded declaration changed; review the model and toolchain before --freeze")
        failed |= changed > 0
    return int(failed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("orphans", help="report records whose source file is gone").add_argument("project", type=Path)
    for name, purpose in (("freeze", "record each source's statements"), ("check", "compare each recorded source's statements")):
        command = commands.add_parser(name, help=purpose)
        command.add_argument("toolchain")
        command.add_argument("audit", type=Path, help="the audit's output, with its STATEMENT lines")
        command.add_argument("module_names", type=Path, help="the module of each source, one per line in source order")
        command.add_argument("sources", nargs="+", type=Path)
    arguments = parser.parse_args()
    if arguments.command == "orphans":
        return check_orphans(arguments.project)
    names = arguments.module_names.read_text(encoding="utf-8").splitlines()
    if len(names) != len(arguments.sources):
        raise ValueError("Lake did not return one module per source")
    action = freeze if arguments.command == "freeze" else check
    return action(arguments.toolchain, declarations(arguments.audit), zip(names, arguments.sources))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"FAIL statements: {error}")
        sys.exit(1)
