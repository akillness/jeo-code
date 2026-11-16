import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "chalk";

afterEach(() => mock.restore());

test("createStreamEvents: step header + tool target are logged on each step, not just results", () => {
  const lines: string[] = [];
  const ev = createStreamEventsSync(4, s => lines.push(s));

  // engine sequence: onStep then onAssistant (with the invocation) then onToolResult
  ev.onStep!(1);
  ev.onAssistant!("", { tool: "read", arguments: { filePath: "src/agent/engine.ts" } });
  ev.onToolResult!("read", true, "1| ...");
  ev.onStep!(2);
  ev.onAssistant!("", { tool: "bash", arguments: { command: "bun test\nignored" } });
  ev.onToolResult!("bash", false, "exit 1\nSegfault");

  const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  // STEP headers with the real tool target — identify the tool being invoked
  expect(out).toMatch(/[Rr]ead\s*:?\s*src\/agent\/engine\.ts/);
  expect(out).toContain("Bash");
  // results, with the failing output tail surfaced
  expect(out).toMatch(/\u2713 [Rr]ead\s*:?\s*src\/agent\/engine\.ts/);
  expect(out).toContain("\u2717 Bash \u2014 exit 1");
});

test("createStreamEvents: 'done' and invalid responses do not emit a step line", () => {
  const lines: string[] = [];
  const ev = createStreamEventsSync(25, s => lines.push(s));
  ev.onStep!(1);
  ev.onAssistant!("", { tool: "done", arguments: { reason: "finished" } });
  ev.onAssistant!("not json", null);
  expect(lines).toEqual([]); // nothing printed for done / non-tool responses
});

// Imported lazily so mock.restore() between suites stays clean.
import { createStreamEvents, formatTaskSubEvent } from "../src/commands/launch";
function createStreamEventsSync(maxSteps: number, log: (s: string) => void) {
  return createStreamEvents(maxSteps, log);
}

test("formatTaskSubEvent treats only explicit false as incomplete", () => {
  const out = formatTaskSubEvent({ kind: "done", role: "executor", detail: "ok" }).replace(/\x1b\[[0-9;]*m/g, "");
  expect(out).toContain("[AGENT]");
  expect(out).toContain("done: ok");
  expect(out).not.toContain("(incomplete)");
});

for (const kind of ["start", "step", "tool", "error", "done"] as const) {
  test(`detached carry: plain ${kind} rows distinguish simultaneous same-role runs`, () => {
    const render = (detachedId: string) => formatTaskSubEvent({
      role: "executor", kind, detachedId, detail: "read src/agent/engine.ts", success: kind !== "error",
    }).replace(/\x1b\[[0-9;]*m/g, "");
    const first = render("detached-17");
    const second = render("detached-18");
    expect(first).toContain("EXECUTOR");
    expect(first).toContain("detached-17");
    expect(first).not.toContain("detached-18");
    expect(second).toContain("detached-18");
    expect(second).not.toContain("detached-17");
    expect(first).not.toBe(second);
  });
}

test("formatTaskSubEvent sanitizes terminal escapes and redacts secrets in role, detachedId, detail, and summary BEFORE chalk styling", () => {
  const prevLevel = chalk.level;
  chalk.level = 3;
  try {
    const toolLine = formatTaskSubEvent({
      kind: "tool",
      role: "exec\x1b[2Jutor token=secret-role",
      detachedId: "det\u009b2J-1",
      detail: "curl \x1b]0;evil\x07 Authorization: Bearer sk-secret-123",
      summary: "Bearer sk-secret-123\x1b[31m leaked",
      success: true,
    });
    expect(/\x1b\[[0-9;]*m/.test(toolLine)).toBe(true);
    expect(toolLine).not.toContain("\x1b[2J");
    expect(toolLine).not.toContain("\x1b]");
    expect(toolLine).not.toContain("\x07");
    expect(toolLine).not.toContain("\u009b");
    expect(toolLine).not.toContain("\x1b[31m");
    // Secrets must be redacted (case-insensitive check covers uppercased roleLabel).
    expect(toolLine.toLowerCase()).not.toContain("secret-role");
    expect(toolLine.toLowerCase()).not.toContain("sk-secret-123");

    const plainTool = toolLine.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainTool).toContain("[AGENT]");
    expect(plainTool).toContain("├─");
    expect(plainTool).toContain("✓");
    expect(plainTool).toContain("<redacted>");

    const doneLine = formatTaskSubEvent({
      kind: "done",
      role: "arch\x1b[2Jitect",
      detachedId: "run\x1b]0;x\x07-2 Bearer sk-secret-123",
      detail: "finished\u009b2J api_key=mysecretkey",
      tokens: { input: 100, output: 50 },
      success: true,
    });
    expect(/\x1b\[[0-9;]*m/.test(doneLine)).toBe(true);
    expect(doneLine).not.toContain("\x1b[2J");
    expect(doneLine).not.toContain("\x1b]");
    expect(doneLine).not.toContain("\u009b");
    expect(doneLine).not.toContain("sk-secret-123");
    expect(doneLine).not.toContain("mysecretkey");

    const plainDone = doneLine.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainDone).toContain("[AGENT]");
    expect(plainDone).toContain("└─");
    expect(plainDone).toContain("done");
    expect(plainDone).toContain("(150 tok)");
  } finally {
    chalk.level = prevLevel;
  }
});

test("formatTaskSubEvent surfaces step/maxSteps and shortened model metadata cleanly when present", () => {
  const stepLine = formatTaskSubEvent({
    kind: "step",
    role: "executor",
    step: 2,
    maxSteps: 6,
    model: "anthropic/claude-sonnet-4-6",
    detail: "inspecting tests",
  }).replace(/\x1b\[[0-9;]*m/g, "");
  expect(stepLine).toContain("[AGENT]");
  expect(stepLine).toContain("├─");
  expect(stepLine).toContain("EXECUTOR");
  expect(stepLine).toContain("2/6");
  expect(stepLine).toContain("claude-sonnet-4-6");
  expect(stepLine).not.toContain("anthropic/claude-sonnet-4-6");
  expect(stepLine).toContain("inspecting tests");

  const startLine = formatTaskSubEvent({
    kind: "start",
    role: "architect",
    maxSteps: 8,
    model: "anthropic/claude-sonnet-4-6",
    detail: "review module",
  }).replace(/\x1b\[[0-9;]*m/g, "");
  expect(startLine).toContain("[AGENT]");
  expect(startLine).toContain("▸ ARCHITECT");
  expect(startLine).toContain("claude-sonnet-4-6");
  expect(startLine).not.toContain("anthropic/claude-sonnet-4-6");
  expect(startLine).toContain("review module");
});

test("formatTaskSubEvent resists escape/surrogate-glued Bearer, keeps truncation well-formed, and caps huge detail/summary", () => {
  const glued = formatTaskSubEvent({
    kind: "tool",
    role: "det\x1b[31m\uD800Bearer sk-det-secret",
    detachedId: "det\x1b[31m\uD800Bearer sk-det-secret",
    detail: "det\x1b[31m\uD800Bearer sk-det-secret",
    summary: "det\x1b[31m\uD800Bearer sk-det-secret",
    success: true,
  });
  expect(glued.isWellFormed()).toBe(true);
  expect(glued.toLowerCase()).not.toContain("sk-det-secret");
  expect(glued).not.toContain("\x1b[31m");

  const splitSurrogate = formatTaskSubEvent({
    kind: "tool",
    role: "executor",
    detail: `${"a".repeat(139)}🚀tail`,
    summary: `${"b".repeat(139)}🚀tail`,
    success: true,
  });
  expect(splitSurrogate.isWellFormed()).toBe(true);
  const plainSplit = splitSurrogate.replace(/\x1b\[[0-9;]*m/g, "");
  expect(plainSplit).not.toContain("\uFFFD");

  const huge = formatTaskSubEvent({
    kind: "tool",
    role: "executor",
    detail: "d".repeat(50000),
    summary: "s".repeat(50000),
    success: true,
  });
  const plainHuge = huge.replace(/\x1b\[[0-9;]*m/g, "");
  expect(huge.isWellFormed()).toBe(true);
  expect(plainHuge).toContain("[AGENT]");
  expect(plainHuge).toContain("├─");
  expect(plainHuge).toContain("EXECUTOR");
  expect(plainHuge).toContain("✓");
  expect(plainHuge.length).toBeLessThan(1000);
});

test("end-to-end: a piped one-shot turn prints the per-step flow (not just the final reply)", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return JSON.stringify({ tool: "read", arguments: { filePath: "note.txt" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "read complete" } });
    },
  }));

  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-se-cfg-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-se-work-"));
  await fs.writeFile(path.join(workDir, "note.txt"), "hello from note\n");
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedCwd = process.cwd();
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    process.chdir(workDir);
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["read note.txt then done", "--model", "ollama/qwen2.5:0.5b", "--max-steps", "3", "--no-session", "--no-tui"]);
  } finally {
    console.log = origLog;
    process.chdir(savedCwd);
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR; else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }

  const out = logged.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  // The whole flow is visible: a step header naming the tool target, then its result.
  expect(out).toMatch(/[Rr]ead\s*:?\s*note\.txt/);
  expect(out).toMatch(/\u2713 [Rr]ead\s*:?\s*note\.txt/);
  expect(out).toContain("read complete"); // final reply still printed
});

test("end-to-end: cmd-mode task subagent prints nested steps and result summaries", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return JSON.stringify({ tool: "task", arguments: { role: "executor", task: "inspect note.txt" } });
      if (turn === 2) return JSON.stringify({ tool: "read", arguments: { filePath: "note.txt" } });
      if (turn === 3) return JSON.stringify({ tool: "done", arguments: { reason: "subagent read it\nSummary: read note\nChanged Files: none\nVerification: n/a" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "parent integrated" } });
    },
  }));

  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-se-sub-cfg-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-se-sub-work-"));
  await fs.writeFile(path.join(workDir, "note.txt"), "hello from note\n");
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedCwd = process.cwd();
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    process.chdir(workDir);
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["delegate to a subagent", "--model", "ollama/qwen2.5:0.5b", "--max-steps", "4", "--no-session", "--no-tui"]);
  } finally {
    console.log = origLog;
    process.chdir(savedCwd);
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR; else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }

  const out = logged.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  expect(out).toMatch(/[Tt]ask\s*:?\s*executor/);
  expect(out).toContain("▸ EXECUTOR · inspect note.txt");
  expect(out).toContain("├─ EXECUTOR · read note.txt");
  expect(out).toMatch(/├─ EXECUTOR ✓ read note\.txt — 1[a-z0-9]{2}\|hello from note/);
  expect(out).toContain("└─ EXECUTOR done: subagent read it");
  expect(out).toMatch(/\u2713 [Tt]ask\s*:?\s*executor \u2014 \[Executor subagent\] completed/);
  expect(out).toContain("[AGENT]"); // nested subagent lines carry the category badge
  expect(out).toContain("[STEP]"); // parent step lines carry the progress badge
  expect(out).toContain("[DONE]"); // successful tool results carry the completed badge
  expect(out).toContain("parent integrated");
});

test("end-to-end: a disk-persisted subagent model override is the model the in-loop task tool uses", async () => {
  let turn = 0;
  const subagentModels: (string | undefined)[] = [];
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_msgs: unknown, options: { model?: string } = {}) => {
      turn++;
      // turn 1: parent delegates. turns 2-3: subagent works + done. turn 4: parent done.
      if (turn === 1) return JSON.stringify({ tool: "task", arguments: { role: "executor", task: "inspect note.txt" } });
      if (turn === 2) { subagentModels.push(options.model); return JSON.stringify({ tool: "read", arguments: { filePath: "note.txt" } }); }
      if (turn === 3) { subagentModels.push(options.model); return JSON.stringify({ tool: "done", arguments: { reason: "ok\nSummary: read note\nChanged Files: none\nVerification: n/a" } }); }
      return JSON.stringify({ tool: "done", arguments: { reason: "parent done" } });
    },
  }));

  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-se-ovr-cfg-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-se-ovr-work-"));
  await fs.writeFile(path.join(workDir, "note.txt"), "hello\n");
  // Persist a per-role override so a DIFFERENT provider/model is pinned for executor.
  await fs.writeFile(
    path.join(cfgDir, "config.json"),
    JSON.stringify({ defaultModel: "ollama/qwen2.5:0.5b", subagents: { executor: { model: "anthropic/claude-haiku-4-5" } } }),
  );
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedCwd = process.cwd();
  const origLog = console.log;
  console.log = () => {};
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    process.chdir(workDir);
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["delegate", "--model", "ollama/qwen2.5:0.5b", "--max-steps", "4", "--no-session", "--no-tui"]);
  } finally {
    console.log = origLog;
    process.chdir(savedCwd);
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR; else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }

  // The delegated subagent must run on the pinned override, NOT the parent default.
  expect(subagentModels.length).toBeGreaterThan(0);
  expect(subagentModels.every(m => m === "anthropic/claude-haiku-4-5")).toBe(true);
});


test("end-to-end: one-shot skill alias executes configured skill instead of chatting about it", async () => {
  let seenUser = "";
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (messages: Array<{ role: string; content: string }>) => {
      seenUser = messages.at(-1)?.content ?? "";
      return JSON.stringify({ tool: "done", arguments: { reason: "skill executed" } });
    },
  }));

  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-se-skill-cfg-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-se-skill-work-"));
  await fs.mkdir(path.join(cfgDir, "skills", "spec-kit"), { recursive: true });
  await fs.writeFile(
    path.join(cfgDir, "skills", "spec-kit", "SKILL.md"),
    "summary: SDD wrapper\naliases: /speckit.plan\n\nPlan with spec-kit.",
  );
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedCwd = process.cwd();
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    process.chdir(workDir);
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["$spec-kit improve jeo", "--model", "ollama/qwen2.5:0.5b", "--no-session", "--no-tui"]);
  } finally {
    console.log = origLog;
    process.chdir(savedCwd);
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR; else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }

  const out = logged.join("\n");
  expect(seenUser).toContain('You are now executing the "spec-kit"');
  expect(seenUser).toContain("Invoked as: $spec-kit");
  expect(seenUser).toContain("User intent: improve jeo");
  expect(out).toContain("▶ Running skill: spec-kit — improve jeo");
  expect(out).toContain("skill executed");
});

test("formatTaskSubEvent redacts Bearer and key=val secrets split by embedded ANSI/CSI escapes", () => {
  const line = formatTaskSubEvent({
    kind: "tool",
    role: "executor",
    detail: "Be\x1b[31marer sk-secret-123",
    summary: "api_\x1b[31mkey=topsecret99",
    success: true,
  });
  expect(line).not.toContain("sk-secret-123");
  expect(line).not.toContain("topsecret99");
  expect(line).not.toContain("\x1b[31m");
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  expect(plain).toContain("Bearer <redacted>");
  expect(plain).toContain("api_key=<redacted>");
});

test("formatTaskSubEvent completely redacts split-escape Authorization Bearer/Basic and OSC-split token=val while preserving surrogate/escape-glued Bearer redaction", () => {
  const splitLine = formatTaskSubEvent({
    role: "executor",
    kind: "tool",
    detail: "Authorization: Be\x1b[31marer sk-live-999",
    summary: "token=sec\x1b]0;a b\x07ret",
  });
  expect(splitLine.isWellFormed()).toBe(true);
  expect(splitLine).not.toContain("\x1b[31m");
  expect(splitLine).not.toContain("\x1b]");
  expect(splitLine).not.toContain("\x07");
  const splitPlain = splitLine.replace(/\x1b\[[0-9;]*m/g, "");
  expect(splitPlain).not.toContain("sk-live-999");
  expect(splitPlain).not.toContain("bret");
  expect(splitPlain).not.toContain("sec");
  expect(splitPlain).not.toContain("ret");
  expect(splitPlain).not.toContain("\x1b");
  expect(splitPlain).toContain("<redacted>");

  const basicAndGluedLine = formatTaskSubEvent({
    role: "executor",
    kind: "tool",
    detail: "Authorization: Ba\x1b[31msic dXNlcjpwYXNz",
    summary: "det\x1b[31m\uD800Bearer sk-det-secret det\x1b[31mBearer sk-secret-123",
  });
  expect(basicAndGluedLine.isWellFormed()).toBe(true);
  expect(basicAndGluedLine).not.toContain("\x1b[31m");
  const basicPlain = basicAndGluedLine.replace(/\x1b\[[0-9;]*m/g, "");
  expect(basicPlain).not.toContain("dXNlcjpwYXNz");
  expect(basicPlain).not.toContain("sk-det-secret");
  expect(basicPlain).not.toContain("sk-secret-123");
  expect(basicPlain).not.toContain("\x1b");
  expect(basicPlain).toContain("<redacted>");
});

test("createStreamEvents.onToolResult sanitizes escapes and redacts secrets in tool output", () => {
  const logs: string[] = [];
  const events = createStreamEvents(5, l => logs.push(l));
  events.onToolResult(
    "task",
    true,
    "Authorization: \x1b[31mBearer\x1b[0m sk_live_secret123456\x1b]2;pwned\x07",
  );
  expect(logs.length).toBe(1);
  const raw = logs[0]!;
  expect(raw).not.toContain("sk_live_secret123456");
  expect(raw).not.toContain("\x1b]2;pwned\x07");
  expect(raw).not.toContain("\x1b]");
  expect(raw).not.toContain("\x07");
  expect(raw).not.toContain("pwned");
  const plain = raw.replace(/\x1b\[[0-9;]*m/g, "");
  expect(plain).not.toContain("\x1b");
  expect(plain).toContain("Authorization: Bearer <redacted>");
});
