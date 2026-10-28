# Contributing

Use [GitHub issues](https://github.com/michael-denyer/agent-formal-verify/issues) for bugs and proposals, and pull requests for changes.

## Develop locally

Clone the repository and install Node.js 22 or later and [prek](https://prek.j178.dev/installation/). Enable the commit hooks once per clone, then run all checks from the repository root:

```shell
prek install
prek run --all-files
```

prek prepares the pinned lint tools in its own cache. The hooks check plugin metadata, skill references, helper tests, shell scripts, Python, Markdown, JSON, YAML and GitHub Actions workflows. CI runs the same checks and also copies the skills into an isolated installation to check that their files match. Keep every skill reference, helper and template within `skills/` so copied installations work.

CI also checks local documentation links and heading anchors with lychee in offline mode and audits workflow security with zizmor. To run these checks locally, install lychee 0.24.2 and zizmor 1.29.0, then run:

```shell
lychee --offline --no-progress --include-fragments \
  --exclude-path .git --exclude-path .agents/skills \
  --exclude-path node_modules --exclude-path .lake '**/*.md'
zizmor --offline --persona pedantic --min-severity low .github/workflows/
```

Test the plugin in Claude Code with `claude --plugin-dir /absolute/path/to/agent-formal-verify`, in Pi with `pi -e /absolute/path/to/agent-formal-verify`, and in OpenCode by adding the checkout's absolute path to `plugins` in a project's `opencode.json`. To test model runners, prepare their tools using [tool setup](skills/formal-verify/references/setup.md). Runner changes should demonstrate a valid model passing and a broken property failing: `bash tests/models.sh` runs both checkers and the mutation runner on the bundled examples and on copies with one guard weakened, a hidden axiom, clashing names, an unowned file or an undetected mutation, and CI runs it as the `models` job. It uses only the template's Lean pin, so after changing the audit in `lean-check.sh`, run the checker once by hand on a project pinned to Lean 4.20.0, the oldest supported version. Verification runners must report missing tools without downloading them; preparation belongs in `setup.sh`.

For skill changes, check a realistic request against the instructions. Confirm that the agent chooses suitable targets, preserves the source behaviour, and reports assumptions and proof gaps. Keep prose direct and remove slogans and unsupported claims.

## Submit a change

Use an unprefixed branch name. Keep each pull request focused on one problem. Describe the problem, resulting behaviour and validation. Include a small reproduction for bug fixes and relevant tests for changed tool behaviour. Avoid including caches, generated build files or unrelated edits.

## Release

Update both plugin manifests, `package.json`, the Claude marketplace entry and `CHANGES.md` together. `node --test tests/plugin.test.mjs` checks that the versions, descriptions and license declarations agree. Document changes to setup requirements or pinned tools so users know what an update requires.

### Claude directory validation

Validate both the plugin manifest and the marketplace; validating the repository root alone selects the marketplace:

```shell
claude plugin validate .claude-plugin/plugin.json --strict
claude plugin validate .claude-plugin/marketplace.json --strict
```

The [directory checklist](https://claude.com/docs/plugins/pre-submission-checklist) adds checks that the CLI does not run. Use Markdown image syntax for bundled artwork and keep image and font paths out of backticks and code blocks, including historical release notes. The metadata tests check this and guard against adding automatic hooks or servers without a policy review.

For a credential or download-and-run finding, inspect the named file at the commit the portal scanned and trace the actual credential read or executed command. The scan covers every tracked file, including the CI workflow, so keep credential variables such as the workflow token out of it, and keep package launchers and links to installable packages out of skill files and documentation. Generated artwork can carry a signed C2PA manifest in a PNG `caBX` chunk, which held the image check; the metadata tests reject that chunk and other text chunks, so strip them before committing an image. After pushing a fix, re-validate in the portal: an existing report describes only the commit it read, and CLI validation does not clear directory policy holds.

## Dependency updates

Dependabot opens weekly update PRs for GitHub Actions, the pinned lint hooks and prek. Updates wait seven days after release and must pass CI before review; they are not merged automatically.

Update the isolated-installation `skills` CLI pin, lychee image tag and digest, zizmor tool version, and elan version and checksum manually in CI. Lean pins and TLC's version and checksum also need deliberate updates: run a valid model and a failing property with the new tools before changing their pins.

## License

Submit contributions under [GPL-3.0-only](LICENSE), the repository's license. Identify any third-party material and preserve its required notices.
