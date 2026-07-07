import { test, expect, mock, afterEach } from "bun:test";
import {
  classifyPromptHeuristically,
  warnOnce,
  resetPromptRouterWarnings,
  deriveCacheSessionKey,
  type RouteDecision,
} from "../src/agent/prompt-router";
import type { Config } from "../src/agent/state";

// `routePrompt` calls the real `callLlm` (src/agent/loop) for LLM escalation. Tests that
// exercise escalation mock that module first, then dynamically re-import the SUT so it
// picks up the mocked binding — mirrors test/engine.test.ts's established convention for
// mocking callLlm (module-mock + fresh dynamic import, not a bespoke DI parameter).
afterEach(() => mock.restore());

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
