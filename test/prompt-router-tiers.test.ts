import { test, expect, mock, afterEach } from "bun:test";
import {
  classifyPromptHeuristically,
  resolveTierModel,
  tierModelPool,
  selectFromPool,
  resetPromptRouterWarnings,
  type RouteDecision,
} from "../src/agent/prompt-router";
import type { Config } from "../src/agent/state";

// Covers the "high" PromptTier (a 4th content-based bucket sitting between "standard"
// and "complex" so automatic routing can actually reach all four `roles.*` price points
// — smol/medium/high/xhigh) and `routing.crossProviderPool` (opt-in cross-provider
// session-stable distribution). Complements test/prompt-router.test.ts's existing
// trivial/standard/complex coverage rather than duplicating it.

afterEach(() => mock.restore());

function credentialedConfig(overrides: Partial<Config> = {}): Config {
  return {
    providers: {},
    defaultModel: "claude-sonnet-4-6",
    ...overrides,
  } as Config;
}

// --- classifyPromptHeuristically: a single complex signal -> "high", not "complex" ---

test("classifyPromptHeuristically: a single deep-work-keyword signal (with a path, no causal/multi-file) -> high, not complex", () => {
  const r = classifyPromptHeuristically("Please refactor src/foo.ts");
  expect(r.tier).toBe("high");
  expect(r.confidence).toBeCloseTo(0.65);
  expect(r.signals).toEqual(["deep-work-keyword"]);
});

test("classifyPromptHeuristically: two corroborating complex signals still resolve to complex (unchanged)", () => {
  const r = classifyPromptHeuristically(
    "Can you investigate and diagnose the root cause across src/agent/loop.ts and src/agent/engine.ts?",
  );
  expect(r.tier).toBe("complex");
  expect(r.confidence).toBeCloseTo(0.85);
});

// --- resolveTierModel("high", …): roles precedence + mid-class auto-select fallback ---

test("resolveTierModel: high tier prefers roles.high, then roles.medium, then defaultModel (no credentials)", () => {
  const withHigh = credentialedConfig({ roles: { high: "model-high", medium: "model-medium" } });
  expect(resolveTierModel("high", withHigh)).toBe("model-high");

  const mediumOnly = credentialedConfig({ roles: { medium: "model-medium" } });
  expect(resolveTierModel("high", mediumOnly)).toBe("model-medium");

  const neither = credentialedConfig({ roles: {} });
  expect(resolveTierModel("high", neither)).toBe("claude-sonnet-4-6");
});

test("resolveTierModel: high tier auto-selects the strongest MID-CLASS credentialed model, distinct from trivial's cheapest and complex's flagship pick", () => {
  const config = credentialedConfig({
    providers: { anthropic: "k1", openai: "k2", gemini: "k3" },
    routing: { enabled: true },
  });
  const trivial = resolveTierModel("trivial", config);
  const high = resolveTierModel("high", config);
  const complex = resolveTierModel("complex", config);

  expect(trivial).toBe("gemini-2.0-flash"); // cheapest
  expect(complex).toBe("claude-fable-5"); // strongest flagship (unclassified id, catalog-wide search)
  // "high" must land on a genuinely mid-class (sonnet/pro-suffixed) model — never
  // colliding with either of the other two tiers' picks.
  expect(high).not.toBe(trivial);
  expect(high).not.toBe(complex);
  expect(["claude-sonnet-4-6", "claude-sonnet-5", "gemini-2.5-pro"]).toContain(high);
});

test("resolveTierModel: high tier falls through to defaultModel when the ONLY credentialed provider has no mid-class-suffixed model", () => {
  // OpenAI's catalogued ids never use a sonnet/pro-style size suffix, so the
  // mid-class search must come back empty rather than accidentally reusing
  // complex's catalog-wide strongest pick (gpt-5.4).
  const config = credentialedConfig({ providers: { openai: "k2" }, routing: { enabled: true } });
  expect(resolveTierModel("high", config)).toBe(config.defaultModel);
  expect(resolveTierModel("complex", config)).toBe("gpt-5.5"); // sanity: complex is unaffected (gpt-5.5 is OpenAI's newest catalogued model, correctly wins the recency tiebreak over gpt-5.4)
});

test("resolveTierModel: no cross-call caching — sequential calls with different tiers, same config/sessionId, never bleed into each other", () => {
  const config = credentialedConfig({
    providers: { anthropic: "k1", openai: "k2", gemini: "k3" },
    routing: { enabled: true },
  });
  // Same session id reused across all three calls to prove no session-keyed cache
  // is silently created either — each call must re-derive its result purely from
  // (tier, config), never from what the PREVIOUS call for a different tier resolved.
  const firstTrivial = resolveTierModel("trivial", config, "session-x");
  const complex = resolveTierModel("complex", config, "session-x");
  const secondTrivial = resolveTierModel("trivial", config, "session-x");

  expect(firstTrivial).toBe("gemini-2.0-flash"); // cheapest credentialed
  expect(complex).toBe("claude-fable-5"); // strongest credentialed (unrelated to trivial's pick)
  expect(secondTrivial).toBe(firstTrivial); // re-evaluated fresh, not left holding "complex"'s result
  expect(secondTrivial).not.toBe(complex);
});

test("resolveTierModel: tier-scoping contrast — standard and high both fall through to defaultModel, but complex's live scan does not", () => {
  // Mirrors the fixture above ("high tier falls through to defaultModel..."): OpenAI is
  // the only credentialed provider and its catalogued ids never carry a sonnet/pro-style
  // mid-class suffix, so the mid-class scan `high` relies on comes up empty. `standard`
  // has no live-scan fallback at all (its ladder stops at defaultModel), and `complex`'s
  // catalog-wide strongest-credentialed scan succeeds regardless — all three must be
  // asserted together so a future change can't silently narrow "falls through to
  // defaultModel" from a high-tier-specific claim into a universal one, or vice versa.
  const config = credentialedConfig({ providers: { openai: "k2" }, routing: { enabled: true } });
  expect(resolveTierModel("standard", config)).toBe(config.defaultModel); // guaranteed fallback, no live scan for standard
  expect(resolveTierModel("high", config)).toBe(config.defaultModel); // mid-class scan empty -> falls through
  expect(resolveTierModel("complex", config)).not.toBe(config.defaultModel); // catalog-wide scan still finds gpt-5.5
});

// --- routing.crossProviderPool: opt-in, purely additive, session-stable ---

test("resolveTierModel: crossProviderPool unset (default) never changes standard/high's pre-existing defaultModel fallback", () => {
  const config = credentialedConfig({
    providers: { anthropic: "k1", gemini: "k3" },
    routing: { enabled: true }, // no crossProviderPool flag
  });
  expect(resolveTierModel("standard", config, "session-a")).toBe(config.defaultModel);
});

test("resolveTierModel: crossProviderPool=true picks a member of tierModelPool for standard when roles.medium/high are unset", () => {
  const config = credentialedConfig({
    providers: { anthropic: "k1", gemini: "k3" },
    routing: { enabled: true, crossProviderPool: true },
  });
  const pool = tierModelPool("standard", config);
  expect(pool.length).toBeGreaterThan(1); // both anthropic + gemini contribute a mid-class model
  const picked = resolveTierModel("standard", config, "session-a");
  expect(pool).toContain(picked);
});

test("resolveTierModel: crossProviderPool session-stable — the same sessionId always resolves to the same model", () => {
  const config = credentialedConfig({
    providers: { anthropic: "k1", gemini: "k3" },
    routing: { enabled: true, crossProviderPool: true },
  });
  const a1 = resolveTierModel("standard", config, "session-fixed");
  const a2 = resolveTierModel("standard", config, "session-fixed");
  expect(a1).toBe(a2);
});

test("resolveTierModel: crossProviderPool spreads DIFFERENT sessions across MORE THAN ONE credentialed provider", () => {
  const config = credentialedConfig({
    providers: { anthropic: "k1", gemini: "k3" },
    routing: { enabled: true, crossProviderPool: true },
  });
  const picks = new Set<string>();
  for (let i = 0; i < 40; i++) picks.add(resolveTierModel("standard", config, `session-${i}`));
  // Not asserting a specific split (selectFromPool's hash is an implementation detail) —
  // only that pooling actually distributes across the pool rather than collapsing to
  // a single constant winner, which is the entire point of this feature.
  expect(picks.size).toBeGreaterThan(1);
});

test("resolveTierModel: explicit roles.medium/high still win over crossProviderPool (opt-in pooling never overrides user config)", () => {
  const config = credentialedConfig({
    providers: { anthropic: "k1", gemini: "k3" },
    roles: { medium: "claude-haiku-4-5" },
    routing: { enabled: true, crossProviderPool: true },
  });
  expect(resolveTierModel("standard", config, "session-a")).toBe("claude-haiku-4-5");
});

// --- selectFromPool / tierModelPool sanity (already-shipped helpers, now actually wired) ---

test("selectFromPool: no sessionId deterministically picks index 0 of the sorted pool", () => {
  const pool = tierModelPool("standard", credentialedConfig({ providers: { anthropic: "k1", gemini: "k3" } }));
  expect(selectFromPool(pool, undefined)).toBe(pool[0]);
});

// --- routePrompt end-to-end: the "high" tier is reachable through the real routing path ---

test("routePrompt: a borderline-complex prompt routes to the 'high' tier and resolves roles.high over the pricier xhigh/slow path", async () => {
  resetPromptRouterWarnings();
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = credentialedConfig({ roles: { high: "gpt-5.4", xhigh: "claude-fable-5" } }) as unknown as Parameters<typeof routePrompt>[1];
  const decision = (await routePrompt("Please refactor src/foo.ts", config)) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.tier).toBe("high");
  expect(decision.source).toBe("heuristic"); // 0.65 confidence >= default 0.6 threshold -> no escalation
  expect(decision.model).toBe("gpt-5.4"); // roles.high, NOT roles.xhigh
});

test("routePrompt: LLM escalation can return the new 'high' tier value (isPromptTier accepts it)", async () => {
  resetPromptRouterWarnings();
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tier: "high" }),
  }));
  const { routePrompt } = await import("../src/agent/prompt-router");
  const config = credentialedConfig({ roles: { smol: "gpt-5.5", high: "gpt-5.4" } }) as unknown as Parameters<typeof routePrompt>[1];
  // "why is this failing?" heuristically resolves to standard/0.35 (conflicting signals) —
  // below the default 0.6 threshold, so escalation is attempted.
  const decision = (await routePrompt("why is this failing?", config)) as RouteDecision;
  expect(decision).not.toBeNull();
  expect(decision.source).toBe("llm");
  expect(decision.tier).toBe("high");
  expect(decision.model).toBe("gpt-5.4");
});
