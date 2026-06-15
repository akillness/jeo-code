import { test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const realReadline = { ...(await import("node:readline/promises")) };
let mockQuestions: string[] = [];
let mockIndex = 0;

mock.module("node:readline/promises", () => ({
  createInterface: () => ({
    question: mock(async () => mockQuestions[mockIndex++] ?? "/exit"),
    close: mock(() => {}),
    on: mock(() => {}),
    pause: mock(() => {}),
    resume: mock(() => {}),
  })
}));

let originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  mockQuestions = [];
  mockIndex = 0;
});

afterEach(() => {
  process.stdin.isTTY = originalIsTTY;
});

afterAll(() => {
  mock.module("node:readline/promises", () => realReadline);
});

test("/model subagent <role> <model> persists the role model override", async () => {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-role-model-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedLog = console.log;
  console.log = () => {};
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    mockQuestions = ["/model subagent planner gpt-4o", "/exit"];
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session"]);
    const raw = JSON.parse(await fs.readFile(path.join(cfgDir, "config.json"), "utf8"));
    expect(raw.subagents?.planner?.model).toBe("gpt-4o");
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
});

test("/model sets only the DEFAULT thinking; role thinking is owned by /agents", async () => {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-role-thinking-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedLog = console.log;
  console.log = () => {};
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    // `/model thinking` sets the default; `/model subagent … thinking` is redirected
    // to /agents and must NOT persist; `/agents … thinking` is the path that does.
    mockQuestions = [
      "/model thinking high",
      "/model subagent planner thinking xhigh",
      "/agents planner thinking medium",
      "/exit",
    ];
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session"]);
    const raw = JSON.parse(await fs.readFile(path.join(cfgDir, "config.json"), "utf8"));
    expect(raw.thinkingLevel).toBe("high");                 // /model owns the default thinking
    expect(raw.subagents?.planner?.thinking).toBe("medium"); // set by /agents, NOT the ignored /model xhigh
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
});

test("antigravity stays selectable in /model with a gemini-fallback OAuth (warned, not refused)", async () => {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-role-ag-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedLog = console.log;
  const logged: string[] = [];
  console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    await fs.writeFile(
      path.join(cfgDir, "config.json"),
      JSON.stringify({
        defaultModel: "ollama/qwen2.5:0.5b",
        oauth: { gemini: { access: "oauth-gem", refresh: "r", expires: Date.now() + 3_600_000, projectId: "proj-1" } },
      }),
    );
    mockQuestions = [
      "/model antigravity/gemini-3-pro-high",
      "/model subagent executor antigravity/claude-sonnet-4-5",
      "/exit",
    ];
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session"]);
    const out = logged.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    // Selection is ALLOWED (session model set), with a not-ready warning instead of a refusal.
    expect(out).toContain("Model set to: antigravity/gemini-3-pro-high");
    expect(out).not.toContain("Cannot select antigravity");
    expect(out).toContain("antigravity is not ready");
    // Role pinning through /model subagent also works with an antigravity id.
    const raw = JSON.parse(await fs.readFile(path.join(cfgDir, "config.json"), "utf8"));
    expect(raw.subagents?.executor?.model).toBe("antigravity/claude-sonnet-4-5");
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
});

test("/fast toggles the session thinking level for fast-capable models", async () => {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-fast-mode-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedLog = console.log;
  const logged: string[] = [];
  console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    await fs.writeFile(
      path.join(cfgDir, "config.json"),
      JSON.stringify({ defaultModel: "gpt-5.5", thinkingLevel: "high" }),
    );
    mockQuestions = ["/fast status", "/fast on", "/thinking", "/fast off", "/thinking", "/exit"];
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session"]);
    const out = logged.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain("Fast mode: off · supported (thinking minimal)");
    expect(out).toContain("Fast mode on:");
    expect(out).toContain("Thinking level: minimal");
    expect(out).toContain("Fast mode off: restored thinking high");
    expect(out).toContain("Thinking level: high");
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
});

test("/fast rejects models without advertised fast thinking", async () => {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-fast-mode-unsupported-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedLog = console.log;
  const logged: string[] = [];
  console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    await fs.writeFile(
      path.join(cfgDir, "config.json"),
      JSON.stringify({ defaultModel: "gpt-4o", thinkingLevel: "medium" }),
    );
    mockQuestions = ["/fast on", "/exit"];
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session"]);
    const out = logged.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain("Fast mode is not advertised");
    expect(out).toContain("pick a thinking-capable model with /model");
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
});

// Characterization tests pinning the /agents command-handler branches BEFORE any
// extraction of that ~190-line handler out of runLaunchCommand (behavior-freeze-first).
test("characterization: /agents <role> maxSteps + thinking persist (handler branches)", async () => {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-agents-char-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedLog = console.log;
  console.log = () => {};
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    mockQuestions = ["/agents executor maxSteps 20", "/agents executor thinking high", "/exit"];
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session"]);
    const raw = JSON.parse(await fs.readFile(path.join(cfgDir, "config.json"), "utf8"));
    expect(raw.subagents?.executor?.maxSteps).toBe(20);
    expect(raw.subagents?.executor?.thinking).toBe("high");
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
});

test("characterization: /agents <role> reset clears that role's overrides (handler branch)", async () => {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-agents-reset-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedLog = console.log;
  console.log = () => {};
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    mockQuestions = ["/agents architect thinking xhigh", "/agents architect maxSteps 30", "/agents architect reset", "/exit"];
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session"]);
    const raw = JSON.parse(await fs.readFile(path.join(cfgDir, "config.json"), "utf8"));
    expect(raw.subagents?.architect?.thinking ?? undefined).toBeUndefined();
    expect(raw.subagents?.architect?.maxSteps ?? undefined).toBeUndefined();
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
});
