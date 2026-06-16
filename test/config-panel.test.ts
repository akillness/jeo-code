import { test, expect } from "bun:test";
import {
  formatModelLine,
  formatAliasLines,
  formatProviderPanel,
  emitLoginCleanup,
  formatAgentsPanel,
  formatAgentDetail,
  formatConfigPanel,
  formatLiveModels,
  liveModelKnown,
  formatPickList,
  formatPickListWithCapabilities,
  formatCanonicalCatalogTable,
} from "../src/tui/components/config-panel";
import { SUBAGENT_ROLES, getSubagentRole } from "../src/agent/subagents";
import type { ProviderStatus } from "../src/ai/provider-status";
import type { ProviderModelsResult } from "../src/ai/model-discovery";
import { flattenModels } from "../src/ai/model-picker";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("formatModelLine shows alias expansion, provider, and credential mark", () => {
  expect(strip(formatModelLine({ label: "fast", resolved: "ollama/qwen2.5:0.5b", provider: "ollama" })))
    .toBe("fast → ollama/qwen2.5:0.5b (ollama · Ollama)");
  expect(strip(formatModelLine({ label: "gpt-4o", resolved: "gpt-4o", provider: "openai" })))
    .toBe("gpt-4o (openai · OpenAI)");
  expect(strip(formatModelLine({ label: "claude", resolved: "claude", provider: "anthropic", ready: false })))
    .toContain("no credential");
  expect(strip(formatModelLine({ label: "claude", resolved: "claude", provider: "anthropic", ready: true })))
    .toContain("✓");
});

test("formatAliasLines sorts by alias and pads", () => {
  const out = formatAliasLines({ sonnet: "claude-3-5-sonnet", fast: "ollama/x" }).map(strip);
  expect(out[0]).toContain("fast");
  expect(out[1]).toContain("sonnet");
  expect(formatAliasLines({})).toEqual(["  (no aliases)"]);
});

test("formatProviderPanel marks ready vs not and shows base URL", () => {
  const statuses: ProviderStatus[] = [
    { name: "anthropic", kind: "none", label: "none", ready: false, envVar: "ANTHROPIC_API_KEY" },
    { name: "ollama", kind: "keyless", label: "keyless (local)", ready: true, baseUrl: "http://localhost:11434" },
  ];
  const out = formatProviderPanel(statuses).map(strip);
  expect(out[0]).toContain("·"); // not ready
  expect(out[1]).toContain("✓");
  expect(out[1]).toContain("http://localhost:11434");
  expect(out[0]).toContain("anthropic (Anthropic)");
  expect(out[1]).toContain("ollama (Ollama)");
});

test("formatAgentsPanel lists roles with resolved model/steps and read-only tag", () => {
  const out = formatAgentsPanel(SUBAGENT_ROLES, r => ({ model: "m", maxSteps: r.defaultMaxSteps })).map(strip);
  expect(out.find(l => l.includes("executor"))).toContain("≤15 steps");
  expect(out.find(l => l.includes("planner"))).toContain("(read-only)");
  expect(out.find(l => l.includes("executor"))).not.toContain("(read-only)");
});

test("formatAgentDetail reports mutation capability", () => {
  const ro = formatAgentDetail(getSubagentRole("critic")!, { model: "m", maxSteps: 8 }).map(strip);
  expect(ro.join("\n")).toContain("read-only");
  const ex = formatAgentDetail(getSubagentRole("executor")!, { model: "m", maxSteps: 15 }).map(strip);
  expect(ex.join("\n")).toContain("full toolset");
});

test("formatConfigPanel includes model, thinking, and conditional fields", () => {
  const out = formatConfigPanel({
    model: "fast",
    resolved: "ollama/q",
    provider: "ollama",
    thinkingLevel: "high",
    ollamaBaseUrl: "http://localhost:11434",
    requestMaxRetries: 4,
    sessionId: "abc",
  }).map(strip);
  const joined = out.join("\n");
  expect(joined).toContain("thinking:  high");
  expect(joined).toContain("ollama:");
  expect(joined).toContain("retries:   4");
  expect(joined).toContain("session:   abc");
  // openaiBaseUrl omitted → no openai line
  expect(joined).not.toContain("openai:");
});

const LIVE: ProviderModelsResult[] = [
  { provider: "openai", ok: true, source: "oauth", models: ["gpt-4o", "o3"] },
  { provider: "anthropic", ok: false, source: "none", error: "not logged in", models: [] },
  { provider: "ollama", ok: true, source: "keyless", models: [] },
];

test("formatLiveModels groups by provider, marks current, surfaces errors", () => {
  const out = formatLiveModels(LIVE, { current: "gpt-4o" }).map(strip);
  const joined = out.join("\n");
  expect(joined).toContain("openai (oauth): 2 models");
  expect(joined).toContain("gpt-4o ◀ current");
  expect(joined).toContain("o3");
  expect(joined).toContain("anthropic (none): not logged in");
  // reachable-but-empty ollama row is skipped
  expect(joined).not.toContain("ollama (keyless)");
});

test("formatLiveModels caps per-provider and shows overflow", () => {
  const many: ProviderModelsResult[] = [
    { provider: "openai", ok: true, source: "api_key", models: Array.from({ length: 30 }, (_, i) => `m${i}`) },
  ];
  const out = formatLiveModels(many, { perProvider: 5 }).map(strip);
  expect(out.some(l => l.includes("(+25 more)"))).toBe(true);
});

test("formatLiveModels with nothing usable hints at login", () => {
  const out = formatLiveModels([{ provider: "ollama", ok: true, source: "keyless", models: [] }]).map(strip);
  expect(out.join("\n")).toContain("no live models");
});

test("liveModelKnown matches only ok provider lists", () => {
  expect(liveModelKnown(LIVE, "gpt-4o")).toBe(true);
  expect(liveModelKnown(LIVE, "claude-x")).toBe(false); // anthropic failed → not counted
  expect(liveModelKnown(LIVE, "nope")).toBe(false);
});

test("formatPickList numbers each model and marks the current one", () => {
  const flat = flattenModels([
    { provider: "openai", ok: true, source: "oauth", models: ["gpt-4o", "o3"] },
    { provider: "gemini", ok: true, source: "api_key", models: ["gemini-2.0-flash"] },
  ]);
  const out = formatPickList(flat, { current: "o3" }).map(strip);
  expect(out[0]).toContain("#1");
  expect(out[0]).toContain("gpt-4o");
  expect(out[0]).toContain("(openai)");
  expect(out[1]).toContain("#2  o3");
  expect(out[1]).toContain("◀ current");
  expect(out[2]).toContain("#3  gemini-2.0-flash");
});

test("formatPickList empty → login hint, and caps with overflow", () => {
  expect(formatPickList([]).join("\n")).toContain("no models");
  const many = flattenModels([{ provider: "openai", ok: true, source: "oauth", models: Array.from({ length: 70 }, (_, i) => `m${i}`) }]);
  const out = formatPickList(many, { cap: 10 }).map(strip);
  expect(out.some(l => l.includes("+60 more"))).toBe(true);
});

test("formatPickListWithCapabilities numbers live models with capability columns", () => {
  const flat = flattenModels([
    { provider: "openai", ok: true, source: "oauth", models: ["gpt-4o", "unknown-live-model"] },
  ]);
  const out = formatPickListWithCapabilities(flat, { current: "gpt-4o" }).map(strip);
  const joined = out.join("\n");
  expect(out[0]).toContain("provider");
  expect(out[0]).toContain("thinking");
  expect(joined).toContain("#1");
  expect(joined).toContain("128K");
  expect(joined).toContain("◀ current");
  expect(joined).toContain("unknown-live-model");
  expect(joined).toContain("?");
});

test("formatCanonicalCatalogTable renders GJC-style canonical rows", () => {
  const out = formatCanonicalCatalogTable([
    { canonical: "alpha", provider: "openai", providerModel: "alpha-1", contextTokens: 128_000, maxOutputTokens: 16_384, thinking: [], images: true },
    { canonical: "alpha", provider: "openai", providerModel: "alpha-2", contextTokens: 200_000, maxOutputTokens: 32_768, thinking: ["low"], images: true },
    { canonical: "beta", provider: "gemini", providerModel: "beta-1", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: ["low"], images: true },
  ], { current: "openai/alpha-2" }).map(strip);
  const joined = out.join("\n");
  expect(out[0]).toContain("canonical");
  expect(out[0]).toContain("selected");
  expect(out[0]).toContain("variants");
  expect(joined).toContain("alpha");
  expect(joined).toContain("openai/alpha-2");
  expect(joined).toContain("2");
  expect(joined).toContain("◀");
});

test("emitLoginCleanup clears + re-renders welcome then one confirmation (TTY)", () => {
  const ops: string[] = [];
  emitLoginCleanup(
    { clear: () => ops.push("CLEAR"), write: l => ops.push(`W:${l}`) },
    { isTty: true, provider: "openai", email: "me@x.com", ready: true, welcomeLines: ["WELCOME"] },
  );
  // Order: clear → welcome → confirmation.
  expect(ops).toEqual([
    "CLEAR",
    "W:WELCOME",
    "W:✓ Logged in to openai (me@x.com). Pick a model with /model.",
  ]);
});

test("emitLoginCleanup skips the clear/welcome off a TTY — just the confirmation", () => {
  const ops: string[] = [];
  emitLoginCleanup(
    { clear: () => ops.push("CLEAR"), write: l => ops.push(l) },
    { isTty: false, provider: "gemini", ready: true, welcomeLines: ["WELCOME"] },
  );
  expect(ops).toEqual(["✓ Logged in to gemini. Pick a model with /model."]);
});

test("emitLoginCleanup notes a not-ready provider's label, omits email when absent", () => {
  const ops: string[] = [];
  emitLoginCleanup(
    { clear: () => {}, write: l => ops.push(l) },
    { isTty: false, provider: "antigravity", ready: false, label: "needs jeo auth", welcomeLines: [] },
  );
  expect(ops[0]).toBe("✓ Logged in to antigravity — needs jeo auth. Pick a model with /model.");
});
