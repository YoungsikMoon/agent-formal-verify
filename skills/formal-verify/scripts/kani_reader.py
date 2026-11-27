# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""Read a Kani harness file's surface, the routes that lead to it from its crate roots, and what Kani compiles from it."""
import functools
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import NamedTuple

sys.dont_write_bytecode = True
import kani
import runner
import storage
from rust_source import RustSource, after_closing, rust_masks
from surface import Surface, collapse

KANI_KEY = re.compile(r"(harness |(?:assume|cover|stub) .* in )(\S+)( #\d+)?", re.DOTALL)


class RustFunction(NamedTuple):
    name: str
    start: int
    keyword: int
    body: int
    end: int


RUST_ITEM = re.compile(r"\b(fn|mod)\s+((?:r#)?\w+)\b")
INCLUDE = re.compile(r"\binclude\s*!$")


def rust_functions(mask):
    """Locate free functions, inline modules, out-of-line `mod name;` declarations and `include!(...)` items outside
    function bodies; leave macro and other item bodies opaque.

    A declaration's or an include's body is its `;`.
    """
    functions, modules, opaque, declarations, includes, counts = [], [], [], [], [], {}

    def add_include(boundary, header, stop, in_body):
        if not in_body and (include := INCLUDE.search(header)):
            semicolon = re.compile(r"\s*;").match(mask, stop)
            includes.append(RustFunction("include", boundary, boundary + include.start(), semicolon.end() - 1 if semicolon else stop - 1, stop))

    def walk(start, end, namespace=(), in_function=False, in_body=False):
        i, boundary, item = start, start, None
        while i < end:
            if match := RUST_ITEM.match(mask, i):
                item = (match[1], match[2], match.start())
                i = match.end()
            elif mask[i] in "([":
                stop = after_closing(mask, i)
                header = mask[boundary:i].rstrip()
                if header.endswith("!"):
                    opaque.append((i, stop))
                    add_include(boundary, header, stop, in_body)
                i = stop
            elif mask[i] == "{":
                stop = after_closing(mask, i)
                header = mask[boundary:i].rstrip()
                macro = header.endswith("!") or bool(re.search(r"\bmacro_rules\s*!\s*\w+\s*$", header))
                if item and not macro:
                    kind, name, keyword = item
                    qualified = (*namespace, name)
                    if kind == "fn":
                        owner = "::".join(qualified)
                        counts[owner] = counts.get(owner, 0) + 1
                        suffix = f"[{counts[owner]}]" if counts[owner] > 1 else ""
                        functions.append(RustFunction(owner + suffix, boundary, keyword, i, stop))
                    else:
                        modules.append(RustFunction("::".join(qualified), boundary, keyword, i, stop))
                    walk(i + 1, stop - 1, qualified, kind == "fn", in_body or kind == "fn")
                elif in_function and not macro and not re.search(r"\b(?:impl|trait|struct|enum|union|extern|macro)\b", header):
                    walk(i + 1, stop - 1, namespace, True, True)
                else:
                    opaque.append((i, stop))
                    add_include(boundary, header, stop, in_body)
                i = boundary = stop
                item = None
            else:
                if mask[i] == ";":
                    if item and item[0] == "mod" and not in_body:
                        declarations.append(RustFunction("::".join((*namespace, item[1])), boundary, item[2], i, i + 1))
                    boundary, item = i + 1, None
                i += 1

    walk(0, len(mask))
    return functions, modules, opaque, declarations, includes


KANI_ATTRIBUTE = r"#\s*\[\s*(?:cfg_attr\s*\(\s*kani\s*,\s*)?kani\s*::\s*"
MACROS = (
    ("assume", re.compile(r"\bkani\s*::\s*assume\s*\(")),
    ("assume", re.compile(r"\bkani\s*::\s*any_where\s*(?:::\s*<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*)?\(")),
    ("cover", re.compile(r"\bkani\s*::\s*cover\s*!\s*\(")),
    ("stub", re.compile(KANI_ATTRIBUTE + r"stub\s*\(")),
)
PROOF = re.compile(KANI_ATTRIBUTE + r"proof(?:_for_contract\s*\([^)]*\))?\s*\)?\s*\]")
HARNESS_ATTRIBUTE = re.compile(r"kani::(?:should_panic(?:\(\)|\[\]|\{\})?|unwind(?:\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}))")
KANI_TOKEN = re.compile(r"\bkani\s*::\s*(?:assume|any_where|cover|stub|proof|should_panic|unwind)\w*\b")
ATTRIBUTE = re.compile(r"#\s*(!\s*)?\[")
INNER_ATTRIBUTE = re.compile(r"[\s\ufeff]*#\s*!\s*\[")
RENAMING_IMPORT = re.compile(r"\buse\s+[^;]*?(?<![\w:])(?:::\s*)?kani\b[^;]*?(?:\bas\b|\*|\b(?:assume|any_where|cover|stub|proof|should_panic|unwind)\w*\b)|\bextern\s+crate\s+kani\s+as\b")


def applies_cfg(attribute):
    """Return whether a compact `cfg_attr(predicate, attribute, ...)` applies a cfg or a module path in its own
    attribute list."""
    arguments, depth, start = [], 0, len("cfg_attr(")
    for i in range(start, len(attribute) - 1):
        depth += (attribute[i] in "([{") - (attribute[i] in ")]}")
        if attribute[i] == "," and not depth:
            arguments.append(attribute[start:i])
            start = i + 1
    arguments.append(attribute[start:-1])
    return any(argument.startswith(("cfg(", "path=")) or argument.startswith("cfg_attr(") and applies_cfg(argument) for argument in arguments[1:])


def outer_attributes(source, start, keyword):
    """Yield the contents of each top-level outer attribute between start and keyword; skip inner attributes."""
    mask = source.without_comments_or_strings
    while attribute := ATTRIBUTE.search(mask, start, keyword):
        opener = attribute.end() - 1
        start = after_closing(mask, opener)
        if not attribute[1]:
            yield rust_masks(source.uncommented[opener + 1:start - 1])


CFG_ATTR_KANI = re.compile(r"\s*cfg_attr\s*\(\s*kani\s*,")


def applied_attributes(mask):
    """Yield the span of each attribute that an outer attribute in mask applies when Kani compiles it: the whole
    attribute, or each argument after the condition of a `#[cfg_attr(kani, ...)]`."""
    for attribute in ATTRIBUTE.finditer(mask):
        if attribute[1]:
            continue
        opener = attribute.end() - 1
        close = after_closing(mask, opener) - 1
        if (condition := CFG_ATTR_KANI.match(mask, opener + 1, close)) is None:
            yield opener + 1, close
            continue
        start, depth = condition.end(), 0
        for i in range(start, close):
            depth += (mask[i] in "([{") - (mask[i] in ")]}")
            if depth < 0 or mask[i] == "," and not depth:
                yield start, i
                if depth < 0:
                    break
                start = i + 1


def cfg_guards(source, items):
    """Return the cfg attributes other than cfg(kani), and the cfg_attr ones whose attribute list applies a cfg or a
    module path, on each (start, keyword, body) item, between its start and its fn or mod keyword, and at the start
    of its body.

    A body of -1 stands for the file, which has only inner attributes, and a body at a `;` for an out-of-line `mod`
    declaration, which has none. An attribute nested inside another attribute's tokens is not read.
    """
    text, mask = source.uncommented, source.without_comments_or_strings
    guards = []

    def read(attribute):
        compact = re.sub(r"\s+", "", attribute.without_comments_or_strings)
        if compact.startswith("cfg(") and compact != "cfg(kani)" or compact.startswith("cfg_attr(") and applies_cfg(compact):
            guards.append(collapse(attribute.uncommented, attribute.literals))

    for start, keyword, body in items:
        if body >= 0:
            for attribute in outer_attributes(source, start, keyword):
                read(attribute)
        if body >= 0 and mask[body] == ";":
            continue
        inner = body + 1
        while attribute := INNER_ATTRIBUTE.match(mask, inner):
            opener = attribute.end() - 1
            inner = after_closing(mask, opener)
            read(rust_masks(text[opener + 1:inner - 1]))
    return " ".join(guards)


PATH_ATTRIBUTE = re.compile(r"\bpath\s*=\s*")


def module_paths(source, item, file):
    """Return the paths that `#[path = "..."]` sets on a module item, and those that a cfg_attr may set."""
    paths, conditional = [], []
    for attribute in outer_attributes(source, item.start, item.keyword):
        compact = re.sub(r"\s+", "", attribute.without_comments_or_strings)
        if not compact.startswith(("path=", "cfg_attr(")):
            continue
        for setting in PATH_ATTRIBUTE.finditer(attribute.without_comments_or_strings):
            value = string_value(next((attribute.uncommented[begin:end] for begin, end in attribute.literals if begin == setting.end()), ""))
            if value is None:
                line = source.without_comments_or_strings.count("\n", 0, item.start) + 1
                raise ValueError(f"{file}:{line}: cannot read the path in '{collapse(attribute.uncommented, attribute.literals)}'; write it as a string without escapes")
            (paths if compact.startswith("path=") else conditional).append(value)
    return paths, conditional


def string_value(literal):
    """Return the value of a Rust string literal without escapes, or None."""
    plain = re.fullmatch(r'r(#*)"(.*)"\1', literal, re.DOTALL) or re.fullmatch(r'"([^"\\]*)"', literal)
    return plain[plain.lastindex] if plain else None


class RustFile(NamedTuple):
    source: RustSource
    modules: list
    declarations: list
    includes: list


def parse_rust(path):
    source = rust_masks(path.read_text(encoding="utf-8"))
    _, modules, _, declarations, includes = rust_functions(source.without_comments_or_strings)
    return RustFile(source, modules, declarations, includes)


def enclosing_modules(parsed, item):
    return sorted((module for module in parsed.modules if module.start <= item.start < module.end), key=lambda module: module.start)


def module_files(file, owner, parsed, declaration):
    """Yield each file that an out-of-line `mod` declaration in file may load, by rustc's rules, and whether that
    file owns its directory, as a crate root, a mod.rs or a `#[path]` file does."""
    states = [(file.parent, file.parent if owner else file.parent / file.stem)]
    for module in enclosing_modules(parsed, declaration):
        paths, conditional = module_paths(parsed.source, module, file)
        name = module.name.rsplit("::", 1)[-1].removeprefix("r#")
        states = [(child, child) for directory, prefix in states for child in ([] if paths else [prefix / name]) + [directory / path for path in paths + conditional]]
    paths, conditional = module_paths(parsed.source, declaration, file)
    name = declaration.name.rsplit("::", 1)[-1].removeprefix("r#")
    for directory, prefix in states:
        if not paths:
            yield prefix / f"{name}.rs", False
            yield prefix / name / "mod.rs", True
        for path in paths + conditional:
            yield directory / path, True


def crate_roots(path):
    """Return the crate roots whose module trees may hold path, and those of them that Cargo names, or None for a
    file in no crate.

    They are the lib.rs and main.rs in the nearest directory above path that holds either and, in the Cargo package
    of the nearest directory above path with a Cargo.toml, Cargo's target files and each `.rs` path that Cargo.toml
    names.
    """
    marker = next((folder for folder in path.parents if (folder / "lib.rs").is_file() or (folder / "main.rs").is_file()), None)
    package = next((folder for folder in path.parents if (folder / "Cargo.toml").is_file()), None)
    if marker is None and package is None:
        return None
    markers = [marker / "lib.rs", marker / "main.rs"] if marker else []
    named = []
    if package:
        named += [package / "src/lib.rs", package / "src/main.rs"]
        for folder in ("src/bin", "tests", "examples", "benches"):
            named += sorted((package / folder).glob("*.rs")) + sorted((package / folder).glob("*/main.rs"))
        manifest = (package / "Cargo.toml").read_text(encoding="utf-8")
        named += [package / file for file in re.findall(r"""\bpath\s*=\s*["']([^"']+\.rs)["']""", manifest)]
    return tuple(dict.fromkeys(root.resolve() for root in markers + named if root.is_file())), {root.resolve() for root in named}


CONCAT = re.compile(r"(?:\w+\s*::\s*)*concat\s*!\s*[(\[{]")
MANIFEST_DIR = re.compile(r'(?:\w+\s*::\s*)*env\s*!\s*[(\[{]\s*"CARGO_MANIFEST_DIR"\s*,?\s*[)\]}]')


def include_path(argument, file, package):
    """Return the file that the argument of an `include!` in file names, or None when the argument is neither a
    string without escapes nor a `concat!` of such strings and `env!("CARGO_MANIFEST_DIR")`, which is package,
    the directory of the Cargo.toml of the crate being compiled.

    Raises:
        ValueError: The argument uses `env!("CARGO_MANIFEST_DIR")` and package is None.
    """
    argument = argument.strip()
    if (value := string_value(argument)) is not None:
        return file.parent / value
    mask = rust_masks(argument).without_comments_or_strings
    if not (concat := CONCAT.match(mask)) or after_closing(mask, concat.end() - 1) != len(mask):
        return None
    parts, start, depth = [], concat.end(), 0
    for i in range(start, len(mask) - 1):
        depth += (mask[i] in "([{") - (mask[i] in ")]}")
        if mask[i] == "," and not depth:
            parts.append(argument[start:i].strip())
            start = i + 1
    parts.append(argument[start:-1].strip())
    pieces = []
    for part in filter(None, parts):
        if (value := string_value(part)) is not None:
            pieces.append(value)
        elif MANIFEST_DIR.fullmatch(part):
            if package is None:
                raise ValueError('no Cargo.toml above the crate root sets env!("CARGO_MANIFEST_DIR"), so the record cannot tell which file it reads')
            pieces.append(str(package))
        else:
            return None
    return file.parent / "".join(pieces)


class Route(NamedTuple):
    """A route to a Kani harness file: its crate root, the guards on its steps, outermost first, and the module path
    that it gives the file's items, "" at a crate root."""
    root: Path
    guards: str
    module: str


class RouteReader:
    """Read the routes that lead to Kani harness files from their crate roots.

    It parses each file and walks each crate's module tree once, so make one per run: it does not see a file that
    changes after it has read it.
    """

    def __init__(self):
        self.parsed, self.trees = {}, {}

    def parse(self, path):
        if path not in self.parsed:
            self.parsed[path] = parse_rust(path)
        return self.parsed[path]

    def module_tree(self, roots):
        """Return the module declarations that lead to each file the crate roots reach, as {file: {(declarer,
        declaration)}}, and the message for each reached file or declaration that could not be read.

        An `include!("...")` item outside function bodies leads to the file it names, relative to the including file,
        which declares modules as a file that owns its directory does, whatever inline modules hold the include.
        """
        if roots not in self.trees:
            edges, broken, seen = {}, [], set()
            work = [(root, True, next((folder for folder in root.parents if (folder / "Cargo.toml").is_file()), None)) for root in roots]
            while work:
                file, owner, package = work.pop()
                if (file, owner, package) in seen:
                    continue
                seen.add((file, owner, package))
                try:
                    parsed = self.parse(file)
                except ValueError as error:
                    broken.append(f"{file}: {error}")
                    continue
                for declaration in parsed.declarations:
                    try:
                        targets = list(module_files(file, owner, parsed, declaration))
                    except ValueError as error:
                        broken.append(str(error))
                        continue
                    for target, owns in targets:
                        if target.is_file():
                            target = target.resolve()
                            edges.setdefault(target, set()).add((file, declaration))
                            work.append((target, owns, package))
                for include in parsed.includes:
                    invocation = rust_masks(parsed.source.uncommented[include.keyword:include.end])
                    line = parsed.source.without_comments_or_strings.count("\n", 0, include.keyword) + 1
                    shown = collapse(invocation.uncommented, invocation.literals)
                    try:
                        target = include_path(invocation.uncommented[invocation.without_comments_or_strings.index("!") + 1:].strip()[1:-1], file, package)
                    except ValueError as error:
                        broken.append(f"{file}:{line}: cannot read the path in '{shown}': {error}")
                        continue
                    if target is None:
                        broken.append(f"{file}:{line}: cannot read the path in '{shown}'; write it as a string without escapes, or as concat! of such strings and env!(\"CARGO_MANIFEST_DIR\")")
                    elif target.is_file():
                        target = target.resolve()
                        edges.setdefault(target, set()).add((file, include))
                        work.append((target, True, package))
            self.trees[roots] = edges, broken
        return self.trees[roots]

    def routes(self, path):
        """Return the routes that lead to path from its crate roots, sorted. A crate root is one route without guards,
        since its own crate always compiles it, unless it is a lib.rs or main.rs that Cargo does not name and another
        file declares, which makes it a module. A file in no crate is one such route too, as Kani compiles it alone.

        It follows each out-of-line `mod` declaration from the crate roots by rustc's rules, including
        `#[path = "..."]` and each path that a cfg_attr may set, and each `include!("...")` item outside function
        bodies. It does not expand macros, so a declaration that a macro holds or builds is not a route it reads;
        `compiled_problems` checks those against the harnesses that Kani compiles.

        Raises:
            ValueError: No route that it reads reaches path. The message names each reached file, declaration and
                `include!` that it could not read.
        """
        if (crates := crate_roots(path)) is None:
            return [Route(path, "", "")]
        roots, named = crates
        edges, broken = self.module_tree(roots)
        if path in roots and path not in edges:
            return [Route(path, "", "")]
        if path not in edges:
            unread = "".join(f"; {message}" for message in broken)
            raise ValueError(f"{path}: no module declaration that the record can read leads to this file from a crate root; declare it with `mod <name>;` or `#[path = \"...\"]` outside macros and function bodies, in a file that a crate root reaches{unread}")

        def walk(file, visiting):
            root = file in named or file in roots and all(declarer == file for declarer, _ in edges.get(file, ()))
            found = [Route(file, "", "")] if root else []
            for declarer, declaration in edges.get(file, ()):
                if declarer in visiting:
                    continue
                parsed = self.parse(declarer)
                enclosing = enclosing_modules(parsed, declaration)
                items = [(0, 0, -1)] + [(module.start, module.keyword, module.body) for module in enclosing] + [(declaration.start, declaration.keyword, declaration.body)]
                guards = cfg_guards(parsed.source, items)
                # An included file's items sit in the modules around the include!; a declared file's in its module.
                local = (enclosing[-1].name if enclosing else "") if declaration in parsed.includes else declaration.name
                found += [Route(route.root, " ".join(filter(None, (route.guards, guards))), "::".join(filter(None, (route.module, local))))
                          for route in walk(declarer, visiting | {declarer})]
            return found

        return sorted(walk(path, {path}))


def route_label(path, routes):
    """Return the guards that routes give path's items, as the record holds them: one route's own guards, or for more
    than one route `routes(...)` with each route as its crate root's path relative to path's directory, a colon and
    its guards, or `unguarded` for a route without any, sorted and separated by `; `."""
    found = sorted((os.path.relpath(route.root, path.parent), route.guards) for route in routes)
    if len(found) == 1:
        return found[0][1]
    labelled = "; ".join(f"{root}: {guards or 'unguarded'}" for root, guards in found)
    return f"routes({labelled})"


def kani_surface(path, reader):
    source = rust_masks(path.read_text(encoding="utf-8"))
    text, mask = source.uncommented, source.without_comments_or_strings
    if renaming := RENAMING_IMPORT.search(mask):
        raise ValueError(f"{path}: '{collapse(renaming[0])}' brings a Kani assumption, cover, stub, harness or harness attribute in under another name; write each as kani::<name> so the record can read it")
    functions, modules, opaque, _, _ = rust_functions(mask)
    declared = route_label(path, reader.routes(path))

    def owner_at(position, *, attribute=False):
        if not any(start <= position < end for start, end in opaque):
            for function in reversed(functions):
                if function.start <= position < function.end and (position < function.body if attribute else position > function.body):
                    return function
        line = mask.count("\n", 0, position) + 1
        raise ValueError(f"{path}:{line}: cannot identify a function owner; write Kani forms in free functions under inline modules, outside macro definitions and impl or trait bodies")

    surface = Surface()
    spans, read = [], []
    for kind, pattern in MACROS:
        for match in pattern.finditer(mask):
            end = after_closing(mask, match.end() - 1)
            read.append((match.start(), end))
            argument = rust_masks(text[match.end():end - 1])
            owner = owner_at(match.start(), attribute=kind == "stub").name
            spans.append((match.start(), f"{kind} {collapse(argument.uncommented, argument.literals)} in {owner}", ""))
    # Kani refuses these attributes on a function that is not a harness, so only a harness's are recorded.
    attributes = {}
    for start, end in applied_attributes(mask):
        if HARNESS_ATTRIBUTE.fullmatch(item := re.sub(r"\s+", "", mask[start:end])):
            read.append((start, end))
            attributes.setdefault(owner_at(start, attribute=True), []).append(item)
    for match in PROOF.finditer(mask):
        read.append(match.span())
        harness = owner_at(match.start(), attribute=True)
        enclosing = sorted((item for item in functions + modules if item.start <= harness.start and harness.end <= item.end), key=lambda item: item.start)
        guards = cfg_guards(source, [(0, 0, -1)] + [(item.start, item.keyword, item.body) for item in enclosing])
        value = " ".join(filter(None, (declared, guards, *sorted(attributes.get(harness, ())))))
        spans.append((match.start(), f"harness {harness.name}", value))
    for token in KANI_TOKEN.finditer(mask):
        if not any(start <= token.start() < end for start, end in read):
            line = mask.count("\n", 0, token.start()) + 1
            raise ValueError(f"{path}:{line}: '{collapse(token[0])}' is in a form the record cannot read; write kani::assume(...), kani::any_where(...), kani::cover!(...), #[kani::stub(...)], #[kani::proof], #[kani::should_panic] or #[kani::unwind(...)], alone or under #[cfg_attr(kani, ...)]")
    for _, item, guards in sorted(spans):
        surface.add(item, guards)
    return surface


@functools.cache
def checker():
    return kani.Kani()


@functools.cache
def compiled_in(package):
    """Return each harness that Kani compiles in the Cargo package at package.

    Raises:
        ValueError: Kani is not installed, or cannot compile the package.
    """
    try:
        with tempfile.TemporaryDirectory(prefix="baseline-kani-", dir=storage.ensure_temp_root()) as work:
            return tuple(kani.compiled(package, Path(work), checker()))
    except (kani.CheckError, runner.Unavailable) as error:
        raise ValueError(f"cannot ask Kani which harnesses it compiles in {package}: {error}") from error


# A closure or a `const _` block puts an anonymous segment in Kani's name for a harness inside it.
ANONYMOUS = re.compile(r"\{\w+#\d+\}|_")


def item_path(name):
    return "::".join(part.removeprefix("r#") for part in name.split("::") if not ANONYMOUS.fullmatch(part))


def route_owner(name, modules, owners):
    """Return the owner in owners, keyed by item_path, that Kani's harness name gives under one of modules, or None.

    The name must start with the module path itself. Anonymous segments are dropped only after it, since no route
    that the record reads runs through a closure or a `const _` block.
    """
    parts = [part.removeprefix("r#") for part in name.split("::")]
    for module in modules:
        prefix = [part.removeprefix("r#") for part in module.split("::")] if module else []
        if parts[:len(prefix)] == prefix and (owner := owners.get(item_path("::".join(parts[len(prefix):])))):
            return owner
    return None


def compiled_problems(path, surface, reader, recorded=None):
    """Return the lines on which the harnesses that Kani compiles from path disagree with surface and recorded, and
    surface's harnesses that it compiles, as `harness <owner>` items, or None for them when no Cargo package holds
    path.

    Each harness that Kani compiles from path must be one of surface's harnesses under the module path of a route
    that the record reads. A harness in recorded that Kani compiles on no route is a harness that was switched off.

    Raises:
        ValueError: Kani is not installed, or cannot compile the package.
    """
    package = next((folder for folder in path.parents if (folder / "Cargo.toml").is_file()), None)
    if package is None:
        return [f"  not compiled {item}" for item in recorded or ()], None
    names = {harness.name for harness in compiled_in(package) if harness.source == path}
    modules = {route.module for route in reader.routes(path)}
    owners = {re.sub(r"\[\d+\]$", "", KANI_KEY.fullmatch(item)[2]) for item in surface if item.startswith("harness ")}
    found = {name: route_owner(name, modules, {item_path(owner): owner for owner in owners}) for name in names}
    lines = [f"  FAIL Kani compiles {name} from this file, but no route that the record reads gives that name; declare "
             "the module with `mod <name>;` or `#[path = \"...\"]` outside macros and function bodies"
             for name, owner in sorted(found.items()) if owner is None]
    compiled = sorted({f"harness {owner}" for owner in found.values() if owner is not None})
    lines += [f"  not compiled {item}" for item in sorted(set(recorded or ()) - set(compiled))]
    return lines, compiled
