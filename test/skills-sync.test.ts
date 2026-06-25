import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncBundledSkills, runSkillsCommand } from "../src/commands/skills";
import { SKILLS, bundledSkillFileContent } from "../src/skills/catalog";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-skills-sync-"));
}

test("bundledSkillFileContent returns canonical on-disk bytes (raw SKILL.md when present)", () => {
  for (const s of SKILLS) {
    const content = bundledSkillFileContent(s);
    expect(content.length).toBeGreaterThan(0);
    // Bundled skills ship with raw SKILL.md text, so the file content IS that raw.
    if (s.raw) expect(content).toBe(s.raw);
    expect(content).toContain(s.name);
  }
});

test("syncBundledSkills: fresh install writes every bundled skill, content matches", async () => {
  const dir = await tmpDir();
  try {
    const result = await syncBundledSkills(dir);
    expect(result.entries.length).toBe(SKILLS.length);
    expect(result.wrote).toBe(SKILLS.length);
    expect(result.drift).toBe(true); // pre-write state was all-missing
    for (const e of result.entries) {
      expect(e.status).toBe("missing");
      expect(e.action).toBe("installed");
      const onDisk = await fs.readFile(e.path, "utf-8");
      const want = bundledSkillFileContent(SKILLS.find(s => s.name === e.name)!);
      expect(onDisk).toBe(want);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("syncBundledSkills: re-run on an in-sync dir is a no-op (no drift, no writes)", async () => {
  const dir = await tmpDir();
  try {
    await syncBundledSkills(dir);
    const result = await syncBundledSkills(dir);
    expect(result.wrote).toBe(0);
    expect(result.drift).toBe(false);
    expect(result.entries.every(e => e.status === "up-to-date")).toBe(true);
    expect(result.entries.every(e => e.action === "unchanged")).toBe(true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("syncBundledSkills --check reports drift without writing and preserves local edits", async () => {
  const dir = await tmpDir();
  try {
    await syncBundledSkills(dir);
    const target = SKILLS[0]!.name;
    const file = path.join(dir, `${target}.md`);
    await fs.writeFile(file, "LOCAL EDIT — do not clobber\n", "utf-8");

    const check = await syncBundledSkills(dir, { check: true });
    expect(check.drift).toBe(true);
    expect(check.wrote).toBe(0);
    const drifted = check.entries.find(e => e.name === target)!;
    expect(drifted.status).toBe("differs");
    expect(drifted.action).toBe("none");
    expect(check.entries.filter(e => e.status === "up-to-date").length).toBe(SKILLS.length - 1);
    // --check must not touch disk.
    expect(await fs.readFile(file, "utf-8")).toBe("LOCAL EDIT — do not clobber\n");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("syncBundledSkills: default install preserves a differing local copy, --force overwrites it", async () => {
  const dir = await tmpDir();
  try {
    await syncBundledSkills(dir);
    const target = SKILLS[1]!.name;
    const file = path.join(dir, `${target}.md`);
    await fs.writeFile(file, "MY OVERRIDE\n", "utf-8");

    const preserve = await syncBundledSkills(dir);
    const pe = preserve.entries.find(e => e.name === target)!;
    expect(pe.status).toBe("differs");
    expect(pe.action).toBe("preserved");
    expect(preserve.wrote).toBe(0);
    expect(await fs.readFile(file, "utf-8")).toBe("MY OVERRIDE\n");

    const forced = await syncBundledSkills(dir, { force: true });
    const fe = forced.entries.find(e => e.name === target)!;
    expect(fe.action).toBe("overwritten");
    expect(forced.wrote).toBe(1);
    expect(await fs.readFile(file, "utf-8")).toBe(bundledSkillFileContent(SKILLS[1]!));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("syncBundledSkills: a missing single file is reinstalled, others untouched", async () => {
  const dir = await tmpDir();
  try {
    await syncBundledSkills(dir);
    const target = SKILLS[2]!.name;
    await fs.rm(path.join(dir, `${target}.md`));

    const check = await syncBundledSkills(dir, { check: true });
    expect(check.entries.find(e => e.name === target)!.status).toBe("missing");
    expect(check.drift).toBe(true);

    const install = await syncBundledSkills(dir);
    expect(install.wrote).toBe(1);
    expect(install.entries.find(e => e.name === target)!.action).toBe("installed");
    expect(install.entries.filter(e => e.action === "unchanged").length).toBe(SKILLS.length - 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runSkillsCommand sync: --check exits non-zero on drift, zero after install (JEO_CONFIG_DIR target)", async () => {
  const home = await tmpDir();
  const prevConfig = process.env.JEO_CONFIG_DIR;
  const prevExit = process.exitCode;
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: any[]) => { logs.push(a.join(" ")); };
  try {
    process.env.JEO_CONFIG_DIR = home;

    // Nothing installed yet → --check must flag drift with a non-zero exit code.
    process.exitCode = 0;
    await runSkillsCommand(["sync", "--check"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Drift detected");

    // Install into ~/.jeo/skills (resolved from JEO_CONFIG_DIR).
    process.exitCode = 0;
    logs.length = 0;
    await runSkillsCommand(["sync"]);
    const installed = await fs.readdir(path.join(home, "skills"));
    expect(installed.filter(f => f.endsWith(".md")).length).toBe(SKILLS.length);

    // Re-check → in sync, exit code stays 0.
    process.exitCode = 0;
    logs.length = 0;
    await runSkillsCommand(["sync", "--check"]);
    expect(process.exitCode).toBe(0);
    expect(logs.join("\n")).toContain("in sync");
  } finally {
    console.log = origLog;
    if (prevConfig === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = prevConfig;
    process.exitCode = prevExit ?? 0;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("runSkillsCommand sync --json emits a structured result with mode", async () => {
  const dir = await tmpDir();
  const origLog = console.log;
  const logs: string[] = [];
  console.log = (...a: any[]) => { logs.push(a.join(" ")); };
  try {
    await runSkillsCommand(["sync", dir, "--json"]);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.mode).toBe("install");
    expect(parsed.dir).toBe(dir);
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries.length).toBe(SKILLS.length);
    expect(parsed.wrote).toBe(SKILLS.length);
  } finally {
    console.log = origLog;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
