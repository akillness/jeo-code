import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as realReadline from "node:readline/promises";
import * as realEngine from "../src/agent/engine";
import { createSession, newSessionId } from "../src/agent/session";

// Launch-level contract: an explicit model pin wins over the saved session model,
// which wins over the authenticated startup default. Config remains unchanged.

const originalReadline = { ...realReadline };
const originalEngine = { ...realEngine };

let mockQuestions: string[] = [];
let mockIndex = 0;
let capturedModels: (string | undefined)[] = [];

mock.module("node:readline/promises", () => ({
  createInterface: () => ({
    question: mock(async () => mockQuestions[mockIndex++] ?? "/exit"),
    close: mock(() => {}),
    on: mock(() => {}),
    pause: mock(() => {}),
    resume: mock(() => {}),
  }),
}));

mock.module("../src/agent/engine", () => ({
  ...originalEngine,
  runAgentLoop: mock(async (_history: unknown, opts: { model?: string }) => {
    capturedModels.push(opts.model);
    return { done: true, steps: 1, doneReason: "ok" };
  }),
}));

afterAll(() => {
  mock.module("node:readline/promises", () => originalReadline);
  mock.module("../src/agent/engine", () => originalEngine);
});

// The scenarios must not be rescued by credentials present in the host environment.
const CLEARED_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "GEMINI_API_KEY", "XAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_OAUTH_TOKEN", "GEMINI_OAUTH_TOKEN", "JEO_DEFAULT_MODEL", "JEO_SESSION_DIR", "JEO_CONFIG_DIR"];
const savedEnv: Record<string, string | undefined> = {};
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  for (const key of CLEARED_ENV) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  mockQuestions = ["hello there", "/exit"];
  mockIndex = 0;
  capturedModels = [];
});

afterEach(() => {
  process.stdin.isTTY = originalIsTTY as boolean;
  for (const key of CLEARED_ENV) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
});

const oauth = { access: "tok", refresh: "r", expires: Date.now() + 3_600_000 };

async function launchedModel(config: Record<string, unknown>, extraArgs: string[], setup?: (dir: string) => Promise<void>): Promise<{ model: string | undefined; savedDefault: unknown }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-session-model-"));
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    process.env.JEO_CONFIG_DIR = dir;
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(config));
    await setup?.(dir);
    // Dynamic import is required here: mock.module() above must be registered before the module
    // under test loads, and a static import would be hoisted ahead of it.
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", ...extraArgs]);
    expect(capturedModels.length).toBeGreaterThan(0);
    const saved = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")) as { defaultModel?: unknown };
    return { model: capturedModels[0], savedDefault: saved.defaultModel };
  } finally {
    console.log = log;
    console.error = err;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("a default the login serves is what the session opens on", async () => {
  const { model } = await launchedModel(
    { defaultModel: "claude-haiku-5-5", providers: { anthropic: "sk-ant" }, recentModels: ["claude-haiku-5-5", "antigravity/gemini-3.8-flash-tiered"], oauth: { antigravity: oauth } },
    ["--no-session"],
  );
  expect(model).toBe("claude-haiku-5-5");
});

test("a default with no usable login opens on an authenticated model and leaves the saved default alone", async () => {
  const { model, savedDefault } = await launchedModel(
    { defaultModel: "claude-haiku-5-5", oauth: { antigravity: oauth }, recentModels: ["claude-haiku-5-5", "antigravity/gemini-3.8-flash-tiered"] },
    ["--no-session"],
  );
  expect(model).toBe("antigravity/gemini-3.8-flash-tiered");
  expect(savedDefault).toBe("claude-haiku-5-5");
});

test("an explicit --model pin still wins over the default and the login fallback", async () => {
  const { model } = await launchedModel(
    { defaultModel: "claude-haiku-5-5", oauth: { antigravity: oauth }, recentModels: ["antigravity/gemini-3.8-flash-tiered"] },
    ["--no-session", "--model", "claude-3-5-haiku"],
  );
  expect(model).toBe("claude-3-5-haiku");
});

test("a resumed session restores the model saved in its header", async () => {
  const id = newSessionId();
  const { model } = await launchedModel(
    { defaultModel: "claude-haiku-5-5", providers: { anthropic: "sk-ant" } },
    ["--resume", id],
    async dir => {
      const sessions = path.join(dir, "sessions");
      process.env.JEO_SESSION_DIR = sessions;
      await createSession(dir, id, "gpt-4o", sessions);
    },
  );
  expect(model).toBe("gpt-4o");
});

test("an explicit model pin overrides a resumed session's saved model", async () => {
  const id = newSessionId();
  const { model } = await launchedModel(
    { defaultModel: "claude-haiku-5-5", providers: { anthropic: "sk-ant" } },
    ["--resume", id, "--model", "claude-3-5-haiku"],
    async dir => {
      const sessions = path.join(dir, "sessions");
      process.env.JEO_SESSION_DIR = sessions;
      await createSession(dir, id, "gpt-4o", sessions);
    },
  );
  expect(model).toBe("claude-3-5-haiku");
});

test("a resumed session without a saved model uses the authenticated startup default", async () => {
  const id = newSessionId();
  const { model } = await launchedModel(
    { defaultModel: "claude-haiku-5-5", providers: { anthropic: "sk-ant" } },
    ["--resume", id],
    async dir => {
      const sessions = path.join(dir, "sessions");
      process.env.JEO_SESSION_DIR = sessions;
      await createSession(dir, id, undefined, sessions);
    },
  );
  expect(model).toBe("claude-haiku-5-5");
});
