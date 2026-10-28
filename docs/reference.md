# Reference

## Skills and slash commands

| Skill | Claude Code command | Purpose |
| --- | --- | --- |
| `setup` | `/agent-formal-verify:setup` | Prepare the complete shared toolset once |
| `formal-verify` | `/agent-formal-verify:formal-verify` | Model-check protocols, prove invariants and check bounded Rust functions |

In Codex, type `$` and pick the skill, run `/skills`, or request the skill by name. The plugin ships no Codex prompts or slash commands. Parallel targets use the host's agent tools and your configured models. Hosts without delegation can process targets sequentially.

In Pi, use `/skill:setup` and `/skill:formal-verify`, or request a skill by name. The package ships no Pi extensions, prompts or themes.

In OpenCode, request `setup` or `formal-verify` by name; the agent loads it through the `skill` tool. The plugin's `opencode.mjs` registers the two skills from `skills/` and leaves any existing skill with the same name in place. It adds no tools, commands, agents or MCP servers. It needs OpenCode 2.2 or later; with an older version, use a skills-only installation.

## Shared installation

To test a local checkout in Claude Code:

```shell
claude --plugin-dir /absolute/path/to/agent-formal-verify
```

To test a local checkout in Pi:

```shell
pi -e /absolute/path/to/agent-formal-verify
```

To test a local checkout in OpenCode, add it to `plugins` in a project's `opencode.json`:

```json
{
  "plugins": ["/absolute/path/to/agent-formal-verify"]
}
```

For a skills-only installation, use `skills/`. Its references, helpers and templates stay inside that tree. Copy both the `setup` and `formal-verify` skills so their references resolve.

Installing the plugin adds skills and helpers. Run setup to prepare the verification tools. The plugin has no hooks.

## Runtime setup and tool pins

The [setup skill](../skills/setup/SKILL.md) prepares a working JDK, Python 3, a SHA256 tool, elan, Lean, Rust, Kani and the pinned TLC JAR. It reuses existing prerequisites and installs missing ones through your package manager or the upstream documented installer, within your installation constraints. It prepares all three verification tools and needs no target repository.

[Tool setup](../skills/formal-verify/references/setup.md) is the reference for everything after that first run: how verification prepares a changed Lean pin or tool version without a setup rerun, what global installations share, where caches live, the version pins, the direct helper commands, environment settings and CI.

## Plugin updates

For Claude Code, run in your terminal:

```shell
claude plugin update agent-formal-verify@agent-formal-verify
```

Run `/reload-plugins` in an existing session to load the update. You can enable marketplace auto-updates through `/plugin`. See [Claude Code plugin updates](https://code.claude.com/docs/en/discover-plugins#keep-plugins-updated).

For Codex:

```shell
codex plugin marketplace upgrade agent-formal-verify
```

Start a new session to use the refreshed plugin. See [Codex marketplace management](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli).

For Pi:

```shell
pi update --extensions
```

Pin a release by installing `npm:agent-formal-verify@0.4.2` or `git:github.com/michael-denyer/agent-formal-verify@v0.4.2`; a pinned package does not move on update.

For OpenCode, `opencode plugin check` reports a newer release on npm, or a newer commit on the default branch for a Git install. To install it, pass the specifier you installed:

```shell
opencode plugin update agent-formal-verify
opencode plugin update 'git+https://github.com/michael-denyer/agent-formal-verify.git'
```

Pin a release in OpenCode by installing `agent-formal-verify@0.4.2`.

Tool caches survive plugin updates. Run setup again only if a release introduces a new system prerequisite.

## Scope and evidence

The [verification skill](../skills/formal-verify/SKILL.md) directs the agent to select protocols and sequential invariants, transcribe their behaviour, and check their properties. It uses TLC to explore bounded protocol instances, Lean to prove properties for every size, and Kani to check actual Rust functions within stated input and unwind bounds. Kani requires satisfied cover conditions so an over-constrained harness cannot pass without reaching its boundary state.

A helper that cannot run a tool prints `UNAVAILABLE` and exits 3. Report that target as "not checked" with the remedy, never as a pass or a model failure. Failed checks exit 1 and usage errors exit 2.

Before reporting a pass, it requires mutations that demonstrate the properties detect relevant bugs. They are kept in a file beside each model, and the mutation runner rechecks them. The Lean checker audits every declaration for `sorry` and for axioms beyond Lean's three standard ones. For failures, it requires source locations, reachability checks, and a reproduction where practical. The agent changes code, commits and opens pull requests only when you ask for fixes; it then fixes the code and model together, with one PR per bug. It fixes only a counter-example that shipped settings can reach, and only with a reproduction unless none is practical. Each PR includes any reproducing test and names the property that failed. The agent uses a tool you name and reports what it leaves unchecked.

For a closed Lean proof, reports give the number of differential vectors that agree with the production function and the integer widths, or say that the comparison was not run. Each counter-example is labelled `reproduced`, `reachable at shipped settings`, or `model-only`, according to the production evidence.

Replies, pull requests and documents are written for a reader who knows the code and has used none of these tools. They lead with what goes wrong in the code, state each property as what it guarantees, and say what a TLC pass, a Lean proof and a detected mutation each mean.

A passing model establishes its stated properties under its assumptions. Reports must identify omitted code constraints and unfinished proofs. These models do not check memory ordering below the mutex; keep ThreadSanitizer or race-detector checks. They do not establish correctness of the entire program or guarantee a particular number of discovered bugs.
