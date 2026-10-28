// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const skills = new URL("./skills/", import.meta.url);

function parse(text) {
  const match = text.replaceAll("\r\n", "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md has no frontmatter");
  const field = (key) => {
    const value = match[1].match(new RegExp(`^${key}: (.+)$`, "m"))?.[1];
    return value?.startsWith('"') ? JSON.parse(value) : value;
  };
  return { name: field("name"), description: field("description"), content: match[2] };
}

async function load() {
  const entries = await readdir(skills, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async ({ name }) => {
        const file = new URL(`${name}/SKILL.md`, skills);
        const skill = parse(await readFile(file, "utf8"));
        return { id: name, ...skill, autoinvoke: true, path: fileURLToPath(file) };
      }),
  );
}

export default {
  id: "agent-formal-verify",
  async setup(ctx) {
    const found = await load();
    await ctx.skill.transform((editor) => {
      for (const skill of found) if (!editor.get(skill.id)) editor.add(skill);
    });
  },
};
