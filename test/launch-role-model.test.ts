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
  const savedCfg = process.env.JOC_CONFIG_DIR;
  const savedLog = console.log;
  console.log = () => {};
  try {
    process.env.JOC_CONFIG_DIR = cfgDir;
    mockQuestions = ["/model subagent planner gpt-4o", "/exit"];
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session"]);
    const raw = JSON.parse(await fs.readFile(path.join(cfgDir, "config.json"), "utf8"));
    expect(raw.subagents?.planner?.model).toBe("gpt-4o");
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JOC_CONFIG_DIR;
    else process.env.JOC_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
});

test("antigravity stays selectable in /model with a gemini-fallback OAuth (warned, not refused)", async () => {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-role-ag-"));
  const savedCfg = process.env.JOC_CONFIG_DIR;
  const savedLog = console.log;
  const logged: string[] = [];
  console.log = (...a: unknown[]) => { logged.push(a.join(" ")); };
  try {
    process.env.JOC_CONFIG_DIR = cfgDir;
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
    if (savedCfg === undefined) delete process.env.JOC_CONFIG_DIR;
    else process.env.JOC_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
});
