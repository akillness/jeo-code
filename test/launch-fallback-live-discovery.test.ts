import { test, expect, mock, spyOn, beforeEach, afterEach, afterAll } from "bun:test";
import { resetPromptRouterWarnings, tierModelPool } from "../src/agent/prompt-router";
import { recordLiveProviderModels, resetLiveCodexModels, resetLiveProviderModels } from "../src/ai/model-catalog";
import type { AgentLoopOptions, AgentLoopResult } from "../src/agent/engine";
import type * as AiModule from "../src/ai";
import type { ProviderModelsResult } from "../src/ai";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Proves `equivalentRouteFallback` (launch.ts) warms live provider discovery ON DEMAND
// when the tier pool is empty — the fix for API-key-only providers (groq, deepseek,
// mistral, …) that only enter `tierModelPool` via `recordLiveProviderModels`, which a
// ONE-SHOT invocation never populates (interactive sessions warm it in the background
// at startup; `jeo -p`/piped input skips that path entirely — see launch.ts's
// `isOneShot` branch). Without the fix, a credentialed-but-undiscovered provider has
// ZERO fallback candidates on a rate-limit/usage-limit/auth/timeout failure even though
// the user's key works.
// Module-mock boundary: launch.ts imports `discoverModels` from the "../src/ai" barrel
// at module scope, so a static import cannot intercept it — dynamic re-import after
// `mock.module` is required (mirrors launch-prompt-routing.test.ts's established
// convention for `../src/agent/engine`/`../src/tui/app`).
const realReadline = { ...(await import("node:readline/promises")) };
const realEngine = { ...(await import("../src/agent/engine")) };
const realAI: typeof AiModule = { ...(await import("../src/ai")) };

let mockQuestions: string[] = [];
let mockIndex = 0;
let capturedCalls: { model?: string; maxTokens?: number; reasoningEffort?: string; sessionKey?: string }[] = [];
let runAgentLoopDelegate: (history: unknown, opts: AgentLoopOptions) => Promise<AgentLoopResult> = async () => ({ done: true, steps: 1, doneReason: "ok" });
let discoverModelsCalls = 0;
let discoverModelsResult: ProviderModelsResult[] = [];
let discoverModelsShouldThrow = false;
let unavailableProvider: string | undefined;
let deferDiscovery = false;
let completionResults: Record<string, [string[], string]> = {};
let completionInputs: string[] = [];

mock.module("node:readline/promises", () => ({
  createInterface: (opts: { completer?: (line: string) => [string[], string] }) => ({
    question: mock(async () => {
      for (const input of completionInputs) completionResults[input] = opts.completer!(input);
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
  runAgentLoop: mock(async (history: unknown, opts: AgentLoopOptions) => {
    capturedCalls.push({ model: opts.model, maxTokens: opts.maxTokens, reasoningEffort: opts.reasoningEffort, sessionKey: opts.sessionKey });
    return runAgentLoopDelegate(history, opts);
  }),
}));

mock.module("../src/ai", () => ({
  ...realAI,
  describeProvider: async (...args: Parameters<typeof realAI.describeProvider>) => {
    const status = await realAI.describeProvider(...args);
    return status.name === unavailableProvider ? { ...status, ready: false } : status;
  },
  discoverModels: mock(async () => {
    discoverModelsCalls++;
    if (discoverModelsShouldThrow) throw new Error("discovery transport error (simulated)");
    // Mirror the REAL discoverModels' contract: a successful discovery call has the
    // side effect of recording live provider models (via listProviderModels ->
    if (deferDiscovery) return new Promise<ProviderModelsResult[]>(() => {});
    // recordLiveProviderModels), which is what actually feeds `tierModelPool`.
    for (const r of discoverModelsResult) {
      if (r.ok) recordLiveProviderModels(r.provider, r.models, { source: r.source === "none" ? undefined : r.source });
    }
    return discoverModelsResult;
  }),
}));

let originalIsTTY: boolean | undefined;

// Provider credential + base-url env must not leak into these turns: an ambient
// OPENAI_BASE_URL would make an uncredentialed pinned openai model appear keyless-local
// (custom-endpoint readiness flips on) and silently defeat the pre-call credential veto /
// on-demand warm-up fallback paths this file exercises. Save + clear around each test, restore after.
const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_OAUTH_TOKEN",
  "GEMINI_API_KEY", "GEMINI_BASE_URL", "GEMINI_OAUTH_TOKEN",
  "XAI_API_KEY", "XAI_BASE_URL",
  "LMSTUDIO_BASE_URL",
];
const savedProviderEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = true;
  mockQuestions = [];
  mockIndex = 0;
  capturedCalls = [];
  discoverModelsCalls = 0;
  discoverModelsResult = [];
  discoverModelsShouldThrow = false;
  unavailableProvider = undefined;
  resetPromptRouterWarnings();
  resetLiveCodexModels();
  resetLiveProviderModels();
  deferDiscovery = false;
  completionInputs = [];
  completionResults = {};
  for (const k of PROVIDER_ENV_KEYS) {
    savedProviderEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  resetLiveCodexModels();
  process.stdin.isTTY = originalIsTTY as boolean;
  for (const [k, v] of Object.entries(savedProviderEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterAll(() => {
  mock.module("node:readline/promises", () => realReadline);
  mock.module("../src/agent/engine", () => realEngine);
  mock.module("../src/ai", () => realAI);
});

// Every test in this file uses ONE-SHOT mode (`-p`) exclusively — interactive mode
// fires an UNCONDITIONAL background `getLiveModels()` warm-up at startup
// (launch.ts's `void getLiveModels().then(...)` right before the REPL loop starts),
// independent of `equivalentRouteFallback`'s own on-demand warm-up. That background
// warm silently satisfies `discoverCalls > 0`/pool-population assertions even with
// the fix reverted — proven by manually reverting the fix and confirming an
// earlier interactive-mode version of this test still passed. One-shot returns
// before that background warm-up is ever reached (see launch.ts's `isOneShot`
// branch), so it is the ONLY invocation mode that isolates the on-demand
// warm-up this file exists to test.
async function runOneShotWithLogs(
  config: Record<string, unknown>,
  message: string,
): Promise<{ calls: typeof capturedCalls; logs: string[]; discoverCalls: number }> {
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-fallback-live-discovery-oneshot-"));
  const savedCfg = process.env.JEO_CONFIG_DIR;
  const savedLog = console.log;
  const logs: string[] = [];
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    process.env.JEO_CONFIG_DIR = cfgDir;
    await fs.writeFile(path.join(cfgDir, "config.json"), JSON.stringify(config));

    // Dynamic import required: must resolve AFTER mock.module installs the mocked
    // "../src/ai"/"../src/agent/engine" bindings launch.ts's module-scope imports pick up.
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session", "-p", message]);

    return { calls: capturedCalls, logs, discoverCalls: discoverModelsCalls };
  } finally {
    console.log = savedLog;
    if (savedCfg === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedCfg;
    await fs.rm(cfgDir, { recursive: true, force: true });
  }
}

test("equivalentRouteFallback: warms live discovery on-demand and falls back to a newly-discovered API-key provider model", async () => {
  // ONLY groq is credentialed — no anthropic/openai/gemini — so the static
  // MODEL_CATALOG contributes zero auto-select candidates and the tier pool is
  // empty until discovery runs. Simulates a groq-only user's ONE-SHOT session
  // (see the file-level comment above for why one-shot mode is required here).
  runAgentLoopDelegate = async (_history, opts) => {
    if (opts.model === "groq/llama-3.3-70b-versatile") {
      return { done: false, steps: 1, doneReason: "Error: Groq hit a rate limit (HTTP 429). Retry later." };
    }
    return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
  };
  // Populated by the "../src/ai" mock's discoverModels override once it is called —
  // this is what the on-demand warm-up inside equivalentRouteFallback should surface.
  discoverModelsResult = [{ provider: "groq", models: ["llama-3.1-8b-instant"], ok: true, source: "api_key" }];

  const { calls, logs, discoverCalls } = await runOneShotWithLogs({
    providers: { groq: "test-groq-key" },
    defaultModel: "groq/llama-3.3-70b-versatile",
    routing: { enabled: true, tiers: { trivial: { model: "groq/llama-3.3-70b-versatile" } } },
  }, "what is this?");
  expect(discoverCalls).toBeGreaterThan(0);
  expect(calls.map(c => c.model)).toEqual(["groq/llama-3.3-70b-versatile", "groq/llama-3.1-8b-instant"]);
  const notice = logs.find(l => l.includes("[route]") && l.includes("rate limit"));
  expect(notice).toBeDefined();
  expect(notice).toContain("groq/llama-3.3-70b-versatile");
  expect(notice).toContain("groq/llama-3.1-8b-instant");
});

test("equivalentRouteFallback: does not call discoverModels when the static catalog already has a candidate", async () => {
  runAgentLoopDelegate = async (_history, opts) => {
    if (opts.model === "gpt-4o-mini") {
      return { done: false, steps: 1, doneReason: "Error: OpenAI hit a rate limit (HTTP 429). Retry later." };
    }
    return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
  };

  const { calls, discoverCalls } = await runOneShotWithLogs({
    providers: { anthropic: "test-anthropic-key", openai: "test-openai-key" },
    defaultModel: "claude-sonnet-4-6",
    roles: { smol: "gpt-4o-mini" },
    routing: { enabled: true },
  }, "what is this?");

  expect(calls.map(c => c.model)).toEqual(["gpt-4o-mini", "gpt-4.1"]);
  // Static catalog (gpt-4.1, trivial tier) already satisfies the fallback —
  // the empty-pool discovery warm-up must never fire when candidates already exist.
  expect(discoverCalls).toBe(0);
});

test("fallbackDecision (pre-call credential veto): warms live discovery on-demand when the static pool is empty and switches to the newly-discovered candidate BEFORE ever dispatching the uncredentialed model", async () => {
  // Only groq is credentialed; routing pins the trivial tier to an OpenAI model
  // (gpt-4o-mini) the user has no credential for. This exercises `fallbackDecision`
  // — the PRE-CALL veto path (routed provider readiness check, ~launch.ts line 973)
  // — NOT the post-call reroute loop tests 1/2 above exercise. Both call the SAME
  // `equivalentRouteFallback`, but this proves the on-demand warm-up also fires
  // from the veto call site, and that the vetoed model is never actually dispatched
  // to `runAgentLoop` (the switch happens before any call is made).
  runAgentLoopDelegate = async (_history, opts) => ({ done: true, steps: 1, doneReason: `completed on ${opts.model}` });
  discoverModelsResult = [{ provider: "groq", models: ["llama-3.1-8b-instant"], ok: true, source: "api_key" }];

  const { calls, logs, discoverCalls } = await runOneShotWithLogs({
    providers: { groq: "test-groq-key" },
    defaultModel: "groq/llama-3.3-70b-versatile",
    routing: { enabled: true, tiers: { trivial: { model: "gpt-4o-mini" } } },
  }, "what is this?");

  expect(discoverCalls).toBeGreaterThan(0);
  // gpt-4o-mini is vetoed before dispatch — the only actual runAgentLoop call is
  // the live-discovered equivalent, never the uncredentialed pinned model.
  expect(calls.map(c => c.model)).toEqual(["groq/llama-3.1-8b-instant"]);
  const notice = logs.find(l => l.includes("[route]") && l.includes("no usable credential"));
  expect(notice).toBeDefined();
  expect(notice).toContain("gpt-4o-mini");
  expect(notice).toContain("Switching to equivalent");
  expect(notice).toContain("groq/llama-3.1-8b-instant");
});

test("fallbackDecision (pre-call credential veto): discovery warm-up finds nothing usable -> returns null cleanly, falls back to defaultModel, no throw", async () => {
  // Discovery itself ERRORS (simulated transport failure) — the harder half of the
  // "finds nothing usable" gap: not just an empty result, but the on-demand
  // `getLiveModels().catch(() => [])` swallowing a genuine rejection. Confirms
  // equivalentRouteFallback degrades to `null` (no throw escapes runTurn) and the
  // turn completes on `defaultModel` — the pre-existing "fell back to" veto-note
  // path, unchanged by this fix's on-demand warm-up.
  discoverModelsShouldThrow = true;
  runAgentLoopDelegate = async (_history, opts) => ({ done: true, steps: 1, doneReason: `completed on ${opts.model}` });

  const { calls, logs, discoverCalls } = await runOneShotWithLogs({
    providers: { groq: "test-groq-key" },
    defaultModel: "groq/llama-3.3-70b-versatile",
    routing: { enabled: true, tiers: { trivial: { model: "gpt-4o-mini" } } },
  }, "what is this?");

  expect(discoverCalls).toBeGreaterThan(0);
  // No fallback was found (discovery errored, pool still empty) -> routed is
  // nulled entirely -> the turn falls through to defaultModel, not gpt-4o-mini
  // (which is never dispatched) and not any live-discovered model (none found).
  expect(calls.map(c => c.model)).toEqual(["groq/llama-3.3-70b-versatile"]);
  const notice = logs.find(l => l.includes("[route]") && l.includes("no usable credential"));
  expect(notice).toBeDefined();
  expect(notice).toContain("gpt-4o-mini");
  // Distinguishes the "no fallback found" notice from the "switched to equivalent"
  // notice the previous test asserts — proves the null path is truly a distinct,
  // gracefully-handled outcome, not an accidental partial match.
  expect(notice).not.toContain("Switching to equivalent");
});

test("fallbackDecision (pre-call credential veto): discovery warm-up SUCCEEDS but no discovered model matches the tier's size class -> returns null cleanly, falls back to defaultModel", async () => {
  // Distinct from the previous test (discovery ERRORS): here `discoverModels`
  // succeeds and DOES record a live groq model, but that model classifies into a
  // different size-class tercile (see prompt-router.ts's `sizeClassFor`) than the
  // "trivial" tier being searched — so `poolCandidates()` is STILL empty after the
  // on-demand warm-up recomputes it. Confirms the fix's `candidates = poolCandidates()`
  // re-check after warming correctly finds nothing (rather than looping or crashing)
  // when discovery genuinely has no USABLE (tier-matching) candidate, not just an
  // empty/erroring discovery call.
  discoverModelsResult = [{ provider: "groq", models: ["custom-opus-model"], ok: true, source: "api_key" }];
  runAgentLoopDelegate = async (_history, opts) => ({ done: true, steps: 1, doneReason: `completed on ${opts.model}` });

  const { calls, logs, discoverCalls } = await runOneShotWithLogs({
    providers: { groq: "test-groq-key" },
    defaultModel: "groq/llama-3.3-70b-versatile",
    routing: { enabled: true, tiers: { trivial: { model: "gpt-4o-mini" } } },
  }, "what is this?");

  expect(discoverCalls).toBeGreaterThan(0);
  // Falls through to defaultModel — the discovered "custom-opus-model" classifies
  // as "large" (opus-suffix), not "trivial", so it never enters the candidate pool.
  expect(calls.map(c => c.model)).toEqual(["groq/llama-3.3-70b-versatile"]);
  const notice = logs.find(l => l.includes("[route]") && l.includes("no usable credential"));
  expect(notice).toBeDefined();
  expect(notice).not.toContain("Switching to equivalent");
});

test("equivalentRouteFallback: does not re-warm discovery on a SECOND reroute attempt once the cache is already warm from the first", async () => {
  // The post-call reroute loop (`for (let routeFallbackAttempt = 0; ...)`) can call
  // `equivalentRouteFallback` more than once in the SAME turn when the first
  // fallback ALSO fails. `getLiveModels()` caches (`liveModelsCache`), so the
  // on-demand warm-up must only ever pay real discovery latency once per cold
  // session — even across multiple fallback attempts within one turn.
  runAgentLoopDelegate = async (_history, opts) => {
    // Both the originally-routed model AND its first fallback hit a rate limit,
    // forcing a SECOND equivalentRouteFallback call; only the third candidate
    // (discovered on the FIRST call, already cached) succeeds.
    if (opts.model === "groq/model-a-mini" || opts.model === "groq/model-b-mini") {
      return { done: false, steps: 1, doneReason: "Error: Groq hit a rate limit (HTTP 429). Retry later." };
    }
    return { done: true, steps: 1, doneReason: `completed on ${opts.model}` };
  };
  // Two discovered candidates in one discoverModels call — the second reroute
  // attempt must find "model-c-mini" ALREADY in the (cached) pool without
  // calling discoverModels again.
  discoverModelsResult = [{ provider: "groq", models: ["model-b-mini", "model-c-mini"], ok: true, source: "api_key" }];

  const { calls, discoverCalls } = await runOneShotWithLogs({
    providers: { groq: "test-groq-key" },
    defaultModel: "groq/llama-3.3-70b-versatile",
    routing: { enabled: true, tiers: { trivial: { model: "groq/model-a-mini" } } },
  }, "what is this?");

  expect(calls.map(c => c.model)).toEqual(["groq/model-a-mini", "groq/model-b-mini", "groq/model-c-mini"]);
  // Exactly ONE discovery call across BOTH fallback attempts — the second
  // attempt's `poolCandidates()` is already non-empty from the first call's
  // cache-warming side effect, so its `candidates.length === 0` guard never fires.
  expect(discoverCalls).toBe(1);
});

test("fallback discovers a usable model after every existing candidate is unusable", async () => {
  recordLiveProviderModels("mistral", ["mistral-small-latest"], { source: "api_key" });
  unavailableProvider = "mistral";
  discoverModelsResult = [{ provider: "groq", models: ["llama-3.1-8b-instant"], ok: true, source: "api_key" }];
  expect(tierModelPool("trivial", { defaultModel: "gpt-4o-mini", roles: {}, providers: { mistral: "test-mistral-key" } })).toContain("mistral/mistral-small-latest");
  runAgentLoopDelegate = async (_history, opts) => opts.model === "gpt-4o-mini"
    ? { done: false, steps: 1, doneReason: "Error: OpenAI hit a rate limit (HTTP 429). Retry later." }
    : { done: true, steps: 1, doneReason: "ok" };

  const { calls, discoverCalls } = await runOneShotWithLogs({
    providers: { groq: "test-groq-key", mistral: "test-mistral-key" },
    defaultModel: "gpt-4o-mini",
    routing: { enabled: true, tiers: { trivial: { model: "gpt-4o-mini" } } },
  }, "what is this?");

  expect(discoverCalls).toBe(1);
  expect(calls.map(c => c.model)).toEqual(["groq/llama-3.1-8b-instant"]);
});

for (const scenario of [
  { name: "confirmed", response: () => new Response(JSON.stringify({ models: [{ slug: "gpt-account-only", visibility: "list" }] })), accepted: true },
  { name: "absent", response: () => new Response(JSON.stringify({ models: [{ slug: "gpt-other", visibility: "list" }] })), accepted: false },
  { name: "rejected", response: () => new Response("unauthorized", { status: 401 }), accepted: false },
]) {
  test(`routing dispatches an account-only OpenAI model only when ${scenario.name}`, async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => scenario.response());
    try {
      const { calls } = await runOneShotWithLogs({
        providers: { anthropic: "test-anthropic-key" },
        oauth: { openai: { access: "opaque-token", accountId: "route-account" } },
        defaultModel: "claude-haiku-4-5",
        routing: { enabled: true, tiers: { trivial: { model: "openai/gpt-account-only" } } },
      }, "what is this?");
      expect(calls).toHaveLength(1);
      if (scenario.accepted) expect(calls[0]?.model).toBe("openai/gpt-account-only");
      else expect(calls[0]?.model).not.toBe("openai/gpt-account-only");
    } finally {
      fetchSpy.mockRestore();
    }
  });
}

test("launch completion shows cached local models for the configured endpoints, not old hosts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-launch-completion-"));
  const previousDir = process.env.JEO_CONFIG_DIR;
  const previousLog = console.log;
  console.log = () => {};
  process.env.JEO_CONFIG_DIR = dir;
  deferDiscovery = true;
  completionInputs = ["/model ollama/", "/model lmstudio/"];
  mockQuestions = ["/exit"];
  try {
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({
      defaultModel: "claude-haiku-4-5", providers: { anthropic: "test-key" },
      ollamaBaseUrl: "http://localhost:23451", lmstudioBaseUrl: "http://localhost:23452/v1",
    }));
    await fs.writeFile(path.join(dir, "model-catalog-cache.json"), JSON.stringify({
      version: 3, updatedAt: Date.now(), providers: [
        { provider: "ollama", source: "keyless", baseUrl: "http://localhost:23451", models: ["current-ollama"] },
        { provider: "ollama", source: "keyless", baseUrl: "http://localhost:11111", models: ["old-ollama"] },
        { provider: "lmstudio", source: "keyless", baseUrl: "http://localhost:23452/v1", models: ["current-lmstudio"] },
        { provider: "lmstudio", source: "keyless", baseUrl: "http://localhost:11112/v1", models: ["old-lmstudio"] },
      ],
    }));
    // Load after the readline and discovery mocks so the launch binds to the test boundaries.
    const { runLaunchCommand } = await import("../src/commands/launch");
    await runLaunchCommand(["--no-tui", "--no-session"]);
    expect(completionResults["/model ollama/"]?.[0]).toEqual(["ollama/current-ollama"]);
    expect(completionResults["/model lmstudio/"]?.[0]).toEqual(["lmstudio/current-lmstudio"]);
  } finally {
    console.log = previousLog;
    if (previousDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = previousDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
