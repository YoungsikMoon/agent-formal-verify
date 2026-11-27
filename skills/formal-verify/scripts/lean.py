#!/usr/bin/env python3
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Build a Lean 4 model with Lake, audit its declarations, check its frozen statements and witnesses, and replay it.

Fails when the build fails, a declaration uses sorry or rests on an axiom beyond propext, Classical.choice and
Quot.sound, no Lake library owns a .lean file in the project, a theorem named <Property>.witness does not state
that the hypotheses of <Property> hold together, or the pin's leanchecker rejects a built module on kernel replay.
Otherwise prints the build output, a WITNESS line for each property and PASS. A property without a witness passes,
and so does a pin that ships no leanchecker; the PASS line counts the first and reports the replay as unavailable
for the second. Named files limit the check to those sources, so agents that share a project can each check their
own model; a run without them checks the whole project. Needs a pin of Lean 4.20.0 or later, the first whose Lake
builds a module by its source path.

Usage: lean.py check <lake-project-dir> [--freeze] [<file.lean> ...]
  The Lean checker; lean-check.sh runs it.
Usage: lean.py ready <lake-project-dir>
  Installs the project's pinned toolchain unless it already runs, then reports it and the temporary directory's free
  space as storage.py report does. setup.sh lean runs it.
"""
import signal

if __name__ == "__main__":
    # Python's SIGINT handler raises KeyboardInterrupt, which prints a traceback when it arrives during the imports.
    # Until runner.run installs its own handlers, the default action ends the process by the signal instead.
    if signal.getsignal(signal.SIGINT) is signal.default_int_handler:
        signal.signal(signal.SIGINT, signal.SIG_DFL)

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
import processes
import runner
import storage
from lean_records import read_record

HERE = Path(__file__).parent
USAGE = "usage: lean-check.sh <lake-project-dir> [--freeze] [<file.lean> ...]"
# Lean quotes sorry with backticks or straight quotes depending on the version.
SORRY = re.compile(r"(warning|error): .*: declaration uses .sorry.")
AUDITED = re.compile(r"AUDITED [0-9]+ declarations")
BLANK = re.compile(r"[ \t\n\r\f\v]*")
OLD_LAKE = re.compile(r"error: (unknown command 'query'|invalid script spec)")


class CheckError(Exception):
    """The project cannot be checked as given; the message is the FAIL line to print."""


def lines(text):
    """Split output into the lines a shell reads, without the empty piece after a final newline."""
    parts = text.split("\n")
    if parts[-1] == "":
        parts.pop()
    return parts


def logical_path(path):
    """Make a path absolute as the shell's cd and pwd do, keeping symbolic links in it."""
    if not os.path.isabs(path):
        cwd = os.environ.get("PWD", "")
        if not os.path.isabs(cwd) or not os.path.isdir(cwd) or not os.path.samefile(cwd, "."):
            cwd = os.getcwd()
        path = os.path.join(cwd, path)
    return os.path.normpath(path)


# Release names that elan resolves to a release online, as a channel or as the release a repository's
# lean-toolchain file names.
CHANNELS = {"stable", "beta", "nightly", "lean-toolchain"}


def pin(project):
    """Return the toolchain pin of the Lake project, or raise when it has none or elan is missing."""
    path = Path(project) / "lean-toolchain"
    if not path.is_file():
        raise CheckError(f"FAIL {project} has no lean-toolchain pin")
    if shutil.which("elan") is None:
        raise runner.Unavailable("UNAVAILABLE elan is not on PATH; install elan from https://github.com/leanprover/elan")
    try:
        toolchain = path.read_text(encoding="utf-8").replace("\r", "").replace("\n", "")
    except (OSError, UnicodeDecodeError) as error:
        raise CheckError(f"FAIL cannot read {path}: {error}") from error
    if toolchain.rpartition(":")[2] in CHANNELS:
        raise CheckError(f"FAIL {path} pins {toolchain}, which elan resolves to a release online; pin a release, "
                         "such as leanprover/lean4:v<version>")
    return toolchain


def installed(toolchain):
    """Whether elan lists the toolchain, under the name elan gives a pin, so that no elan run downloads it.

    A pin that is an absolute path names a toolchain directory, which elan runs without installing anything.
    """
    if os.path.isabs(toolchain):
        return os.path.isdir(toolchain)
    origin, _, channel = toolchain.rpartition(":")
    origin = origin or "leanprover/lean4"
    if channel[:1].isdigit():
        channel = "v" + channel
    if channel.startswith("nightly-") and not origin.endswith("-nightly"):
        origin += "-nightly"
    listed = processes.run_captured(["elan", "toolchain", "list"], encoding="utf-8", errors="replace")
    names = {line.split()[0] for line in listed.stdout.splitlines() if line.strip()}
    return listed.returncode == 0 and bool(names & {toolchain, f"{origin}:{channel}"})


def pin_ready(toolchain):
    """Whether the toolchain is installed and runs Lake. elan run installs a missing toolchain, so check first."""
    try:
        return installed(toolchain) and processes.run_captured(["elan", "run", toolchain, "lake", "--version"],
                                                               encoding="utf-8", errors="replace").returncode == 0
    except OSError:
        return False


def ready_pin(project):
    """Return the project's pin when its toolchain runs, or raise with the remedy."""
    toolchain = pin(project)
    if not pin_ready(toolchain):
        raise runner.Unavailable(f"UNAVAILABLE {toolchain} is not ready; run bash {HERE}/setup.sh lean {project}")
    return toolchain


def step(command, *, merge=True, env=None):
    """Run one build step and return its status as a shell reports it, its stdout and its stderr.

    With merge, stderr joins stdout in the order the step wrote them, and the returned stderr is empty. Lean and Lake
    write UTF-8 whatever the locale, and the frozen records hash that text, so it is read as UTF-8.
    """
    def collect(process):
        stdout, stderr = process.communicate()
        status = process.returncode
        return (128 - status if status < 0 else status), stdout, stderr or ""
    try:
        return processes.guarded(command, collect, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT if merge else subprocess.PIPE, encoding="utf-8",
                                 errors="replace", env=env)
    except OSError as error:
        return 127, "", f"cannot run {command[0]}: {error}\n"


def project_files(project):
    """Find model sources and orphan records in the same walk, outside the root Lake build directory."""
    sources, records = set(), []
    for top, directories, names in os.walk(project):
        if top == project and ".lake" in directories:
            directories.remove(".lake")
        for name in directories + names:
            if name.endswith(".lean") and (top != project or name != "lakefile.lean"):
                sources.add(os.path.join(top, name))
            elif name.endswith(".statements"):
                records.append(Path(top, name))
    return sorted(sources), sorted(path for path in records if str(path.with_suffix(".lean")) not in sources)


def layout(objects, search_path):
    """Name the module of each queried object and the library roots that own them, from Lake's search path."""
    roots = sorted({Path(entry).resolve() for entry in search_path.split(os.pathsep) if entry},
                   key=lambda path: len(path.parts), reverse=True)
    names, owners = [], set()
    for line in objects.splitlines():
        path = Path(line)
        # The object itself may link into an artifact cache. Its location in the library names the module.
        path = path.parent.resolve() / path.name
        owner = next((root for root in roots if root in path.parents), None)
        if owner is None or path.suffix != ".olean":
            raise ValueError(f"cannot identify the module of {line}")
        names.append(".".join(path.relative_to(owner).with_suffix("").parts))
        owners.add(owner)
    return names, sorted(owners)


def fingerprint(expression):
    return hashlib.sha256(expression.encode("utf-8")).hexdigest()


def declarations(audit):
    """Group the audit's STATEMENT records by module, with each type and value reduced to a fingerprint."""
    modules = {}
    for line in audit:
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


def check_orphans(orphans, out):
    """Report every record without a model source in the project."""
    for path in orphans:
        record = read_record(path)
        out(f"FROZEN {path}: source file is missing")
        for declaration in record["declarations"]:
            out(f"FROZEN {declaration['name']}: statement changed (source deleted)")
    return int(bool(orphans))


def freeze_statements(toolchain, modules, sources, out):
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
        runner.atomic_write(path, contents)
        out(f"FROZEN {path}: statements recorded; proofs not checked")
    return 0


def check_statements(toolchain, modules, sources, out):
    """Compare every recorded source's statements with the audit; a source without a record passes."""
    failed = False
    for module, source in sources:
        path = source.with_suffix(".statements")
        if not path.exists():
            continue
        records = records_by_name(modules, module)
        frozen = read_record(path)
        if frozen["toolchain"] != toolchain:
            out(f"FROZEN {path}: toolchain changed from {frozen['toolchain']} to {toolchain}; review and run --freeze")
            failed = True
            continue
        if frozen["module"] != module:
            raise ValueError(f"{path}: expected module {module}, found {frozen['module']}")
        changed = 0
        for old in frozen["declarations"]:
            if old["kind"] == "opaque" and old["valueHash"] is None:
                out(f"FROZEN {old['name']}: opaque body was not recorded; review the definition and run --freeze")
                failed = True
                continue
            new = records.get(old["name"])
            if new is not None and all(old[key] == new[key] for key in ("kind", "typeHash", "valueHash")):
                continue
            changed += 1
            out(f"FROZEN {old['name']}: statement changed")
            out(f"  old: {old['type']}")
            out(f"  new: {new['type'] if new else '(deleted)'}")
            if new and old["valueHash"] != new["valueHash"]:
                out("  definition value changed")
        if changed == len(frozen["declarations"]):
            out(f"FROZEN {path}: every recorded declaration changed; review the model and toolchain before --freeze")
        failed |= changed > 0
    return int(failed)


def statements(action):
    """Run a frozen-record step on a line sink and return its status and output; an unreadable record fails the step."""
    output = []
    try:
        status = action(output.append)
    except (OSError, ValueError, KeyError, TypeError) as error:
        output.append(f"FAIL statements: {error}")
        status = 1
    return status, output


def check(project, files, freeze, out):
    """Check a Lake project, or only the named sources in it, writing each output line to out; return the exit status."""
    if not (Path(project) / "lakefile.toml").is_file() and not (Path(project) / "lakefile.lean").is_file():
        out(f"FAIL {project} has no lakefile")
        return 1
    project = logical_path(project)
    try:
        toolchain = ready_pin(project)
    except CheckError as error:
        out(str(error))
        return 1
    with tempfile.TemporaryDirectory(prefix="lean-check.", dir=storage.ensure_temp_root()) as temporary:
        storage.warn_runtime()
        return checked(project, toolchain, files, freeze, out, Path(temporary))


def checked(project, toolchain, files, freeze, out, work):
    """Build, audit, compare frozen statements, check witnesses and replay, in that order, stopping at the first failure."""
    lake = ["elan", "run", toolchain, "lake", "--dir", project]
    # Lake builds a module named by its source path and rejects a path that no library owns, so naming every
    # source leaves no file unchecked. Its query command prints the .olean of each, which names the modules to
    # audit without picking up a module left in the build directory by a deleted source.
    scope = project
    if files:
        scope = f"{project} ({' '.join(files)} only)"
        sources = [source if source.startswith("/") else f"{project}/{source}" for source in files]
        for source in sources:
            if not os.path.isfile(source):
                out(f"FAIL {source} does not exist")
                return 1
    else:
        sources, orphans = project_files(project)
        if not freeze:
            status, output = statements(lambda sink: check_orphans(orphans, sink))
            if status:
                out(f"FAIL {scope}: frozen model sources are missing or their records are invalid")
                for line in output:
                    out(line)
                return status
        if not sources:
            out(f"FAIL {project} has no .lean file to check")
            return 1
    status, objects, log = step([*lake, "query", *(f"{source}:olean" for source in sources)], merge=False)
    log = lines(log)
    sorries = [line for line in log if SORRY.match(line)]

    # lean-analysis.lean audit imports those modules and collects the axioms under each of their declarations, so
    # it needs no #print axioms line in the model. It skips the compiler's auxiliary declarations, which older
    # pins store with opaque placeholders that would read as axioms.
    audit_status, audit, modules, libraries = 0, [], [], []
    if status == 0:
        # The module of each source, in source order, for the audit's imports and the frozen records.
        # Lake writes notices to stderr, such as one for a project with both lakefiles, so only stdout is the path.
        found, search_path, errors = step([*lake, "env", "printenv", "LEAN_PATH"], merge=False)
        try:
            if found:
                raise ValueError(f"{search_path}{errors}lake env exit {found}")
            modules, libraries = layout(objects, search_path.rstrip("\n"))
        except (ValueError, OSError) as error:
            out(f"FAIL {scope}: cannot resolve Lake's module layout")
            for line in lines(f"{error}\n"):
                out(line)
            return 1
        module_list = work / "modules"
        module_list.write_text("".join(name + "\n" for name in modules), encoding="utf-8")
        audit_status, output, _ = step([*lake, "env", "lean", "--run", str(HERE / "lean-analysis.lean"),
                                        "audit", *(["--freeze"] if freeze else []), str(module_list)])
        audit = lines(output)
        if not any(AUDITED.fullmatch(line) for line in audit):
            audit_status = 1
        if "AUDITED 0 declarations" in audit:
            frozen = any(os.path.isfile(source.removesuffix(".lean") + ".statements") for source in sources)
            if freeze or not frozen:
                audit_status = 1
    axioms = [line for line in audit if line.startswith("AXIOMS ")]

    if status or not freeze and sorries or axioms or audit_status:
        out(f"FAIL {scope}: {len(sorries)} unfinished proofs (sorry), {len(axioms)} declarations on an added axiom, "
            f"lake exit {status}")
        for line in sorries + axioms:
            out(line)
        if status:
            for line in [line for line in log if not BLANK.fullmatch(line)][-40:]:
                out(line)
        if any(line.startswith("error: unknown module source path") for line in log):
            out("no library owns that file; import it from a built module or move it out of the project")
        if any(OLD_LAKE.match(line) for line in log):
            out(f"{toolchain} cannot build a module by its source path; pin Lean 4.20.0 or later")
        if audit_status:
            out("the axiom audit did not run or found no declarations:")
            for line in [line for line in audit if not BLANK.fullmatch(line) and not line.startswith("IMPORTED ")][-40:]:
                out(line)
            if any("environment already contains" in line for line in audit):
                out("two modules declare the same name; put each model in a namespace of its own")
        return 1
    def compare(sink):
        if len(modules) != len(sources):
            raise ValueError("Lake did not return one module per source")
        action = freeze_statements if freeze else check_statements
        return action(toolchain, declarations(audit), zip(modules, map(Path, sources)), sink)
    statement_status, output = statements(compare)
    if statement_status:
        out(f"FAIL {scope}: frozen statements differ or could not be checked")
        for line in output:
            out(line)
        return statement_status
    # #eval output arrives as info blocks that can span lines.
    for line in output + [line for line in log if not BLANK.fullmatch(line)]:
        out(line)
    if freeze:
        return 0

    def witnesses(kind):
        return sum(line.startswith(f"WITNESS {kind} ") for line in audit)
    failed = witnesses("failed")
    if failed:
        out(f"FAIL {scope}: {failed} witnesses do not state their property's hypotheses")
    for line in audit:
        if line.startswith("WITNESS "):
            out(line)
    if failed:
        return 1

    # The build trusts a declaration that a command adds to the environment without a kernel check. leanchecker
    # replays every declaration of the built modules through the kernel and rejects it. Use its exact-module
    # replayer rather than its CLI's prefix search, which also finds deleted sources' cached objects. A named
    # module rests on the project modules it imports, so replay those too.
    prefix = processes.guarded(["elan", "run", toolchain, "lean", "--print-prefix"],
                               lambda process: process.communicate()[0], stdout=subprocess.PIPE,
                               encoding="utf-8", errors="replace")
    prefix = prefix.rstrip("\n")
    replay = "unavailable"
    if os.access(f"{prefix}/bin/leanchecker", os.X_OK):
        imported = [line.removeprefix("IMPORTED ") for line in audit if line.startswith("IMPORTED ")]
        replayed = set(modules) | {module for module in imported
                                   if any((library / (module.replace(".", "/") + ".olean")).is_file() for library in libraries)}
        replay_list = work / "replay-modules"
        replay_list.write_text("".join(module + "\n" for module in sorted(replayed)), encoding="utf-8")
        replay_status, output, _ = step([*lake, "env", "lean", str(HERE / "lean-replay.lean")],
                                        env=os.environ | {"AFV_REPLAY_MODULES": str(replay_list)})
        replay = "failed" if replay_status else "passed"
        if replay == "failed":
            out(f"FAIL {scope}: kernel replay rejected a built module")
            for line in lines(output):
                out(line)
            return 1
        out(f"REPLAYED {sum(line.startswith('replaying ') for line in lines(output))} modules through the Lean kernel")
    else:
        out(f"UNAVAILABLE kernel replay: {toolchain} ships no leanchecker")
    declared = "\n".join(line.split(" ")[1] for line in audit if line.startswith("AUDITED "))
    out(f"PASS {scope}: {declared} declarations checked, no unfinished proof (sorry), no added axiom, kernel replay "
        f"{replay}, {witnesses('checked')} witnesses checked, {witnesses('absent')} absent, "
        f"{witnesses('unavailable')} unavailable, {witnesses('no-hypotheses')} properties without hypotheses")
    return 0


def ready(project):
    """Install the project's pinned toolchain unless it already runs, then report it and the temporary storage."""
    try:
        toolchain = pin(project)
    except CheckError as error:
        print(error)
        return 1
    if not pin_ready(toolchain):
        status, log, _ = step(["elan", "toolchain", "install", toolchain])
        log = log.rstrip("\n")
        if status:
            raise runner.Unavailable(f"UNAVAILABLE cannot install {toolchain}; run elan toolchain install {toolchain}\n{log}")
        if not pin_ready(toolchain):
            raise runner.Unavailable(f"UNAVAILABLE {toolchain} does not run after installation; "
                                     f"check elan toolchain list and reinstall it\n{log}")
        if log:
            print(log)
    print(f"READY Lean {toolchain}")
    storage.report()
    return 0


def main():
    # Lean's output is UTF-8 whatever the locale; pass it through unchanged, as the shell checker did. Each line goes
    # out as it is written, so a killed or piped run keeps what it printed, and a path that the locale could not
    # decode goes out as its original bytes.
    sys.stdout.reconfigure(encoding="utf-8", errors="surrogateescape", line_buffering=True)
    command, *arguments = sys.argv[1:] or [""]
    if command == "ready" and len(arguments) == 1:
        return ready(arguments[0])
    if command != "check" or not arguments:
        print(USAGE)
        return 2
    project, *files = arguments
    freeze = files[:1] == ["--freeze"]
    files = files[freeze:]
    if any(name.startswith("--") for name in files):
        print("usage: --freeze must precede source files")
        return 2
    return check(project, files, freeze, print)


if __name__ == "__main__":
    runner.run(main)
