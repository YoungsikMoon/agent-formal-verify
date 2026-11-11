-- Copyright (c) 2026 Michael Denyer
-- SPDX-License-Identifier: GPL-3.0-only
-- Elaborate one source and report declaration identities, ranges and errors.
-- Run through the target project's pinned Lake environment, without building it.
import Lean

open Lean Elab Command

private def point (p : Position) : Json := toJson (p.line, p.column)

private def declarations : CommandElabM (Array Json) := do
  let env ← getEnv
  let names := env.constants.fold (fun acc name _ =>
    if env.isImportedConst name then acc else acc.push name) #[]
  let mut result := #[]
  for name in names do
    let some ranges ← findDeclarationRanges? name | continue
    result := result.push <| Json.mkObj [
      ("name", toJson ((privateToUserName? name).getD name).toString),
      ("private", toJson (privateToUserName? name).isSome),
      ("theorem", toJson ((env.find? name).get!.isTheorem)),
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
  let (decls, _) ← (Frontend.runCommandElabM declarations).run { inputCtx } |>.run state
  let mut commands := #[]
  for stx in state.commands do
    let some start := stx.getPos? | continue
    let some tail := stx.getTailPos? | continue
    let property := if stx.isOfKind ``Parser.Command.guardCmd then "#guard"
      else if (stx.find? (·.isOfKind ``Parser.Command.example)).isSome then "example"
      else ""
    commands := commands.push <| Json.mkObj [
      ("property", toJson property),
      ("start", point (inputCtx.fileMap.toPosition start)),
      ("end", point (inputCtx.fileMap.toPosition tail))]
  let mut errors := #[]
  for msg in state.commandState.messages.toList do
    if msg.severity == .error then errors := errors.push (← msg.toJson)
  IO.println <| "AFV_LEAN " ++ (Json.mkObj [
    ("declarations", toJson decls), ("commands", toJson commands),
    ("errors", toJson errors)]).compress
  return 0
