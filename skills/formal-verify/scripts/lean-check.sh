#!/bin/bash
# Copyright (c) 2026 Michael Denyer
# SPDX-License-Identifier: GPL-3.0-only
# Builds a Lean 4 model with Lake, then audits every declaration of every built
# module. Fails when the build fails, a declaration uses sorry or rests on an
# axiom beyond propext, Classical.choice and Quot.sound, or no Lake library
# owns a .lean file in the project. Otherwise prints the build output and PASS.
# Named files limit the check to those sources, so agents that share a project
# can each check their own model; a run without them checks the whole project.
# Needs a pin of Lean 4.20.0 or later, the first whose Lake builds a module by
# its source path.
#
# Usage: lean-check.sh <lake-project-dir> [--freeze] [<file.lean> ...]
#   A file is absolute or relative to the project.
set -uo pipefail
[ "$#" -gt 0 ] || { echo "usage: lean-check.sh <lake-project-dir> [--freeze] [<file.lean> ...]"; exit 2; }
dir=$1
shift
freeze=0
if [ "${1-}" = "--freeze" ]; then freeze=1; shift; fi
for arg; do
  [[ $arg != --* ]] || { echo "usage: --freeze must precede source files"; exit 2; }
done
HERE=$(cd "$(dirname "$0")" && pwd)
[ -f "$dir/lakefile.toml" ] || [ -f "$dir/lakefile.lean" ] || { echo "FAIL $dir has no lakefile"; exit 1; }
dir=$(cd "$dir" && pwd)
# shellcheck source=skills/formal-verify/scripts/lean-tools.sh
source "$HERE/lean-tools.sh"
toolchain=$(lean_ready_pin "$dir") || { status=$?; echo "$toolchain"; exit "$status"; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
log=$work/build.log
command -v python3 > /dev/null || { echo "UNAVAILABLE python3 is required to check frozen Lean statements; install Python 3"; exit 3; }
# Lake builds a module named by its source path and rejects a path that no
# library owns, so naming every source leaves no file unchecked. Its query
# command prints the .olean of each, which names the modules to audit without
# picking up a module left in the build directory by a deleted source.
sources=()
scope=$dir
if [ "$#" -gt 0 ]; then
  scope="$dir ($* only)"
  for src; do
    [[ $src == /* ]] || src=$dir/$src
    [ -f "$src" ] || { echo "FAIL $src does not exist"; exit 1; }
    sources+=("$src")
  done
else
  if [ "$freeze" -eq 0 ]; then
    python3 "$HERE/lean-statements.py" orphans "$dir" > "$work/orphans.out"
    orphan_status=$?
    if [ "$orphan_status" -ne 0 ]; then
      echo "FAIL $scope: frozen model sources are missing or their records are invalid"
      cat "$work/orphans.out"
      exit "$orphan_status"
    fi
  fi
  while IFS= read -r src; do sources+=("$src"); done \
    < <(find "$dir" -name '*.lean' -not -path "$dir/.lake/*" -not -name lakefile.lean | sort)
  [ "${#sources[@]}" -gt 0 ] || { echo "FAIL $dir has no .lean file to check"; exit 1; }
fi
elan run "$toolchain" lake --dir "$dir" query "${sources[@]/%/:olean}" > "$work/oleans" 2> "$log"
status=$?
# Lean quotes sorry with backticks or straight quotes depending on the version.
sorry='^(warning|error): .*: declaration uses .sorry.'
sorries=$(grep -cE "$sorry" "$log")

# The audit imports those modules and collects the axioms under each of their
# declarations, so it needs no #print axioms line in the model. It skips the
# compiler's auxiliary declarations, which older pins store with opaque
# placeholders that would read as axioms.
audit_status=0
: > "$work/audit.out"
if [ "$status" -eq 0 ]; then
  {
    echo "import Lean"
    sed -e 's|^.*/\.lake/build/lib/lean/||' -e 's|\.olean$||' -e 's|/|.|g' -e 's|^|import |' "$work/oleans"
    cat << 'EOF'
open Lean in
private def hasTheoremParent (env : Environment) : Name → Bool
  | .anonymous => false
  | .str parent _ | .num parent _ =>
    (match env.find? parent with | some (.thmInfo _) => true | _ => false) || hasTheoremParent env parent

open Lean Elab Command in
#eval show CommandElabM Unit from do
  let env ← getEnv
  let freezing := (← IO.getEnv "AFV_FREEZE") == some "1"
  let modules := (env.imports.map (·.module)).erase `Lean
  let standard : Array Name := #[``propext, ``Classical.choice, ``Quot.sound]
  let names := env.constants.fold (fun acc name info => if info matches .axiomInfo _ then acc else acc.push name) #[]
  let mut audited := 0
  for name in names do
    let some idx := env.getModuleIdxFor? name | continue
    unless modules.contains env.header.moduleNames[idx.toNat]! do continue
    if ((privateToUserName? name).getD name).isInternal then continue
    audited := audited + 1
    let extra := (← collectAxioms name).filter (!standard.contains ·)
    let extra := if freezing then extra.filter (· != ``sorryAx) else extra
    unless extra.isEmpty do IO.println s!"AXIOMS '{name}' depends on axioms: {extra}"
    let userName := (privateToUserName? name).getD name
    if userName.isInternalDetail && hasTheoremParent env name && (← findDeclarationRanges? name).isNone then continue
    let info := (env.find? name).get!
    let kind := match info with
      | .thmInfo _ => "theorem"
      | .defnInfo _ => "definition"
      | .opaqueInfo _ => "opaque"
      | .inductInfo _ => "inductive"
      | .ctorInfo _ => "constructor"
      | .recInfo _ => "recursor"
      | .quotInfo _ => "quotient"
      | .axiomInfo _ => "axiom"
    let value := match info with
      | .defnInfo v => toJson (reprStr v.value)
      | _ => Json.null
    let pp ← liftTermElabM <| Meta.ppExpr info.type
    let record := Json.mkObj [
      ("module", toJson env.header.moduleNames[idx.toNat]!.toString),
      ("name", toJson userName.toString), ("kind", toJson kind),
      ("typeExpr", toJson (reprStr (info.levelParams, info.type))),
      ("valueExpr", value), ("type", toJson pp.pretty)]
    IO.println s!"STATEMENT {record.compress}"
  IO.println s!"AUDITED {audited} declarations"
EOF
  } > "$work/Audit.lean"
  AFV_FREEZE=$freeze elan run "$toolchain" lake --dir "$dir" env lean "$work/Audit.lean" > "$work/audit.out" 2>&1
  audit_status=$?
  grep -qE '^AUDITED [0-9]+ declarations$' "$work/audit.out" || audit_status=1
  if grep -q '^AUDITED 0 declarations$' "$work/audit.out"; then
    frozen=0
    for src in "${sources[@]}"; do
      [ ! -f "${src%.lean}.statements" ] || frozen=1
    done
    [ "$freeze" -eq 0 ] && [ "$frozen" -eq 1 ] || audit_status=1
  fi
fi
axioms=$(grep -c '^AXIOMS ' "$work/audit.out")

if [ "$status" -ne 0 ] || { [ "$freeze" -eq 0 ] && [ "$sorries" -ne 0 ]; } || [ "$axioms" -ne 0 ] || [ "$audit_status" -ne 0 ]; then
  echo "FAIL $scope: $sorries unfinished proofs (sorry), $axioms declarations on an added axiom, lake exit $status"
  grep -E "$sorry" "$log"
  grep '^AXIOMS ' "$work/audit.out"
  [ "$status" -eq 0 ] || grep -v '^[[:space:]]*$' "$log" | tail -40
  ! grep -q '^error: unknown module source path' "$log" \
    || echo "no library owns that file; import it from a built module or move it out of the project"
  ! grep -qE "^error: (unknown command 'query'|invalid script spec)" "$log" \
    || echo "$toolchain cannot build a module by its source path; pin Lean 4.20.0 or later"
  if [ "$audit_status" -ne 0 ]; then
    echo "the axiom audit did not run or found no declarations:"
    grep -v '^[[:space:]]*$' "$work/audit.out" | tail -40
    ! grep -q 'environment already contains' "$work/audit.out" \
      || echo "two modules declare the same name; put each model in a namespace of its own"
  fi
  exit 1
fi
mode=check
[ "$freeze" -eq 0 ] || mode=freeze
python3 "$HERE/lean-statements.py" "$mode" "$toolchain" "$work/audit.out" "$work/oleans" "${sources[@]}" > "$work/statements.out"
statement_status=$?
if [ "$statement_status" -ne 0 ]; then
  echo "FAIL $scope: frozen statements differ or could not be checked"
  cat "$work/statements.out"
  exit "$statement_status"
fi
cat "$work/statements.out"
# #eval output arrives as info blocks that can span lines.
grep -v '^[[:space:]]*$' "$log"
[ "$freeze" -eq 0 ] || exit 0
echo "PASS $scope: $(grep '^AUDITED ' "$work/audit.out" | cut -d' ' -f2) declarations checked, no unfinished proof (sorry), no added axiom"
