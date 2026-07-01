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
  loginHint,
  loginExpiryLabel,
  buildLoginChoices,
  buildOnboardingChoices,
  onboardingPicker,
  apiKeyHint,
  buildApiKeyChoices,
  subscriptionHint,
  buildSubscriptionLoginChoices,
  isSubscriptionProvider,
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
  const sonnet = findCatalogEntry("claude-sonnet-4-6")!;
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
  const sonnetChoice = choices.find(c => c.value === "claude-sonnet-4-6");
  expect(sonnetChoice?.label).toBe("claude-sonnet-4-6 (Anthropic)");
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

test("buildProviderChoices marks the current provider in its hint", () => {
  const statuses = [status("anthropic", true), status("openai", true)];
  const choices = buildProviderChoices(statuses, true, "openai");
  const openai = choices.find(c => c.value === "openai")!;
  const anthropic = choices.find(c => c.value === "anthropic")!;
  expect(openai.hint).toContain("● current");
  expect(anthropic.hint).not.toContain("current");
  // No current given → no marker anywhere.
  expect(buildProviderChoices(statuses, true).every(c => !c.hint?.includes("current"))).toBe(true);
});

test("recommendedProvider is the first ready provider", () => {
  expect(recommendedProvider([status("anthropic", false), status("ollama", true)])).toBe("ollama");
  expect(recommendedProvider([status("anthropic", false)])).toBe("anthropic"); // none ready → first
  expect(recommendedProvider([])).toBeUndefined();
});

test("loginExpiryLabel renders relative expiry or 'expired'", () => {
  const now = 1_000_000_000_000;
  expect(loginExpiryLabel(undefined, now)).toBeUndefined();
  expect(loginExpiryLabel(now - 1000, now)).toBe("expired");
  expect(loginExpiryLabel(now + 30 * 60_000, now)).toBe("expires in 30m");
  expect(loginExpiryLabel(now + 3 * 3_600_000, now)).toBe("expires in 3h");
});

test("loginHint shows live OAuth login status (account + expiry)", () => {
  const out = status("anthropic", true, {
    loggedIn: true,
    oauthEmail: "me@example.com",
    oauthExpires: Date.now() + 90 * 60_000,
  });
  const h = loginHint(out, true);
  expect(h).toContain("✓ logged in");
  expect(h).toContain("me@example.com");
  expect(h).toContain("expires in");
  // Not logged in → muted hint.
  expect(loginHint(status("openai", false), true)).toBe("· not logged in");
  expect(loginHint(status("openai", false), false)).toBe("not logged in");
});

test("buildLoginChoices sorts logged-in providers first and groups them", () => {
  const statuses = [
    status("anthropic", false, { loggedIn: false }),
    status("openai", true, { loggedIn: true, oauthEmail: "u@o.ai" }),
  ];
  const choices = buildLoginChoices(statuses, false);
  expect(choices[0]!.value).toBe("openai"); // logged in first
  expect(choices[0]!.group).toBe("logged in");
  expect(choices[1]!.group).toBe("not logged in");
  expect(choices[0]!.hint).toContain("u@o.ai");
});

test("buildOnboardingChoices offers OAuth-login first, then API-key, then API-compatible setup", () => {
  const choices = buildOnboardingChoices(false);
  expect(choices.map(c => c.value)).toEqual(["oauth-login", "api-key", "api-add"]);
  expect(choices[0]!.label).toContain("OAuth");
  expect(choices[1]!.label).toContain("API key");
  expect(choices[2]!.label).toContain("API-compatible");
  expect(choices[2]!.hint).toContain("/provider add");
  // unicode arrow is opt-in (default true), suppressed when unicode=false
  expect(choices[0]!.hint).not.toContain("\u2192");
  expect(buildOnboardingChoices(true)[0]!.hint).toContain("\u2192");
});

test("onboardingPicker selects the first (OAuth-login) action by default", () => {
  const list = onboardingPicker(true);
  expect(list.selected()?.value).toBe("oauth-login");
  list.down();
  expect(list.selected()?.value).toBe("api-key");
  list.down();
  expect(list.selected()?.value).toBe("api-add");
});

test("apiKeyHint reflects whether a key is stored, plus the env var", () => {
  const set = status("groq", true, { kind: "api_key", envVar: "GROQ_API_KEY" });
  expect(apiKeyHint(set, true)).toContain("\u2713 key set");
  expect(apiKeyHint(set, true)).toContain("GROQ_API_KEY");
  const unset = status("deepseek", false, { kind: "none", envVar: "DEEPSEEK_API_KEY" });
  expect(apiKeyHint(unset, true)).toContain("no key");
  expect(apiKeyHint(unset, false)).toBe("no key · DEEPSEEK_API_KEY");
});

test("buildApiKeyChoices sorts keyed providers first and groups them", () => {
  const statuses = [
    status("groq", false, { kind: "none", envVar: "GROQ_API_KEY" }),
    status("deepseek", true, { kind: "api_key", envVar: "DEEPSEEK_API_KEY" }),
  ];
  const choices = buildApiKeyChoices(statuses, false);
  expect(choices[0]!.value).toBe("deepseek"); // key set first
  expect(choices[0]!.group).toBe("key set");
  expect(choices[1]!.group).toBe("needs key");
});
test("isSubscriptionProvider flags coding-plan/portal/token-plan/code products", () => {
  expect(isSubscriptionProvider("alibaba-coding-plan")).toBe(true);
  expect(isSubscriptionProvider("qwen-portal")).toBe(true);
  expect(isSubscriptionProvider("xiaomi-token-plan-ams")).toBe(true);
  expect(isSubscriptionProvider("minimax-code")).toBe(true);
  // pay-per-token APIs and OAuth providers are NOT subscriptions
  expect(isSubscriptionProvider("groq")).toBe(false);
  expect(isSubscriptionProvider("anthropic")).toBe(false);
  expect(isSubscriptionProvider("xiaomi")).toBe(false);
});

test("subscriptionHint reflects token status + env var", () => {
  const active = status("qwen-portal", true, { kind: "api_key", envVar: "QWEN_PORTAL_API_KEY" });
  expect(subscriptionHint(active, true)).toContain("✓ active");
  expect(subscriptionHint(active, true)).toContain("QWEN_PORTAL_API_KEY");
  const off = status("minimax-code", false, { kind: "none", envVar: "MINIMAX_CODE_API_KEY" });
  expect(subscriptionHint(off, true)).toContain("no token");
  expect(subscriptionHint(off, false)).toBe("no token · MINIMAX_CODE_API_KEY");
});

test("buildSubscriptionLoginChoices lists OAuth providers then subscriptions", () => {
  const oauth = [
    status("anthropic", false, { loggedIn: false }),
    status("openai", true, { loggedIn: true, oauthEmail: "u@o.ai" }),
  ];
  const subs = [
    status("qwen-portal", false, { kind: "none", envVar: "QWEN_PORTAL_API_KEY" }),
    status("alibaba-coding-plan", true, { kind: "api_key", envVar: "ALIBABA_CODING_PLAN_API_KEY" }),
  ];
  const choices = buildSubscriptionLoginChoices(oauth, subs, false);
  // OAuth group first (logged-in sorted first), then subscription group (active first)
  expect(choices[0]!.value).toBe("openai");
  expect(choices[0]!.group).toBe("OAuth login");
  expect(choices[1]!.value).toBe("anthropic");
  expect(choices[2]!.value).toBe("alibaba-coding-plan"); // active subscription first
  expect(choices[2]!.group).toBe("subscription / plan");
  expect(choices[3]!.value).toBe("qwen-portal");
  expect(choices[2]!.hint).toContain("active");
  expect(choices[3]!.hint).toContain("no token");
});
