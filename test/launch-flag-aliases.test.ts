import { test, expect } from "bun:test";
import { parseFlags, normalizeSlashAlias } from "../src/commands/launch";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

test("parseFlags: -p/--print sets print and noTui, and checks message requirement", () => {
  const flags1 = parseFlags(["-p", "hello world"]);
  expect(flags1.print).toBe(true);
  expect(flags1.noTui).toBe(true);
  expect(flags1.message).toBe("hello world");
  expect(flags1.errors).toEqual([]);

  const flags2 = parseFlags(["--print", "test message"]);
  expect(flags2.print).toBe(true);
  expect(flags2.noTui).toBe(true);
  expect(flags2.message).toBe("test message");
  expect(flags2.errors).toEqual([]);

  const flags3 = parseFlags(["-p"]);
  expect(flags3.print).toBe(true);
  expect(flags3.noTui).toBe(true);
  expect(flags3.errors).toContain("-p/--print requires a message argument");
});

test("parseFlags: -c/--continue maps to resume without UUID or with UUID", () => {
  const flags1 = parseFlags(["-c"]);
  expect(flags1.resume).toBe(true);
  expect(flags1.resumeId).toBeUndefined();

  const flags2 = parseFlags(["--continue"]);
  expect(flags2.resume).toBe(true);
  expect(flags2.resumeId).toBeUndefined();

  const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const flags3 = parseFlags(["-c", uuid]);
  expect(flags3.resume).toBe(true);
  expect(flags3.resumeId).toBe(uuid);

  const flags4 = parseFlags(["--continue", uuid]);
  expect(flags4.resume).toBe(true);
  expect(flags4.resumeId).toBe(uuid);

  const flags5 = parseFlags([`-c=${uuid}`]);
  expect(flags5.resume).toBe(true);
  expect(flags5.resumeId).toBe(uuid);

  const flags6 = parseFlags([`--continue=${uuid}`]);
  expect(flags6.resume).toBe(true);
  expect(flags6.resumeId).toBe(uuid);
});

test("parseFlags: --continue/-c always resumes latest silently, never sets resumeInteractive", () => {
  const flags1 = parseFlags(["-c"]);
  expect(flags1.resume).toBe(true);
  expect(flags1.resumeInteractive).toBe(false);
  expect(flags1.resumeId).toBeUndefined();

  const flags2 = parseFlags(["--continue"]);
  expect(flags2.resume).toBe(true);
  expect(flags2.resumeInteractive).toBe(false);
  expect(flags2.resumeId).toBeUndefined();

  const flags3 = parseFlags(["-c", "abc123"]);
  expect(flags3.resume).toBe(true);
  expect(flags3.resumeInteractive).toBe(false);
  expect(flags3.resumeId).toBe("abc123");

  const flags4 = parseFlags(["--continue", "abc123"]);
  expect(flags4.resume).toBe(true);
  expect(flags4.resumeInteractive).toBe(false);
  expect(flags4.resumeId).toBe("abc123");

  const flags5 = parseFlags(["-c=abc123"]);
  expect(flags5.resume).toBe(true);
  expect(flags5.resumeInteractive).toBe(false);
  expect(flags5.resumeId).toBe("abc123");

  const flags6 = parseFlags(["--continue=abc123"]);
  expect(flags6.resume).toBe(true);
  expect(flags6.resumeInteractive).toBe(false);
  expect(flags6.resumeId).toBe("abc123");
});

test("parseFlags: --resume/-r with a value resolves as an id/prefix (not UUID-restricted)", () => {
  const flags1 = parseFlags(["--resume", "abc123"]);
  expect(flags1.resume).toBe(true);
  expect(flags1.resumeInteractive).toBe(false);
  expect(flags1.resumeId).toBe("abc123");

  const flags2 = parseFlags(["-r", "abc123"]);
  expect(flags2.resume).toBe(true);
  expect(flags2.resumeInteractive).toBe(false);
  expect(flags2.resumeId).toBe("abc123");

  const flags3 = parseFlags(["--resume=abc123"]);
  expect(flags3.resume).toBe(true);
  expect(flags3.resumeInteractive).toBe(false);
  expect(flags3.resumeId).toBe("abc123");
});

test("parseFlags: bare --resume/-r (no value) sets resumeInteractive for the cold-startup picker", () => {
  const flags1 = parseFlags(["--resume"]);
  expect(flags1.resume).toBe(true);
  expect(flags1.resumeInteractive).toBe(true);
  expect(flags1.resumeId).toBeUndefined();

  const flags2 = parseFlags(["-r"]);
  expect(flags2.resume).toBe(true);
  expect(flags2.resumeInteractive).toBe(true);
  expect(flags2.resumeId).toBeUndefined();

  // Followed by another flag (not a value) — still bare.
  const flags3 = parseFlags(["--resume", "--no-session"]);
  expect(flags3.resume).toBe(true);
  expect(flags3.resumeInteractive).toBe(true);
  expect(flags3.resumeId).toBeUndefined();
  expect(flags3.noSession).toBe(true);

  const flags4 = parseFlags(["-r", "-p", "hi"]);
  expect(flags4.resume).toBe(true);
  expect(flags4.resumeInteractive).toBe(true);
  expect(flags4.resumeId).toBeUndefined();
});

test("parseFlags: --append-system-prompt literal + @file + missing file", () => {
  // 1. Literal text
  const flags1 = parseFlags(["--append-system-prompt", "hello custom system prompt"]);
  expect(flags1.appendSystemPromptRaw).toBe("hello custom system prompt");
  expect(flags1.appendSystemPrompt).toBe("hello custom system prompt");
  expect(flags1.errors).toEqual([]);

  const flags1Inline = parseFlags(["--append-system-prompt=hello inline prompt"]);
  expect(flags1Inline.appendSystemPromptRaw).toBe("hello inline prompt");
  expect(flags1Inline.appendSystemPrompt).toBe("hello inline prompt");
  expect(flags1Inline.errors).toEqual([]);

  // 2. @file with mkdtemp
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jeo-test-"));
  const tempFile = path.join(tempDir, "prompt.txt");
  fs.writeFileSync(tempFile, "loaded from file prompt", "utf8");

  try {
    const flags2 = parseFlags(["--append-system-prompt", `@${tempFile}`]);
    expect(flags2.appendSystemPromptRaw).toBe(`@${tempFile}`);
    expect(flags2.appendSystemPrompt).toBe("loaded from file prompt");
    expect(flags2.errors).toEqual([]);
  } finally {
    try {
      fs.unlinkSync(tempFile);
      fs.rmdirSync(tempDir);
    } catch {}
  }

  // 3. missing-file error path
  const missingFile = path.join(os.tmpdir(), "jeo-non-existent-prompt.txt");
  const flags3 = parseFlags(["--append-system-prompt", `@${missingFile}`]);
  expect(flags3.appendSystemPromptRaw).toBe(`@${missingFile}`);
  expect(flags3.appendSystemPrompt).toBeUndefined();
  expect(flags3.errors.length).toBeGreaterThan(0);
  expect(flags3.errors[0]).toContain("failed to read system prompt file");
});
test("normalizeSlashAlias rewrites gjc-parity command aliases (preserving args)", () => {
  // gjc-parity: bare `/login` → onboarding selector (same as bare `/provider`);
  // `/login <provider>` → direct OAuth-login alias.
  expect(normalizeSlashAlias("/login")).toBe("/provider");
  expect(normalizeSlashAlias("/login gemini")).toBe("/provider login gemini");
  expect(normalizeSlashAlias("/login gemini")).toBe("/provider login gemini");
  expect(normalizeSlashAlias("/settings")).toBe("/config");
  expect(normalizeSlashAlias("/subagent")).toBe("/agents");
  expect(normalizeSlashAlias("/subagent edit")).toBe("/agents edit");
  expect(normalizeSlashAlias("/subagents planner")).toBe("/agents planner");
  expect(normalizeSlashAlias("/resume")).toBe("/session resume");
  expect(normalizeSlashAlias("/resume 1234")).toBe("/session resume 1234");
  // non-aliases pass through untouched
  expect(normalizeSlashAlias("/model")).toBe("/model");
  expect(normalizeSlashAlias("/help")).toBe("/help");
  expect(normalizeSlashAlias("hello /login")).toBe("hello /login"); // only a leading command is rewritten
  expect(normalizeSlashAlias("/settingsx")).toBe("/settingsx"); // exact-match guard
  expect(normalizeSlashAlias("/new")).toBe("/session new");
  expect(normalizeSlashAlias("/drop")).toBe("/session drop");
  expect(normalizeSlashAlias("/rename")).toBe("/session rename");
  expect(normalizeSlashAlias("/rename My Title")).toBe("/session rename My Title");
  expect(normalizeSlashAlias("/sessions")).toBe("/session list");
  expect(normalizeSlashAlias("/newx")).toBe("/newx");
  expect(normalizeSlashAlias("/renamex")).toBe("/renamex");
});
