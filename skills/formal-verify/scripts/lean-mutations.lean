-- Copyright (c) 2026 Michael Denyer
-- SPDX-License-Identifier: GPL-3.0-only
-- Elaborate one source and report declaration identities, ranges and errors.
-- Run through the target project's pinned Lake environment, without building it.
import Lean

open Lean Elab Command

private def point (p : Position) : Json := toJson (p.line, p.column)

private def declarations (instances : Array (Nat × Nat)) : CommandElabM (Array Json) := do
  let env ← getEnv
  let fileMap ← getFileMap
  let names := env.constants.fold (fun acc name _ =>
    if env.isImportedConst name then acc else acc.push name) #[]
  let mut result := #[]
  for name in names do
    let some ranges ← findDeclarationRanges? name | continue
    let pos := (fileMap.ofPosition ranges.selectionRange.pos).byteIdx
    -- Local and scoped instances may no longer be registered in the final environment.
    let instanceDecl := Meta.isInstanceCore env name || instances.any fun (start, tail) =>
      start ≤ pos && pos < tail
    result := result.push <| Json.mkObj [
      ("name", toJson ((privateToUserName? name).getD name).toString),
      ("private", toJson (privateToUserName? name).isSome),
      ("theorem", toJson ((env.find? name).get!.isTheorem &&
        !env.isProjectionFn name && !instanceDecl)),
      ("start", point ranges.range.pos), ("end", point ranges.range.endPos)]
  return result

unsafe def main (args : List String) : IO UInt32 := do
  let [path] := args | throw <| IO.userError "usage: lean-mutations.lean <source.lean>"
  enableInitializersExecution
  initSearchPath (← findSysroot)
  let inputCtx := Parser.mkInputContext (← IO.FS.readFile path) path
  let (header, parserState, messages) ← Parser.parseHeader inputCtx
  let (env, messages) ← processHeader header {} messages inputCtx
  let state ← IO.processCommands inputCtx parserState (Command.mkState env messages {})
  let mut commands := #[]
  let mut instances := #[]
  for stx in state.commands do
    if let some instanceStx := stx.find? (·.isOfKind ``Parser.Command.instance) then
      if let (some start, some tail) := (instanceStx.getPos?, instanceStx.getTailPos?) then
        instances := instances.push (start.byteIdx, tail.byteIdx)
    let some start := stx.getPos? | continue
    let some tail := stx.getTailPos? | continue
    let propertyStx := stx.find? fun cmd =>
      cmd.isOfKind ``Parser.Command.guardCmd || cmd.isOfKind ``Parser.Command.example
    let property := match propertyStx with
      | some cmd => if cmd.isOfKind ``Parser.Command.guardCmd then "#guard" else "example"
      | none => ""
    let propertyStart := (propertyStx.bind Syntax.getPos?).getD start
    let propertyEnd := (propertyStx.bind Syntax.getTailPos?).getD tail
    commands := commands.push <| Json.mkObj [
      ("property", toJson property),
      ("start", point (inputCtx.fileMap.toPosition propertyStart)),
      ("end", point (inputCtx.fileMap.toPosition propertyEnd))]
  let (decls, _) ← (Frontend.runCommandElabM (declarations instances)).run { inputCtx } |>.run state
  let mut errors := #[]
  for msg in state.commandState.messages.toList do
    if msg.severity == .error then errors := errors.push (← msg.toJson)
  IO.println <| "AFV_LEAN " ++ (Json.mkObj [
    ("declarations", toJson decls), ("commands", toJson commands),
    ("errors", toJson errors)]).compress
  return 0
