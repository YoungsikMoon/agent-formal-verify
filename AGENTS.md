# AGENTS.md

Instructions for coding agents working in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) explains the same workflow for people; this file lists the steps an agent runs without being asked.

## Commands

- `prek run --all-files` runs every lint and the metadata tests. CI runs the same checks.
- `node --test 'tests/*.test.mjs'` runs the helper and metadata tests alone.
- `bash tests/models.sh` runs the bundled examples and their mutations through TLC, Lean and Kani. CI runs it as the `models` job.

## Release

A release is a version bump and a tag, and a bump without the tag publishes nothing. When a change raises the version in `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json` and `CHANGES.md`, then after it merges to `main`:

1. Tag the merge commit and push the tag:

   ```shell
   git fetch origin
   git tag -a v<version> origin/main -m "agent-formal-verify <version>"
   git push origin v<version>
   ```

2. Confirm that the `Publish` workflow run for the tag succeeded. It publishes to npm with provenance and skips a version that is already on npm. The registry can list the new version a few minutes after the run ends.

The Claude directory scans `main` after the push. A held version appears on the plugin's **Versions** tab in the portal; [Claude directory validation](CONTRIBUTING.md#claude-directory-validation) says how to read a hold and how to test a fix without a release.

## Rules

- Use an unprefixed kebab-case branch name and keep one problem per pull request.
- Do not add a project `CLAUDE.md`. Claude Code reads this file.
- Keep every skill reference, helper and template under `skills/`, so copied installations work.
- Describe directory-scanner triggers in words in release notes and guides. The scanner reads prose as it reads code.
