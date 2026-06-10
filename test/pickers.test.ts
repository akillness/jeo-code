import { test, expect } from "bun:test";
import {
  formatContextWindow,
  modelHint,
  buildModelChoices,
  modelPicker,
} from "../src/tui/components/model-picker";
import {
  providerHint,
  buildProviderChoices,
  recommendedProvider,
} from "../src/tui/components/provider-picker";
import { findCatalogEntry } from "../src/ai/model-catalog-compat";
import type { ProviderStatus } from "../src/ai/provider-status";

const status = (name: ProviderStatus["name"], ready: boolean, extra: Partial<ProviderStatus> = {}): ProviderStatus => ({
  name,
  kind: ready ? "api_key" : "none",
  label: ready ? "API key" : "none",
  ready,
  ...extra,
});

test("formatContextWindow renders k/M units", () => {
  expect(formatContextWindow(200_000)).toBe("200k ctx");
  expect(formatContextWindow(1_000_000)).toBe("1M ctx");
  expect(formatContextWindow(2_000_000)).toBe("2M ctx");
  expect(formatContextWindow(0)).toBe("");
});

test("modelHint badges reasoning / recommended / readiness", () => {
  const o1 = findCatalogEntry("o3")!; // reasoning model
  const h = modelHint(o1, false, true);
  expect(h).toContain("reasoning");
  expect(h).toContain("no credential");
  const sonnet = findCatalogEntry("claude-sonnet-4-5")!;
  expect(modelHint(sonnet, true, true)).toContain("recommended");
  expect(modelHint(sonnet, true, true)).toContain("ready");
});

test("buildModelChoices lists ready providers first and groups them", () => {
  const statuses = [status("anthropic", false), status("openai", true), status("gemini", false), status("ollama", true)];
  const choices = buildModelChoices(statuses, { unicode: false });
  // first group should be a ready provider (openai or ollama), branded with the company
  expect(["openai — OpenAI", "ollama — Ollama"]).toContain(choices[0]!.group);
  // every catalogued model id appears
  expect(choices.some(c => c.value === "gpt-4o")).toBe(true);
  const sonnetChoice = choices.find(c => c.value === "claude-sonnet-4-5");
  expect(sonnetChoice?.label).toBe("claude-sonnet-4-5 (Anthropic)");
  // unready providers carry a "(no credential)" group label
  expect(choices.some(c => c.group === "anthropic — Anthropic (no credential)")).toBe(true);
});

test("modelPicker excludes unready providers when includeUnready:false", () => {
  const statuses = [status("anthropic", false), status("openai", true), status("gemini", false), status("ollama", false)];
  const list = modelPicker(statuses, { includeUnready: false });
  expect(list.visible().every(i => i.group === "openai — OpenAI")).toBe(true);
});

test("providerHint + buildProviderChoices sort ready first", () => {
  const statuses = [status("anthropic", false), status("openai", true, { baseUrl: "http://x" })];
  const choices = buildProviderChoices(statuses, false);
  expect(choices[0]!.value).toBe("openai"); // ready first
  expect(choices[0]!.label).toBe("openai (OpenAI)");
  expect(choices[1]!.label).toBe("anthropic (Anthropic)");
  expect(choices[0]!.group).toBe("ready");
  expect(choices[1]!.group).toBe("needs setup");
  expect(providerHint(statuses[1]!, false)).toContain("http://x");
});

test("recommendedProvider is the first ready provider", () => {
  expect(recommendedProvider([status("anthropic", false), status("ollama", true)])).toBe("ollama");
  expect(recommendedProvider([status("anthropic", false)])).toBe("anthropic"); // none ready → first
  expect(recommendedProvider([])).toBeUndefined();
});
