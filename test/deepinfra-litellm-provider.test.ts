import { test, expect } from "bun:test";
import { resolveProvider, qualifyModelId, providerModelFor } from "../src/ai/model-manager";
import { PROVIDER_NAMES, providerEnvVar, describeProvider } from "../src/ai/provider-status";
import { companyLabel } from "../src/ai/model-catalog";
import { openaiCompatDef } from "../src/ai/providers/openai-compatible-catalog";

// gjc parity: current gjc `packages/ai/src/models.json` provider list has these two
// entries jeo lacked (verified directly against a shallow clone of the real, public
// gajae-code source — not inferred). Both are catalog-driven OpenAI-compatible clouds
// (ONE table row each, per openai-compatible-catalog.ts's own design), registered
// generically — no bespoke adapter code needed.

test("deepinfra is a registered provider with the DEEPINFRA_API_KEY env and DeepInfra label", () => {
  expect(PROVIDER_NAMES).toContain("deepinfra");
  expect(providerEnvVar("deepinfra")).toBe("DEEPINFRA_API_KEY");
  expect(companyLabel("deepinfra")).toBe("DeepInfra");
  expect(openaiCompatDef("deepinfra")?.baseUrl).toBe("https://api.deepinfra.com/v1/openai");
});

test("deepinfra ids route to the deepinfra provider", () => {
  expect(resolveProvider("deepinfra/deepseek-ai/DeepSeek-V3.2")).toBe("deepinfra");
  // Not a catalogued bare id (unlike tencent's model-catalog.ts rows) — qualifyModelId
  // correctly prefixes it, matching how every other un-catalogued OpenAI-compat
  // provider (fireworks, together, groq, ...) already behaves.
  expect(qualifyModelId("deepseek-ai/DeepSeek-V3.2", "deepinfra")).toBe("deepinfra/deepseek-ai/DeepSeek-V3.2");
  expect(providerModelFor("deepinfra/deepseek-ai/DeepSeek-V3.2")).toBe("deepinfra/deepseek-ai/DeepSeek-V3.2");
});

test("describeProvider: deepinfra is api_key-ready only when a key is configured", async () => {
  const withKey = await describeProvider("deepinfra", {
    providers: { deepinfra: "dik" },
    defaultModel: "deepinfra/deepseek-ai/DeepSeek-V3.2",
  } as never);
  expect(withKey.kind).toBe("api_key");
  expect(withKey.ready).toBe(true);

  const noKey = await describeProvider("deepinfra", { providers: {}, defaultModel: "claude-3-5-sonnet" } as never);
  expect(noKey.kind).toBe("none");
  expect(noKey.ready).toBe(false);
  expect(noKey.label).toContain("DEEPINFRA_API_KEY");
});

test("litellm is a registered provider pointed at the standard local-proxy default", () => {
  expect(PROVIDER_NAMES).toContain("litellm");
  expect(providerEnvVar("litellm")).toBe("LITELLM_API_KEY");
  expect(companyLabel("litellm")).toBe("LiteLLM");
  // LiteLLM is a self-hosted proxy — this is the documented default a user overrides
  // via `jeo provider add litellm --base-url <their-proxy>`, not a fixed cloud host.
  expect(openaiCompatDef("litellm")?.baseUrl).toBe("http://localhost:4000/v1");
});

test("litellm ids route to the litellm provider (arbitrary user-configured model ids)", () => {
  expect(resolveProvider("litellm/gpt-4o")).toBe("litellm");
  expect(qualifyModelId("gpt-4o", "litellm")).toBe("litellm/gpt-4o");
});
