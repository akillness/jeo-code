import { test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { resetPromptRouterWarnings, credentialScopeFor } from "../src/agent/prompt-router";
import { OPENAI_COMPAT_PROVIDERS } from "../src/ai/providers/openai-compatible-catalog";
import { recordLiveProviderModels, resetLiveProviderModels } from "../src/ai/model-catalog";
import type { AgentLoopOptions, AgentLoopResult } from "../src/agent/engine";
import { ProviderStreamError } from "../src/ai/providers/errors";
import { friendlyProviderError } from "../src/util/provider-error";
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
const realApp = { ...(await import("../src/tui/app")) };
const realAI = { ...(await import("../src/ai")) };

// Captures the `routedTier` field passed into EVERY `LaunchTui` construction across
// a real multi-turn session — the only way to prove the status-bar exposure (added
// v0.7.52, `StatusBarData.routedTier`) actually tracks PromptRouter's per-turn decision
// as it changes turn-to-turn, rather than trusting the isolated single-construction
// unit tests in test/tui-app.test.ts (which never exercise launch.ts's real `runTurn`
// wiring) or the `--no-tui` tests above (which never construct a `LaunchTui` at all).
// `write`/`tty` are forced so the real renderer/spinner never touch the real terminal;
// `tui.finish()` (called by the real `runTurn` on every completed turn) still clears
// its own interval timer normally — same as production.
let capturedRoutedTiers: (string | undefined)[] = [];
mock.module("../src/tui/app", () => ({
  ...realApp,
  LaunchTui: class extends realApp.LaunchTui {
    constructor(opts: ConstructorParameters<typeof realApp.LaunchTui>[0]) {
      capturedRoutedTiers.push(opts.routedTier);
      super({ ...opts, write: () => {}, tty: true });
    }
  },
}));


let mockQuestions: string[] = [];
let mockIndex = 0;
let capturedCalls: { model?: string; maxTokens?: number; reasoningEffort?: string; sessionKey?: string }[] = [];
let runAgentLoopDelegate: (history: unknown, opts: AgentLoopOptions) => Promise<AgentLoopResult> = async () => ({ done: true, steps: 1, doneReason: "ok" });
// Rate-limit fast-fallback (opts.rateLimitFallbackAvailable): one entry per
// runAgentLoop call, the predicate's return value at CALL TIME (undefined when
// the caller never wired the predicate — must never happen for a routed/pinned
// call in launch.ts's runTurn, but distinguishes "false" from "not wired" for a
// defensive assertion).
let capturedRateLimitAvailability: (boolean | undefined)[] = [];
// Same shape as capturedRateLimitAvailability above, for safetyFallbackAvailable
// (v0.8.24: the safety-boundary automatic model fallback — see engine.ts's
// AgentLoopOptions doc comment).
let capturedSafetyFallbackAvailability: (boolean | undefined)[] = [];

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
  runAgentLoop: mock(async (history: unknown, opts: AgentLoopOptions) => {
    capturedCalls.push({ model: opts.model, maxTokens: opts.maxTokens, reasoningEffort: opts.reasoningEffort, sessionKey: opts.sessionKey });
    capturedRateLimitAvailability.push(opts.rateLimitFallbackAvailable?.());
    capturedSafetyFallbackAvailability.push(opts.safetyFallbackAvailable?.());
    return runAgentLoopDelegate(history, opts);
  }),
}));

// Interactive-mode tests below (`runOneTurn`/`runOneTurnWithLogs` never pass `-p`, so
// `isOneShot` is false — see launch.ts) trigger an UNAWAITED `void getLiveModels()`
// background warm at REPL startup, which otherwise makes REAL network calls to every
// credentialed provider (anthropic/openai test keys here) that RACE this file's
// synchronous assertions — the source of prior flakiness (unexpected fallback picks
// like "antigravity/gemini-3.1-pro-low" appearing only when run as part of the FULL
// suite, where a slow/failed real fetch could still be in flight when a later test's
// assertions ran). Mocking discoverModels to resolve instantly with nothing makes
// every test in this file deterministic regardless of run order or network state.
mock.module("../src/ai", () => ({
  ...realAI,
  discoverModels: mock(async () => []),
}));

let originalIsTTY: boolean | undefined;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  mockQuestions = [];
  mockIndex = 0;
  capturedCalls = [];
  capturedRateLimitAvailability = [];
  capturedSafetyFallbackAvailability = [];
  capturedRoutedTiers = [];
  runAgentLoopDelegate = async () => ({ done: true, steps: 1, doneReason: "ok" });
  resetPromptRouterWarnings();
  resetLiveProviderModels();
});


afterEach(() => {
  process.stdin.isTTY = originalIsTTY as boolean;
});

afterAll(() => {
  mock.module("node:readline/promises", () => realReadline);
  mock.module("../src/agent/engine", () => realEngine);
  mock.module("../src/tui/app", () => realApp);
  mock.module("../src/ai", () => realAI);
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
// Same as `runTurnsInOneSession`, but forces `process.stdout.isTTY = true` and does NOT
// pass `--no-tui` — `LaunchTui.usable(noTui)` is `isTTY() && !noTui`, so this is the ONLY
// way to actually exercise `useTui = true` in `runLaunchCommand` and get `runTurn` to
// construct a real (mocked-write) `LaunchTui` per turn, which is what `capturedRoutedTiers`
// (populated by the `../src/tui/app` mock above) observes.
async function runTurnsInOneSessionWithTui(
  config: Record<string, unknown>,
  prompts: string[],
): Promise<{ model?: string; sessionKey?: string }[]> {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-prompt-routing-tui-cfg-"));
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-prompt-routing-tui-work-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedCwd = process.cwd();
  const savedLog = console.log;
  const savedStdoutIsTTY = process.stdout.isTTY;
  const savedStdoutWrite = process.stdout.write;
  console.log = () => {};
  try {
    // Real `useTui = true` also engages the REPL's own boxed-input-prompt renderer
    // (a separate direct-stdout path from `LaunchTui`, which only owns the per-turn
    // model bar/frame) — override `process.stdout.write` to cut most of the raw ANSI
    // escapes that path would otherwise dump into the runner's own terminal/log. Some
    // setup writes still slip through a reference captured before this override runs;
    // harmless either way (never asserted on), just cosmetic test-output noise.

    (process.stdout as unknown as { write: typeof process.stdout.write }).write = (() => true) as typeof process.stdout.write;
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;

    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    process.env.JEO_CONFIG_DIR = cfgDir;
    await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify(config));
    process.chdir(workDir);
    mockQuestions = [...prompts, "/exit"];

    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand([]); // no --no-tui: real session AND real (mocked-write) TUI per turn

    return capturedCalls;
  } finally {
    console.log = savedLog;
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = savedStdoutWrite;
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = savedStdoutIsTTY;

    process.chdir(savedCwd);
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// --- TUI model exposure (design doc v0.7.52: a persistent ⚡tier marker in the status
// bar, unconditional whenever routing actually chose THIS turn's model) — proves the
// exposure actually tracks PromptRouter's decision turn-to-turn in the REAL runTurn/
// LaunchTui wiring, not just an isolated single-construction render test. ---

test("TUI exposure: routedTier is surfaced per-turn and tracks the routed tier as it changes turn-to-turn", async () => {
  const calls = await runTurnsInOneSessionWithTui(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5", slow: "claude-opus-4-6" },
      routing: { enabled: true },
    },
    [
      "what is this?", // trivial, 0.85 confidence -> roles.smol
      "Can you investigate and diagnose the root cause across src/agent/loop.ts and src/agent/engine.ts?", // complex, 0.85 confidence -> roles.slow
    ],
  );
  expect(calls.length).toBe(2);
  expect(calls[0].model).toBe("claude-haiku-4-5");
  expect(calls[1].model).toBe("claude-opus-4-6");
  // Two real LaunchTui constructions (one per turn) — the exposed tier changed
  // from turn 1 to turn 2, tracking the actual routed decision each time.
  expect(capturedRoutedTiers).toEqual(["trivial", "complex"]);
});

test("TUI exposure: routedTier clears (is omitted) the instant a later turn stops routing — no stale marker leaks across turns", async () => {
  const calls = await runTurnsInOneSessionWithTui(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5", slow: "claude-opus-4-6" },
      routing: { enabled: true },
    },
    [
      "Can you investigate and diagnose the root cause across src/agent/loop.ts and src/agent/engine.ts?", // complex -> roles.slow, marker "complex"
      "/route off", // session-local override: routing stops engaging from here on
      "what is this?", // same trivial content that routed to "trivial" earlier in the other test — now must NOT route
    ],
  );
  // "/route off" is a slash command handled inline (no runTurn/LaunchTui call) — only
  // the 2 real prompts reach the model layer and construct a LaunchTui.
  expect(calls.length).toBe(2);
  expect(calls[0].model).toBe("claude-opus-4-6");
  expect(calls[1].model).toBe("claude-sonnet-4-6"); // routing off -> defaultModel, unrouted
  expect(capturedRoutedTiers).toEqual(["complex", undefined]);
});



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
      "Can you investigate and diagnose the root cause across src/agent/loop.ts and src/agent/engine.ts?", // complex, 0.85 confidence -> roles.slow unset -> auto-selects strongest anthropic-credentialed model
    ],
  );
  expect(calls.length).toBe(2);
  expect(calls[0].model).toBe("claude-haiku-4-5");
  expect(calls[1].model).toBe("claude-fable-5");
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

test("credential gate: routed tier resolves to a provider with NO credential -> switches to an equivalent credentialed model", async () => {
  const { calls } = await runOneTurnWithLogs({
    providers: { anthropic: "test-anthropic-key" }, // defaultModel's provider: credentialed
    defaultModel: "claude-sonnet-4-6",
    roles: { smol: "gpt-4o-mini" }, // openai: NOT credentialed anywhere in this config
    routing: { enabled: true },
  }, "what is this?"); // trivial, 0.85 confidence -> would route to roles.smol (gpt-4o-mini)
  expect(calls.length).toBeGreaterThan(0);
  // Without the gate this would be "gpt-4o-mini" and the real call would fail with
  // "No credential for provider 'openai'" — the gate must prevent dispatch to it.
  expect(calls[0].model).toBe("claude-haiku-4-5");
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

test("credential gate: warnOnce suppresses the notice on a second turn hitting the SAME unready provider, but the alternate still applies every turn", async () => {
  const config = {
    providers: { anthropic: "test-anthropic-key" },
    defaultModel: "claude-sonnet-4-6",
    roles: { smol: "gpt-4o-mini" },
    routing: { enabled: true },
  };
  const first = await runOneTurnWithLogs(config, "what is this?");
  expect(first.calls[0].model).toBe("claude-haiku-4-5"); // alternate applied
  expect(first.logs.some(l => l.includes("no usable credential"))).toBe(true); // notice fired

  const second = await runOneTurnWithLogs(config, "what is that?");
  expect(second.calls[0].model).toBe("claude-haiku-4-5"); // alternate STILL applied
  expect(second.logs.some(l => l.includes("no usable credential"))).toBe(false); // notice suppressed (warnOnce)
});

test("credential gate: /route why after a veto explains the equivalent fallback, not a phantom routed decision", async () => {
  const { logs } = await runOneTurnWithLogs({
    providers: { anthropic: "test-anthropic-key" },
    defaultModel: "claude-sonnet-4-6",
    roles: { smol: "gpt-4o-mini" },
    routing: { enabled: true },
  }, ["what is this?", "/route why"]);
  const whyLine = logs.find(l => l.includes("switched to equivalent"));
  expect(whyLine).toBeDefined();
  expect(whyLine).toContain("gpt-4o-mini");
  expect(whyLine).toContain("claude-haiku-4-5"); // names the equivalent actually used
});
// --- model-servability veto (v0.8.2): provider-level readiness is necessary but
// NOT sufficient. An OAuth-only OpenAI login passes describeProvider's ready
// check yet only serves Codex ids — an explicitly-pinned routing.tiers model
// outside that set must be vetoed (fall back to the session/default model)
// instead of failing at call time demanding an API key. ---

// Clears env credentials that would leak into the temp config via withEnvOverlay
// (an ambient OPENAI_API_KEY fills providers.openai and makes gpt-4o servable;
// an ambient OPENAI_BASE_URL makes EVERY openai id servable), then restores them.
async function withOpenAiEnvCleared<T>(run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_OAUTH_TOKEN"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const ROUTING_PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "GEMINI_OAUTH_TOKEN",
  "XAI_API_KEY",
  ...OPENAI_COMPAT_PROVIDERS.map(def => def.apiKeyEnv),
];

async function withRoutingProviderEnvCleared<T>(run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ROUTING_PROVIDER_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("servability veto: OAuth-only openai + pinned non-Codex tier model -> switches to an equivalent credentialed model with a 'cannot serve' notice", async () => {
  await withOpenAiEnvCleared(async () => {
    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key" },
      oauth: { openai: "oauth-tok" }, // provider IS ready (passes describeProvider)…
      defaultModel: "claude-sonnet-4-6",
      routing: { enabled: true, tiers: { trivial: { model: "gpt-4o" } } }, // …but OAuth cannot serve gpt-4o
    }, "what is this?"); // trivial -> routes to the pinned gpt-4o
    expect(calls.length).toBeGreaterThan(0);
    // Without the model-level veto this dispatches gpt-4o and the call fails
    // demanding OPENAI_API_KEY despite a valid OAuth login — the v0.8.2 bug.
    expect(calls[0].model).toBe("claude-haiku-4-5");
    const notice = logs.find(l => l.includes("[route]") && l.includes("cannot serve"));
    expect(notice).toBeDefined();
    expect(notice).toContain("gpt-4o");
    expect(notice).toContain("OPENAI_API_KEY");
  });
});

test("servability veto: /route why explains the routed model is not servable and names the equivalent fallback", async () => {
  await withOpenAiEnvCleared(async () => {
    const { logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key" },
      oauth: { openai: "oauth-tok" },
      defaultModel: "claude-sonnet-4-6",
      routing: { enabled: true, tiers: { trivial: { model: "gpt-4o" } } },
    }, ["what is this?", "/route why"]);
    const whyLine = logs.find(l => l.includes("not servable"));
    expect(whyLine).toBeDefined();
    expect(whyLine).toContain("gpt-4o");
    expect(whyLine).toContain("claude-haiku-4-5"); // names the equivalent actually used
  });
});

test("servability veto: does NOT fire for a Codex id the OAuth login serves (gate is model-scoped, not provider-scoped)", async () => {
  await withOpenAiEnvCleared(async () => {
    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key" },
      oauth: { openai: "oauth-tok" },
      defaultModel: "claude-sonnet-4-6",
      routing: { enabled: true, tiers: { trivial: { model: "gpt-5.5" } } }, // Codex-served
    }, "what is this?");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].model).toBe("gpt-5.5"); // routing engaged normally — no veto
    expect(logs.some(l => l.includes("cannot serve") || l.includes("not servable"))).toBe(false);
  });
});

test("/model auto releases a CLI --model pin mid-session: the NEXT turn resumes routing instead of staying pinned", async () => {
  const { calls } = await runOneTurnWithLogs(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      routing: { enabled: true },
    },
    ["/model auto", "what is this?"],
    ["--model", "claude-sonnet-4-6"],
  );
  expect(calls.length).toBe(1); // "/model auto" is a slash command, not a turn -> only ONE runAgentLoop call
  expect(calls[0].model).toBe("claude-haiku-4-5"); // routed to roles.smol, NOT the released 'claude-sonnet-4-6' pin
});


test("without /model auto, the CLI --model pin still wins on every subsequent turn (regression guard for the test above)", async () => {
  const calls = await runOneTurn(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      routing: { enabled: true },
    },
    "what is this?",
    ["--model", "claude-sonnet-4-6"],
  );
  expect(calls.length).toBe(1);
  expect(calls[0].model).toBe("claude-sonnet-4-6"); // pin still wins, unrouted
});
test("/route on overrides an active CLI --model pin: routing evaluates the prompt instead of staying pinned", async () => {
  const { calls } = await runOneTurnWithLogs(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      // routing.enabled deliberately OFF/unset — proves the explicit `/route on`
      // toggle alone (not config) is what re-opens routing past the pin.
    },
    ["/route on", "what is this?"],
    ["--model", "claude-sonnet-4-6"],
  );
  expect(calls.length).toBe(1); // "/route on" is a slash command, not a turn -> only ONE runAgentLoop call
  expect(calls[0].model).toBe("claude-haiku-4-5"); // routed to roles.smol, NOT the pinned 'claude-sonnet-4-6'
});

test("/route on then /route off: pin reasserts itself once the explicit override is turned back off", async () => {
  const { calls } = await runOneTurnWithLogs(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      routing: { enabled: true },
    },
    ["/route on", "what is this?", "/route off", "what is this?"],
    ["--model", "claude-sonnet-4-6"],
  );
  expect(calls.length).toBe(2); // two real prompts, two slash commands consumed inline
  expect(calls[0].model).toBe("claude-haiku-4-5"); // override engaged -> routed past the pin
  expect(calls[1].model).toBe("claude-sonnet-4-6"); // override turned off -> pin wins again
});

test("routing.enabled: true + no explicit /route toggle still respects an active --model pin (regression guard: config alone must not gain the override's pin-bypass power)", async () => {
  const calls = await runOneTurn(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      routing: { enabled: true },
    },
    "what is this?",
    ["--model", "claude-sonnet-4-6"],
  );
  expect(calls.length).toBe(1);
  expect(calls[0].model).toBe("claude-sonnet-4-6"); // still pinned — only an explicit /route on bypasses the pin
});

test("mid-session /model <name> (literal slash command, not --model CLI flag) locks the pin: the turn AFTER it stops using roles.smol", async () => {
  const { calls } = await runOneTurnWithLogs(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      routing: { enabled: true },
    },
    ["what is this?", "/model claude-sonnet-4-6", "what is this?"],
    // no --model CLI flag: the session starts fully unpinned, routing-only
  );
  expect(calls.length).toBe(2); // 2 real prompts; "/model claude-sonnet-4-6" is consumed inline, not a turn
  expect(calls[0].model).toBe("claude-haiku-4-5"); // turn 1: routing active pre-pin -> roles.smol
  expect(calls[1].model).toBe("claude-sonnet-4-6"); // turn 3 (after the pin): explicit pin wins, NOT roles.smol, despite an equally trivial prompt
});

test("mid-session /model <name> pin persists across EVERY subsequent turn, not just the first one after pinning", async () => {
  const { calls } = await runOneTurnWithLogs(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      routing: { enabled: true },
    },
    ["what is this?", "/model claude-sonnet-4-6", "what is this?", "what is this?", "what is this?"],
  );
  expect(calls.length).toBe(4); // 1 pre-pin routed turn + 3 pinned turns after "/model claude-sonnet-4-6"
  expect(calls[0].model).toBe("claude-haiku-4-5"); // pre-pin: routed to roles.smol
  expect(calls[1].model).toBe("claude-sonnet-4-6"); // 1st turn after pin
  expect(calls[2].model).toBe("claude-sonnet-4-6"); // 2nd turn after pin — NOT roles.smol
  expect(calls[3].model).toBe("claude-sonnet-4-6"); // 3rd turn after pin — NOT roles.smol
});

test("mid-session /model <name> pin, then /model auto, then re-pin to a DIFFERENT model: each turn matches the expected state transition", async () => {
  const { calls } = await runOneTurnWithLogs(
    {
      providers: { anthropic: "test-anthropic-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "claude-haiku-4-5" },
      routing: { enabled: true },
    },
    [
      "what is this?",             // turn 1: routed (no pin yet)
      "/model claude-sonnet-4-6",  // pin to sonnet
      "what is this?",             // turn 2: pinned to sonnet
      "/model auto",               // release the pin
      "what is this?",             // turn 3: routed again
      "/model claude-opus-4-6",    // re-pin to a DIFFERENT model
      "what is this?",             // turn 4: pinned to opus
    ],
  );
  expect(calls.length).toBe(4);
  expect(calls[0].model).toBe("claude-haiku-4-5"); // routed pre-pin
  expect(calls[1].model).toBe("claude-sonnet-4-6"); // pinned
  expect(calls[2].model).toBe("claude-haiku-4-5"); // routed again after /model auto released the pin
  expect(calls[3].model).toBe("claude-opus-4-6"); // re-pinned to a DIFFERENT model than before
});



// --- local-provider reachability veto (v0.9.0): `describeProvider` reports ollama/
// lmstudio as `ready: true` UNCONDITIONALLY (keyless just means "no credential
// needed", not "the server is up"), so a routing.tiers/roles pin to a downed local
// server previously sailed past every readiness check and only failed mid-turn with
// a raw, provider-less "Unable to connect. Is the computer able to access the url?"
// (Bun's fetch/undici error for both a refused connection and an unresolvable host).
// A short-timeout live probe closes that gap. ---

async function withMockedFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = prevFetch;
  }
}

test("reachability veto: routing pinned to an unreachable ollama model switches to an equivalent credentialed model with an 'unreachable' notice", async () => {
  await withMockedFetch(
    (async () => { throw new Error("Unable to connect. Is the computer able to access the url?"); }) as typeof fetch,
    async () => {
      const { calls, logs } = await runOneTurnWithLogs({
        providers: { anthropic: "test-anthropic-key" },
        defaultModel: "claude-sonnet-4-6",
        routing: { enabled: true, tiers: { trivial: { model: "ollama/llama3.1" } } },
      }, "what is this?");
      expect(calls.length).toBeGreaterThan(0);
      // Without the reachability veto this dispatches ollama/llama3.1 and the call
      // fails mid-turn with the raw Bun connection error instead of switching.
      expect(calls[0].model).toBe("claude-haiku-4-5");
      const notice = logs.find(l => l.includes("[route]") && l.includes("unreachable"));
      expect(notice).toBeDefined();
      expect(notice).toContain("ollama/llama3.1");
      expect(notice).toContain("ollama");
    },
  );
});

test("reachability veto: does not fire when the local provider IS reachable (no false positives)", async () => {
  await withMockedFetch(
    (async () => new Response(JSON.stringify({ models: [{ name: "llama3.1" }] }), { status: 200 })) as typeof fetch,
    async () => {
      const { calls, logs } = await runOneTurnWithLogs({
        providers: { anthropic: "test-anthropic-key" },
        defaultModel: "claude-sonnet-4-6",
        routing: { enabled: true, tiers: { trivial: { model: "ollama/llama3.1" } } },
      }, "what is this?");
      expect(calls[0].model).toBe("ollama/llama3.1"); // routing engaged normally
      expect(logs.some(l => l.includes("unreachable"))).toBe(false);
    },
  );
});

test("reachability veto: /route why explains the routed model is unreachable and names the equivalent fallback", async () => {
  await withMockedFetch(
    (async () => { throw new Error("Unable to connect. Is the computer able to access the url?"); }) as typeof fetch,
    async () => {
      const { logs } = await runOneTurnWithLogs({
        providers: { anthropic: "test-anthropic-key" },
        defaultModel: "claude-sonnet-4-6",
        routing: { enabled: true, tiers: { trivial: { model: "ollama/llama3.1" } } },
      }, ["what is this?", "/route why"]);
      const whyLine = logs.find(l => l.includes("switched to equivalent"));
      expect(whyLine).toBeDefined();
      expect(whyLine).toContain("ollama/llama3.1");
      expect(whyLine).toContain("claude-haiku-4-5");
    },
  );
});

test("reachability veto: warnOnce suppresses the notice on a second turn hitting the SAME unreachable provider, but the alternate still applies every turn", async () => {
  await withMockedFetch(
    (async () => { throw new Error("Unable to connect. Is the computer able to access the url?"); }) as typeof fetch,
    async () => {
      const config = {
        providers: { anthropic: "test-anthropic-key" },
        defaultModel: "claude-sonnet-4-6",
        routing: { enabled: true, tiers: { trivial: { model: "ollama/llama3.1" } } },
      };
      const first = await runOneTurnWithLogs(config, "what is this?");
      expect(first.calls[0].model).toBe("claude-haiku-4-5"); // alternate applied
      expect(first.logs.some(l => l.includes("unreachable"))).toBe(true); // notice fired

      const second = await runOneTurnWithLogs(config, "what is that?");
      expect(second.calls[0].model).toBe("claude-haiku-4-5"); // alternate STILL applied
      expect(second.logs.some(l => l.includes("unreachable"))).toBe(false); // notice suppressed (warnOnce)
    },
  );
});

test("reachability veto: is scoped to local providers only — a cloud provider pin never triggers a live probe", async () => {
  let fetchCalls = 0;
  await withMockedFetch(
    (async (url: string | URL | Request) => {
      fetchCalls++;
      if (String(url).includes("localhost:11434")) throw new Error("Unable to connect. Is the computer able to access the url?");
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    }) as typeof fetch,
    async () => {
      const { calls, logs } = await runOneTurnWithLogs({
        providers: { anthropic: "test-anthropic-key" },
        defaultModel: "claude-sonnet-4-6",
        roles: { smol: "claude-haiku-4-5" }, // same (credentialed) cloud provider
        routing: { enabled: true },
      }, "what is this?");
      expect(calls[0].model).toBe("claude-haiku-4-5"); // routed normally — no local-provider probe involved
      expect(logs.some(l => l.includes("unreachable"))).toBe(false);
    },
  );
});

// --- post-call rerouting continuity (v0.8.14): once routing dispatches a model,
// recoverable terminal failures should keep the turn alive by walking same-tier
// servable fallbacks. Deterministic budget/safety/cancel failures must stay put
// so the user sees the real failure instead of a silent model switch. ---

test("post-call reroute: plain OpenAI no-content retry switches to same-tier fallback and /route why names it", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "gpt-4o-mini") {
        return { done: false, steps: 1, doneReason: "Error: OpenAI returned no content." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, ["what is this?", "/route why"]);

    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
    const notice = logs.find(l => l.includes("[route]") && l.includes("returned no content"));
    expect(notice).toBeDefined();
    expect(notice).toContain("gpt-4o-mini");
    expect(notice).toContain("claude-haiku-4-5");
    const whyWarning = logs.find(l => l.startsWith("warning:") && l.includes("returned no content"));
    expect(whyWarning).toBeDefined();
    expect(whyWarning).toContain("gpt-4o-mini");
    expect(whyWarning).toContain("claude-haiku-4-5");
  });
});

test("post-call reroute: recoverable failure on first fallback keeps trying the next servable equivalent", async () => {
  await withRoutingProviderEnvCleared(async () => {
    const recoverableFailures: Record<string, true> = { "gpt-4o-mini": true, "claude-haiku-4-5": true };
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model && recoverableFailures[opts.model]) {
        return { done: false, steps: 1, doneReason: "Error: OpenAI returned no content." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, "what is this?");

    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "claude-haiku-4-5", "gpt-4.1"]);
    const notices = logs.filter(l => l.includes("[route]") && l.includes("switching to equivalent"));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("gpt-4o-mini");
    expect(notices[0]).toContain("claude-haiku-4-5");
    expect(notices[1]).toContain("claude-haiku-4-5");
    expect(notices[1]).toContain("gpt-4.1");
  });
});

test("post-call reroute: deterministic output-budget no-content does not switch models", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async () => ({
      done: false,
      steps: 1,
      doneReason: "Error: OpenAI returned no content (finish_reason=length) — output budget exhausted before any text (often reasoning tokens); raise maxTokens or lower reasoning effort.",
    });

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, ["what is this?", "/route why"]);

    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini"]);
    expect(logs.some(l => l.includes("[route]") && l.includes("switching to equivalent"))).toBe(false);
    expect(logs.some(l => l === "model: gpt-4o-mini")).toBe(true);
    expect(logs.some(l => l.startsWith("warning:") && l.includes("switched to equivalent"))).toBe(false);
  });
});

test("post-call reroute: auth/credential rejection (401) on the routed model switches to a same-tier fallback", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "gpt-4o-mini") {
        return { done: false, steps: 1, doneReason: "Error: OpenAI rejected the credential (HTTP 401). Run 'jeo auth status', re-login with /provider login <name>." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, ["what is this?", "/route why"]);

    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
    const notice = logs.find(l => l.includes("[route]") && l.includes("unauthenticated"));
    expect(notice).toBeDefined();
    expect(notice).toContain("gpt-4o-mini");
    expect(notice).toContain("claude-haiku-4-5");
  });
});

test("post-call reroute: unreachable/connection-refused failure on the routed model switches to a same-tier fallback", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "gpt-4o-mini") {
        return { done: false, steps: 1, doneReason: "Error: Could not connect to OpenAI. Check the configured base URL, your network connection, or switch model with /model." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, ["what is this?", "/route why"]);

    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
    const notice = logs.find(l => l.includes("[route]") && l.includes("unreachable"));
    expect(notice).toBeDefined();
    expect(notice).toContain("gpt-4o-mini");
    expect(notice).toContain("claude-haiku-4-5");
  });
});

test("post-call reroute: silent/no-response call-timeout on the routed model switches to a same-tier fallback", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "gpt-4o-mini") {
        return { done: false, steps: 1, doneReason: "Error: OpenAI did not complete the request within the call timeout (default 30min). This is expected for a HIGH/XHIGH-reasoning-effort completion." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, ["what is this?", "/route why"]);

    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
    const notice = logs.find(l => l.includes("[route]") && l.includes("did not respond in time"));
    expect(notice).toBeDefined();
    expect(notice).toContain("gpt-4o-mini");
    expect(notice).toContain("claude-haiku-4-5");
  });
});

test("post-call reroute: billing/quota-exhausted (402) on the routed model switches to a same-tier fallback", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "gpt-4o-mini") {
        return { done: false, steps: 1, doneReason: "Error: OpenAI request failed (HTTP 402): {\"error\":{\"message\":\"The free trial quota for the service has been exhausted and postpaid billing is not enabled, so the service cannot be accessed.\",\"type\":\"api_error\"}}" };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, ["what is this?", "/route why"]);

    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
    const notice = logs.find(l => l.includes("[route]") && l.includes("billing/payment"));
    expect(notice).toBeDefined();
    expect(notice).toContain("gpt-4o-mini");
    expect(notice).toContain("claude-haiku-4-5");
  });
});

test("post-call reroute: persistent 5xx (server error surviving the retry budget) on the routed model switches to a same-tier fallback", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "gpt-4o-mini") {
        return { done: false, steps: 1, doneReason: "Error: OpenAI request failed (HTTP 503): the server is overloaded or not ready yet." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, ["what is this?", "/route why"]);

    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
    const notice = logs.find(l => l.includes("[route]") && l.includes("persistent server-side error"));
    expect(notice).toBeDefined();
    expect(notice).toContain("gpt-4o-mini");
    expect(notice).toContain("claude-haiku-4-5");
  });
});

// Mirrors the "persistent 5xx" test immediately above, but using the exact message
// shape `friendlyProviderError` now produces for a `ProviderStreamError` (Antigravity/
// Gemini's in-band `google.rpc.Status` SSE error, or OpenAI Codex's `response.failed`
// event) instead of the `ProviderHttpError` (REST) shape — proves the fix in
// src/util/provider-error.ts's `friendlyProviderError` (the 5xx status branch that now
// embeds the numeric HTTP code) round-trips all the way through engine.ts's
// `doneReason: \`Error: ${friendlyProviderError(err)}\`` composition into launch.ts's
// `routeFailureReason` text regex and the post-call reroute loop, not just the
// REST-level `ProviderHttpError` shape which already embedded the numeric status.
test("post-call reroute: persistent 5xx from a ProviderStreamError (Antigravity/Gemini in-band google.rpc.Status shape, no numeric status in the raw stream-error text) on the routed model switches to a same-tier fallback", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "gpt-4o-mini") {
        // Built LIVE via friendlyProviderError + ProviderStreamError (not a hardcoded
        // string) so this test is genuinely coupled to — and mutation-sensitive to —
        // the fix in src/util/provider-error.ts, and mirrors engine.ts's real
        // `doneReason: \`Error: ${friendlyProviderError(err)}\`` composition exactly.
        const streamErr = new ProviderStreamError("Antigravity", "internal error", "INTERNAL", 500);
        return { done: false, steps: 1, doneReason: `Error: ${friendlyProviderError(streamErr)}` };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, ["what is this?", "/route why"]);

    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
    const notice = logs.find(l => l.includes("[route]") && l.includes("persistent server-side error"));
    expect(notice).toBeDefined();
    expect(notice).toContain("gpt-4o-mini");
    expect(notice).toContain("claude-haiku-4-5");
  });
});

test("post-call reroute: context-overflow (400/413, conversation too large) does NOT switch models — switching providers cannot fix a prompt that no longer fits", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async () => ({
      done: false,
      steps: 1,
      doneReason: "Error: Anthropic rejected the request: the conversation no longer fits the model's context window. Run /compact, drop large attachments, or start a fresh session.",
    });

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, "what is this?");

    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini"]);
    expect(logs.some(l => l.startsWith("[route]") && l.includes("switching to equivalent"))).toBe(false);
  });
});

// --- Rate-limit fast fallback (v0.8.22): opts.rateLimitFallbackAvailable is threaded
// into EVERY runAgentLoop call so the engine can bail a same-model 429 retry ladder on
// the FIRST failed attempt (instead of riding ~90s of backoff) whenever an untried
// same-tier model is available RIGHT NOW — see engine.ts's AgentLoopOptions doc comment
// and launch.ts's `rateLimitFallbackAvailable` closure. ---

test("rate-limit fast fallback: rateLimitFallbackAvailable() is true when an untried same-tier candidate is credentialed", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => ({ done: true, steps: 1, doneReason: `completed on ${opts.model}` });

    await runOneTurn({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, "what is this?");

    // gpt-4o-mini is the only call (turn succeeded first try) — claude-haiku-4-5 (proven
    // reachable by the "post-call reroute" tests above, same trivial-tier pool) is an
    // untried, credentialed candidate at that moment, so the predicate reads true.
    expect(capturedCalls.map(c => c.model)).toEqual(["gpt-4o-mini"]);
    expect(capturedRateLimitAvailability).toEqual([true]);
  });
});

test("rate-limit fast fallback: rateLimitFallbackAvailable() is false when no credentialed fallback candidate exists at all", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => ({ done: true, steps: 1, doneReason: `completed on ${opts.model}` });

    // Zero providers credentialed, routing off, no /model pin: the turn still runs on
    // defaultModel (routing not active this turn), but the tier pool is empty — nothing
    // is credentialed for ANY provider, so there is genuinely no candidate to switch to.
    await runOneTurn({
      providers: {},
      defaultModel: "claude-sonnet-4-6",
    }, "what is this?");

    expect(capturedCalls.map(c => c.model)).toEqual(["claude-sonnet-4-6"]);
    expect(capturedRateLimitAvailability).toEqual([false]);
  });
});

test("rate-limit fast fallback: predicate re-evaluates fresh after a fallback switch (excludes the already-tried model from the SECOND call too)", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "gpt-4o-mini") {
        return { done: false, steps: 1, doneReason: "Error: Rate limited by OpenAI (HTTP 429)." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, "what is this?");

    // Two calls: gpt-4o-mini (rate limited) then claude-haiku-4-5 (the equivalent
    // fallback, succeeds). Both models here are API-KEY-served (providers.openai/
    // providers.anthropic, no oauth block) — `credentialScopeFor` returns `null` for
    // both, so the credential-scope exclusion never engages and both calls see a TRUE
    // predicate: first because claude-haiku-4-5 (untried) is credentialed, second
    // because a FURTHER untried candidate (e.g. gpt-4.1, per the "recoverable failure
    // on first fallback" test above) is still available even after gpt-4o-mini was
    // excluded by id. See the "OAuth subscription" tests below for the scope-exclusion
    // behavior this test does NOT exercise.
    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
    expect(capturedRateLimitAvailability).toEqual([true, true]);
  });
});

test("post-call reroute: HTTP 429 rate limit on the routed model switches to a same-tier fallback (the actual scenario rateLimitFallbackAvailable exists to shortcut)", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "gpt-4o-mini") {
        return { done: false, steps: 1, doneReason: "Error: Rate limited by OpenAI (HTTP 429). Auto-retry cannot clear this window right now." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, ["what is this?", "/route why"]);

    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
    const notice = logs.find(l => l.includes("[route]") && l.includes("hit a rate limit"));
    expect(notice).toBeDefined();
    expect(notice).toContain("gpt-4o-mini");
    expect(notice).toContain("claude-haiku-4-5");
  });
});

// --- OAuth-SUBSCRIPTION credential-scope exclusion (v0.8.22 follow-up): the fix
// above (excluding by MODEL id only) is insufficient when several models share ONE
// account-wide OAuth subscription rate-limit window (Claude Pro/Max, ChatGPT/Codex,
// Kimi Code, Antigravity Cloud Code Assist). A real field report: `claude-sonnet-5`
// 429s, the equivalent-pool fallback picks `claude-sonnet-4-6` (SAME Anthropic OAuth
// token, SAME rate-limit window), which immediately re-429s — indistinguishable from
// "never escaping auto-retry #1" even though a different model WAS dispatched each
// round. Fix: `credentialScopeFor` classifies OAuth-subscription-served models into a
// shared scope key; a 429/quota/auth failure excludes the WHOLE scope, not just the
// one model id — while API-key-served models (independent per-key budget, exercised
// by the tests above) are correctly left untouched (`credentialScopeFor` -> null). ---

const OAUTH_STAMP = { access: "x", refresh: "x", expires: Date.now() + 1e9 };

test("OAuth subscription scope: rateLimitFallbackAvailable() is FALSE when every untried same-tier candidate shares the SAME exhausted OAuth subscription", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => ({ done: true, steps: 1, doneReason: `completed on ${opts.model}` });

    await runOneTurn({
      providers: {},
      oauth: { anthropic: OAUTH_STAMP },
      defaultModel: "claude-sonnet-4-6",
      routing: { enabled: true },
    }, "Update the styling in src/app.css to use a darker background color for the header.");

    // Standard tier under anthropic-OAuth-only credentials pools ONLY
    // claude-sonnet-4-6/claude-sonnet-5 — both ride the SAME anthropic:oauth
    // subscription scope as the active model, so there is genuinely no different-
    // scope candidate to escape to.
    expect(capturedCalls.map(c => c.model)).toEqual(["claude-sonnet-4-6"]);
    expect(capturedRateLimitAvailability).toEqual([false]);
  });
});

test("OAuth subscription scope: rateLimitFallbackAvailable() is TRUE when a DIFFERENT-scope (API-key-served) candidate exists alongside the exhausted OAuth subscription", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => ({ done: true, steps: 1, doneReason: `completed on ${opts.model}` });

    await runOneTurn({
      providers: { openai: "sk-test-openai" },
      oauth: { anthropic: OAUTH_STAMP },
      defaultModel: "claude-sonnet-4-6",
      routing: { enabled: true },
    }, "Update the styling in src/app.css to use a darker background color for the header.");

    // Now the standard-tier pool also has gpt-5.4/o3 (API-key-served, independent
    // budget from the anthropic OAuth subscription) — a genuine fallback exists.
    expect(capturedCalls.map(c => c.model)).toEqual(["claude-sonnet-4-6"]);
    expect(capturedRateLimitAvailability).toEqual([true]);
  });
});

test("OAuth subscription scope: a 429 does NOT switch to another model on the SAME OAuth subscription — switches to a genuinely different credential scope instead", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "claude-sonnet-4-6") {
        return { done: false, steps: 1, doneReason: "Error: Rate limited by Anthropic (HTTP 429). Auto-retry cannot clear this window right now." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { openai: "sk-test-openai" },
      oauth: { anthropic: OAUTH_STAMP },
      defaultModel: "claude-sonnet-4-6",
      routing: { enabled: true },
    }, ["Update the styling in src/app.css to use a darker background color for the header.", "/route why"]);

    // Must switch to gpt-5.4/o3 (API-key, different scope) — NEVER to claude-sonnet-5
    // (same anthropic:oauth scope as the model that just 429'd).
    expect(calls.map(c => c.model)).toEqual(["claude-sonnet-4-6", expect.any(String)]);
    const secondModel = calls[1].model;
    expect(secondModel).not.toBe("claude-sonnet-5");
    expect(["gpt-5.4", "o3"]).toContain(secondModel);
    const notice = logs.find(l => l.includes("[route]") && l.includes("hit a rate limit"));
    expect(notice).toBeDefined();
    expect(notice).toContain("claude-sonnet-4-6");
    expect(notice).toContain(secondModel!);
  });
});

test("OAuth subscription scope: exclusion accumulates across rounds — a SECOND OAuth-subscription failure (Antigravity) also gets scope-excluded, not just the first (Anthropic)", async () => {
  await withRoutingProviderEnvCleared(async () => {
    let calls = 0;
    runAgentLoopDelegate = async (_history, opts) => {
      calls++;
      // Both the original Anthropic OAuth model AND its first Antigravity OAuth
      // fallback 429 — only the third candidate (API-key OpenAI) succeeds.
      if (opts.model === "claude-sonnet-4-6" || (typeof opts.model === "string" && opts.model.startsWith("antigravity/"))) {
        return { done: false, steps: 1, doneReason: "Error: Rate limited (HTTP 429). Auto-retry cannot clear this window right now." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls: captured } = await runOneTurnWithLogs({
      providers: { openai: "sk-test-openai" },
      oauth: { anthropic: OAUTH_STAMP, antigravity: OAUTH_STAMP },
      defaultModel: "claude-sonnet-4-6",
      routing: { enabled: true },
    }, "Update the styling in src/app.css to use a darker background color for the header.");

    const models = captured.map(c => c.model);
    // Every attempted model's PROVIDER must be distinct from every OTHER attempted
    // OAuth-subscription model — anthropic and antigravity never both appear if one
    // of them already failed and got scope-excluded (only ONE OAuth-scope model may
    // appear per distinct scope: anthropic:oauth OR antigravity, never both after
    // either has failed once — the accumulating excludedCredentialScopes set is what
    // this proves). The turn must end on the API-key OpenAI model.
    expect(models[models.length - 1]).toMatch(/^(gpt-5\.4|o3)$/);
    // No model is repeated (the exact "stuck at auto-retry #1" symptom this fix targets).
    expect(new Set(models).size).toBe(models.length);
    expect(calls).toBe(models.length);
  });
});

test("OAuth subscription scope: a 402 billing/payment failure ALSO excludes the whole OAuth subscription (not just rate limits/quota/auth) — never wastes a round on the same doomed subscription", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "claude-sonnet-4-6") {
        return { done: false, steps: 1, doneReason: "Error: Anthropic requires billing/payment on this account (HTTP 402) — free trial quota exhausted or postpaid billing not enabled." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { openai: "sk-test-openai" },
      oauth: { anthropic: OAUTH_STAMP },
      defaultModel: "claude-sonnet-4-6",
      routing: { enabled: true },
    }, ["Update the styling in src/app.css to use a darker background color for the header.", "/route why"]);

    // Must switch straight to gpt-5.4/o3 (API-key, different scope) — never wastes a
    // round retrying claude-sonnet-5 (same anthropic:oauth scope, guaranteed to 402
    // identically since the SAME subscription's billing is what's actually blocked).
    expect(calls.map(c => c.model)).toEqual(["claude-sonnet-4-6", expect.any(String)]);
    const secondModel = calls[1].model;
    expect(secondModel).not.toBe("claude-sonnet-5");
    expect(["gpt-5.4", "o3"]).toContain(secondModel);
    const notice = logs.find(l => l.includes("[route]") && l.includes("billing/payment"));
    expect(notice).toBeDefined();
    expect(notice).toContain("claude-sonnet-4-6");
    expect(notice).toContain(secondModel!);
  });
});

test("402 billing failure on an API-KEY-served model does NOT exclude the whole provider (regression guard: preserves the Tencent-style per-model billing-block case)", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "gpt-4o-mini") {
        return { done: false, steps: 1, doneReason: "Error: OpenAI requires billing/payment on this account (HTTP 402) — free trial quota exhausted or postpaid billing not enabled." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, "what is this?");

    // gpt-4o-mini is API-key-served (credentialScopeFor -> null) — a 402 on it must
    // NOT exclude other openai models by scope, only by exact id. Falls back to the
    // normal same-tier pool exactly as the pre-existing 402 test (line ~987) proves.
    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
  });
});

// --- Live-discovered credential-scope classification (resolveProvider live-catalog
// fix): `credentialScopeFor` classifies a model's scope by first resolving ITS
// provider via `resolveProvider`. Before the fix, `resolveProvider` never consulted
// the live-discovered-model index (`liveProviderModels`/`recordLiveProviderModels`),
// so a live-discovered id with no recognizable brand substring (e.g. an xAI model
// that doesn't contain "grok") silently fell through to the final `anthropic`
// heuristic — wrongly bucketing it into the SAME `{oauth-subscription,"anthropic:oauth"}`
// scope as an active Anthropic OAuth session, excluding it from the fallback pool the
// instant that OAuth subscription 429s despite the model having its OWN independent
// xai API-key budget. `aurora-2-pro` is chosen so `sizeClassFor` deterministically
// places it in the "standard" tier's suffix pool (segment "pro") — the SAME tier
// `claude-sonnet-4-6` occupies — instead of the tercile split reserved for
// unclassified ids, keeping this test's pool membership independent of how many
// OTHER unclassified models happen to be credentialed. ---

test("live-discovered credential scope: credentialScopeFor classifies a live-discovered xai model independently of an unrelated Anthropic OAuth subscription", async () => {
  await withRoutingProviderEnvCleared(async () => {
    resetLiveProviderModels();
    recordLiveProviderModels("xai", ["aurora-2-pro"], { source: "api_key" });
    try {
      const config = {
        providers: { xai: "test-xai-key" },
        oauth: { anthropic: OAUTH_STAMP },
        defaultModel: "claude-sonnet-4-6",
        routing: { enabled: true },
      };
      // Without the fix, `resolveProvider("aurora-2-pro")` misresolves to "anthropic"
      // (the substring-heuristic fallthrough — "aurora-2-pro" contains no recognized
      // brand substring), so `credentialScopeFor` wrongly returns the SAME
      // `{oauth-subscription,"anthropic:oauth"}` scope as the actively-routed Anthropic
      // OAuth model below — indistinguishable from a genuinely same-subscription
      // sibling. With the fix, `resolveProvider` recovers the live row's correct "xai"
      // provider; xai is API-key-served here (no xai OAuth configured), so the scope
      // is `null` (independent per-key budget, never group-excluded).
      expect(credentialScopeFor("aurora-2-pro", config)).toBeNull();
      // Sanity check on the OTHER side of the bug: the actively-routed Anthropic OAuth
      // model DOES classify into the oauth-subscription scope aurora-2-pro must NOT share.
      expect(credentialScopeFor("claude-sonnet-4-6", config)).toEqual({ kind: "oauth-subscription", key: "anthropic:oauth" });
    } finally {
      resetLiveProviderModels();
    }
  });
});

test("live-discovered credential scope: a 429 on the Anthropic OAuth model actually SWITCHES to the live xai model, not just reports availability", async () => {
  await withRoutingProviderEnvCleared(async () => {
    resetLiveProviderModels();
    recordLiveProviderModels("xai", ["aurora-2-pro"], { source: "api_key" });
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "claude-sonnet-4-6") {
        return { done: false, steps: 1, doneReason: "Error: Rate limited by Anthropic (HTTP 429). Auto-retry cannot clear this window right now." };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { xai: "test-xai-key" },
      oauth: { anthropic: OAUTH_STAMP },
      defaultModel: "claude-sonnet-4-6",
      routing: { enabled: true },
    }, ["Update the styling in src/app.css to use a darker background color for the header.", "/route why"]);

    // Must switch to the live-discovered xai model (independent budget) — never
    // silently give up (falling back to defaultModel) despite a genuine fallback
    // candidate existing.
    expect(calls.map(c => c.model)).toEqual(["claude-sonnet-4-6", "aurora-2-pro"]);
    const notice = logs.find(l => l.includes("[route]") && l.includes("hit a rate limit"));
    expect(notice).toBeDefined();
    expect(notice).toContain("claude-sonnet-4-6");
    expect(notice).toContain("aurora-2-pro");
  });
});

// --- Safety-boundary automatic model fallback (v0.8.24 — engine.ts's
// AgentLoopOptions.safetyFallbackAvailable): mirrors the rate-limit fast-fallback
// block above end-to-end through launch.ts's ACTUAL main-turn wiring (routeFailureReason's
// dedicated tag branch, safetyFallbackAvailable's provider-aware predicate,
// equivalentRouteFallback's provider-level exclusion, and stripSafetyFallbackTag on
// the terminal reply) — the exact surface that was previously untested end-to-end. ---

test("post-call reroute: an uncategorized refusal (SafetyFallback tag) on the routed model switches to a DIFFERENT-PROVIDER fallback and completes", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => {
      if (opts.model === "gpt-4o-mini") {
        return {
          done: false,
          steps: 1,
          doneReason: "SafetyFallback (uncategorized): OpenAI declined to answer (safety refusal — no content returned). Usually a content classifier tripped on recently read file/search content.",
        };
      }
      return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
    };

    const { calls, logs } = await runOneTurnWithLogs({
      providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
      defaultModel: "claude-sonnet-4-6",
      roles: { smol: "gpt-4o-mini" },
      routing: { enabled: true },
    }, ["what is this?", "/route why"]);

    // Switched PROVIDER (openai -> anthropic), never a same-provider sibling —
    // safetyFallbackAvailable/equivalentRouteFallback's provider-level exclusion.
    expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
    const notice = logs.find(l => l.includes("[route]") && l.includes("possible safety classifier false positive"));
    expect(notice).toBeDefined();
    expect(notice).toContain("gpt-4o-mini");
    expect(notice).toContain("claude-haiku-4-5");
    // The internal engine tag never leaks into ANY user-visible log line.
    expect(logs.some(l => l.includes("SafetyFallback (uncategorized)"))).toBe(false);
  });
});

test("safetyFallbackAvailable() is FALSE when every untried same-tier candidate shares the SAME provider (no genuinely different classifier boundary)", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => ({ done: true, steps: 1, doneReason: `completed on ${opts.model}` });

    await runOneTurn({
      providers: {},
      oauth: { anthropic: OAUTH_STAMP },
      defaultModel: "claude-sonnet-4-6",
      routing: { enabled: true },
    }, "Update the styling in src/app.css to use a darker background color for the header.");

    // Standard tier under anthropic-only credentials pools ONLY claude models —
    // same provider as the active model, so safetyFallbackAvailable is FALSE even
    // though rateLimitFallbackAvailable is also false here for the same reason
    // (both checks correctly agree: no fallback of ANY kind exists).
    expect(capturedCalls.map(c => c.model)).toEqual(["claude-sonnet-4-6"]);
    expect(capturedSafetyFallbackAvailability).toEqual([false]);
  });
});

test("safetyFallbackAvailable() is stricter than rateLimitFallbackAvailable(): FALSE for a same-provider-different-credential-scope candidate that the rate-limit predicate would accept", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async (_history, opts) => ({ done: true, steps: 1, doneReason: `completed on ${opts.model}` });

    // anthropic served via OAuth (one scope) PLUS a configured anthropic API key —
    // credentialScopeFor still classifies every anthropic model into the SAME
    // "anthropic:oauth" scope (OAuth wins over API key whenever it serves the
    // model), but even if it did not, they are the SAME PROVIDER regardless of
    // credential — proving safetyFallbackAvailable's provider check is the
    // binding constraint here, not the credential-scope one.
    await runOneTurn({
      providers: { anthropic: "test-anthropic-key" },
      oauth: { anthropic: OAUTH_STAMP },
      defaultModel: "claude-sonnet-4-6",
      routing: { enabled: true },
    }, "Update the styling in src/app.css to use a darker background color for the header.");

    expect(capturedCalls.map(c => c.model)).toEqual(["claude-sonnet-4-6"]);
    expect(capturedSafetyFallbackAvailability).toEqual([false]);
  });
});

test("post-call reroute: an uncategorized refusal with NO different-provider fallback strips the internal SafetyFallback tag from the terminal reply (regression guard against the raw tag leaking to the user)", async () => {
  await withRoutingProviderEnvCleared(async () => {
    runAgentLoopDelegate = async () => ({
      done: false,
      steps: 3,
      doneReason:
        "SafetyFallback (uncategorized): Anthropic declined to answer (safety refusal — no content returned). " +
        "Usually a content classifier tripped on recently read file/search content: /retry, /compact or /new to drop the triggering context, or switch model with /model.",
    });

    const { calls, logs } = await runOneTurnWithLogs({
      providers: {},
      oauth: { anthropic: OAUTH_STAMP },
      defaultModel: "claude-sonnet-4-6",
      routing: { enabled: true },
    }, "Update the styling in src/app.css to use a darker background color for the header.");

    // No fallback exists (single-provider config) — never switched, reroute loop
    // broke on the FIRST iteration (equivalentRouteFallback returned null).
    expect(calls.map(c => c.model)).toEqual(["claude-sonnet-4-6"]);
    // The reply printed to the user carries the FRIENDLY message, with the
    // internal "SafetyFallback (uncategorized):" prefix tag stripped.
    const printed = logs.find(l => l.includes("declined to answer (safety refusal"));
    expect(printed).toBeDefined();
    expect(printed).not.toContain("SafetyFallback (uncategorized)");
  });
});
