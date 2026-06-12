import { test, expect } from "bun:test";
import { parseFlags, matchSkillGlob, filterToolMap, buildToolProtocol, createInFlightAbortHarness } from "../src/commands/launch";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

test("parseFlags: parses --no-skills, --skills, --no-tools, --tools, --system-prompt", () => {
  // Test default values
  const defaults = parseFlags([]);
  expect(defaults.noSkills).toBe(false);
  expect(defaults.skills).toBeUndefined();
  expect(defaults.noTools).toBe(false);
  expect(defaults.tools).toBeUndefined();
  expect(defaults.systemPromptRaw).toBeUndefined();
  expect(defaults.systemPrompt).toBeUndefined();

  // Test --no-skills
  const flags1 = parseFlags(["--no-skills"]);
  expect(flags1.noSkills).toBe(true);

  // Test --skills (space-separated and inline)
  const flags2 = parseFlags(["--skills", "git-*,docker"]);
  expect(flags2.skills).toBe("git-*,docker");

  const flags2Inline = parseFlags(["--skills=git-*,docker"]);
  expect(flags2Inline.skills).toBe("git-*,docker");

  // Test --no-tools
  const flags3 = parseFlags(["--no-tools"]);
  expect(flags3.noTools).toBe(true);

  // Test --tools (space-separated and inline)
  const flags4 = parseFlags(["--tools", "read,search"]);
  expect(flags4.tools).toBe("read,search");

  const flags4Inline = parseFlags(["--tools=read,search"]);
  expect(flags4Inline.tools).toBe("read,search");

  // Test --system-prompt (space-separated and inline)
  const flags5 = parseFlags(["--system-prompt", "custom preamble text"]);
  expect(flags5.systemPromptRaw).toBe("custom preamble text");
  expect(flags5.systemPrompt).toBe("custom preamble text");

  const flags5Inline = parseFlags(["--system-prompt=custom preamble inline"]);
  expect(flags5Inline.systemPromptRaw).toBe("custom preamble inline");
  expect(flags5Inline.systemPrompt).toBe("custom preamble inline");
});

test("parseFlags: --system-prompt reading from @file", () => {
  const tempFile = path.join(os.tmpdir(), `jeo-temp-sysprompt-${Date.now()}.txt`);
  fs.writeFileSync(tempFile, "system prompt from file content", "utf8");

  try {
    const flags = parseFlags(["--system-prompt", `@${tempFile}`]);
    expect(flags.systemPromptRaw).toBe(`@${tempFile}`);
    expect(flags.systemPrompt).toBe("system prompt from file content");
    expect(flags.errors).toEqual([]);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {}
  }
});

test("parseFlags: --system-prompt missing @file records error", () => {
  const missingFile = path.join(os.tmpdir(), "jeo-non-existent-sysprompt-file.txt");
  const flags = parseFlags(["--system-prompt", `@${missingFile}`]);
  expect(flags.systemPromptRaw).toBe(`@${missingFile}`);
  expect(flags.systemPrompt).toBeUndefined();
  expect(flags.errors.length).toBeGreaterThan(0);
});

test("matchSkillGlob edges", () => {
  // star-only
  expect(matchSkillGlob("*", "anything")).toBe(true);
  expect(matchSkillGlob("*", "git-diff")).toBe(true);

  // prefix*
  expect(matchSkillGlob("git-*", "git-diff")).toBe(true);
  expect(matchSkillGlob("git-*", "git-status")).toBe(true);
  expect(matchSkillGlob("git-*", "docker-run")).toBe(false);

  // *suffix
  expect(matchSkillGlob("*diff", "git-diff")).toBe(true);
  expect(matchSkillGlob("*diff", "diff")).toBe(true);
  expect(matchSkillGlob("*diff", "git-status")).toBe(false);

  // case-insensitive
  expect(matchSkillGlob("Git-*", "git-diff")).toBe(true);
  expect(matchSkillGlob("git-*", "GIT-DIFF")).toBe(true);
  expect(matchSkillGlob("GIT", "git")).toBe(true);

  // no-wildcard exact
  expect(matchSkillGlob("git", "git")).toBe(true);
  expect(matchSkillGlob("git", "git-diff")).toBe(false);
  expect(matchSkillGlob("git", "github")).toBe(false);
});

test("filterToolMap", () => {
  const mockTools = {
    read: () => "read",
    write: () => "write",
    edit: () => "edit",
    bash: () => "bash"
  };

  const filtered1 = filterToolMap(mockTools, ["read", "edit"]);
  expect(Object.keys(filtered1)).toEqual(["read", "edit"]);
  expect(filtered1.read()).toBe("read");
  expect(filtered1.edit()).toBe("edit");

  const filtered2 = filterToolMap(mockTools, ["write", "foo", "bash"]);
  expect(Object.keys(filtered2)).toEqual(["write", "bash"]);
  expect(filtered2.write()).toBe("write");
  expect(filtered2.bash()).toBe("bash");
});

test("buildToolProtocol respects allowed tools list", () => {
  // empty / done only
  const protocolEmpty = buildToolProtocol(new Set());
  expect(protocolEmpty).toContain("1. done");
  expect(protocolEmpty).not.toContain("read   {filePath");
  expect(protocolEmpty).not.toContain("ls     {dirPath}");

  // subset allowed
  const protocolSubset = buildToolProtocol(new Set(["read", "search"]));
  expect(protocolSubset).toContain("1. read");
  expect(protocolSubset).toContain("2. search");
  expect(protocolSubset).toContain("3. done");
  expect(protocolSubset).not.toContain("write");
  expect(protocolSubset).not.toContain("bash");
});

test("createInFlightAbortHarness: first Ctrl-C is an immediate hard exit", () => {
  const notices: string[] = [];
  let hardExit = 0;
  const h = createInFlightAbortHarness({
    captureEsc: false,
    onAbortNotice: msg => notices.push(msg),
    onHardExit: () => { hardExit++; },
  });
  try {
    expect(h.controller.signal.aborted).toBe(false);
    h.handleSigint();
    expect(h.controller.signal.aborted).toBe(true);
    expect(notices).toEqual([]);
    expect(hardExit).toBe(1);
  } finally {
    h.dispose();
  }
});

test("createInFlightAbortHarness: ESC aborts and raw mode is restored on dispose", () => {
  const rawCalls: boolean[] = [];
  let onHandler: ((chunk: string | Uint8Array) => void) | undefined;
  let offHandler: ((chunk: string | Uint8Array) => void) | undefined;
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) { rawCalls.push(raw); },
    resume() {},
    on(_event: "data", handler: (chunk: string | Uint8Array) => void) { onHandler = handler; },
    off(_event: "data", handler: (chunk: string | Uint8Array) => void) { offHandler = handler; },
  };
  const h = createInFlightAbortHarness({ captureEsc: true, stdin });
  try {
    expect(onHandler).toBeDefined();
    h.handleData("\u001b");
    expect(h.controller.signal.aborted).toBe(true);
  } finally {
    h.dispose();
  }
  expect(offHandler).toBeDefined();
  expect(rawCalls).toEqual([true, false]);
});

test("createInFlightAbortHarness: raw-mode Ctrl-C data hard-exits; wheel noise auto-repaints without aborting", () => {
  const notices: string[] = [];
  let noise = 0;
  let hardExit = 0;
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode(_raw: boolean) {},
    resume() {},
    on() {},
    off() {},
  };
  const h = createInFlightAbortHarness({
    captureEsc: true,
    stdin,
    onAbortNotice: msg => notices.push(msg),
    onNoise: () => { noise++; },
    onHardExit: () => { hardExit++; },
  });
  try {
    // Mouse-wheel scroll arrives as arrow escape bursts → auto-repair, NOT an abort.
    h.handleData("\u001b[A\u001b[A\u001b[A");
    expect(noise).toBe(1);
    expect(h.controller.signal.aborted).toBe(false);
    // Raw mode swallows terminal SIGINT generation: Ctrl-C arrives as \u0003 data.
    h.handleData("\u0003");
    expect(h.controller.signal.aborted).toBe(true);
    expect(notices).toEqual([]);
    expect(hardExit).toBe(1);
  } finally {
    h.dispose();
  }
});
