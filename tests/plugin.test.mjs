// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");
const json = (file) => JSON.parse(read(file));
const manifests = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "package.json"].map(json);
const claude = json(".claude-plugin/marketplace.json");
const codex = json(".agents/plugins/marketplace.json");

test("the release version agrees across the manifests, the pi package, the marketplace entry and the changelog", () => {
  const { version } = manifests[0];
  assert.match(version, /^\d+\.\d+\.\d+$/);
  for (const manifest of manifests) assert.equal(manifest.version, version);
  assert.equal(claude.plugins[0].version, version);
  assert.ok(read("CHANGES.md").split("\n").some((line) => line.startsWith(`## ${version} - `)), "missing release entry");
});

test("the manifests and marketplaces describe one plugin", () => {
  for (const manifest of manifests) {
    assert.equal(manifest.name, "agent-formal-verify");
    assert.equal(manifest.license, "GPL-3.0-only");
    assert.equal(manifest.description, manifests[0].description);
  }
  for (const marketplace of [claude, codex]) {
    assert.equal(marketplace.name, "agent-formal-verify");
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, "agent-formal-verify");
  }
  assert.equal(claude.plugins[0].description, manifests[0].description);
  assert.equal(claude.plugins[0].source, "./");
  assert.equal(codex.plugins[0].source.path, "./");
  assert.equal(manifests[1].skills, "./skills/");
});

test("the pi package exposes the skills tree and is discoverable", () => {
  const { pi, keywords } = manifests[2];
  assert.deepEqual(pi.skills, ["./skills"]);
  assert.ok(existsSync(join(root, pi.skills[0], "formal-verify", "SKILL.md")));
  assert.ok(keywords.includes("pi-package"));
});

async function register(entry, existing = []) {
  const plugin = (await import(entry)).default;
  assert.equal(plugin.id, "agent-formal-verify");
  const registered = new Map(existing.map((skill) => [skill.id, skill]));
  await plugin.setup({
    skill: {
      transform: async (edit) => edit({ get: (id) => registered.get(id), add: (skill) => registered.set(skill.id, skill) }),
    },
  });
  return registered;
}
const opencode = new URL("../opencode.mjs", import.meta.url);
const bundled = () => readdirSync(skills).sort();

test("the OpenCode plugin registers every bundled skill from its SKILL.md", async () => {
  const { exports, dependencies } = manifests[2];
  assert.deepEqual(exports, { "./server": "./opencode.mjs" });
  assert.equal(dependencies, undefined);
  const registered = await register(opencode);
  assert.deepEqual([...registered.keys()].sort(), bundled());
  for (const id of bundled()) {
    const skill = registered.get(id);
    const text = read(`skills/${id}/SKILL.md`);
    assert.equal(realpathSync(skill.path), join(skills, id, "SKILL.md"));
    assert.equal(skill.name, id);
    assert.ok(text.includes(`description: ${JSON.stringify(skill.description)}\n`), id);
    assert.ok(text.endsWith(`\n---\n${skill.content}`), id);
    assert.equal(skill.autoinvoke, true);
  }
});

test("the OpenCode plugin keeps a skill already registered under the same name", async () => {
  const existing = { id: "setup", path: "/elsewhere/setup/SKILL.md" };
  const registered = await register(opencode, [existing]);
  assert.equal(registered.get("setup"), existing);
  assert.ok(registered.has("formal-verify"));
});

test("the OpenCode plugin reads skills checked out with CRLF line endings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-crlf-"));
  try {
    copyFileSync(fileURLToPath(opencode), join(dir, "opencode.mjs"));
    for (const id of bundled()) {
      mkdirSync(join(dir, "skills", id), { recursive: true });
      writeFileSync(join(dir, "skills", id, "SKILL.md"), read(`skills/${id}/SKILL.md`).replaceAll("\n", "\r\n"));
    }
    const lf = await register(opencode);
    const crlf = await register(pathToFileURL(join(dir, "opencode.mjs")));
    for (const id of bundled()) {
      const { name, description, content } = crlf.get(id);
      assert.deepEqual({ name, description, content }, { name: lf.get(id).name, description: lf.get(id).description, content: lf.get(id).content });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the plugin has no automatic hooks or servers that could forward credentials", () => {
  for (const manifest of manifests.slice(0, 2)) {
    for (const field of ["hooks", "mcpServers", "lspServers"]) {
      assert.ok(!(field in manifest), `${field} requires a directory policy review`);
    }
  }
  for (const file of ["hooks/hooks.json", ".mcp.json", ".lsp.json"]) {
    assert.ok(!existsSync(join(root, file)), `${file} requires a directory policy review`);
  }
});

const skills = realpathSync(join(root, "skills"));
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

test("documentation does not present bundled images or fonts as code", () => {
  const files = ["README.md", "CHANGES.md", "CONTRIBUTING.md"].map((file) => join(root, file));
  files.push(...walk(join(root, "docs")), ...walk(skills));
  for (const file of files.filter((path) => path.endsWith(".md"))) {
    const text = readFileSync(file, "utf8");
    for (const [, , code] of text.matchAll(/(`+|~{3,})([\s\S]*?)\1/g)) {
      for (const [target] of code.matchAll(/[\w./-]+\.(?:png|jpe?g|gif|webp|woff2?|ttf|otf)\b/gi)) {
        const asset = resolve(dirname(file), target);
        assert.ok(!existsSync(asset), `${relative(root, file)}: use a Markdown image instead of code for ${target}`);
      }
    }
  }
});

test("bundled images carry no provenance or text chunks", () => {
  const images = [".claude-plugin", "assets"].flatMap((dir) => walk(join(root, dir))).filter((path) => path.endsWith(".png"));
  assert.ok(images.length > 0);
  for (const file of images) {
    const data = readFileSync(file);
    assert.equal(data.toString("latin1", 0, 8), "\x89PNG\r\n\x1a\n", `${relative(root, file)}: not a PNG`);
    for (let pos = 8; pos < data.length; pos += 12 + data.readUInt32BE(pos)) {
      const type = data.toString("latin1", pos + 4, pos + 8);
      assert.ok(!["caBX", "iTXt", "tEXt", "zTXt", "eXIf"].includes(type), `${relative(root, file)}: strip the ${type} chunk; the directory screens its text as code or credentials`);
    }
  }
});

test("skills declare their names and link only to files inside the skills tree", () => {
  for (const file of walk(skills).filter((path) => path.endsWith(".md"))) {
    const text = readFileSync(file, "utf8");
    if (file.endsWith("/SKILL.md")) {
      assert.match(text, new RegExp(`^---\\nname: ${dirname(file).split(sep).at(-1)}\\n`));
      assert.match(text, /^description: .+/m);
    }
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:|^#/i.test(target)) continue;
      const path = decodeURIComponent(target.split(/[?#]/)[0]);
      const linked = resolve(dirname(file), path);
      assert.ok(existsSync(linked), `${file}: broken reference: ${target}`);
      const rel = relative(skills, realpathSync(linked));
      assert.ok(!isAbsolute(path) && rel !== ".." && !rel.startsWith(`..${sep}`), `${file}: reference escapes skills tree: ${target}`);
    }
  }
});
