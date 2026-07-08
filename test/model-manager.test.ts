import { test, expect } from "bun:test";
import { resolveProvider, thinkingMaxTokens, resolveMaxOutputTokens, thinkingToReasoningEffort, effectiveCredentialForProvider, modelServableWithConfig, describeModel, resolveCall } from "../src/ai/model-manager";
import { resetLiveCodexModels, recordLiveCodexModels } from "../src/ai/model-catalog";
import type { Credential } from "../src/auth/storage";

test("effectiveCredentialForProvider: anthropic OAuth wins even when an API key is configured", () => {
  const oauth: Credential = { kind: "oauth", provider: "anthropic", token: "oauth-tok" };
  const eff = effectiveCredentialForProvider("anthropic", oauth, { providers: { anthropic: "sk-ant" } }, "claude-3-5-sonnet");
  expect(eff.kind).toBe("oauth");
});

test("effectiveCredentialForProvider: gemini OAuth does not win over API key (google/gemini-* requires API key)", () => {
  const oauth: Credential = { kind: "oauth", provider: "gemini", token: "oauth-tok" };
  const eff = effectiveCredentialForProvider("gemini", oauth, { providers: { gemini: "AIza" } }, "gemini-2.5-flash");
  expect(eff.kind).toBe("api_key");
});

test("effectiveCredentialForProvider: OpenAI OAuth serves Codex models but falls back to API key for others", () => {
  const oauth: Credential = { kind: "oauth", provider: "openai", token: "oauth-tok" };
  const codex = effectiveCredentialForProvider("openai", oauth, { providers: { openai: "sk-oai" } }, "gpt-5.5");
  expect(codex.kind).toBe("oauth");
  const other = effectiveCredentialForProvider("openai", oauth, { providers: { openai: "sk-oai" } }, "gpt-4o");
  expect(other.kind).toBe("api_key");
});

test("resolveProvider: routing is stable across model id shapes", () => {
  expect(resolveProvider("ollama/qwen2.5:0.5b")).toBe("ollama");
  expect(resolveProvider("openai/local-model")).toBe("openai");
  expect(resolveProvider("gpt-4o")).toBe("openai");
  expect(resolveProvider("gemini-2.5-flash")).toBe("gemini");
  expect(resolveProvider("google/gemini-pro")).toBe("gemini");
  expect(resolveProvider("claude-3-5-sonnet")).toBe("anthropic");
  // Reasoning models must route to OpenAI (previously fell through to anthropic).
  expect(resolveProvider("o1")).toBe("openai");
  expect(resolveProvider("o1-preview")).toBe("openai");
  expect(resolveProvider("o3-mini")).toBe("openai");
  expect(resolveProvider("o4-mini")).toBe("openai");
  expect(resolveProvider("openai/o3")).toBe("openai");
  expect(resolveProvider("GPT-4O")).toBe("openai");
  // Non-OpenAI ids with an embedded "o<digit>" must not be misrouted.
  expect(resolveProvider("claude-opus-4")).toBe("anthropic");
  expect(resolveProvider("echo1-model")).toBe("anthropic");
});

test("thinkingMaxTokens: maps level → token budget (medium default)", () => {
  expect(thinkingMaxTokens("low")).toBe(8000);
  expect(thinkingMaxTokens("medium")).toBe(16000);
  expect(thinkingMaxTokens("high")).toBe(24000);
  expect(thinkingMaxTokens(undefined)).toBe(16000);
});

test("resolveMaxOutputTokens: catalogued models use catalog max-output capped at 64k, NOT the thinking table", () => {
  // Fable-5/Sonnet-5 catalog 128k → capped at the 64k default. The thinking level
  // must no longer constrain output size (it steers depth via reasoningEffort).
  expect(resolveMaxOutputTokens("claude-fable-5", "xhigh")).toBe(64000);
  expect(resolveMaxOutputTokens("claude-sonnet-5", "low")).toBe(64000);
  // Catalog max BELOW the cap passes through (haiku 4.5 = 64k exactly, gpt-4o = 16384).
  expect(resolveMaxOutputTokens("claude-haiku-4-5", "high")).toBe(64000);
  expect(resolveMaxOutputTokens("gpt-4o", "high")).toBe(16384);
  // Aliases expand before lookup (sonnet → claude-sonnet-4-6, 128k → 64k cap).
  expect(resolveMaxOutputTokens("sonnet", "medium")).toBe(64000);
});

test("resolveMaxOutputTokens: uncatalogued/absent models keep the legacy thinking-table budget", () => {
  // ollama/qwen2.5:0.5b IS catalogued (8192 max output) — small catalog values pass through.
  expect(resolveMaxOutputTokens("ollama/qwen2.5:0.5b", "high")).toBe(8192);
  expect(resolveMaxOutputTokens("some-live-model", undefined)).toBe(16000);
  expect(resolveMaxOutputTokens(undefined, "low")).toBe(8000);
});

test("resolveMaxOutputTokens: JEO_MAX_OUTPUT_TOKENS raises/lowers the cap for catalogued models", () => {
  const prev = process.env.JEO_MAX_OUTPUT_TOKENS;
  try {
    process.env.JEO_MAX_OUTPUT_TOKENS = "128000";
    expect(resolveMaxOutputTokens("claude-fable-5", "high")).toBe(128000);
    process.env.JEO_MAX_OUTPUT_TOKENS = "8000";
    expect(resolveMaxOutputTokens("claude-fable-5", "high")).toBe(8000);
    // Invalid values fall back to the 64k default cap.
    process.env.JEO_MAX_OUTPUT_TOKENS = "not-a-number";
    expect(resolveMaxOutputTokens("claude-fable-5", "high")).toBe(64000);
  } finally {
    if (prev === undefined) delete process.env.JEO_MAX_OUTPUT_TOKENS;
    else process.env.JEO_MAX_OUTPUT_TOKENS = prev;
  }
});

test("thinkingToReasoningEffort: maps session level → provider reasoning tier", () => {
  expect(thinkingToReasoningEffort("low")).toBe("low");
  expect(thinkingToReasoningEffort("medium")).toBe("medium");
  // high AND xhigh both map to the deepest provider tier.
  expect(thinkingToReasoningEffort("high")).toBe("high");
  expect(thinkingToReasoningEffort("xhigh")).toBe("high");
  // Unset → undefined so the caller falls back to the global config.
  expect(thinkingToReasoningEffort(undefined)).toBeUndefined();
});

// --- modelServableWithConfig: the shared model-LEVEL credential gate behind
// auto-routing candidacy (isAutoSelectCandidate) and launch.ts's routing veto.
// Each block defends one rule of the contract; a flipped/dropped branch in the
// implementation (e.g. treating an antigravity API key as a credential, or
// letting OAuth-only OpenAI serve non-Codex ids) reddens the matching block. ---

test("modelServableWithConfig: local providers (ollama/lmstudio) are keyless — servable with ZERO credentials", () => {
  const empty = { providers: {}, oauth: {} };
  expect(modelServableWithConfig("ollama", "qwen2.5", empty)).toBe(true);
  expect(modelServableWithConfig("lmstudio", "some-local-model", empty)).toBe(true);
});

test("modelServableWithConfig: OAuth-only OpenAI serves ONLY Codex ids (gpt-5.5/gpt-5.4/gpt-5.4-mini), never the API catalog", () => {
  resetLiveCodexModels(); // isolate from any prior listProviderModels("openai", oauth) discovery in this run
  const oauthOnly = { providers: {}, oauth: { openai: "tok" } };
  expect(modelServableWithConfig("openai", "gpt-5.5", oauthOnly)).toBe(true);
  expect(modelServableWithConfig("openai", "gpt-5.4", oauthOnly)).toBe(true);
  expect(modelServableWithConfig("openai", "gpt-5.4-mini", oauthOnly)).toBe(true);
  // Provider-qualified ids (`openai/…`) are valid route targets — adapters strip
  // the prefix on the wire, so servability must match the bare id's verdict.
  expect(modelServableWithConfig("openai", "openai/gpt-5.5", oauthOnly)).toBe(true);
  // Non-Codex ids fail at call time with "set OPENAI_API_KEY" — the exact bug the gate prevents.
  expect(modelServableWithConfig("openai", "gpt-4o", oauthOnly)).toBe(false);
  expect(modelServableWithConfig("openai", "gpt-4o-mini", oauthOnly)).toBe(false);
  expect(modelServableWithConfig("openai", "o3", oauthOnly)).toBe(false);
  expect(modelServableWithConfig("openai", "openai/gpt-4o", oauthOnly)).toBe(false);
});

test("isCodexModel / oauthServesModel self-heal: a model OpenAI's live Codex endpoint confirms this session becomes servable even before it's added to the static list", () => {
  resetLiveCodexModels();
  const oauthOnly = { providers: {}, oauth: { openai: "tok" } };
  // A hypothetical future Codex model, not yet in CODEX_MODELS — rejected before discovery.
  expect(modelServableWithConfig("openai", "gpt-6-codex", oauthOnly)).toBe(false);
  // The live endpoint (via listProviderModels -> recordLiveCodexModels) confirms it...
  recordLiveCodexModels(["gpt-6-codex"]);
  // ...and the SAME gate now accepts it, with no release/code change needed.
  expect(modelServableWithConfig("openai", "gpt-6-codex", oauthOnly)).toBe(true);
  expect(modelServableWithConfig("openai", "openai/gpt-6-codex", oauthOnly)).toBe(true);
  // An id that was NEVER observed live and isn't in the static list still fails.
  expect(modelServableWithConfig("openai", "gpt-7-imaginary", oauthOnly)).toBe(false);
  resetLiveCodexModels();
});

test("recordLiveCodexModels: additive ACROSS separate discovery calls — a later call with a different id list never forgets an earlier-observed id", () => {
  // Guards against a REPLACE implementation (e.g. clearing the Set before adding
  // the new batch) — a transient discovery response missing a previously-confirmed
  // id must never un-widen the gate for that id (see recordLiveCodexModels' own
  // "additive only" doc comment).
  resetLiveCodexModels();
  const oauthOnly = { providers: {}, oauth: { openai: "tok" } };
  recordLiveCodexModels(["gpt-6-codex"]);
  expect(modelServableWithConfig("openai", "gpt-6-codex", oauthOnly)).toBe(true);
  // A second, later discovery call returns a DIFFERENT list that does not include
  // the first id (e.g. paginated/partial response, or the account's list simply
  // changed order/content this time).
  recordLiveCodexModels(["gpt-7-other"]);
  expect(modelServableWithConfig("openai", "gpt-7-other", oauthOnly)).toBe(true);
  // The earlier id must STILL be servable — recording is additive, never a reset.
  expect(modelServableWithConfig("openai", "gpt-6-codex", oauthOnly)).toBe(true);
  resetLiveCodexModels();
});

test("modelServableWithConfig: an API key serves the provider's FULL catalog (keys are never model-scoped)", () => {
  expect(modelServableWithConfig("openai", "gpt-4o", { providers: { openai: "sk-oai" }, oauth: {} })).toBe(true);
  expect(modelServableWithConfig("gemini", "gemini-3-flash", { providers: { gemini: "AIza" }, oauth: {} })).toBe(true);
  // API key wins even when a (Codex-limited) OAuth token is ALSO stored.
  expect(modelServableWithConfig("openai", "gpt-4o", { providers: { openai: "sk-oai" }, oauth: { openai: "tok" } })).toBe(true);
});

test("modelServableWithConfig: a configured OpenAI base URL is the keyless local-proxy path — any model", () => {
  const baseUrlOnly = { providers: {}, oauth: {}, openaiBaseUrl: "http://localhost:8080/v1" };
  expect(modelServableWithConfig("openai", "gpt-4o", baseUrlOnly)).toBe(true);
  expect(modelServableWithConfig("openai", "totally-local-model", baseUrlOnly)).toBe(true);
  // The base URL even overrides an OAuth token's Codex-only limit (local proxy serves anything).
  expect(modelServableWithConfig("openai", "gpt-4o", { providers: {}, oauth: { openai: "tok" }, openaiBaseUrl: "http://localhost:8080/v1" })).toBe(true);
});

test("modelServableWithConfig: OAuth-only gemini serves NOTHING (Cloud Code Assist masquerade removed — GEMINI_API_KEY required)", () => {
  const oauthOnly = { providers: {}, oauth: { gemini: "tok" } };
  expect(modelServableWithConfig("gemini", "gemini-3-flash", oauthOnly)).toBe(false);
  expect(modelServableWithConfig("gemini", "gemini-2.5-pro", oauthOnly)).toBe(false);
});

test("modelServableWithConfig: antigravity is OAuth-ONLY — an API key alone can never serve it", () => {
  // resolveCall throws for a keyed antigravity call; the gate must agree.
  expect(modelServableWithConfig("antigravity", "antigravity/gemini-3.1-pro-high", { providers: { antigravity: "key" }, oauth: {} })).toBe(false);
  // Its own OAuth login serves it…
  expect(modelServableWithConfig("antigravity", "antigravity/gemini-3.1-pro-high", { providers: {}, oauth: { antigravity: "tok" } })).toBe(true);
  // …and so does the gemini OAuth fallback credential.
  expect(modelServableWithConfig("antigravity", "antigravity/gemini-3.1-pro-high", { providers: {}, oauth: { gemini: "tok" } })).toBe(true);
});

test("modelServableWithConfig: OAuth-only kimi serves ONLY the Kimi Code catalog (kimi/ prefix stripped for the check)", () => {
  const oauthOnly = { providers: {}, oauth: { kimi: "tok" } };
  expect(modelServableWithConfig("kimi", "kimi/kimi-k2.5", oauthOnly)).toBe(true);
  expect(modelServableWithConfig("kimi", "kimi-k2.5", oauthOnly)).toBe(true);
  // Moonshot API-platform ids 404 against api.kimi.com/coding — need KIMI_API_KEY.
  expect(modelServableWithConfig("kimi", "kimi-latest", oauthOnly)).toBe(false);
  expect(modelServableWithConfig("kimi", "moonshot-v1-128k", oauthOnly)).toBe(false);
});

test("modelServableWithConfig: no credential at all -> not servable (cloud providers)", () => {
  const empty = { providers: {}, oauth: {} };
  expect(modelServableWithConfig("openai", "gpt-5.5", empty)).toBe(false);
  expect(modelServableWithConfig("anthropic", "claude-sonnet-4-6", empty)).toBe(false);
  expect(modelServableWithConfig("gemini", "gemini-3-flash", empty)).toBe(false);
  expect(modelServableWithConfig("antigravity", "antigravity/gemini-3.1-pro-high", empty)).toBe(false);
});

test("modelServableWithConfig: verified end-to-end OAuth (anthropic) serves its models without an API key", () => {
  expect(modelServableWithConfig("anthropic", "claude-sonnet-4-6", { providers: {}, oauth: { anthropic: "tok" } })).toBe(true);
});

test("describeModel: deprecated antigravity/gemini-3.1-pro-high resolves to its successor gemini-pro-agent via BUILTIN_ALIASES", async () => {
  // The Antigravity backend deprecated this wire id (deprecatedModelIds →
  // newModelId: gemini-pro-agent); configs/roles pinned to the old id must keep
  // working. Explicit empty config keeps the test off the user's global config.
  const d = await describeModel("antigravity/gemini-3.1-pro-high", {});
  expect(d.resolved).toBe("antigravity/gemini-pro-agent");
  expect(d.provider).toBe("antigravity");
  // The successor id itself passes through unchanged (not an alias loop).
  expect((await describeModel("antigravity/gemini-pro-agent", {})).resolved).toBe("antigravity/gemini-pro-agent");
});

test("describeModel: user modelAliases override the built-in deprecation mapping (config wins over BUILTIN_ALIASES)", async () => {
  const d = await describeModel("antigravity/gemini-3.1-pro-high", {
    modelAliases: { "antigravity/gemini-3.1-pro-high": "claude-sonnet-4-6" },
  });
  expect(d.resolved).toBe("claude-sonnet-4-6");
});

test("modelServableWithConfig: antigravity OAuth serves the Anthropic-via-Antigravity rows, not just gemini-* wire ids", () => {
  const oauthOnly = { providers: {}, oauth: { antigravity: "tok" } };
  expect(modelServableWithConfig("antigravity", "antigravity/claude-sonnet-4-6", oauthOnly)).toBe(true);
  expect(modelServableWithConfig("antigravity", "antigravity/claude-opus-4-6-thinking", oauthOnly)).toBe(true);
});

test("resolveCall: reasoningEffort 'none' explicitly disables thinking, ignoring the global default", async () => {
  // Mock/override the global config to have thinkingLevel = "medium"
  const originalConfigDir = process.env.JEO_CONFIG_DIR;
  const tempDir = require("node:os").tmpdir() + "/jeo-test-none-" + Math.random().toString(36).slice(2);
  require("node:fs").mkdirSync(tempDir, { recursive: true });
  process.env.JEO_CONFIG_DIR = tempDir;

  try {
    // Write a temp config with thinkingLevel = "medium" and defaultModel = "claude-sonnet-4-6"
    const configPath = require("node:path").join(tempDir, "config.json");
    require("node:fs").writeFileSync(configPath, JSON.stringify({
      defaultModel: "claude-sonnet-4-6",
      thinkingLevel: "medium",
      providers: { anthropic: "sk-mock" }
    }));

    // 1. Without reasoningEffort override: falls back to global default (medium -> medium)
    const resDefault = await resolveCall({ model: "claude-sonnet-4-6" });
    expect(resDefault.callOptions.reasoningEffort).toBe("medium");

    // 2. With reasoningEffort: "none": disables thinking (resolves to undefined)
    const resNone = await resolveCall({ model: "claude-sonnet-4-6", reasoningEffort: "none" });
    expect(resNone.callOptions.reasoningEffort).toBeUndefined();

    // 3. With explicit level override: honors the override (low -> low)
    const resLow = await resolveCall({ model: "claude-sonnet-4-6", reasoningEffort: "low" });
    expect(resLow.callOptions.reasoningEffort).toBe("low");
  } finally {
    if (originalConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = originalConfigDir;
    require("node:fs").rmSync(tempDir, { recursive: true, force: true });
  }
});