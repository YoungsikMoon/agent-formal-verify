#!/usr/bin/env python3
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Run the pinned Kani and validate its versioned discovery and result records."""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path

STATUSES = {"Success", "Failure", "Unreachable", "Undetermined", "Satisfied", "Unsatisfiable"}
# Statuses that pass and statuses that refute the property, by check category; any other is inconclusive.
OUTCOMES = {
    "cover": ({"Satisfied"}, {"Unsatisfiable", "Unreachable"}),
    "unwind": ({"Success", "Unreachable"}, set()),
}
PROPERTY_OUTCOMES = ({"Success", "Unreachable"}, {"Failure"})


class CheckError(Exception):
    pass


class Unavailable(Exception):
    pass


class Verdict(IntEnum):
    """A check's or harness's result, ordered so the worst check decides the harness."""
    PASS = 0
    REFUTED = 1
    INCONCLUSIVE = 2


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


class Kani:
    version = "0.68.0"

    def __init__(self):
        home = Path(os.environ.get("KANI_HOME", Path.home() / ".kani")).resolve()
        bundle = home / f"kani-{self.version}"
        remedy = (f"run cargo install --locked kani-verifier --version {self.version} "
                  "then cargo kani setup")
        for binary in ("bin/kani-driver", "bin/kani-compiler", "bin/cbmc", "toolchain/bin/rustc", "toolchain/bin/cargo"):
            path = bundle / binary
            if not path.is_file() or not os.access(path, os.X_OK):
                raise Unavailable(f"Kani {self.version} bundle is incomplete; {remedy}")
        if any(home.glob("*.tar.gz")):
            raise Unavailable(f"incomplete Kani setup at {home}; finish cargo kani setup before checking")
        self.driver = bundle / "bin/kani-driver"
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
            raise Unavailable(f"Kani {self.version} cannot run: {error}; {remedy}") from error
        if done.returncode or not done.stdout.startswith(f"Kani Rust Verifier {self.version} (cargo plugin)\n"):
            raise Unavailable(f"Kani {self.version} is required; {remedy}")

    def run(self, *arguments, cwd=None):
        try:
            # The driver selects Cargo mode from argv[0]; the Cargo wrapper can auto-install.
            return subprocess.run(
                ["cargo-kani", *arguments], executable=str(self.driver), env=self.env,
                cwd=cwd, capture_output=True, text=True, check=False)
        except OSError as error:
            raise CheckError(f"cannot execute Kani: {error}") from error


def invoke(crate, work, kani, *arguments):
    return kani.run("--manifest-path", str(crate / "Cargo.toml"),
                    "--target-dir", str(work / "target"), *arguments, cwd=work)


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise CheckError(f"missing or invalid Kani report {path.name}: {error}") from error


def discover(crate, work, kani):
    """Return the unwind bound of every proof harness in crate, by fully qualified name."""
    if not (crate / "Cargo.toml").is_file():
        raise CheckError(f"{crate}/Cargo.toml is missing")
    done = invoke(crate, work, kani, "list", "--format", "json")
    if done.returncode:
        raise CheckError(f"Kani discovery failed:\n{done.stdout}{done.stderr}")
    try:
        report = read_json(work / "kani-list.json")
        if report.get("kani-version") != kani.version or report.get("file-version") != "0.1":
            raise CheckError("unsupported Kani discovery schema or version")
        groups = report.get("standard-harnesses")
        if not isinstance(groups, dict) or not all(
                isinstance(names, list) and all(isinstance(name, str) and name for name in names)
                for names in groups.values()):
            raise CheckError("malformed Kani harness list")
        names = [name for group in groups.values() for name in group]
        if not names:
            raise CheckError("no proof harnesses found")
        if len(set(names)) != len(names):
            raise CheckError("duplicate harness names; select a single crate")
        bounds = {}
        for metadata in (work / "target").rglob("*.kani-metadata.json"):
            for harness in read_json(metadata).get("proof_harnesses", []):
                name = harness.get("pretty_name")
                if name in names:
                    bound = harness.get("attributes", {}).get("unwind_value")
                    if type(bound) is not int or bound < 1:
                        raise CheckError(f"{name} needs #[kani::unwind(N)] with N greater than zero")
                    bounds[name] = bound
    except (TypeError, AttributeError) as error:
        raise CheckError(f"malformed Kani discovery record: {error!r}") from error
    if set(bounds) != set(names):
        raise CheckError("Kani did not report unwind metadata for every harness")
    return bounds


def harness_result(report, kani, name, returncode):
    """Return the one harness result in report after checking it agrees with itself and the process."""
    if report.get("metadata", {}).get("version") != "1.0" or report["metadata"].get("kani_version") != kani.version:
        raise CheckError("unsupported Kani result schema or version")
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


def verify(crate, work, kani, name, bound):
    """Check one harness; a report that is malformed or disagrees with the process is inconclusive."""
    result_file = work / "result.json"
    result_file.unlink(missing_ok=True)
    try:
        done = invoke(crate, work, kani, "--harness", name, "--exact", "--unwind", str(bound),
                      "-Z", "unstable-options", "--export-json", str(result_file),
                      "-Z", "concrete-playback", "--concrete-playback", "print",
                      "--output-format", "regular")
    except CheckError as error:
        return Outcome(Verdict.INCONCLUSIVE, 0, [str(error)], "")
    output = done.stdout + done.stderr
    try:
        result = harness_result(read_json(result_file), kani, name, done.returncode)
        verdicts = [(check, classify(check)) for check in result["checks"]]
        verdict = max(verdict for _, verdict in verdicts)
        if verdict is Verdict.PASS and result["status"] != "Success":
            raise CheckError("Kani reports a harness failure that no check explains")
        failures = [describe(check) for check, verdict in verdicts if verdict is not Verdict.PASS]
    except (KeyError, TypeError, AttributeError, CheckError) as error:
        return Outcome(Verdict.INCONCLUSIVE, 0, [f"verification did not complete: {error}"], output)
    return Outcome(verdict, len(verdicts), failures, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("ready", help="check that the pinned Kani bundle runs")
    check = commands.add_parser("check", help="verify the crate's proof harnesses")
    check.add_argument("crate")
    check.add_argument("harnesses", nargs="*")
    arguments = parser.parse_args()
    try:
        kani = Kani()
    except Unavailable as error:
        print(f"UNAVAILABLE {error}")
        return 3
    if arguments.command == "ready":
        print(f"READY Kani {kani.version}")
        return 0
    crate, selected = Path(arguments.crate).resolve(), arguments.harnesses
    with tempfile.TemporaryDirectory(prefix="formal-kani-") as temporary:
        work = Path(temporary)
        try:
            bounds = discover(crate, work, kani)
            names = list(dict.fromkeys(selected)) if selected else sorted(bounds)
            unknown = set(names) - set(bounds)
            if unknown:
                raise CheckError("unknown harnesses: " + ", ".join(sorted(unknown)))
        except CheckError as error:
            print(f"FAIL {error}")
            return 1
        passed = 0
        for name in names:
            outcome = verify(crate, work, kani, name, bounds[name])
            ok = outcome.verdict is Verdict.PASS
            passed += ok
            print(f"{'PASS' if ok else 'FAIL'} {name} unwind={bounds[name]} checks={outcome.checks}"
                  + (": " + "; ".join(outcome.failures) if outcome.failures else ""))
            if not ok:
                print(outcome.output.rstrip())
        print(f"SUMMARY {passed} of {len(names)} harnesses passed")
        return 0 if passed == len(names) else 1


if __name__ == "__main__":
    sys.exit(main())
