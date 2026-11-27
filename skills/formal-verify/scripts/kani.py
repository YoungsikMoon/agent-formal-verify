#!/usr/bin/env python3
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Run the pinned Kani and validate its versioned discovery and result records."""
import signal

if __name__ == "__main__":
    # Python's SIGINT handler raises KeyboardInterrupt, which prints a traceback when it arrives during the imports.
    # Until runner.run installs its own handlers, the default action ends the process by the signal instead.
    if signal.getsignal(signal.SIGINT) is signal.default_int_handler:
        signal.signal(signal.SIGINT, signal.SIG_DFL)

import argparse
import json
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path

sys.dont_write_bytecode = True
import processes
import runner
import storage

STATUSES = {"Success", "Failure", "Unreachable", "Undetermined", "Satisfied", "Unsatisfiable"}
# Statuses that pass and statuses that refute the property, by check category; any other is inconclusive.
OUTCOMES = {
    "cover": ({"Satisfied"}, {"Unsatisfiable", "Unreachable"}),
    "unwind": ({"Success", "Unreachable"}, set()),
}
PROPERTY_OUTCOMES = ({"Success", "Unreachable"}, {"Failure"})


class CheckError(Exception):
    pass


class Verdict(IntEnum):
    """A check's or harness's result, ordered so the worst check decides the harness."""
    PASS = 0
    REFUTED = 1
    INCONCLUSIVE = 2


@dataclass(frozen=True)
class Harness:
    unwind: int
    source: Path
    should_panic: bool


@dataclass(frozen=True)
class Compiled:
    name: str
    source: Path
    attributes: dict


@dataclass(frozen=True)
class Outcome:
    verdict: Verdict
    checks: int
    failures: list
    output: str


def search_path(inherited, *directories):
    entries = [str(directory) for directory in directories]
    if inherited is not None:
        entries.append(inherited)
    return os.pathsep.join(entries)


@dataclass(frozen=True)
class CargoMetadata:
    workspace: Path
    target: Path
    packages: tuple


@dataclass
class CrateSources:
    roots: set
    outputs: set

    def stage(self, crate, work):
        """Copy local packages in their relative layout, omitting Cargo's build directories."""
        anchor = Path(os.path.commonpath(self.roots))
        work = work.resolve()
        # Other mutations can stage into the same workspace-local temporary root.
        (work / "CACHEDIR.TAG").write_text("Signature: 8a477f597d28d172789f06886806bc55\n", encoding="ascii")
        destination = work / "source"

        def ignore(directory, names):
            # Cargo tags each build directory, including one left behind after the target directory moved.
            # A dangling symlink, such as an editor's lock file, is skipped here because copytree's
            # ignore_dangling_symlinks reaches only the top directory before Python 3.10.
            directory = Path(directory).resolve()
            skipped = []
            for name in names:
                path = directory / name
                if (name == ".git" or path == work or path in self.outputs or (path / "CACHEDIR.TAG").is_file()
                        or path.is_symlink() and (not path.exists() or path.resolve().is_relative_to(work))):
                    skipped.append(name)
            return skipped

        for root in self.roots:
            if self.roots.isdisjoint(root.parents):
                shutil.copytree(root, destination / root.relative_to(anchor), ignore=ignore)
        return destination / crate.relative_to(anchor)


class Kani:
    version = "0.68.0"

    def __init__(self):
        home = Path(os.environ.get("KANI_HOME", Path.home() / ".kani")).resolve()
        self.timeout = os.environ.get("KANI_HARNESS_TIMEOUT", "").strip() or "5m"
        # Kani reads a number with no unit as seconds; the label names the unit when reporting the limit.
        self.limit = runner.parse_limit("KANI_HARNESS_TIMEOUT", self.timeout, "harness time limit", "five minutes")[0]
        bundle = home / f"kani-{self.version}"
        remedy = (f"run cargo install --locked kani-verifier --version {self.version} "
                  "then cargo kani setup")
        for binary in ("bin/kani-driver", "bin/kani-compiler", "bin/cbmc", "toolchain/bin/rustc", "toolchain/bin/cargo"):
            path = bundle / binary
            if not path.is_file() or not os.access(path, os.X_OK):
                raise runner.Unavailable(f"UNAVAILABLE Kani {self.version} bundle is incomplete; {remedy}")
        if any(home.glob("*.tar.gz")):
            raise runner.Unavailable(f"UNAVAILABLE incomplete Kani setup at {home}; finish cargo kani setup before checking")
        self.bundle = bundle
        self.driver = bundle / "bin/kani-driver"
        self.cargo = bundle / "toolchain/bin/cargo"
        self.env = os.environ | {
            "KANI_HOME": str(home),
            "RUSTUP_TOOLCHAIN": str((bundle / "toolchain").resolve()),
            "PATH": search_path(os.environ.get("PATH"), bundle / "bin", bundle / "pyroot/bin", bundle / "toolchain/bin"),
            "PYTHONPATH": search_path(os.environ.get("PYTHONPATH"), bundle / "pyroot"),
        }
        # A parent cargo (cargo run, cargo test, a build script) exports its rustup toolchain's
        # lib directory here; the bundled compiler must load only the bundled toolchain.
        loader = "DYLD_FALLBACK_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"
        if loader in self.env:
            self.env[loader] = os.pathsep.join(
                path for path in self.env[loader].split(os.pathsep)
                if not (Path(path).name == "lib" and Path(path).parent.parent.name == "toolchains"))
        try:
            done = self.run("--version")
        except CheckError as error:
            raise runner.Unavailable(f"UNAVAILABLE Kani {self.version} cannot run: {error}; {remedy}") from error
        if done.returncode or not done.stdout.startswith(f"Kani Rust Verifier {self.version} (cargo plugin)\n"):
            raise runner.Unavailable(f"UNAVAILABLE Kani {self.version} is required; {remedy}")

    def run(self, *arguments, cwd=None, tmpdir=None):
        env = self.env if tmpdir is None else self.env | {"TMPDIR": str(tmpdir)}
        try:
            # The driver selects Cargo mode from argv[0]; the Cargo wrapper can auto-install.
            return processes.run_captured(["cargo-kani", *arguments], executable=str(self.driver), env=env, cwd=cwd)
        except OSError as error:
            raise CheckError(f"cannot execute Kani: {error}") from error

    def cargo_metadata(self, crate, resolve=False):
        """Read package declarations; resolve only when finding the full local source graph."""
        try:
            done = processes.run_captured(
                [str(self.cargo), "metadata", *([] if resolve else ["--no-deps"]), "--format-version", "1",
                 "--manifest-path", str(crate / "Cargo.toml")],
                cwd=crate, env=self.env)
        except OSError as error:
            raise CheckError(f"cannot read Cargo metadata: {error}") from error
        if done.returncode:
            raise CheckError(f"Cargo metadata failed for {crate}:\n{done.stdout}{done.stderr}")
        try:
            report = json.loads(done.stdout)
            if report["version"] != 1:
                raise CheckError("unsupported Cargo metadata version")
            workspace = Path(report["workspace_root"])
            target = Path(report["target_directory"])
            packages = []
            for package in report["packages"]:
                if package["source"] is None:
                    packages.append(Path(package["manifest_path"]).parent)
                    packages.extend(Path(dep["path"]) for dep in package["dependencies"] if "path" in dep)
            if not all(path.is_absolute() for path in (workspace, target, *packages)):
                raise CheckError("Cargo metadata returned a relative source path")
            return CargoMetadata(workspace, target, tuple(packages))
        except (ValueError, KeyError, TypeError) as error:
            raise CheckError(f"malformed Cargo metadata: {error}") from error

    def crate_sources(self, crate):
        """Find local workspaces, including transitive and optional path dependencies."""
        pending, visited = {crate}, set()
        sources = CrateSources(set(), set())
        while pending:
            directory = pending.pop()
            if directory in visited:
                continue
            visited.add(directory)
            metadata = self.cargo_metadata(directory, resolve=directory == crate)
            sources.roots.update((metadata.workspace.resolve(), directory))
            sources.outputs.add(metadata.target.parent.resolve() / metadata.target.name)
            pending.update(path.resolve() for path in metadata.packages)
        return sources


def invoke(crate, work, kani, *arguments, cwd=None):
    # Kani's tools, such as goto-cc, write their own temporary files to TMPDIR. Keep those in the
    # work directory, which the runner removes even when it stops a tool partway.
    tmpdir = work / "tmp"
    tmpdir.mkdir(parents=True, exist_ok=True)
    return kani.run("--manifest-path", str(crate / "Cargo.toml"),
                    "--target-dir", str(work / "target"), "-Z", "stubbing", *arguments, cwd=cwd or crate, tmpdir=tmpdir)


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise CheckError(f"missing or invalid Kani report {path.name}: {error}") from error


def compiled(crate, work, kani):
    """Return each proof harness that Kani compiles in crate's targets, one per target that compiles it.

    It compiles harness metadata without `list`, which writes into the source directory.
    """
    if not (crate / "Cargo.toml").is_file():
        raise CheckError(f"{crate}/Cargo.toml is missing")
    workspace = kani.cargo_metadata(crate).workspace
    done = invoke(crate, work, kani, "--only-codegen")
    if done.returncode:
        output = done.stdout + done.stderr
        if "error[E0658]" in output:
            try:
                toolchain = (kani.bundle / "rust-toolchain-version").read_text(encoding="utf-8").strip()
            except OSError:
                toolchain = "Rust toolchain (version metadata unavailable)"
            output += (f"\nKani {kani.version} compiles with its bundled {toolchain}, which lacks a feature "
                       "used at the locations above. Rewrite harness code that uses it. If every location is "
                       "in production code or a dependency, report the Kani target as not checked; a feature "
                       "attribute would change the production crate.")
        raise CheckError(f"Kani discovery failed:\n{output}")
    found = []
    try:
        for metadata in (work / "target").rglob("*.kani-metadata.json"):
            for harness in read_json(metadata)["proof_harnesses"]:
                name, source, attributes = harness["pretty_name"], harness["original_file"], harness["attributes"]
                if not isinstance(name, str) or not name or not isinstance(source, str) or not source or not isinstance(attributes, dict) or "kind" not in attributes:
                    raise CheckError("malformed Kani harness name, source or attributes")
                found.append(Compiled(name, (workspace / source).resolve(), attributes))
    except (KeyError, TypeError, AttributeError) as error:
        raise CheckError(f"malformed Kani discovery record: {error!r}") from error
    return found


def discover(crate, work, kani):
    """Return the checker's harnesses in crate by name: each `#[kani::proof]` with its unwind bound and source."""
    harnesses = {}
    for harness in compiled(crate, work, kani):
        if harness.attributes.get("kind") != "Proof":
            continue
        bound = harness.attributes.get("unwind_value")
        if harness.name in harnesses:
            raise CheckError("duplicate harness names; select a single crate")
        if type(bound) is not int or bound < 1:
            raise CheckError(f"{harness.name} needs #[kani::unwind(N)] with N greater than zero")
        harnesses[harness.name] = Harness(bound, harness.source, harness.attributes.get("should_panic") is True)
    if not harnesses:
        raise CheckError("no proof harnesses found")
    return harnesses


def reject_should_panic(harnesses, names):
    """Raise CheckError for the first named harness that Kani verifies with an expected panic."""
    for name in names:
        # Kani reports the expected panic as a failed check, which would read as a refuted property.
        if harnesses[name].should_panic:
            raise CheckError(f"{name} is marked #[kani::should_panic], which the Rust checker does not "
                             "support; remove the attribute and assert the condition that leads to the panic")


def harness_result(report, kani, name, returncode):
    """Return the one harness result in report after checking it agrees with itself and the process."""
    if report.get("metadata", {}).get("version") != "1.0" or report["metadata"].get("kani_version") != kani.version:
        raise CheckError("unsupported Kani result schema or version")
    if any(detail.get("harness_id") == name and detail.get("exit_status") == "timeout"
           for detail in report.get("error_details", [])):
        raise CheckError(f"the solver did not finish within the {kani.limit} harness limit; "
                         "narrow the harness or set KANI_HARNESS_TIMEOUT to a longer limit")
    verification = report["verification_results"]
    summary, results = verification["summary"], verification["results"]
    if summary["status"] != "completed" or summary["executed"] != 1 or summary["total_harnesses"] != 1:
        raise CheckError("incomplete Kani verification")
    if len(results) != 1 or results[0]["harness_id"] != name:
        raise CheckError("Kani returned an unexpected harness")
    result = results[0]
    if not isinstance(result["checks"], list) or not result["checks"]:
        raise CheckError("Kani returned no property checks")
    if result["status"] not in {"Success", "Failure"}:
        raise CheckError("unknown Kani harness status")
    failed = result["status"] == "Failure"
    if returncode != int(failed) or summary["failed"] != int(failed) or summary["successful"] != int(not failed):
        raise CheckError("Kani process and result disagree")
    return result


def classify(check):
    category, status = check["category"], check["status"]
    if status not in STATUSES:
        raise CheckError(f"unknown Kani check status {status}")
    passes, refutes = OUTCOMES.get(category, PROPERTY_OUTCOMES)
    if status in passes:
        return Verdict.PASS
    return Verdict.REFUTED if status in refutes else Verdict.INCONCLUSIVE


def describe(check):
    location = check["location"]
    reason = "bound too low: " if check["category"] == "unwind" else ""
    return (f"{reason}{check['category']} {check['status']}: {check['description']} at "
            f"{location['file']}:{location['line']}:{location['column']}")


def verify(crate, work, kani, name, bound, *, cwd=None):
    """Check one harness; a report that is malformed or disagrees with the process is inconclusive."""
    result_file = work / "result.json"
    result_file.unlink(missing_ok=True)
    try:
        done = invoke(crate, work, kani, "--harness", name, "--exact", "--unwind", str(bound),
                      "-Z", "unstable-options", "--harness-timeout", kani.timeout,
                      "--export-json", str(result_file),
                      "-Z", "concrete-playback", "--concrete-playback", "print",
                      "--output-format", "regular", cwd=cwd)
    except CheckError as error:
        return Outcome(Verdict.INCONCLUSIVE, 0, [str(error)], "")
    output = done.stdout + done.stderr
    try:
        result = harness_result(read_json(result_file), kani, name, done.returncode)
        verdicts = [(check, classify(check)) for check in result["checks"]]
        verdict = max(verdict for _, verdict in verdicts)
        if verdict is Verdict.PASS and result["status"] != "Success":
            raise CheckError("Kani reports a harness failure that no check explains")
        if verdict is Verdict.PASS and not any(
                check["status"] == "Satisfied" and check["category"] == "cover"
                for check, _ in verdicts):
            # Kani labels compiler safety checks as assertions too: an overflow check
            # before contradictory assumptions can succeed while the property is unreachable.
            raise CheckError("no satisfied kani::cover! witness; cover a boundary after the assumptions")
        failures = [describe(check) for check, verdict in verdicts if verdict is not Verdict.PASS]
    except (KeyError, TypeError, AttributeError, CheckError) as error:
        return Outcome(Verdict.INCONCLUSIVE, 0, [f"verification did not complete: {error}"], output)
    return Outcome(verdict, len(verdicts), failures, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("ready", help="check that the pinned Kani bundle runs, then report the temporary directory's free space")
    check = commands.add_parser("check", help="verify the crate's proof harnesses")
    check.add_argument("crate")
    check.add_argument("harnesses", nargs="*")
    arguments = parser.parse_args()
    kani = Kani()
    if arguments.command == "ready":
        print(f"READY Kani {kani.version}")
        storage.report()
        return 0
    crate, selected = Path(arguments.crate).resolve(), arguments.harnesses
    temp_root = storage.ensure_temp_root()
    storage.warn_runtime()
    with tempfile.TemporaryDirectory(prefix="formal-kani-", dir=temp_root) as temporary:
        work = Path(temporary)
        try:
            bounds = discover(crate, work, kani)
            names = list(dict.fromkeys(selected)) if selected else sorted(bounds)
            unknown = set(names) - set(bounds)
            if unknown:
                raise CheckError("unknown harnesses: " + ", ".join(sorted(unknown)))
            reject_should_panic(bounds, names)
        except CheckError as error:
            print(f"FAIL {error}")
            return 1
        passed = 0
        for name in names:
            outcome = verify(crate, work, kani, name, bounds[name].unwind)
            ok = outcome.verdict is Verdict.PASS
            passed += ok
            print(f"{'PASS' if ok else 'FAIL'} {name} unwind={bounds[name].unwind} checks={outcome.checks}"
                  + (": " + "; ".join(outcome.failures) if outcome.failures else ""))
            if not ok:
                print(outcome.output.rstrip())
        print(f"SUMMARY {passed} of {len(names)} harnesses passed")
        return 0 if passed == len(names) else 1


if __name__ == "__main__":
    # The readiness check runs Kani too, so the signal handling covers all of main.
    runner.run(main)
