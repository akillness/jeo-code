import { test, expect, mock, afterEach } from "bun:test";
import {
  classifyPromptHeuristically,
  warnOnce,
  resetPromptRouterWarnings,
  deriveCacheSessionKey,
  resolveTierModel,
  routePrompt,
  tierModelPool,
  cheapestCredentialed,
  strongestCredentialed,
  type RouteDecision,
} from "../src/agent/prompt-router";
import { resolveSubagentModel } from "../src/agent/subagents";
import { CODEX_MODELS, recordLiveProviderModels, resetLiveProviderModels } from "../src/ai/model-catalog";
import type { Config } from "../src/agent/state";

// `routePrompt` calls the real `callLlm` (src/agent/loop) for LLM escalation. Tests that
// exercise escalation mock that module first, then dynamically re-import the SUT so it
// picks up the mocked binding — mirrors test/engine.test.ts's established convention for
// mocking callLlm (module-mock + fresh dynamic import, not a bespoke DI parameter).
afterEach(() => {
  mock.restore();
  resetLiveProviderModels();
});

function baseConfig(overrides: Partial<Pick<Config, "defaultModel" | "roles" | "routing">> = {}): Pick<
  Config,
  "defaultModel" | "roles" | "routing"
> {
  return { defaultModel: "claude-sonnet-4-6", ...overrides };
}

// --- classifyPromptHeuristically: bilingual validated corpus ---

test("classifyPromptHeuristically: short EN factual question -> trivial", () => {
  const r = classifyPromptHeuristically("What is TypeScript?");
  expect(r.tier).toBe("trivial");
  expect(r.confidence).toBeCloseTo(0.85);
  expect(r.signals).toEqual(["short-question", "no-code-no-path"]);
});

test("classifyPromptHeuristically: short KR factual question -> trivial", () => {
  const r = classifyPromptHeuristically("이게 뭔가요?");
  expect(r.tier).toBe("trivial");
  expect(r.confidence).toBeCloseTo(0.85);
  expect(r.signals).toEqual(["short-question", "no-code-no-path"]);
});

test("classifyPromptHeuristically: EN causal question is NOT trivial despite being short and question-shaped", () => {
  const r = classifyPromptHeuristically("why is this failing?");
  expect(r.tier).not.toBe("trivial");
  expect(r.tier).toBe("standard");
  expect(r.confidence).toBeCloseTo(0.35);
  expect(r.signals).toContain("causal-question");
  expect(r.signals).not.toContain("short-question");
});

test("classifyPromptHeuristically: KR causal question ('왜 ') is NOT trivial", () => {
  const r = classifyPromptHeuristically("왜 실패하나요?");
  expect(r.tier).not.toBe("trivial");
  expect(r.signals).toContain("causal-question");
  expect(r.signals).not.toContain("short-question");
});

test("classifyPromptHeuristically: 'how' causal question -> standard (conflicting signals)", () => {
  const r = classifyPromptHeuristically("How do I install bun?");
  expect(r.tier).toBe("standard");
  expect(r.confidence).toBeCloseTo(0.35);
  expect(r.signals).toContain("causal-question");
});

test("classifyPromptHeuristically: EN deep-work keyword conflicts with no-code-no-path -> standard", () => {
  const r = classifyPromptHeuristically("Please refactor the auth module for clarity.");
  expect(r.tier).toBe("standard");
  expect(r.confidence).toBeCloseTo(0.35);
  expect(r.signals).toEqual(expect.arrayContaining(["deep-work-keyword", "no-code-no-path"]));
});

test("classifyPromptHeuristically: KR deep-work keyword ('설계') conflicts with no-code-no-path -> standard", () => {
  const r = classifyPromptHeuristically("설계를 다시 검토해줘");
  expect(r.tier).toBe("standard");
  expect(r.confidence).toBeCloseTo(0.35);
  expect(r.signals).toContain("deep-work-keyword");
});

test("classifyPromptHeuristically: causal + deep-work + multi-file -> complex, high confidence", () => {
  const r = classifyPromptHeuristically(
    "Can you investigate and diagnose the root cause across src/agent/loop.ts and src/agent/engine.ts?",
  );
  expect(r.tier).toBe("complex");
  expect(r.confidence).toBeCloseTo(0.85);
  expect(r.signals).toEqual(expect.arrayContaining(["deep-work-keyword", "causal-question", "multi-file"]));
});

test("classifyPromptHeuristically: single file path, no other signals -> standard, no escalation needed", () => {
  const r = classifyPromptHeuristically(
    "Update the styling in src/app.css to use a darker background color for the header.",
  );
  expect(r.tier).toBe("standard");
  expect(r.confidence).toBeCloseTo(0.9);
  expect(r.signals).toEqual([]);
});

test("classifyPromptHeuristically: numeric fraction '3/4.5' does NOT match the path-token regex", () => {
  const r = classifyPromptHeuristically("the ratio is 3/4.5 today");
  // Indirect assertion per the contract: if the fraction had false-matched as a path token,
  // "no-code-no-path" would NOT fire (pathMatches.length would be > 0). It still fires here,
  // proving zero path-token matches against this text.
  expect(r.signals).toContain("no-code-no-path");
  expect(r.tier).toBe("trivial");
});

test("classifyPromptHeuristically: numeric fraction '10/10' does NOT match the path-token regex", () => {
  const r = classifyPromptHeuristically("what's the score, 10/10?");
  expect(r.signals).toContain("no-code-no-path");
  expect(r.tier).toBe("trivial");
  expect(r.confidence).toBeCloseTo(0.85);
});

test("classifyPromptHeuristically: a code fence suppresses the no-code-no-path signal -> standard", () => {
  const r = classifyPromptHeuristically("```\nconst x = 1;\n```");
  expect(r.signals).not.toContain("no-code-no-path");
  expect(r.tier).toBe("standard");
  expect(r.confidence).toBeCloseTo(0.9);
});

test("classifyPromptHeuristically: long multi-sentence design request -> conflicting signals -> standard 0.35", () => {
  const r = classifyPromptHeuristically(
    "Design a new architecture for the plugin system. It needs to support hot reload. It also needs versioning. Can it be backward compatible?",
  );
  expect(r.tier).toBe("standard");
  expect(r.confidence).toBeCloseTo(0.35);
  expect(r.signals).toEqual(
    expect.arrayContaining(["deep-work-keyword", "no-code-no-path", "long-or-multi-sentence"]),
  );
});

test("classifyPromptHeuristically: bare greeting, no signals but short -> trivial (single trivial signal)", () => {
  const r = classifyPromptHeuristically("hello");
  expect(r.tier).toBe("trivial");
  expect(r.confidence).toBeCloseTo(0.65);
  expect(r.signals).toEqual(["no-code-no-path"]);
});

test("classifyPromptHeuristically: EN 'where' factual question -> trivial", () => {
  const r = classifyPromptHeuristically("Where is the config file located?");
  expect(r.tier).toBe("trivial");
  expect(r.confidence).toBeCloseTo(0.85);
});

test("classifyPromptHeuristically: CLI command -> trivial (cli-command + no-code-no-path)", () => {
  const r = classifyPromptHeuristically("git status");
  expect(r.signals).toContain("cli-command");
  expect(r.signals).toContain("no-code-no-path");
  expect(r.tier).toBe("trivial");
  expect(r.confidence).toBeCloseTo(0.85);
});

test("classifyPromptHeuristically: code snippet without backticks suppresses no-code-no-path -> standard", () => {
  const r = classifyPromptHeuristically("const x = 1; console.log(x);");
  expect(r.signals).not.toContain("no-code-no-path");
  expect(r.tier).toBe("standard");
});

test("classifyPromptHeuristically: plain English words like 'import' or 'export' in prose do NOT trigger code snippet detection", () => {
  const r = classifyPromptHeuristically("I want to import some goods from the store.");
  expect(r.signals).toContain("no-code-no-path");
  expect(r.tier).toBe("trivial");
});

test("classifyPromptHeuristically: Windows path and extensionless path -> standard", () => {
  const r = classifyPromptHeuristically("check src\\agent\\loop.ts");
  expect(r.signals).not.toContain("no-code-no-path");
  expect(r.tier).toBe("standard");
});

test("classifyPromptHeuristically: KR trivial question word ('인가요') -> trivial", () => {
  const r = classifyPromptHeuristically("몇 시인가요?");
  expect(r.tier).toBe("trivial");
  expect(r.confidence).toBeCloseTo(0.85);
});

test("classifyPromptHeuristically: very long prose (>=200 chars) with no other signal -> conflicting -> standard 0.35", () => {
  const long = "This is a very long prompt that goes on and on. ".repeat(5);
  expect(long.trim().length).toBeGreaterThanOrEqual(200);
  const r = classifyPromptHeuristically(long);
  expect(r.tier).toBe("standard");
  expect(r.confidence).toBeCloseTo(0.35);
  expect(r.signals).toEqual(expect.arrayContaining(["no-code-no-path", "long-or-multi-sentence"]));
});

// --- warnOnce / resetPromptRouterWarnings ---

test("warnOnce: fires once, then stays silent, then fires again after reset", () => {
  resetPromptRouterWarnings();
  expect(warnOnce("k1", "first")).toBe("first");
  expect(warnOnce("k1", "first")).toBeUndefined();
  expect(warnOnce("k1", "first")).toBeUndefined();
  resetPromptRouterWarnings();
  expect(warnOnce("k1", "first")).toBe("first");
});

test("warnOnce: distinct keys are independent", () => {
  resetPromptRouterWarnings();
  expect(warnOnce("a", "msg-a")).toBe("msg-a");
  expect(warnOnce("b", "msg-b")).toBe("msg-b");
  expect(warnOnce("a", "msg-a")).toBeUndefined();
  resetPromptRouterWarnings();
});

// --- routePrompt ---

test("routePrompt: high-confidence trivial heuristic never escalates, resolves to defaultModel with no roles configured", async () => {
  resetPromptRouterWarnings();
  const { routePrompt } = await import("../src/agent/prompt-router");
  const decision = (await routePrompt("What is TypeScript?", baseConfig())) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.tier).toBe("trivial");
  expect(decision.source).toBe("heuristic");
  expect(decision.model).toBe("claude-sonnet-4-6"); // roles.smol unset -> falls through to defaultModel
  expect(decision.warning).toBeUndefined();
});

test("routePrompt: high-confidence complex heuristic never escalates, resolves to defaultModel with no roles configured", async () => {
  resetPromptRouterWarnings();
  const { routePrompt } = await import("../src/agent/prompt-router");
  const decision = (await routePrompt(
    "Can you investigate and diagnose the root cause across src/agent/loop.ts and src/agent/engine.ts?",
    baseConfig(),
  )) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.tier).toBe("complex");
  expect(decision.source).toBe("heuristic");
  expect(decision.model).toBe("claude-sonnet-4-6"); // roles.slow unset -> falls through to defaultModel
});

// Verification checklist item 5: NO routing.tiers at all and NO roles at all -> every
// resolvable tier's model is config.defaultModel (safe no-op absent configuration).
test("routePrompt (checklist #5): absent roles AND absent routing.tiers resolves every tier's model to defaultModel", async () => {
  resetPromptRouterWarnings();
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = baseConfig(); // no roles, no routing at all

  const trivial = (await routePrompt("What is TypeScript?", config)) as RouteDecision;
  expect(trivial.tier).toBe("trivial");
  expect(trivial.model).toBe(config.defaultModel);

  const standard = (await routePrompt(
    "Update the styling in src/app.css to use a darker background color for the header.",
    config,
  )) as RouteDecision;
  expect(standard.tier).toBe("standard");
  expect(standard.model).toBe(config.defaultModel);

  const complex = (await routePrompt(
    "Can you investigate and diagnose the root cause across src/agent/loop.ts and src/agent/engine.ts?",
    config,
  )) as RouteDecision;
  expect(complex.tier).toBe("complex");
  expect(complex.model).toBe(config.defaultModel);
});

// Verification checklist item 6: forcing callLlm to throw during escalation still returns
// a valid heuristic-sourced RouteDecision (fail-open at the escalation layer).
test("routePrompt (checklist #6): callLlm throwing during escalation falls back to the heuristic result", async () => {
  resetPromptRouterWarnings();
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      throw new Error("simulated provider failure");
    },
  }));
  const { routePrompt } = await import("../src/agent/prompt-router");

  // "why is this failing?" heuristically resolves to standard/0.35 — below the default 0.6
  // threshold, so escalation is attempted (roles.smol IS configured here so the "unconfigured"
  // skip path does not intercept it first).
  const config = baseConfig({ roles: { smol: "gpt-5.5" } });
  const decision = (await routePrompt("why is this failing?", config)) as RouteDecision;

  expect(decision).not.toBeNull();
  expect(decision.source).toBe("heuristic"); // escalation failed -> stayed on the heuristic source
  expect(decision.tier).toBe("standard"); // the heuristic's own tier, unchanged by the failed escalation
  expect(decision.confidence).toBeCloseTo(0.35);
});

// Verification checklist item 7: an image-bearing prompt routed to a tier whose resolved
// model has catalogMetadata(...)?.images === false returns null (fail-open at the
// capability-gate layer).
test("routePrompt (checklist #7): image-bearing prompt routed to an image-incapable model returns null", async () => {
  resetPromptRouterWarnings();
  const { routePrompt } = await import("../src/agent/prompt-router");
  // "What is TypeScript?" resolves to trivial/0.85 (no escalation) -> resolveTierModel("trivial", …)
  // uses roles.smol when set. o3-mini is catalogued with images:false.
  const config = baseConfig({ roles: { smol: "o3-mini" } });
  const decision = await routePrompt("What is TypeScript?", config, { hasImages: true });
  expect(decision).toBeNull();
});

test("routePrompt: image-bearing prompt routed to an image-capable model is unaffected", async () => {
  resetPromptRouterWarnings();
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = baseConfig({ roles: { smol: "gpt-5.5" } }); // images: true
  const decision = (await routePrompt("What is TypeScript?", config, { hasImages: true })) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.model).toBe("gpt-5.5");
});

test("routePrompt: ambiguous prompt escalates and a valid LLM tier response overrides the heuristic tier", async () => {
  resetPromptRouterWarnings();
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tier: "complex" }),
  }));
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = baseConfig({ roles: { smol: "gpt-5.5" } });
  const decision = (await routePrompt("why is this failing?", config)) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.source).toBe("llm");
  expect(decision.tier).toBe("complex");
  expect(decision.model).toBe(config.defaultModel); // roles.slow unset -> defaultModel
});

test("routePrompt: escalation response wrapped in prose/fence is still parsed via tryExtractJsonObject", async () => {
  resetPromptRouterWarnings();
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => 'Sure, here you go:\n```json\n{"tier":"trivial"}\n```\nHope that helps!',
  }));
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = baseConfig({ roles: { smol: "gpt-5.5" } });
  const decision = (await routePrompt("why is this failing?", config)) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.source).toBe("llm");
  expect(decision.tier).toBe("trivial");
});

test("routePrompt: an invalid/unrecognized tier value from escalation is rejected, falls back to heuristic", async () => {
  resetPromptRouterWarnings();
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tier: "super-duper-complex" }),
  }));
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = baseConfig({ roles: { smol: "gpt-5.5" } });
  const decision = (await routePrompt("why is this failing?", config)) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.source).toBe("heuristic");
  expect(decision.tier).toBe("standard");
});

test("routePrompt: roles.smol unconfigured skips escalation and attaches a one-time warning", async () => {
  resetPromptRouterWarnings();
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = baseConfig(); // no roles at all -> resolveRoleModel("smol",…) === defaultModel

  const first = (await routePrompt("why is this failing?", config)) as RouteDecision;
  expect(first).not.toBeNull();
  expect(first.source).toBe("heuristic");
  expect(typeof first.warning).toBe("string");

  const second = (await routePrompt("why is this failing?", config)) as RouteDecision;
  expect(second).not.toBeNull();
  expect(second.warning).toBeUndefined(); // one-time warning already fired

  resetPromptRouterWarnings();
  const third = (await routePrompt("why is this failing?", config)) as RouteDecision;
  expect(typeof third.warning).toBe("string"); // fires again after reset
});

test("routePrompt: routing.tiers explicit override wins over roles and defaultModel", async () => {
  resetPromptRouterWarnings();
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = baseConfig({
    roles: { smol: "gpt-5.5" },
    routing: { tiers: { trivial: { model: "claude-haiku-4-5", thinking: "low" } } },
  });
  const decision = (await routePrompt("What is TypeScript?", config)) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.model).toBe("claude-haiku-4-5");
  expect(decision.thinking).toBe("low");
});

test("routePrompt: custom confidenceThreshold changes whether escalation is attempted", async () => {
  resetPromptRouterWarnings();
  let called = false;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      called = true;
      return JSON.stringify({ tier: "trivial" });
    },
  }));
  const { routePrompt } = await import("../src/agent/prompt-router");
  // "hello" heuristically resolves to trivial/0.65. With a threshold of 0.9, that now counts
  // as low-confidence and must escalate (unlike the module's default 0.6 threshold).
  const config = baseConfig({ roles: { smol: "gpt-5.5" }, routing: { confidenceThreshold: 0.9 } });
  const decision = (await routePrompt("hello", config)) as RouteDecision;
  expect(called).toBe(true);
  expect(decision.source).toBe("llm");
});

test("routePrompt: an aborted signal during escalation fails open to the heuristic result", async () => {
  resetPromptRouterWarnings();
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_messages: unknown, options: { signal?: AbortSignal }) => {
      if (options.signal?.aborted) throw new Error("aborted");
      return JSON.stringify({ tier: "complex" });
    },
  }));
  const { routePrompt } = await import("../src/agent/prompt-router");
  const ac = new AbortController();
  ac.abort();
  const config = baseConfig({ roles: { smol: "gpt-5.5" } });
  const decision = (await routePrompt("why is this failing?", config, { signal: ac.signal })) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.source).toBe("heuristic");
});

// --- deriveCacheSessionKey (design doc §7 risk #4: per-model cache-key scoping) ---

test("deriveCacheSessionKey: same sessionId + same model -> identical key across calls (cache reuse preserved)", () => {
  const a = deriveCacheSessionKey("sess-1", "claude-sonnet-4-6");
  const b = deriveCacheSessionKey("sess-1", "claude-sonnet-4-6");
  expect(a).toBe(b);
});

test("deriveCacheSessionKey: same sessionId + different model -> different keys (no false cross-model cache hit)", () => {
  const a = deriveCacheSessionKey("sess-1", "claude-sonnet-4-6");
  const b = deriveCacheSessionKey("sess-1", "claude-haiku-4-5");
  expect(a).not.toBe(b);
});

test("deriveCacheSessionKey: different sessionId + same model -> different keys (sessions never collide)", () => {
  const a = deriveCacheSessionKey("sess-1", "claude-sonnet-4-6");
  const b = deriveCacheSessionKey("sess-2", "claude-sonnet-4-6");
  expect(a).not.toBe(b);
});

test("deriveCacheSessionKey: embeds both sessionId and model verbatim (no hashing/truncation at this layer)", () => {
  const key = deriveCacheSessionKey("sess-abc", "gpt-5.5");
  expect(key).toBe("sess-abc:gpt-5.5");
});

// --- Cross-provider auto-select (long-term fix for catalog drift: trivial/complex
// tiers pick the cheapest/strongest CREDENTIALED model LIVE off MODEL_CATALOG when
// unconfigured, instead of collapsing to defaultModel — see prompt-router.ts's
// cheapestCredentialed/strongestCredentialed). ---

function credentialedConfig(overrides: Partial<Config> = {}): Config {
  return {
    providers: {},
    defaultModel: "claude-sonnet-4-6",
    ...overrides,
  } as Config;
}

test("resolveTierModel (via routePrompt) auto-select: trivial tier picks the CHEAPEST credentialed model across multiple providers, not defaultModel", async () => {
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = credentialedConfig({
    providers: { anthropic: "k1", openai: "k2", gemini: "k3" },
    routing: { enabled: true },
  });
  const decision = (await routePrompt("what is this?", config)) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.tier).toBe("trivial");
  // gemini-2.0-flash: $0.1/$0.4 per 1M — cheapest of anthropic+openai+gemini's catalogued models.
  expect(decision.model).toBe("gemini-2.0-flash");
});

test("resolveTierModel (via routePrompt) auto-select: complex tier picks the STRONGEST credentialed model across multiple providers, not defaultModel", async () => {
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = credentialedConfig({
    providers: { anthropic: "k1", openai: "k2", gemini: "k3" },
    routing: { enabled: true },
  });
  const decision = (await routePrompt(
    "Can you investigate and diagnose the root cause across src/agent/loop.ts and src/agent/engine.ts?",
    config,
  )) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.tier).toBe("complex");
  // claude-fable-5: xhigh thinking + 128k output + 1M context — strongest catalogued
  // credentialed model (matches current external agentic-benchmark leadership).
  expect(decision.model).toBe("claude-fable-5");
});

test("resolveTierModel auto-select constrains candidates to ONLY credentialed providers (single-provider config never cross-selects an uncredentialed provider's model)", async () => {
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = credentialedConfig({ providers: { openai: "k2" }, routing: { enabled: true } });
  const trivial = (await routePrompt("what is this?", config)) as RouteDecision;
  const complex = (await routePrompt(
    "Can you investigate and diagnose the root cause across src/agent/loop.ts and src/agent/engine.ts?",
    config,
  )) as RouteDecision;
  expect(trivial.model).toBe("gpt-4o-mini"); // cheapest OpenAI-catalogued model
  expect(complex.model).toBe("gpt-5.6"); // strongest OpenAI-catalogued model (recency tiebreak: 2026-06 beats gpt-5.5's 2026-04)

  expect(trivial.model).not.toContain("claude");
  expect(trivial.model).not.toContain("gemini");
  expect(complex.model).not.toContain("claude");
  expect(complex.model).not.toContain("gemini");
});

test("resolveTierModel auto-select: explicit routing.tiers.*.model still wins over auto-select (user override never bypassed)", async () => {
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = credentialedConfig({
    providers: { anthropic: "k1", openai: "k2", gemini: "k3" },
    routing: { enabled: true, tiers: { trivial: { model: "gpt-4o" } } },
  });
  const decision = (await routePrompt("what is this?", config)) as RouteDecision;
  expect(decision.model).toBe("gpt-4o"); // explicit config, NOT the auto-selected gemini-2.0-flash
});

test("resolveTierModel auto-select: legacy roles.smol/roles.slow still win over auto-select (backward compat with pre-existing role-tier setups)", async () => {
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = credentialedConfig({
    providers: { anthropic: "k1", openai: "k2", gemini: "k3" },
    roles: { smol: "claude-haiku-4-5" },
    routing: { enabled: true },
  });
  const decision = (await routePrompt("what is this?", config)) as RouteDecision;
  expect(decision.model).toBe("claude-haiku-4-5"); // roles.smol, NOT the auto-selected gemini-2.0-flash
});

test("resolveTierModel auto-select: ZERO stored credentials falls back to defaultModel (safe no-op, matches checklist #5's documented contract)", async () => {
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = credentialedConfig({ providers: {}, routing: { enabled: true } }); // no credentials at all
  const trivial = (await routePrompt("what is this?", config)) as RouteDecision;
  const complex = (await routePrompt(
    "Can you investigate and diagnose the root cause across src/agent/loop.ts and src/agent/engine.ts?",
    config,
  )) as RouteDecision;
  expect(trivial.model).toBe(config.defaultModel);
  expect(complex.model).toBe(config.defaultModel);
});

test("resolveTierModel auto-select: OAuth-stored credential (not just providers API key) also counts as credentialed", async () => {
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = credentialedConfig({
    providers: {},
    oauth: { gemini: { access: "tok", refresh: "r", expires: Date.now() + 100000 } },
    routing: { enabled: true },
  });
  const decision = (await routePrompt("what is this?", config)) as RouteDecision;
  expect(decision.model).toBe("antigravity/gemini-3.5-flash-extra-low"); // only antigravity credentialed (via gemini OAuth fallback) -> cheapest = smallest size class, newest on the flat-price tie ("Gemini 3.5 Flash (Low)")
});

test("resolveTierModel auto-select: Antigravity OAuth beats public Gemini API key on the trivial cheapest path", async () => {
  const config = credentialedConfig({
    providers: { gemini: "k3" },
    oauth: { antigravity: { access: "tok", refresh: "r", expires: Date.now() + 100000 } },
    routing: { enabled: true },
  });
  const decision = (await routePrompt("what is this?", config)) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.tier).toBe("trivial");
  // The Gemini API key must not let public google/gemini ids outrank the OAuth-backed
  // Antigravity Gemini lane; the selected Gemini auto-pick stays provider-qualified.
  expect(decision.model).not.toMatch(/^gemini-/);
  expect(decision.model).toStartWith("antigravity/gemini-");
  const version = Number(/^antigravity\/gemini-(\d+(?:\.\d+)?)-/.exec(decision.model)?.[1] ?? "0");
  expect(version).toBeGreaterThanOrEqual(3.1);
});

test("resolveTierModel auto-select: high tier stays Antigravity-qualified (never a bare public Gemini id) even when a Gemini API key is also configured", () => {
  const config = credentialedConfig({
    providers: { gemini: "k3" },
    oauth: { antigravity: { access: "tok", refresh: "r", expires: Date.now() + 100000 } },
    routing: { enabled: true },
  });
  // No sessionId -> deterministic index-0 pick across the antigravity multi-company
  // pool (see antigravityCompanyPoolPick): Anthropic's Sonnet now sorts first
  // alphabetically among the 3 company representatives, so it wins the no-session
  // case. What this test actually pins is the invariant that mattered before that
  // change too: the public `providers.gemini` credential must NEVER let a bare
  // `gemini-*` id (unqualified, no `antigravity/` prefix) leak into auto-select —
  // every candidate stays provider-qualified regardless of which one wins.
  const model = resolveTierModel("high", config);
  expect(model).not.toMatch(/^gemini-/);
  expect(model).toStartWith("antigravity/");
});

test("resolveTierModel auto-select: high/complex tiers are session-stably reachable across ALL of Antigravity's re-exported companies (Anthropic/Google/OpenAI), not just Google's", () => {
  const config = credentialedConfig({
    oauth: { antigravity: { access: "tok", refresh: "r", expires: Date.now() + 100000 } },
    routing: { enabled: true },
  });
  const highModels = new Set<string>();
  const complexModels = new Set<string>();
  for (let i = 0; i < 50; i++) {
    highModels.add(resolveTierModel("high", config, `sess-${i}`));
    complexModels.add(resolveTierModel("complex", config, `sess-${i}`));
  }
  // "high": Anthropic (claude-sonnet-4-6), Google (strongest same-tier Gemini row),
  // OpenAI (gpt-oss-120b-medium) — all 3 companies reachable, never just Google's.
  expect(highModels).toContain("antigravity/claude-sonnet-4-6");
  // Google's slot is deterministic, not a coin flip: gemini-3.5-flash-low and
  // gemini-pro-agent tie on thinking/maxOutputTokens/contextTokens, so the
  // releaseDate tiebreak picks the newer row (2026-05 > 2026-02) EVERY time —
  // gemini-pro-agent never wins Google's company slot for "high".
  expect(highModels.has("antigravity/gemini-3.5-flash-low")).toBe(true);
  expect(highModels.has("antigravity/gemini-pro-agent")).toBe(false);
  expect(highModels).toContain("antigravity/gpt-oss-120b-medium");
  // "complex": only 2 companies have a large-class row (Anthropic's Opus, Google's
  // flash-agent) — OpenAI's gpt-oss is mid-class only, correctly absent here.
  expect(complexModels).toContain("antigravity/claude-opus-4-6-thinking");
  expect(complexModels).toContain("antigravity/gemini-3-flash-agent");
  expect(complexModels).not.toContain("antigravity/gpt-oss-120b-medium");
  // Every reachable model stays provider-qualified — no bare/public id ever wins.
  for (const m of [...highModels, ...complexModels]) expect(m).toStartWith("antigravity/");
});

test("resolveTierModel auto-select: SAME session always resolves to the SAME antigravity company pick (session-stable, not re-randomized per call)", () => {
  const config = credentialedConfig({
    oauth: { antigravity: { access: "tok", refresh: "r", expires: Date.now() + 100000 } },
    routing: { enabled: true },
  });
  const first = resolveTierModel("high", config, "stable-session-id");
  for (let i = 0; i < 10; i++) expect(resolveTierModel("high", config, "stable-session-id")).toBe(first);
});

test("resolveTierModel auto-select: an explicit roles.high override still wins over Antigravity's multi-company spread", () => {
  const config = credentialedConfig({
    roles: { high: "antigravity/gemini-pro-agent" },
    oauth: { antigravity: { access: "tok", refresh: "r", expires: Date.now() + 100000 } },
    routing: { enabled: true },
  });
  for (let i = 0; i < 20; i++) {
    expect(resolveTierModel("high", config, `sess-${i}`)).toBe("antigravity/gemini-pro-agent");
  }
});

test("tierModelPool: Antigravity OAuth plus Gemini API key excludes public Gemini ids from pooled auto-select candidates", () => {
  const config = credentialedConfig({
    providers: { gemini: "k3" },
    oauth: { antigravity: { access: "tok", refresh: "r", expires: Date.now() + 100000 } },
    routing: { enabled: true, crossProviderPool: true },
  });
  const pool = tierModelPool("standard", config);
  expect(pool.some(model => model.startsWith("gemini-"))).toBe(false);
  expect(pool.some(model => model.startsWith("antigravity/gemini-"))).toBe(true);
});

test("resolveTierModel: resolves standard and complex tiers using new config roles (medium, high, xhigh)", () => {
  const config = credentialedConfig({
    defaultModel: "claude-sonnet-4-6",
    roles: {
      smol: "model-smol",
      medium: "model-medium",
      high: "model-high",
      xhigh: "model-xhigh",
      slow: "model-slow",
      plan: "model-plan"
    }
  });

  expect(resolveTierModel("trivial", config)).toBe("model-smol");
  expect(resolveTierModel("standard", config)).toBe("model-medium");
  expect(resolveTierModel("complex", config)).toBe("model-xhigh");
});

test("resolveTierModel: standard tier falls back to high role, then defaultModel", () => {
  const config1 = credentialedConfig({
    defaultModel: "claude-sonnet-4-6",
    roles: {
      high: "model-high"
    }
  });
  expect(resolveTierModel("standard", config1)).toBe("model-high");

  const config2 = credentialedConfig({
    defaultModel: "claude-sonnet-4-6",
    roles: {}
  });
  expect(resolveTierModel("standard", config2)).toBe("claude-sonnet-4-6");
});

test("resolveSubagentModel: resolves executor using new config roles (xhigh, slow)", () => {
  const config1 = credentialedConfig({
    defaultModel: "claude-sonnet-4-6",
    roles: { xhigh: "model-xhigh", slow: "model-slow" }
  });
  expect(resolveSubagentModel("executor", config1)).toBe("model-xhigh");

  const config2 = credentialedConfig({
    defaultModel: "claude-sonnet-4-6",
    roles: { slow: "model-slow" }
  });
  expect(resolveSubagentModel("executor", config2)).toBe("model-slow");
});

test("resolveSubagentModel: resolves architect using new config roles (xhigh)", () => {
  const config = credentialedConfig({
    defaultModel: "claude-sonnet-4-6",
    roles: { xhigh: "model-xhigh" }
  });
  expect(resolveSubagentModel("architect", config)).toBe("model-xhigh");
});

test("resolveSubagentModel: resolves planner using new config roles (high)", () => {
  const config = credentialedConfig({
    defaultModel: "claude-sonnet-4-6",
    roles: { high: "model-high" }
  });
  expect(resolveSubagentModel("planner", config)).toBe("model-high");
});

test("resolveSubagentModel: resolves critic using new config roles (medium, smol)", () => {
  const config1 = credentialedConfig({
    defaultModel: "claude-sonnet-4-6",
    roles: { medium: "model-medium", smol: "model-smol" }
  });
  expect(resolveSubagentModel("critic", config1)).toBe("model-medium");

  const config2 = credentialedConfig({
    defaultModel: "claude-sonnet-4-6",
    roles: { smol: "model-smol" }
  });
  expect(resolveSubagentModel("critic", config2)).toBe("model-smol");
});

test("resolveTierModel: resolves high prompt tier using new config roles (high, medium)", () => {
  const config = credentialedConfig({
    defaultModel: "claude-sonnet-4-6",
    roles: {
      high: "model-high",
      medium: "model-medium"
    }
  });
  expect(resolveTierModel("high", config)).toBe("model-high");

  const configFallback = credentialedConfig({
    defaultModel: "claude-sonnet-4-6",
    roles: {
      medium: "model-medium"
    }
  });
  expect(resolveTierModel("high", configFallback)).toBe("model-medium");
});

test("cheapestCredentialed & strongestCredentialed: excludes limitedAvailability models", () => {
  const config = credentialedConfig({
    providers: { anthropic: "k1" },
    routing: { enabled: true }
  });
  // claude-mythos-5 is limitedAvailability: true. So cheapest/strongest should not return it.
  const cheapest = cheapestCredentialed(config);
  const strongest = strongestCredentialed(config);
  expect(cheapest).not.toBe("claude-mythos-5");
  expect(strongest).not.toBe("claude-mythos-5");
});

test("tierModelPool/routePrompt: custom OpenAI base URL without live discovery does not auto-select public OpenAI catalog rows", async () => {
  resetLiveProviderModels();
  const config = credentialedConfig({
    providers: { openai: "sk-custom" },
    defaultModel: "openai/local-default",
    openaiBaseUrl: "http://127.0.0.1:4321/v1",
    routing: { enabled: true, crossProviderPool: true },
  });
  const tiers = ["trivial", "standard", "high", "complex"] as const;
  const allPooled = tiers.flatMap(tier => tierModelPool(tier, config));
  expect(allPooled).toEqual([]);
  const decision = (await routePrompt("what is this?", config)) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.model).toBe("openai/local-default");
});

test("tierModelPool/routePrompt: live custom OpenAI base models are routed only after being recorded for that base URL", async () => {
  resetLiveProviderModels();
  const baseUrl = "http://127.0.0.1:4321/v1";
  recordLiveProviderModels("openai", ["local-flash-mini"], { source: "api_key", baseUrl: `${baseUrl}/` });
  const config = credentialedConfig({
    providers: { openai: "sk-custom" },
    defaultModel: "openai/local-default",
    openaiBaseUrl: baseUrl,
    routing: { enabled: true, crossProviderPool: true },
  });
  expect(tierModelPool("trivial", config)).toEqual(["openai/local-flash-mini"]);
  const decision = (await routePrompt("what is this?", config, { sessionId: "custom-openai-live" })) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.model).toBe("openai/local-flash-mini");
});

test("tierModelPool: live OpenAI-compatible provider models enter routing pools under their provider prefix", () => {
  resetLiveProviderModels();
  recordLiveProviderModels("groq", ["llama-3.3-70b-versatile"], { source: "api_key" });
  const config = credentialedConfig({
    providers: { groq: "sk-groq" },
    routing: { enabled: true, crossProviderPool: true },
  });
  expect(tierModelPool("trivial", config)).toEqual(["groq/llama-3.3-70b-versatile"]);
});

// --- Model-level OAuth gate in isAutoSelectCandidate (via modelServableWithConfig):
// an OAuth-only OpenAI login serves ONLY Codex ids, and an antigravity API key
// serves NOTHING (OAuth-only provider). Reverting isAutoSelectCandidate to the old
// provider-level "any stored credential" check reddens every assertion below
// (gpt-4o/gpt-4o-mini/o3 re-enter the pools; antigravity rows reappear). ---

test("tierModelPool: OAuth-only OpenAI pools contain ONLY Codex ids across all four tiers (never gpt-4o/gpt-4o-mini/o3)", () => {
  const config = credentialedConfig({
    providers: {},
    oauth: { openai: "oauth-tok" },
    routing: { enabled: true },
  });
  const tiers = ["trivial", "standard", "high", "complex"] as const;
  const all = tiers.flatMap(tier => tierModelPool(tier, config));
  // Not vacuous: the Codex ids ARE credentialed, so at least one pool is non-empty.
  expect(all.length).toBeGreaterThan(0);
  for (const id of all) expect(CODEX_MODELS).toContain(id);
});

test("cheapestCredentialed/strongestCredentialed: OAuth-only OpenAI picks stay within the Codex-served set", () => {
  const config = credentialedConfig({
    providers: {},
    oauth: { openai: "oauth-tok" },
    routing: { enabled: true },
  });
  const cheapest = cheapestCredentialed(config);
  const strongest = strongestCredentialed(config);
  // Without the model-level gate, cheapest would be gpt-4o-mini ($0.15/$0.6 —
  // far cheaper than any Codex id) — the exact regression this pins.
  expect(cheapest).not.toBeNull();
  expect(CODEX_MODELS).toContain(cheapest!);
  expect(strongest).not.toBeNull();
  expect(CODEX_MODELS).toContain(strongest!);
});

test("tierModelPool/cheapest/strongest: an antigravity API key alone credentials NOTHING (antigravity is OAuth-only)", () => {
  const config = credentialedConfig({
    providers: { antigravity: "some-api-key" },
    routing: { enabled: true },
  });
  const tiers = ["trivial", "standard", "high", "complex"] as const;
  for (const tier of tiers) expect(tierModelPool(tier, config)).toEqual([]);
  expect(cheapestCredentialed(config)).toBeNull();
  expect(strongestCredentialed(config)).toBeNull();
});

// --- Antigravity tier mapping (catalog `sizeClass` truth over the wire-id suffix
// heuristic): the LIVE Cloud Code Assist agent set names its ids misleadingly —
// `gemini-3-flash-agent` is "Gemini 3.5 Flash (High)" (flagship), `gemini-3.1-pro-low`
// is the LOW agent tier. Reverting a row's explicit `sizeClass` (or restoring the old
// suffix-only sizeClassFor) moves rows between pools and reddens the exact-set
// assertions below. ---

function antigravityOnlyConfig(): Config {
  return credentialedConfig({
    providers: {},
    oauth: { antigravity: { access: "tok", refresh: "r", expires: Date.now() + 100000 } },
    routing: { enabled: true },
  });
}

test("tierModelPool: antigravity-OAuth-only trivial pool is EXACTLY the two Low-display rows (pro-low is 'small' despite its 'pro' segment)", () => {
  // gemini-3.1-pro-low would land in "mid" under the suffix heuristic ('pro');
  // its explicit sizeClass:"small" puts it in trivial instead.
  expect(tierModelPool("trivial", antigravityOnlyConfig())).toEqual([
    "antigravity/gemini-3.1-pro-low",
    "antigravity/gemini-3.5-flash-extra-low",
  ]);
});

test("tierModelPool: antigravity-OAuth-only complex pool is EXACTLY opus-thinking + flash-agent (flash-agent is 'large' despite its 'flash' segment)", () => {
  // gemini-3-flash-agent would land in "small" under the suffix heuristic ('flash');
  // its explicit sizeClass:"large" makes it a complex-tier flagship instead.
  expect(tierModelPool("complex", antigravityOnlyConfig())).toEqual([
    "antigravity/claude-opus-4-6-thinking",
    "antigravity/gemini-3-flash-agent",
  ]);
});

test("tierModelPool: antigravity-OAuth-only standard AND high pools carry the mid-class agents (pro-agent + sonnet), never the Low rows or flash-agent", () => {
  const config = antigravityOnlyConfig();
  for (const tier of ["standard", "high"] as const) {
    const pool = tierModelPool(tier, config);
    expect(pool).toContain("antigravity/gemini-pro-agent"); // "Gemini 3.1 Pro (High)" — the code-agent model
    expect(pool).toContain("antigravity/claude-sonnet-4-6"); // "Claude Sonnet 4.6 (Thinking)"
    expect(pool).not.toContain("antigravity/gemini-3.1-pro-low");
    expect(pool).not.toContain("antigravity/gemini-3.5-flash-extra-low");
    expect(pool).not.toContain("antigravity/gemini-3-flash-agent"); // flagship, complex-only
  }
});

test("cheapestCredentialed: on the flat Antigravity Gemini price tie, the SMALL size class wins — extra-low, never the large flash-agent", () => {
  // Every antigravity/gemini-* row resolves to the same family price, so the
  // size-class tiebreak decides. Without sizeClass pins, flash-agent ('flash'
  // suffix → small) would enter the tie and win on canonical order — the exact
  // quota-burning regression this pins.
  expect(cheapestCredentialed(antigravityOnlyConfig())).toBe("antigravity/gemini-3.5-flash-extra-low");
});

test("strongestCredentialed: antigravity-OAuth-only picks flash-agent — the 'Gemini 3.5 Flash (High)' flagship", () => {
  expect(strongestCredentialed(antigravityOnlyConfig())).toBe("antigravity/gemini-3-flash-agent");
});

test("routePrompt: roles.smol unconfigured but a cheaper credentialed model exists -> escalation still fires via that fallback classifier", async () => {
  resetPromptRouterWarnings();
  let capturedModel: string | undefined;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_messages: unknown, opts: { model: string }) => {
      capturedModel = opts.model;
      return JSON.stringify({ tier: "complex" });
    },
  }));
  const { routePrompt, cheapestCredentialed: cheapestCredentialedFresh } = await import("../src/agent/prompt-router");
  const config = credentialedConfig({ providers: { gemini: "k3" }, defaultModel: "claude-opus-4-6" });
  // Sanity: a cheaper credentialed model really exists and differs from defaultModel —
  // otherwise this test would pass for the wrong reason (the original skip-and-warn path).
  const fallback = cheapestCredentialedFresh(config);
  expect(fallback).not.toBeNull();
  expect(fallback).not.toBe(config.defaultModel);

  const decision = (await routePrompt("why is this failing?", config)) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.source).toBe("llm"); // escalation fired despite roles.smol being unset
  expect(decision.tier).toBe("complex");
  expect(decision.warning).toBeUndefined(); // no "skip" warning — the fallback classifier covered it
  expect(capturedModel).toBe(fallback);
});

test("routePrompt: roles.smol unconfigured AND no cheaper credentialed model -> unchanged skip-and-warn behavior", async () => {
  resetPromptRouterWarnings();
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = credentialedConfig({ providers: {}, defaultModel: "claude-sonnet-4-6" }); // nothing credentialed at all
  const decision = (await routePrompt("why is this failing?", config)) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.source).toBe("heuristic");
  expect(typeof decision.warning).toBe("string");
});
