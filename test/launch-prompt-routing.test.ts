import { test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { resetPromptRouterWarnings } from "../src/agent/prompt-router";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Proves the PromptRouter → launch.ts `runTurn` wiring end-to-end:
// 1. Explicit /model (sessionModel) ALWAYS wins — routing never engages even
//    when `routing.enabled: true`, per the design doc's non-negotiable #2.
// 2. With routing enabled and no sessionModel, a trivial-classified prompt
//    resolves `activeModel` to `roles.smol` (zero new config beyond `roles`).
// Mirrors test/session-model-isolation.test.ts's established convention:
// mock.module + a top-level dynamic re-import so the SUT picks up the mocked
// `runAgentLoop` binding (module-mock boundary — static import cannot work
// here since launch.ts must resolve `../agent/engine` to the mocked module).
const realReadline = { ...(await import("node:readline/promises")) };
const realEngine = { ...(await import("../src/agent/engine")) };

let mockQuestions: string[] = [];
let mockIndex = 0;
let capturedCalls: { model?: string; maxTokens?: number; reasoningEffort?: string; sessionKey?: string }[] = [];

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
  ...realEngine,
  runAgentLoop: mock(async (_history: unknown, opts: { model?: string; maxTokens?: number; reasoningEffort?: string; sessionKey?: string }) => {
    capturedCalls.push({ model: opts.model, maxTokens: opts.maxTokens, reasoningEffort: opts.reasoningEffort, sessionKey: opts.sessionKey });
    return { done: true, steps: 1, doneReason: "ok" };
  }),
}));

let originalIsTTY: boolean | undefined;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  mockQuestions = [];
  mockIndex = 0;
  capturedCalls = [];
  resetPromptRouterWarnings();
});

afterEach(() => {
  process.stdin.isTTY = originalIsTTY as boolean;
});

afterAll(() => {
  mock.module("node:readline/promises", () => realReadline);
  mock.module("../src/agent/engine", () => realEngine);
});

// Runs one launch turn against a temp config dir, returns every runAgentLoop
// invocation's captured (model, maxTokens, reasoningEffort).
async function runOneTurn(
  config: Record<string, unknown>,
  prompt: string,
  extraArgs: string[] = [],
): Promise<{ model?: string; maxTokens?: number; reasoningEffort?: string; sessionKey?: string }[]> {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-prompt-routing-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedLog = console.log;
  console.log = () => {};
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify(config));
    mockQuestions = [prompt, "/exit"];

    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session", ...extraArgs]);

    return capturedCalls;
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
}

// Same as `runOneTurn` but also returns captured `console.log` lines — needed to
// assert on the credential-veto notice text, which `runOneTurn` deliberately
// discards (silences console.log entirely) to keep unrelated test output quiet.
// `prompt` accepts a single string or multiple sequential prompts (e.g. a real
// prompt followed by a slash command like "/route why") within ONE session.
async function runOneTurnWithLogs(
  config: Record<string, unknown>,
  prompt: string | string[],
  extraArgs: string[] = [],
): Promise<{ calls: typeof capturedCalls; logs: string[] }> {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-prompt-routing-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify(config));
    mockQuestions = [...(Array.isArray(prompt) ? prompt : [prompt]), "/exit"];

    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session", ...extraArgs]);

    return { calls: capturedCalls, logs };
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
}

test("explicit /model pin always wins: routing never overrides an explicit --model even with routing.enabled", async () => {
  const calls = await runOneTurn(
    {
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      routing: { enabled: true },
    },
    "what is this?", // would classify as trivial -> smol if routing engaged
    ["--model", "claude-sonnet-4-6"],
  );
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0].model).toBe("claude-sonnet-4-6");
});

test("routing enabled + no sessionModel: a trivial-classified prompt resolves activeModel to roles.smol", async () => {
  const calls = await runOneTurn(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      routing: { enabled: true },
    },
    "what is this?", // short factual question -> trivial, confidence 0.85 (no escalation)
  );
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0].model).toBe("claude-haiku-4-5");
});

test("routing disabled (default): an unpinned session keeps resolving to defaultModel regardless of prompt content", async () => {
  const calls = await runOneTurn(
    {
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      // no `routing` key at all -> off by default
    },
    "what is this?",
  );
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0].model).toBe("claude-sonnet-4-6");
});

test("routing.tiers.trivial.thinking overrides the session thinking level when routing engages", async () => {
  const calls = await runOneTurn(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      routing: { enabled: true, tiers: { trivial: { thinking: "low" } } },
    },
    "what is this?",
  );
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[0].model).toBe("claude-haiku-4-5");
  expect(calls[0].reasoningEffort).toBeDefined();
});

// --- sessionKey cache-scoping (design doc §7 risk #4) ---
// A real session (no `--no-session`) is required here since the derived key is
// `${sessionId}:${activeModel}` — `--no-session` leaves sessionId undefined and the
// derivation short-circuits to `undefined` (see launch.ts's turnSessionKey guard, tested
// separately as a pure-function unit test in test/prompt-router.test.ts). `process.chdir`
// isolates session file writes (`.jeo/sessions/`) to a throwaway work dir, mirroring
// test/stream-events.test.ts's established convention for real-session launch tests.
async function runTurnsInOneSession(
  config: Record<string, unknown>,
  prompts: string[],
): Promise<{ model?: string; maxTokens?: number; reasoningEffort?: string; sessionKey?: string }[]> {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-prompt-routing-cfg-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-prompt-routing-work-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedCwd = process.cwd();
  const savedLog = console.log;
  console.log = () => {};
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify(config));
    process.chdir(workDir);
    mockQuestions = [...prompts, "/exit"];

    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui"]); // real session: sessionId persists across all turns below

    return capturedCalls;
  } finally {
    console.log = savedLog;
    process.chdir(savedCwd);
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

test("sessionKey: two turns routed to the SAME model within one session produce the SAME derived key (cache reuse preserved)", async () => {
  const calls = await runTurnsInOneSession(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      routing: { enabled: true },
    },
    ["what is this?", "where is the config file located?"], // both trivial -> both route to roles.smol
  );
  expect(calls.length).toBe(2);
  expect(calls[0].model).toBe("claude-haiku-4-5");
  expect(calls[1].model).toBe("claude-haiku-4-5");
  expect(calls[0].sessionKey).toBeDefined();
  expect(calls[0].sessionKey).toBe(calls[1].sessionKey);
});

test("sessionKey: two turns routed to DIFFERENT models within one session produce DIFFERENT derived keys (no false cache hit across models)", async () => {
  const calls = await runTurnsInOneSession(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      routing: { enabled: true },
    },
    [
      "what is this?", // trivial, 0.85 confidence -> roles.smol
      "Can you investigate and diagnose the root cause across src/agent/loop.ts and src/agent/engine.ts?", // complex, 0.85 confidence -> roles.slow unset -> defaultModel
    ],
  );
  expect(calls.length).toBe(2);
  expect(calls[0].model).toBe("claude-haiku-4-5");
  expect(calls[1].model).toBe("claude-sonnet-4-6");
  expect(calls[0].sessionKey).toBeDefined();
  expect(calls[1].sessionKey).toBeDefined();
  expect(calls[0].sessionKey).not.toBe(calls[1].sessionKey);
  // Both keys still share the same session lineage (same sessionId prefix) — only the
  // model suffix differs, proving the key is session-AND-model-scoped, not model-only.
  const sessionPrefix = (calls[0].sessionKey as string).split(":")[0];
  expect((calls[1].sessionKey as string).split(":")[0]).toBe(sessionPrefix);
});

// --- credential-readiness gate (routing must never make a turn WORSE than
// routing being off — a routed tier's model can be configured without its
// provider ever having a usable credential) ---

test("credential gate: routed tier resolves to a provider with NO credential -> falls back to defaultModel (whose provider IS credentialed)", async () => {
  const { calls } = await runOneTurnWithLogs({
    providers: { anthropic: "test-anthropic-key" }, // defaultModel's provider: credentialed
    defaultModel: "claude-sonnet-4-6",
    roles: { smol: "gpt-4o-mini" }, // openai: NOT credentialed anywhere in this config
    routing: { enabled: true },
  }, "what is this?"); // trivial, 0.85 confidence -> would route to roles.smol (gpt-4o-mini)
  expect(calls.length).toBeGreaterThan(0);
  // Without the gate this would be "gpt-4o-mini" and the real call would fail with
  // "No credential for provider 'openai'" — the gate must prevent dispatch to it.
  expect(calls[0].model).toBe("claude-sonnet-4-6");
});

test("credential gate: veto notice explains what happened and how to fix it", async () => {
  const { logs } = await runOneTurnWithLogs({
    providers: { anthropic: "test-anthropic-key" },
    defaultModel: "claude-sonnet-4-6",
    roles: { smol: "gpt-4o-mini" },
    routing: { enabled: true },
  }, "what is this?");
  const noticeLine = logs.find(l => l.includes("[route]") && l.includes("no usable credential"));
  expect(noticeLine).toBeDefined();
  expect(noticeLine).toContain("gpt-4o-mini");
  expect(noticeLine).toContain("openai");
  expect(noticeLine).toContain("jeo auth login openai");
});

test("credential gate: does not fire when the routed provider IS credentialed (no false positives)", async () => {
  const { calls, logs } = await runOneTurnWithLogs({
    providers: { anthropic: "test-anthropic-key" },
    defaultModel: "claude-sonnet-4-6",
    roles: { smol: "claude-haiku-4-5" }, // same (credentialed) provider as defaultModel
    routing: { enabled: true },
  }, "what is this?");
  expect(calls[0].model).toBe("claude-haiku-4-5"); // routing engaged normally
  expect(logs.some(l => l.includes("no usable credential"))).toBe(false);
});

test("credential gate: warnOnce suppresses the notice on a second turn hitting the SAME unready provider, but the veto still applies every turn", async () => {
  const config = {
    providers: { anthropic: "test-anthropic-key" },
    defaultModel: "claude-sonnet-4-6",
    roles: { smol: "gpt-4o-mini" },
    routing: { enabled: true },
  };
  const first = await runOneTurnWithLogs(config, "what is this?");
  expect(first.calls[0].model).toBe("claude-sonnet-4-6"); // veto applied
  expect(first.logs.some(l => l.includes("no usable credential"))).toBe(true); // notice fired

  const second = await runOneTurnWithLogs(config, "what is that?");
  expect(second.calls[0].model).toBe("claude-sonnet-4-6"); // veto STILL applied
  expect(second.logs.some(l => l.includes("no usable credential"))).toBe(false); // notice suppressed (warnOnce)
});

test("credential gate: /route why after a veto explains the fallback, not a phantom routed decision", async () => {
  const { logs } = await runOneTurnWithLogs({
    providers: { anthropic: "test-anthropic-key" },
    defaultModel: "claude-sonnet-4-6",
    roles: { smol: "gpt-4o-mini" },
    routing: { enabled: true },
  }, ["what is this?", "/route why"]);
  const whyLine = logs.find(l => l.includes("fell back to"));
  expect(whyLine).toBeDefined();
  expect(whyLine).toContain("gpt-4o-mini");
  expect(whyLine).toContain("claude-sonnet-4-6"); // names the fallback that was actually used
});
