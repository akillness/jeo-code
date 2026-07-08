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
const realApp = { ...(await import("../src/tui/app")) };

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
  capturedRoutedTiers = [];
  resetPromptRouterWarnings();
});


afterEach(() => {
  process.stdin.isTTY = originalIsTTY as boolean;
});

afterAll(() => {
  mock.module("node:readline/promises", () => realReadline);
  mock.module("../src/agent/engine", () => realEngine);
  mock.module("../src/tui/app", () => realApp);
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

test("servability veto: OAuth-only openai + pinned non-Codex tier model -> falls back to defaultModel with a 'cannot serve' notice", async () => {
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
    expect(calls[0].model).toBe("claude-sonnet-4-6");
    const notice = logs.find(l => l.includes("[route]") && l.includes("cannot serve"));
    expect(notice).toBeDefined();
    expect(notice).toContain("gpt-4o");
    expect(notice).toContain("OPENAI_API_KEY");
  });
});

test("servability veto: /route why explains the routed model is not servable and names the fallback", async () => {
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
    expect(whyLine).toContain("claude-sonnet-4-6"); // names the fallback actually used
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

test("reachability veto: routing pinned to an unreachable ollama model falls back to defaultModel with an 'unreachable' notice", async () => {
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
      // fails mid-turn with the raw Bun connection error instead of falling back.
      expect(calls[0].model).toBe("claude-sonnet-4-6");
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

test("reachability veto: /route why explains the routed model is unreachable and names the fallback", async () => {
  await withMockedFetch(
    (async () => { throw new Error("Unable to connect. Is the computer able to access the url?"); }) as typeof fetch,
    async () => {
      const { logs } = await runOneTurnWithLogs({
        providers: { anthropic: "test-anthropic-key" },
        defaultModel: "claude-sonnet-4-6",
        routing: { enabled: true, tiers: { trivial: { model: "ollama/llama3.1" } } },
      }, ["what is this?", "/route why"]);
      const whyLine = logs.find(l => l.includes("fell back to"));
      expect(whyLine).toBeDefined();
      expect(whyLine).toContain("ollama/llama3.1");
      expect(whyLine).toContain("claude-sonnet-4-6");
    },
  );
});

test("reachability veto: warnOnce suppresses the notice on a second turn hitting the SAME unreachable provider, but the veto still applies every turn", async () => {
  await withMockedFetch(
    (async () => { throw new Error("Unable to connect. Is the computer able to access the url?"); }) as typeof fetch,
    async () => {
      const config = {
        providers: { anthropic: "test-anthropic-key" },
        defaultModel: "claude-sonnet-4-6",
        routing: { enabled: true, tiers: { trivial: { model: "ollama/llama3.1" } } },
      };
      const first = await runOneTurnWithLogs(config, "what is this?");
      expect(first.calls[0].model).toBe("claude-sonnet-4-6"); // veto applied
      expect(first.logs.some(l => l.includes("unreachable"))).toBe(true); // notice fired

      const second = await runOneTurnWithLogs(config, "what is that?");
      expect(second.calls[0].model).toBe("claude-sonnet-4-6"); // veto STILL applied
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
