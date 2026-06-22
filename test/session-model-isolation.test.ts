import { test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Proves the cross-session model-isolation guarantee:
// "각 세션별 모델설정 시 동작중인 세션 간 영향 없어야 함" — a concurrent jeo
// session running `/model` persists the GLOBAL defaultModel, but that write must
// NOT silently switch a different, already-running session's model. An unpinned
// running session is frozen to the default it resolved at startup and passes that
// concrete id into the agent loop, never the live global default.

const realReadline = { ...(await import("node:readline/promises")) };
const realEngine = { ...(await import("../src/agent/engine")) };

let mockQuestions: string[] = [];
let mockIndex = 0;
let capturedModels: (string | undefined)[] = [];
let onFirstQuestion: (() => Promise<void>) | undefined;

mock.module("node:readline/promises", () => ({
  createInterface: () => ({
    question: mock(async () => {
      // On the FIRST prompt, simulate a CONCURRENT session persisting a different
      // global default BEFORE this session runs its turn.
      if (mockIndex === 0 && onFirstQuestion) await onFirstQuestion();
      return mockQuestions[mockIndex++] ?? "/exit";
    }),
    close: mock(() => {}),
    on: mock(() => {}),
    pause: mock(() => {}),
    resume: mock(() => {}),
  }),
}));

mock.module("../src/agent/engine", () => ({
  ...realEngine,
  runAgentLoop: mock(async (_history: unknown, opts: { model?: string }) => {
    capturedModels.push(opts.model);
    return { done: true, steps: 1, doneReason: "ok" };
  }),
}));

let originalIsTTY: boolean | undefined;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  mockQuestions = [];
  mockIndex = 0;
  capturedModels = [];
  onFirstQuestion = undefined;
});

afterEach(() => {
  process.stdin.isTTY = originalIsTTY as boolean;
});

afterAll(() => {
  mock.module("node:readline/promises", () => realReadline);
  mock.module("../src/agent/engine", () => realEngine);
});

// Runs one launch turn whose startup global default is gpt-4o-mini, while a
// concurrent session rewrites that global to gpt-4o mid-turn. Returns the model
// the agent loop was actually invoked with.
async function modelPassedToLoop(extraArgs: string[]): Promise<string | undefined> {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-session-iso-"));
  const cfgPath = path.join(cfgDir, "config.json");
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedLog = console.log;
  console.log = () => {};
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    await fs.writeFile(cfgPath, JSON.stringify({ defaultModel: "gpt-4o-mini" }));
    onFirstQuestion = () => fs.writeFile(cfgPath, JSON.stringify({ defaultModel: "gpt-4o" }));
    mockQuestions = ["hello there", "/exit"];

    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session", ...extraArgs]);

    expect(capturedModels.length).toBeGreaterThan(0);
    return capturedModels[0];
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
}

test("an unpinned running session ignores a concurrent session's global /model write", async () => {
  // Frozen to the startup default — NOT the concurrently-written gpt-4o, and NOT
  // undefined (which would let the manager resolve the live global default).
  expect(await modelPassedToLoop([])).toBe("gpt-4o-mini");
});

test("a --model pinned session passes its explicit pin to the loop", async () => {
  expect(await modelPassedToLoop(["--model", "claude-3-5-haiku"])).toBe("claude-3-5-haiku");
});
