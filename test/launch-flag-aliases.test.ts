import { test, expect } from "bun:test";
import { parseFlags } from "../src/commands/launch";
import { globalModelsArgs } from "../src/cli/runner";
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "joc-test-"));
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
  const missingFile = path.join(os.tmpdir(), "joc-non-existent-prompt.txt");
  const flags3 = parseFlags(["--append-system-prompt", `@${missingFile}`]);
  expect(flags3.appendSystemPromptRaw).toBe(`@${missingFile}`);
  expect(flags3.appendSystemPrompt).toBeUndefined();
  expect(flags3.errors.length).toBeGreaterThan(0);
  expect(flags3.errors[0]).toContain("failed to read system prompt file");
});

test("globalModelsArgs classifies new launch flags correctly", () => {
  // If we pass global models command after --append-system-prompt, it should skip --append-system-prompt and its value
  expect(globalModelsArgs(["--append-system-prompt", "custom text", "--models", "caps"])).toEqual(["caps"]);
  expect(globalModelsArgs(["--append-system-prompt=custom inline", "--models", "caps"])).toEqual(["caps"]);

  // If we pass global models command after -p / --print, they are stripped/ignored
  expect(globalModelsArgs(["-p", "--models", "caps"])).toEqual(["caps"]);
  expect(globalModelsArgs(["--print", "--models", "caps"])).toEqual(["caps"]);

  // -c and --continue take optional UUID like --resume
  expect(globalModelsArgs(["-c", "--models", "caps"])).toEqual(["caps"]);
  const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  expect(globalModelsArgs(["-c", uuid, "--models", "caps"])).toEqual(["caps"]);
  expect(globalModelsArgs(["--continue", uuid, "--models", "caps"])).toEqual(["caps"]);
});
