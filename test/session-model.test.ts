import { afterEach, beforeEach, expect, test } from "bun:test";
import { isModelAuthenticated, resolveStartupDefaultModel } from "../src/agent/session-model";
import type { Config } from "../src/agent/state";

// The unauthenticated scenarios must not be rescued by keys that happen to be set in the
// developer's or CI's environment, so the credential env vars are cleared for this file.
const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "GEMINI_API_KEY", "XAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_OAUTH_TOKEN", "GEMINI_OAUTH_TOKEN"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const config = (over: Partial<Config>): Config => ({ providers: {}, defaultModel: "claude-haiku-5-5", thinkingLevel: "medium", ...over });
const oauth = (access = "tok") => ({ access, refresh: "r", expires: Date.now() + 3_600_000 });

test("a default model the login serves is kept as is, with no notice", async () => {
  const cfg = config({ providers: { anthropic: "sk-ant" }, recentModels: ["claude-haiku-5-5", "gpt-6.1-terra"] });
  expect(await resolveStartupDefaultModel(cfg)).toEqual({ model: "claude-haiku-5-5" });
});

test("a default whose provider has no login falls back to the first authenticated recent model and says so", async () => {
  const cfg = config({
    defaultModel: "claude-haiku-5-5", // anthropic: no credential at all
    oauth: { antigravity: oauth() },
    recentModels: ["claude-haiku-5-5", "gpt-6.1-terra", "antigravity/gemini-3.8-flash-tiered"],
  });
  const result = await resolveStartupDefaultModel(cfg);
  expect(result.model).toBe("antigravity/gemini-3.8-flash-tiered");
  expect(result.fellBackFrom).toBe("claude-haiku-5-5");
  expect(result.notice).toContain("claude-haiku-5-5");
  expect(result.notice).toContain("antigravity/gemini-3.8-flash-tiered");
  expect(result.notice).toContain("jeo auth login anthropic");
});

test("a ChatGPT OAuth login does not authenticate a non-Codex OpenAI default", async () => {
  // Provider readiness alone says openai is ready; the model-level gate must still reject it,
  // otherwise the session opens on a model whose first turn fails with "set OPENAI_API_KEY".
  const cfg = config({ defaultModel: "gpt-6.1-terra", oauth: { openai: oauth(), antigravity: oauth() }, recentModels: ["gpt-6.1-terra", "antigravity/gemini-3.8-flash-tiered"] });
  expect(await isModelAuthenticated("gpt-6.1-terra", cfg)).toBe(false);
  expect((await resolveStartupDefaultModel(cfg)).model).toBe("antigravity/gemini-3.8-flash-tiered");
});

test("role tiers are fallback candidates after recents", async () => {
  const cfg = config({ defaultModel: "claude-haiku-5-5", oauth: { antigravity: oauth() }, roles: { medium: "antigravity/gemini-3.8-flash-tiered" } });
  expect((await resolveStartupDefaultModel(cfg)).model).toBe("antigravity/gemini-3.8-flash-tiered");
});

test("with no authenticated model anywhere the configured default is kept so the first turn reports the real error", async () => {
  const cfg = config({ defaultModel: "claude-haiku-5-5", recentModels: ["gpt-6.1-terra"] });
  expect(await resolveStartupDefaultModel(cfg)).toEqual({ model: "claude-haiku-5-5" });
});

test("a fallback is session-local: the configured default string is untouched", async () => {
  const cfg = config({ defaultModel: "claude-haiku-5-5", oauth: { antigravity: oauth() }, recentModels: ["antigravity/gemini-3.8-flash-tiered"] });
  await resolveStartupDefaultModel(cfg);
  expect(cfg.defaultModel).toBe("claude-haiku-5-5");
});

test("a probe that throws keeps the configured default instead of breaking startup", async () => {
  const cfg = config({ recentModels: ["gpt-6.1-terra"] });
  const boom = async () => { throw new Error("probe exploded"); };
  expect(await resolveStartupDefaultModel(cfg, boom)).toEqual({ model: "claude-haiku-5-5" });
});

test("an expired OAuth entry with no refresh token is not an authenticated login", async () => {
  const dead = { access: "x", expires: Date.now() - 1000 };
  const cfg = config({ defaultModel: "antigravity/gemini-3.8-flash-tiered", oauth: { antigravity: dead } });
  expect(await isModelAuthenticated("antigravity/gemini-3.8-flash-tiered", cfg)).toBe(false);
});

test("local providers are keyless and always count as authenticated", async () => {
  expect(await isModelAuthenticated("ollama/fast", config({}))).toBe(true);
});
