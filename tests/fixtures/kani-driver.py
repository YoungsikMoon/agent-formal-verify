import json
import os
import pathlib
import sys

args = sys.argv[1:]
trace = os.environ.get("TASK_TRACE")
base = pathlib.Path(trace).parent
config = json.loads((base / "driver.json").read_text())
with open(trace, "a") as log:
    log.write(" ".join(args) + "\n")
kani_home = os.environ.get("KANI_HOME")
bundle_home = pathlib.Path(__file__).resolve().parents[2]
if config.get("expectResolvedHome") and kani_home != str(bundle_home):
    sys.exit(f"KANI_HOME is {kani_home!r}, expected the resolved {bundle_home}")
library_path = os.environ.get("DYLD_FALLBACK_LIBRARY_PATH") if sys.platform == "darwin" else os.environ.get("LD_LIBRARY_PATH")
if "expectLibraryPath" in config and library_path != config["expectLibraryPath"]:
    sys.exit(f"loader path is {library_path!r}, expected {config['expectLibraryPath']!r}")
if args == ["--version"]:
    print(f"Kani Rust Verifier {config['version']} (cargo plugin)\nCBMC 6.11.0")
    sys.exit()
target = pathlib.Path(args[args.index("--target-dir") + 1])
if "list" in args:
    if config.get("deleteDriverAfterList"):
        (pathlib.Path(kani_home) / f"kani-{config['version']}/bin/kani-driver").unlink()
    target.mkdir(parents=True, exist_ok=True)
    harnesses = config["harnesses"]
    pathlib.Path("kani-list.json").write_text(json.dumps(
        {"kani-version": config["version"], "file-version": "0.1", "standard-harnesses": {"src/lib.rs": list(harnesses)}}))
    metadata = config.get("metadata", {"proof_harnesses": [
        {"pretty_name": name, "attributes": {"unwind_value": bound}} for name, bound in harnesses.items()]})
    (target / "crate.kani-metadata.json").write_text(json.dumps(metadata))
elif config.get("compileError"):
    print("error: compilation failed")
    sys.exit(1)
else:
    report = json.loads((base / "report.json").read_text())
    pathlib.Path(args[args.index("--export-json") + 1]).write_text(json.dumps(report))
    print("Concrete playback unit test fixture")
    sys.exit(1 if report["verification_results"]["results"][0]["status"] == "Failure" else 0)
