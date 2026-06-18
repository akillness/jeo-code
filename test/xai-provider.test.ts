import { test, expect } from "bun:test";
import { resolveProvider, qualifyModelId, providerModelFor } from "../src/ai/model-manager";
import { expandAlias } from "../src/ai/model-registry";
import { discoveryRequest, parseModelsBody } from "../src/ai/model-discovery";
import { PROVIDER_NAMES, providerEnvVar, describeProvider } from "../src/ai/provider-status";
import { companyLabel, findCatalogModel } from "../src/ai/model-catalog";

// xAI (Grok) is a first-class, API-key, OpenAI-compatible cloud provider
// (https://api.x.ai/v1, XAI_API_KEY) — mirrors gajae-code's xAI/Grok support.

test("xai is a registered provider with the XAI_API_KEY env and xAI label", () => {
  expect(PROVIDER_NAMES).toContain("xai");
  expect(providerEnvVar("xai")).toBe("XAI_API_KEY");
  expect(companyLabel("xai")).toBe("xAI");
});

test("grok ids route to the xai provider (by name or prefix); alias resolves", () => {
  expect(resolveProvider("grok-4.3")).toBe("xai");
  expect(resolveProvider("grok-code-fast-1")).toBe("xai");
  expect(resolveProvider("xai/grok-4-fast-reasoning")).toBe("xai");
  expect(expandAlias("grok")).toBe("grok-4.3");
  expect(qualifyModelId("grok-4.3", "xai")).toBe("grok-4.3"); // already routes to xai → unchanged
  expect(providerModelFor("xai/grok-4.3")).toBe("xai/grok-4.3");
});

test("grok models are catalogued with reasoning support", () => {
  const flagship = findCatalogModel("grok-4.3");
  expect(flagship?.provider).toBe("xai");
  expect(flagship!.thinking.length).toBeGreaterThan(0); // reasoning-capable
  expect(findCatalogModel("grok-4-fast-non-reasoning")?.thinking).toEqual([]); // explicitly non-reasoning
});

test("xai discovery hits the OpenAI-compatible /models endpoint with a bearer key", () => {
  const req = discoveryRequest("xai", { kind: "api_key", provider: "openai", token: "xk" });
  expect(req.url).toBe("https://api.x.ai/v1/models");
  expect(req.headers.Authorization).toBe("Bearer xk");
});

test("xai model list parses the OpenAI shape (grok ids route by name, no prefix)", () => {
  expect(parseModelsBody("xai", { data: [{ id: "grok-4.3" }, { id: "grok-code-fast-1" }] }))
    .toEqual(["grok-4.3", "grok-code-fast-1"]);
});

test("describeProvider: xai is api_key-ready only when a key is configured", async () => {
  const withKey = await describeProvider("xai", {
    providers: { xai: "xk" },
    defaultModel: "claude-sonnet-4-5",
  } as never);
  expect(withKey.kind).toBe("api_key");
  expect(withKey.ready).toBe(true);
  expect(withKey.envVar).toBe("XAI_API_KEY");

  const noKey = await describeProvider("xai", {
    providers: {},
    defaultModel: "claude-sonnet-4-5",
  } as never);
  expect(noKey.kind).toBe("none");
  expect(noKey.ready).toBe(false);
  expect(noKey.label).toContain("XAI_API_KEY");
});
