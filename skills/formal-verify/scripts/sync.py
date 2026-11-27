#!/usr/bin/env python3
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
"""List the commits an existing model has not been synced with, and the paths its covered code has had since.

  SYNC <commit> <reason>     the commit the model was last synced at, or SYNC none
  PATH <path>                a path the covered code has had since that commit
  MISSING <name>: <commits>  a covered name that git grep finds in no file that could define it,
                             with the commits since the sync that added or removed it
  READ <command>             the git log command that shows every commit to read

The sync commit is the header's `Source read at <commit>` when that commit is in HEAD's
history, and otherwise the last commit that changed the model files; the SYNC line then says
why the header's commit was not used. When a model file is also a --source, such as a Rust file
with its Kani harness, that fallback counts only a commit that changed the code of its
#[cfg(kani)] items and none of its other code, whatever it did to the other model files,
following each source back through its renames along the renaming commit's parents, so not into a branch merged after the
rename. A merge never counts, but a rename made in one is followed into each of its parents, under the old path
that git finds against that parent, or else against the first parent with one; parents with different old paths get
a walk each, read together newest commit first, and a commit two walks reach under the same paths counts once.
SYNC none follows when none of the last 100 commits of the model files it reads qualifies, and adds that it did not
follow a rename into a branch merged after it when such a branch changed the old path, each parent read under another
parent's old path that it does not hold, and each source that a merge holds under no path git finds renamed to it,
which the walk stops following there. Each source path is followed through every rename since
the sync commit in both directions. Each name adds the files where git grep finds it as a whole
word now, outside the model files that are not also a --source, such as a Kani harness kept
apart from the production code, and outside documents, such as README, and TLA+ and Lean files,
which cannot define it, unless a source path has the same extension. A name in none of the remaining files,
or only in files with no extension and data files such as .json, .yml or .html, which seldom define it,
or only in the comments and strings of Rust files, is MISSING. Each name also adds, under the same rules, the files where a commit since the sync
added or removed it as a whole word, which git log -S finds, renames included. A path that held
the code only under another name, such as code renamed as it moved, is not found, nor is one
whose commits all kept the number of times the name appears. Exits 1 outside a git
repository, for a source path that no commit has, or when git grep fails.

Usage: sync.py <model file>... [--source <path>]... [--name <name>]...
"""
import argparse
import functools
import heapq
import itertools
import re
import shlex
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
import rust_source

HEADER = re.compile(r"Source read at ([0-9a-fA-F]{7,40})\b")
# Documents and model files mention covered names but cannot define them, unless a source has the same extension.
NO_DEFINITIONS = {".md", ".markdown", ".rst", ".txt", ".adoc", ".org", ".tex", ".csv", ".tla", ".cfg", ".lean", ".statements",
                  ".matrix", ".mutations"}
# Nor can a document with no extension.
DOCUMENT_NAMES = {"README", "CHANGELOG", "CHANGES", "HISTORY", "NEWS", "TODO", "AUTHORS", "CONTRIBUTORS", "COPYING",
                  "LICENSE", "NOTICE", "CODEOWNERS"}
# Other files with no extension and data formats can hold code, such as a Makefile or a CI workflow, but seldom the
# definition of a covered name, so they are read but do not keep a name from being MISSING.
SELDOM_DEFINE = {"", ".html", ".htm", ".ipynb", ".json", ".yaml", ".yml", ".toml", ".xml", ".svg"}
# #[cfg(kani)] on an item, past any other attributes and its visibility; on a field or a variant it is production code.
KANI_CFG = re.compile(
    r"#\s*\[\s*cfg\s*\(\s*kani\s*\)\s*\](?=(?:\s*#\s*\[[^\]]*\])*\s*(?:pub\s*(?:\([^)]*\))?\s*)?"
    r"(?:mod|fn|impl|use|const|static|struct|enum|union|trait|type|unsafe|extern|async|macro_rules)\b)"
)
# The fallback reads at most this many commits of the model files, since each costs a parse of the file twice.
FALLBACK_COMMITS = 100


@functools.cache
def rust_code(path):
    """Return a Rust file's text with its comments and strings blanked, or None when it cannot be read."""
    try:
        return rust_source.rust_masks(path.read_text(encoding="utf-8", errors="replace")).without_comments_or_strings
    except OSError:
        return None


def in_code(root, file, name):
    """Whether name occurs as a whole word outside the comments and strings of a Rust file; True for another file.

    The reader is Rust's lexer, with nested block comments and raw strings, which would hide code in a language
    whose comments and strings differ, such as an unclosed `/*` inside a C comment, so only Rust files are read.
    """
    code = rust_code(root / file) if Path(file).suffix.lower() == ".rs" else None
    return code is None or re.search(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", code) is not None


def role(file, paths, suffixes):
    """Return "defines" for a file that may define a covered name it holds, "uses" for one that may only use it, or None."""
    path = Path(file)
    suffix = path.suffix.lower()
    if file in paths or suffix in suffixes:
        return "defines"
    if suffix in NO_DEFINITIONS or not suffix and path.name.upper() in DOCUMENT_NAMES:
        return None
    return "uses" if suffix in SELDOM_DEFINE else "defines"


def git(root, *arguments, check=True):
    done = subprocess.run(["git", "-C", str(root), *arguments], capture_output=True, text=True, check=False)
    if check and done.returncode:
        raise RuntimeError(f"git {' '.join(arguments)} failed: {done.stderr.strip()}")
    return done


@functools.cache
def split_harness(text):
    """Return the code of the #[cfg(kani)] items in Rust text and the code outside them, without comments or blank lines."""
    source = rust_source.rust_masks(text)
    mask, spans = source.without_comments_or_strings, []
    for found in KANI_CFG.finditer(mask):
        if spans and found.start() < spans[-1][1]:
            continue
        at = found.end()
        while at < len(mask) and mask[at] not in "{;":
            at = rust_source.after_closing(mask, at) if mask[at] in "([" else at + 1
        end = rust_source.after_closing(mask, at) if at < len(mask) and mask[at] == "{" else at + 1
        spans.append((found.start(), end))
    starts = [0] + [end for _, end in spans]
    ends = [start for start, _ in spans] + [len(mask)]

    def code(parts):
        return [line.rstrip() for part in parts for line in part.splitlines() if line.strip()]

    return code(source.uncommented[a:b] for a, b in spans), code(source.uncommented[a:b] for a, b in zip(starts, ends))


def renamed_from(root, *trees):
    """Map each path that a commit, or the diff between two trees, renamed to its path before."""
    fields = git(root, "diff-tree", "-M", "-r", "--no-commit-id", "--name-status", "--diff-filter=R", "-z", *trees).stdout.split("\0")
    return {fields[at + 2]: fields[at + 1] for at in range(len(fields) - 2) if re.fullmatch(r"R[0-9]*", fields[at])}


def changed_only_harness(root, commit, models, sources):
    """Whether commit changed the #[cfg(kani)] items of a model file that is also a source, and no code outside them.

    Also returns, for each parent of commit, each source that commit renamed mapped to its path in that parent,
    so the caller can follow them. A merge never counts, since it joins code that the harness was not written
    against, but a source that it holds and none of its parents does maps, in each parent, to the path that git
    finds renamed to it against that parent, or to None.
    """
    parents = git(root, "rev-parse", f"{commit}^@").stdout.split()
    if len(parents) > 1:
        absent = {path for path in sources if not git(root, "cat-file", "-e", f"{commit}:{path}", check=False).returncode
                  and all(git(root, "cat-file", "-e", f"{parent}:{path}", check=False).returncode for parent in parents)}
        if not absent:
            return False, {}
        renames = {}
        for parent in parents:
            found = renamed_from(root, parent, commit)
            renames[parent] = {new: found.get(new) for new in absent}
        return False, renames
    touched = set(git(root, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit, "--", *models).stdout.split("\0")) - {""}
    befores = {path: git(root, "show", f"{commit}^:{path}", check=False) for path in touched & set(sources)}
    renames = {}
    if any(before.returncode for before in befores.values()):
        olds = {new: old for new, old in renamed_from(root, commit).items() if new in befores}
        befores.update({path: git(root, "show", f"{commit}^:{old}", check=False) for path, old in olds.items()})
        renames = {parents[0]: olds} if olds else {}
    # A commit that changed only another model file never synced the harness in a source, so only a harness edit counts.
    changed = False
    for path, before in befores.items():
        after = git(root, "show", f"{commit}:{path}", check=False)
        if before.returncode or after.returncode:
            return False, renames
        try:
            (old_harness, old_code), (new_harness, new_code) = split_harness(before.stdout), split_harness(after.stdout)
        except ValueError:
            return False, renames
        if old_code != new_code:
            return False, renames
        changed = changed or old_harness != new_harness
    return changed, renames


def missed_branch(root, rename, olds, read):
    """Whether HEAD has a commit of olds not in read, outside rename's history and not after it, so on a branch merged since."""
    commits = git(root, "rev-list", "--full-history", "--no-merges", "HEAD", f"^{rename}", "--", *olds).stdout.split()
    return any(commit not in read and git(root, "merge-base", "--is-ancestor", rename, commit, check=False).returncode == 1
               for commit in commits)


class Walk:
    """A git log of the model files from some starting commits, read one commit at a time and fetched in pages."""

    def __init__(self, root, starts, paths, sources):
        # The pathspec stays as given, so each page of the log continues the one before it.
        self.root, self.starts, self.pathspec, self.paths, self.sources = root, starts, paths, paths, sources
        self.pending, self.skip, self.more = [], 0, True

    def next(self, size):
        """Return the committer time and hash of the next commit, fetching up to size commits, or None at the end."""
        if not self.pending and self.more:
            fields = git(self.root, "log", f"--skip={self.skip}", f"-{size + 1}", "--format=%ct %H", *self.starts, "--", *self.pathspec).stdout.split()
            self.pending = list(zip(map(int, fields[::2]), fields[1::2]))[:size]
            self.more = len(fields) > 2 * size
            self.skip += len(self.pending)
        return self.pending[0] if self.pending else None


def sync_commit(root, models, shared):
    """Return the sync commit and where it came from, or (None, reason); shared are the models also given as --source."""
    unused = []
    for model in models:
        text = model.read_text(encoding="utf-8", errors="replace")
        found = HEADER.search(text)
        if found and git(root, "merge-base", "--is-ancestor", found[1], "HEAD", check=False).returncode == 0:
            return git(root, "rev-parse", found[1]).stdout.strip(), f"from the Source read at line in {model.name}"
        if found:
            unused.append(f"the Source read at commit {found[1]} in {model.name} is not in HEAD's history")
        elif "Source read at" in text:
            unused.append(f"the Source read at line in {model.name} names no commit hash")
    relative = [str(model.relative_to(root)) for model in models]
    if shared:
        names = ", ".join(model.name for model in shared)
        sources = [str(model.relative_to(root)) for model in shared]
        # git log does not follow a rename, so a walk starts again at the renaming commit's parents under the old path.
        # Parents that hold a source under different old paths get a walk each. The walks are read together, newest
        # commit first, as one git log reads every parent of a rename whose old path they share, so the first commit
        # that qualifies is the latest, and a commit that two walks reach under the same paths is read once. A branch
        # merged after the rename is not followed back past it, a parent that git finds no rename against is read under
        # another parent's old path, and a source that a merge holds under no path git finds renamed to it is no longer
        # followed, and SYNC none says so.
        queue, order, done, left, unread = [], itertools.count(), {}, FALLBACK_COMMITS, False
        followed, unseen, stopped = {}, {}, {}

        def add(walk):
            nonlocal unread
            if not left:
                unread = unread or bool(walk.pending) or walk.more
            elif head := walk.next(left):
                heapq.heappush(queue, (-head[0], next(order), walk))

        add(Walk(root, ["HEAD"], relative, sources))
        while queue and left:
            walk = heapq.heappop(queue)[2]
            commit = walk.pending.pop(0)[1]
            key = (commit, tuple(walk.paths), tuple(walk.sources))
            if key not in done:
                left -= 1
                found, renames = changed_only_harness(root, commit, walk.paths, walk.sources)
                if found:
                    return commit, "; ".join([f"from the last commit of the model files that changed no production code in {names}", *unused])
                news = {new for olds in renames.values() for new in olds}
                lost = [new for new in news if not any(olds[new] for olds in renames.values())]
                stopped.update(dict.fromkeys((commit, path) for path in lost))
                paths, sources = ([path for path in group if path not in lost] for group in (walk.paths, walk.sources))
                firsts = {new: next(olds[new] for olds in renames.values() if olds[new]) for new in news - set(lost)}
                if firsts:
                    groups = {}
                    for parent, olds in renames.items():
                        mapping = {new: olds[new] or firsts[new] for new in firsts}
                        unseen.update(dict.fromkeys((commit, parent, mapping[new], new) for new in firsts if not olds[new]
                                                    and git(root, "cat-file", "-e", f"{parent}:{mapping[new]}", check=False).returncode))
                        groups.setdefault(tuple(sorted(mapping.items())), []).append(parent)
                    for group_key, parents in groups.items():
                        mapping = dict(group_key)
                        add(Walk(root, parents, *([mapping.get(path, path) for path in group] for group in (paths, sources))))
                    followed[(commit, tuple(sorted({old for olds in renames.values() for old in olds.values() if old})))] = None
                done[key] = paths, sources, bool(firsts) or not sources
            walk.paths, walk.sources, ends = done[key]
            if not ends:
                add(walk)
        read = f"the last {FALLBACK_COMMITS} commits of the model files" if unread or queue else "the model files"
        reasons = [f"no commit of {read} changed only the #[cfg(kani)] items of {names}"]
        reasons += [f"it did not follow the rename of {', '.join(olds)} in {rename} into a branch merged after it"
                    for rename, olds in followed if missed_branch(root, rename, olds, {commit for commit, _, _ in done})]
        reasons += [f"it read the parent {parent} of the merge {merge} under {old}, which that parent does not hold, since git finds no rename to {new} against it"
                    for merge, parent, old, new in unseen]
        reasons += [f"it stopped following {path} at the merge {merge}, since none of its parents has {path} and git finds no rename to it"
                    for merge, path in stopped]
        return None, "; ".join([*reasons, *unused])
    last = git(root, "log", "-1", "--format=%H", "--", *relative).stdout.strip()
    if last:
        return last, "; ".join(["from the last commit of the model files", *unused])
    return None, "; ".join(["the model files have no commit and no Source read at line in HEAD's history", *unused])


def renamed(root, sync, paths):
    """Add every path that the renames since sync connect to one of paths."""
    # -m diffs a merge against each parent, so a rename made in a merge connects its paths too.
    fields = git(root, "log", "-m", "-M", "--diff-filter=R", "--name-status", "--format=", "-z", f"{sync}..HEAD").stdout.split("\0")
    fields = [field.lstrip("\n") for field in fields]
    pairs = [(fields[at + 1], fields[at + 2]) for at in range(len(fields) - 2) if re.fullmatch(r"R[0-9]*", fields[at])]
    paths = set(paths)
    grown = True
    while grown:
        grown = False
        for old, new in pairs:
            if (old in paths) != (new in paths):
                paths |= {old, new}
                grown = True
    return paths


def held(root, sync, name, pathspec):
    """Return the files where a commit since sync added or removed name as a whole word."""
    # One log lists each such commit, its parents and the files where the raw count of name changed, and a few greps
    # read those files at each commit and its first parent. Without --no-renames, a rename that keeps the name's
    # count pairs the old path with the new one and -S skips both. A path holds no NUL, so the two NULs before each
    # header mark it, and -z puts one newline before the header's first path.
    log = git(root, "log", "--no-renames", "--no-textconv", "-S", name, "--format=%x00%x00%H %P", "--name-only", "-z",
              f"{sync}..HEAD", "--", *pathspec).stdout
    changed = {}
    for entry in re.split("\0\0+", log)[1:]:
        header, _, names = entry.partition("\0")
        commit, *parents = header.split()
        # A root commit, such as one of a history merged in, changed nothing since the sync.
        for revision in (commit, parents[0]) if parents else ():
            changed.setdefault(revision, set()).update(file for file in names.removeprefix("\n").split("\0") if file)
    files = set()
    for revisions, paths in batches(changed):
        found = git(root, "grep", "-l", "-z", "-w", "-F", "-e", name, *revisions, "--", *(f":(literal){path}" for path in paths), check=False)
        if found.returncode > 1:
            raise RuntimeError(f"git grep for {name} failed: {found.stderr.strip()}")
        hits = (hit.partition(":") for hit in found.stdout.split("\0") if hit)
        files.update(file for revision, _, file in hits if file in changed[revision])
    return files


def batches(changed, limit=100_000):
    """Yield revisions and paths to grep together, each group within limit bytes of arguments.

    A revision's paths are split across groups when they do not fit in one, as at a commit that is the parent of
    several listed commits.
    """
    revisions, paths, size = set(), set(), 0
    for revision, files in changed.items():
        for path in sorted(files):
            grown = (revision not in revisions) * (len(revision) + 1) + (path not in paths) * (len(path.encode()) + 12)
            if paths and size + grown > limit:
                yield sorted(revisions), sorted(paths)
                revisions, paths, size = set(), set(), 0
                grown = len(revision) + 1 + len(path.encode()) + 12
            revisions.add(revision)
            paths.add(path)
            size += grown
    if paths:
        yield sorted(revisions), sorted(paths)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("models", nargs="+", type=Path)
    parser.add_argument("--source", action="append", default=[], help="a source file the model's header names")
    parser.add_argument("--name", action="append", default=[], help="a function or shared variable the model covers")
    arguments = parser.parse_args()
    models = [model.resolve() for model in arguments.models]
    for model in models:
        if not model.is_file():
            print(f"FAIL {model} does not exist")
            return 1
    found = git(models[0].parent, "rev-parse", "--show-toplevel", check=False)
    if found.returncode:
        print(f"FAIL {models[0]} is in no git repository")
        return 1
    root = Path(found.stdout.strip())
    relative = [str(model.relative_to(root)) for model in models]
    given = {(Path.cwd() / source).resolve() for source in arguments.source}
    sync, reason = sync_commit(root, models, [model for model in models if model in given])
    if sync is None:
        print(f"SYNC none: {reason}; compare the model with the code in full")
        return 0
    print(f"SYNC {sync} {reason}")
    sources = []
    for source in arguments.source:
        path = (Path.cwd() / source).resolve()
        if root not in path.parents or not git(root, "log", "-1", "--format=%H", "--", str(path.relative_to(root))).stdout:
            print(f"FAIL --source {source} is {path}, which no commit in {root} has")
            return 1
        sources.append(str(path.relative_to(root)))
    source_paths = renamed(root, sync, sources)
    paths = set(source_paths)
    excluded = [f":(exclude){path}" for path in relative if path not in sources]
    suffixes = {Path(path).suffix.lower() for path in source_paths}
    missing = []
    for name in arguments.name:
        found = git(root, "grep", "-l", "-z", "-w", "-F", "-e", name, "--", ".", *excluded, check=False)
        if found.returncode > 1:
            raise RuntimeError(f"git grep for {name} failed: {found.stderr.strip()}")
        roles = {file: role(file, source_paths, suffixes) for file in found.stdout.split("\0") if file}
        if not any(kind == "defines" and in_code(root, file, name) for file, kind in roles.items()):
            missing.append(name)
        files = [*roles, *held(root, sync, name, [".", *excluded])]
        paths.update(file for file in files if role(file, source_paths, suffixes))
    for path in sorted(paths):
        print(f"PATH {path}")
    for name in missing:
        removed = git(root, "log", "-S", name, "--format=%h", f"{sync}..HEAD", "--", *sorted(paths)).stdout.split()
        print(f"MISSING {name}: " + (" ".join(removed) if removed else "no commit since the sync removed it"))
    if paths:
        print("READ " + shlex.join(["git", "-C", str(root), "log", "-p", f"{sync}..HEAD", "--", *sorted(paths)]))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, ValueError) as error:
        print(f"FAIL {error}")
        sys.exit(1)
