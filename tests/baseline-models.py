# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Check that the baseline rejects specification narrowing that makes real verifier failures pass."""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "skills/formal-verify/scripts"
EXAMPLES = ROOT / "skills/formal-verify/examples"


def run(status, script, *arguments):
    interpreter = "python3" if script.endswith(".py") else "bash"
    # TLC extracts standard modules under java.io.tmpdir and deletes them on exit.
    with tempfile.TemporaryDirectory(prefix="formal-java-") as java_work:
        options = f'{os.environ.get("JAVA_TOOL_OPTIONS", "")} -Djava.io.tmpdir="{java_work}"'
        done = subprocess.run([interpreter, str(SCRIPTS / script), *map(str, arguments)],
                              env=os.environ | {"JAVA_TOOL_OPTIONS": options}, capture_output=True, text=True, check=False)
    print(done.stdout + done.stderr, end="", flush=True)
    if done.returncode != status:
        raise RuntimeError(f"{script} exited {done.returncode}, expected {status}")
    return done.stdout


def matrix_order(work):
    project = work / "tla"
    shutil.copytree(EXAMPLES / "tla-template", project)
    matrix, spec, record = project / "BoundedQueue.matrix", project / "BoundedQueue.tla", work / "tla.json"
    checks = "check INVARIANTS TypeOK InWindow\ncheck PROPERTIES AllConsumed\n"
    runs = "run one | Window=1 Items=3 Workers={w1} FailAt={}\n"
    matrix.write_text("spec BoundedQueue.tla\n" + checks + runs)
    run(0, "tlc-matrix.sh", matrix)
    run(0, "baseline.py", "record", record, matrix)
    spec.write_text(spec.read_text().replace("next < consumed + Window", "next <= consumed + Window"))
    run(1, "tlc-matrix.sh", matrix)
    matrix.write_text("spec BoundedQueue.tla\n" + runs + checks)
    changed = run(1, "baseline.py", "compare", record)
    assert "removed check BoundedQueue.tla INVARIANTS InWindow | [run BoundedQueue.tla one]" in changed
    run(0, "tlc-matrix.sh", matrix)


def imported_property(work):
    project = work / "imports"
    project.mkdir()
    rules, matrix = project / "Rules.tla", project / "Advance.matrix"
    rules.write_text("---- MODULE Rules ----\nAllowed(x) == x = 0\n====\n")
    (project / "Advance.tla").write_text(r"""---- MODULE Advance ----
EXTENDS Rules
VARIABLE x
Init == x = 0
Next == x' = 1
Spec == Init /\ [][Next]_x
Within == Allowed(x)
====
""")
    matrix.write_text("spec Advance.tla\ncheck INVARIANT Within\nrun default |\n")
    record = work / "imports.json"
    run(0, "baseline.py", "record", record, matrix)
    assert "Invariant Within is violated" in run(1, "tlc-matrix.sh", matrix)
    rules.write_text(rules.read_text().replace("x = 0", "TRUE"))
    run(0, "tlc-matrix.sh", matrix)
    assert "changed definition Rules.tla Allowed" in run(1, "baseline.py", "compare", record)


def fairness_subscript(work):
    plain = r"Spec == Init /\ [][Next]_vars /\ WF_vars(Next)"
    quantified = "Step(p) == Next\n" + r"Spec == Init /\ [][Next]_<<x, aux>> /\ \A p \in {1} : WF_vars(Step(p))"
    for name, fairness in (("subscript", plain), ("quantified", quantified)):
        project = work / name
        project.mkdir()
        spec, matrix, record = project / "One.tla", project / "One.matrix", work / f"{name}.json"
        spec.write_text(r"""---- MODULE One ----
EXTENDS Naturals
VARIABLES x, aux
vars == <<x, aux>>
Init == x = 0 /\ aux = 0
Inc == x < 3 /\ x' = x + 1 /\ UNCHANGED aux
Spin == aux' = 1 - aux /\ UNCHANGED x
Next == Inc \/ Spin
""" + fairness + """
Done == <>(x = 3)
====
""")
        matrix.write_text("spec One.tla\ncheck PROPERTIES Done\nrun base |\n")
        assert "Temporal properties were violated" in run(1, "tlc-matrix.sh", matrix)
        run(0, "baseline.py", "record", record, matrix)
        spec.write_text(spec.read_text().replace("vars == <<x, aux>>", "vars == <<x>>"))
        run(0, "tlc-matrix.sh", matrix)
        assert "changed definition One.tla vars" in run(1, "baseline.py", "compare", record)


def tla_layout(work):
    project = work / "layout"
    project.mkdir()
    spec, matrix = project / "Layout.tla", project / "Layout.matrix"
    matrix.write_text("spec Layout.tla\ncheck INVARIANT Safe\nrun one |\n")
    prefix = "---- MODULE Layout ----\nVARIABLE x\nInit == x = 0\nNext == UNCHANGED x\nSpec == Init /\\ [][Next]_x\n"
    grouped = r"""Safe ==
    \/ /\ x = 1
       /\ \/ x = 1
          \/ x = 1
          \/ x = 0
"""
    helper = "Unused == FALSE\n  Allowed(n) == n = 1\nSafe == Allowed(x)\n"
    cases = [
        (grouped, grouped.replace("          \\/ x = 0", "    \\/ x = 0")),
        (helper, helper.replace("n = 1", "n = 0")),
    ]
    for before, after in cases:
        spec.write_text(prefix + before + "====\n")
        run(0, "baseline.py", "record", work / "layout.json", matrix)
        assert "Invariant Safe is violated" in run(1, "tlc-matrix.sh", matrix)
        spec.write_text(prefix + after + "====\n")
        run(0, "tlc-matrix.sh", matrix)
        run(1, "baseline.py", "compare", work / "layout.json")


def kani_ownership(work):
    project = work / "kani"
    (project / "src").mkdir(parents=True)
    shutil.copyfile(EXAMPLES / "kani-template/Cargo.toml", project / "Cargo.toml")
    source, record = project / "src/lib.rs", work / "kani.json"
    before = """pub fn target(n: u8) -> u8 { n }
#[cfg(kani)]
mod proofs {
    #[kani::proof]
    #[kani::unwind(2)]
    fn bounded_support() {
        let n: u8 = kani::any();
        kani::assume(n < 10);
        assert!(u16::from(n) < 256);
        kani::cover!(n == 9);
    }
    #[kani::proof]
    #[kani::unwind(2)]
    fn target_preserves_input() {
        let n: u8 = kani::any();
        assert!(super::target(n) == n);
        kani::cover!(n == 9);
    }
}
"""
    source.write_text(before)
    run(0, "kani-check.sh", project)
    run(0, "baseline.py", "record", record, source)
    broken = before.replace("{ n }", "{ if n < 10 { n } else { 0 } }")
    source.write_text(broken)
    run(1, "kani-check.sh", project)
    moved = broken.replace("        kani::assume(n < 10);\n", "")
    moved = moved.replace("        assert!(super::target(n) == n);", "        kani::assume(n < 10);\n        assert!(super::target(n) == n);")
    source.write_text(moved)
    changed = run(1, "baseline.py", "compare", record)
    assert "added assume n < 10 in proofs::target_preserves_input" in changed
    assert "removed assume n < 10 in proofs::bounded_support" in changed
    run(0, "kani-check.sh", project)


BUILDERS = """#[macro_export]
macro_rules! declare { ($m:ident) => { mod $m; }; }
#[macro_export]
macro_rules! declare_at { ($m:ident, $p:literal) => { #[path = $p] mod $m; }; }
"""
CALL_PATH = "macro_rules! call { ($mac:path, $m:ident) => { $mac!($m); }; }\n"
# Each crate compiles src/<harness> a second time through a macro from the builders crate, as #266, #271 and #273 to
# #275 show, beside a #[path] route that the record reads. Kani names the harness on the second route.
HIDDEN_ROUTES = [
    ("a::proofs::check", "a/proofs.rs", {
        "lib.rs": '#[path = "a/proofs.rs"] mod readable;\nmod other;\nmod a;\npub use builders::declare;\n',
        "a.rs": "use crate::declare;\ndeclare!(proofs);\n",
        "other.rs": "#[allow(unused_macros)]\nmacro_rules! declare { ($m:ident) => { struct $m; } }\n"}),
    ("proofs::check", "proofs.rs", {
        "lib.rs": '#[path = "proofs.rs"] mod readable;\n'
                  "macro_rules! w { () => { macro_rules! v { () => { builders::declare!(proofs); } } v!(); }; }\nw!();\n"}),
    ("x::check", "proofs.rs", {
        "lib.rs": '#[path = "proofs.rs"] mod readable;\n'
                  'macro_rules! w { () => { macro_rules! v { () => { builders::declare_at!(x, "proofs.rs"); } } v!(); }; }\nw!();\n'}),
    ("a::proofs::check", "a/proofs.rs", {
        "lib.rs": '#[path = "a/proofs.rs"] mod readable;\nmod other;\nmacro_rules! w { ($m:ident) => { declare!($m); } }\nmod a;\n',
        "other.rs": "#[allow(unused_macros)]\nmacro_rules! declare { ($m:ident) => { struct $m; } }\n",
        "a.rs": "use builders::declare;\nw!(proofs);\n"}),
    ("proofs::check", "proofs.rs", {
        "lib.rs": '#[path = "proofs.rs"] mod readable;\n' + CALL_PATH
                  + "macro_rules! via { ($($t:tt)*) => { call!($($t)*); }; }\nvia!(builders::declare, proofs);\n"}),
    ("proofs::check", "proofs.rs", {
        "lib.rs": '#[path = "proofs.rs"] mod readable;\n' + CALL_PATH
                  + "macro_rules! via { ($m:ident) => { call!(builders::declare, $m); }; }\nvia!(proofs);\n"}),
    ("proofs::check", "proofs.rs", {
        "lib.rs": '#[path = "proofs.rs"] mod readable;\n' + CALL_PATH
                  + "macro_rules! outer { () => { call!(builders::declare, proofs); }; }\nouter!();\n"}),
    ("proofs::check", "proofs.rs", {
        "lib.rs": '#[path = "proofs.rs"] mod readable;\n'
                  "macro_rules! call { ($($mac:ident)::+, $m:ident) => { $($mac)::+!($m); }; }\ncall!(builders::declare, proofs);\n"}),
    ("proofs::check", "proofs.rs", {
        "lib.rs": '#[path = "proofs.rs"] mod readable;\nuse builders::declare;\n'
                  "macro_rules! call { ($mac:ident $bang:tt $m:ident) => { $mac $bang ($m); }; }\ncall!(declare ! proofs);\n"}),
    ("proofs::check", "proofs.rs", {
        "lib.rs": '#[path = "proofs.rs"] mod readable;\n'
                  "macro_rules! call { ($mac:ident, $m:ident) => { builders::$mac!($m); }; }\ncall!(declare, proofs);\n"}),
    # A route under a function body or a const _ block, which the record does not read, keeps its own name.
    ("f::m::again::check", "proofs.rs", {
        "lib.rs": '#[path = "proofs.rs"] mod readable;\nfn f() {\n    mod m {\n        #[path = "../proofs.rs"]\n        mod again;\n    }\n}\n',
        # rustc resolves src/m/../proofs.rs only when src/m exists.
        "m/.keep": ""}),
    ("f::m::again::check", "proofs.rs", {
        "lib.rs": '#[path = "proofs.rs"] mod readable;\nfn f() {\n    mod m { include!("sub/items.rs"); }\n}\n',
        "sub/items.rs": '#[path = "../proofs.rs"]\nmod again;\n'}),
    ("_::readable::check", "proofs.rs", {
        "lib.rs": '#[path = "proofs.rs"] mod readable;\nconst _: () = {\n    #[path = "proofs.rs"]\n    mod readable;\n};\n'}),
    ("_::x::check", "proofs.rs", {
        "lib.rs": 'include!("proofs.rs");\nconst _: () = {\n    #[path = "proofs.rs"]\n    mod x;\n};\n'}),
]
# Each crate invokes a macro that rustc resolves to a local one that declares no module, through a glob import, a
# module path, and a definition that shadows one passing the name to the builders crate. Each records.
READABLE_ROUTES = [
    ("a/proofs.rs", {
        "lib.rs": "mod a;\nmacro_rules! declare { ($m:ident) => { fn $m() {} } }\npub(crate) use declare;\n",
        "a.rs": "mod proofs;\nuse super::*;\ndeclare!(proofs);\n"}),
    ("proofs.rs", {
        "lib.rs": "mod proofs;\nmod a;\na::declare!(proofs);\n",
        "a.rs": "macro_rules! declare { ($m:ident) => { fn $m() {} } }\npub(crate) use declare;\n"}),
    ("proofs.rs", {
        "lib.rs": "mod proofs;\n#[allow(unused_macros)]\nmacro_rules! declare { ($m:ident) => { builders::declare!($m); } }\n"
                  "macro_rules! declare { ($m:ident) => { fn $m() {} } }\ndeclare!(proofs);\n"}),
]
HARNESS = "#[kani::proof]\n#[kani::unwind(1)]\nfn check() {\n    assert!(1 + 1 == 2);\n}\n"


def write_crate(directory, files, dependencies=""):
    manifest = (EXAMPLES / "kani-template/Cargo.toml").read_text().replace('name = "bounded-queue"', f'name = "{directory.name}"')
    (directory / "src").mkdir(parents=True)
    (directory / "Cargo.toml").write_text(manifest.replace("[lints.rust]", f"{dependencies}[lints.rust]"))
    for name, text in files.items():
        (directory / "src" / name).parent.mkdir(parents=True, exist_ok=True)
        (directory / "src" / name).write_text(text)


def kani_generator_width(work):
    project, record = work / "width", work / "width.json"
    wide = """#[cfg(kani)]
#[kani::proof]
#[kani::unwind(2)]
fn sample_range() {
    let n = u32::from(kani::any_where::<u16, _>(|n| *n != 0));
    kani::cover!(n == 1);
    assert!(n < 512);
}
"""
    write_crate(project, {"lib.rs": wide})
    source = project / "src/lib.rs"
    assert "assertion failed: n < 512" in run(1, "kani-check.sh", project)
    run(0, "baseline.py", "record", record, source)
    source.write_text(wide.replace("u16", "u8"))
    run(0, "kani-check.sh", project)
    changed = run(1, "baseline.py", "compare", record)
    assert "removed assume kani::any_where::<u16, _>" in changed
    assert "added assume kani::any_where::<u8, _>" in changed


def kani_routes(work):
    """Kani's own harness list decides whether a harness compiles through a route the record does not read."""
    write_crate(work / "builders", {"lib.rs": BUILDERS})
    for number, (name, harness, files) in enumerate(HIDDEN_ROUTES):
        crate = work / f"routes-{number}"
        write_crate(crate, {**files, harness: HARNESS}, '[dependencies]\nbuilders = { path = "../builders" }\n\n')
        refused = run(1, "baseline.py", "record", work / f"routes-{number}.json", crate / "src" / harness)
        assert f"Kani compiles {name} from this file, but no route that the record reads gives that name" in refused, refused
    for number, (harness, files) in enumerate(READABLE_ROUTES):
        crate = work / f"readable-{number}"
        write_crate(crate, {**files, harness: HARNESS}, '[dependencies]\nbuilders = { path = "../builders" }\n\n')
        run(0, "baseline.py", "record", work / f"readable-{number}.json", crate / "src" / harness)
    switched = work / "switched"
    write_crate(switched, {"lib.rs": '#[cfg(feature = "proofs")]\nmod proofs;\n', "proofs.rs": HARNESS})
    manifest = switched / "Cargo.toml"
    manifest.write_text(manifest.read_text() + '\n[features]\ndefault = ["proofs"]\nproofs = []\n')
    record = work / "switched.json"
    run(0, "baseline.py", "record", record, switched / "src/proofs.rs")
    run(0, "baseline.py", "compare", record)
    manifest.write_text(manifest.read_text().replace('default = ["proofs"]', "default = []"))
    assert "  not compiled harness check\n" in run(1, "baseline.py", "compare", record)


with tempfile.TemporaryDirectory(prefix="formal-baseline-") as directory:
    tla_layout(Path(directory))
    matrix_order(Path(directory))
    imported_property(Path(directory))
    fairness_subscript(Path(directory))
    kani_ownership(Path(directory))
    kani_generator_width(Path(directory))
    kani_routes(Path(directory))
print("ok: the baseline rejects narrowed checks and assumptions even when the real verifiers pass")
