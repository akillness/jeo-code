import { test, expect } from "bun:test";
import { priceForModel, costForUsage, formatCost } from "../src/ai/pricing";
import { renderFooter } from "../src/tui/components/footer";
import { renderJeoStatus } from "../src/tui/components/status";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---- B3 pricing ----

test("priceForModel resolves families by substring incl. provider prefix", () => {
  expect(priceForModel("claude-sonnet-4-5-20250929")).toEqual({ inPerM: 3, outPerM: 15 });
  expect(priceForModel("claude-opus-4-5")).toEqual({ inPerM: 15, outPerM: 75 });
  expect(priceForModel("gpt-4o-mini")).toEqual({ inPerM: 0.15, outPerM: 0.6 });
  expect(priceForModel("gemini-2.5-flash")).toEqual({ inPerM: 0.3, outPerM: 2.5 });
});

test("priceForModel returns null for unknown/local models", () => {
  expect(priceForModel("ollama/qwen2.5:0.5b")).toBeNull();
  expect(priceForModel("some-unlisted-model")).toBeNull();
  expect(priceForModel(undefined)).toBeNull();
});

test("costForUsage computes USD; unknown model → null (never fabricated)", () => {
  // sonnet: 1M in × $3 + 0.5M out × $15 = 3 + 7.5 = 10.5
  expect(costForUsage("claude-sonnet-4-5", { inputTokens: 1_000_000, outputTokens: 500_000 })).toBeCloseTo(10.5, 6);
  expect(costForUsage("ollama/qwen", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeNull();
  expect(costForUsage("claude-sonnet-4-5", null)).toBeNull();
});

test("formatCost is compact and honest about tiny non-zero", () => {
  expect(formatCost(0)).toBe("$0.00");
  expect(formatCost(0.004)).toBe("<$0.01");
  expect(formatCost(0.42)).toBe("$0.42");
  expect(formatCost(12.34)).toBe("$12.3");
});

// ---- B3 footer/status cost render ----

test("renderFooter shows the cost segment only when costUsd > 0", () => {
  const withCost = renderFooter({ model: "claude-sonnet-4-5", costUsd: 0.42, color: false });
  expect(withCost).toContain("$0.42");
  const noCost = renderFooter({ model: "ollama/qwen", color: false });
  expect(noCost).not.toContain("$");
  const zero = renderFooter({ model: "claude-sonnet-4-5", costUsd: 0, color: false });
  expect(zero).not.toContain("$");
});

test("renderJeoStatus [STEP] row shows $cost and a (sub) marker for subagent turns", () => {
  const line = strip(renderJeoStatus({
    step: 2, maxSteps: 25, elapsedMs: 5000, color: false, unicode: true,
    usage: { inputTokens: 1000, outputTokens: 500 }, costUsd: 0.42, subagentActive: true,
  })[0]);
  expect(line).toContain("$0.42");
  expect(line).toContain("(sub)");
  // No cost shown when undefined/zero, no (sub) when inactive.
  const bare = strip(renderJeoStatus({
    step: 2, maxSteps: 25, elapsedMs: 5000, color: false, unicode: true,
    usage: { inputTokens: 1000, outputTokens: 500 },
  })[0]);
  expect(bare).not.toContain("$");
  expect(bare).not.toContain("(sub)");
});

// ---- B5 git dirty-flag ----

test("renderFooter renders the ?N dirty flag inside the branch segment", () => {
  const dirty = renderFooter({ model: "m", cwd: "/tmp/x", branch: "main", dirtyCount: 3, color: false });
  expect(dirty).toContain("(main ?3)");
  const clean = renderFooter({ model: "m", cwd: "/tmp/x", branch: "main", color: false });
  expect(clean).toContain("(main)");
  expect(clean).not.toContain("?");
  const zero = renderFooter({ model: "m", cwd: "/tmp/x", branch: "main", dirtyCount: 0, color: false });
  expect(zero).toContain("(main)");
  expect(zero).not.toContain("?");
});
