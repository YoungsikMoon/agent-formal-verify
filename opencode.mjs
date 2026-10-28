// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const skills = new URL("./skills/", import.meta.url);

function parse(text, path) {
  const match = text.replaceAll("\r\n", "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${path} has no frontmatter`);
  const field = (key) => {
    const value = match[1].match(new RegExp(`^${key}: (.+)$`, "m"))?.[1];
    if (value === undefined) throw new Error(`${path} has no ${key}`);
    if (value.startsWith('"')) return JSON.parse(value);
    if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
    return value;
  };
  return { name: field("name"), description: field("description"), content: match[2] };
}

async function load() {
  const entries = await readdir(skills, { withFileTypes: true });
  const found = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async ({ name }) => {
        const path = fileURLToPath(new URL(`${name}/SKILL.md`, skills));
        const text = await readFile(path, "utf8").catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        return text && { id: name, ...parse(text, path), autoinvoke: true, path };
      }),
  );
  return found.filter(Boolean);
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
