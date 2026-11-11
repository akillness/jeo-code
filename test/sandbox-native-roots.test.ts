import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nativeSandboxSkillRoots } from "../src/skills/catalog";
import { nativeSandboxHome } from "../src/agent/sandbox/policy";

test("native skill roots reject spoofed HOME and arbitrary configured skill directories", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-native-roots-")));
  const previous = { home: process.env.HOME, config: process.env.JEO_CONFIG_DIR, skills: process.env.JEO_SKILLS_DIR };
  try {
    await Promise.all([".claude/skills", ".agents/skills", ".jeo/skills", "custom"].map(dir => fs.mkdir(path.join(root, dir), { recursive: true })));
    process.env.HOME = root;
    process.env.JEO_CONFIG_DIR = path.join(root, ".jeo");
    process.env.JEO_SKILLS_DIR = path.join(root, "custom");
    expect(await nativeSandboxSkillRoots(path.join(root, "project"))).toEqual([]);
  } finally {
    for (const [key, value] of [["HOME", previous.home], ["JEO_CONFIG_DIR", previous.config], ["JEO_SKILLS_DIR", previous.skills]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("native skill roots are canonical existing directories under the native account's fixed stores", async () => {
  const home = await fs.realpath(await nativeSandboxHome());
  const allowed = new Set([".claude/skills", ".agents/skills", ".agent-skills", ".jeo/skills", ".jeo/agent/skills"].map(dir => path.join(home, dir)));
  const roots = await nativeSandboxSkillRoots(process.cwd());
  expect(new Set(roots).size).toBe(roots.length);
  for (const root of roots) {
    expect(allowed.has(root)).toBe(true);
    expect(await fs.realpath(root)).toBe(root);
    expect((await fs.stat(root)).isDirectory()).toBe(true);
  }
});
