import { test, expect } from "bun:test";
import { resolveProvider, qualifyModelId, providerModelFor } from "../src/ai/model-manager";
import { discoveryRequest, parseModelsBody } from "../src/ai/model-discovery";
import { PROVIDER_NAMES, providerEnvVar, describeProvider } from "../src/ai/provider-status";
import { companyLabel, findCatalogModel } from "../src/ai/model-catalog";

test("tencent is a registered provider with the TENCENT_API_KEY env and Tencent label", () => {
  expect(PROVIDER_NAMES).toContain("tencent");
  expect(providerEnvVar("tencent")).toBe("TENCENT_API_KEY");
  expect(companyLabel("tencent")).toBe("Tencent");
});

test("tencent ids route to the tencent provider", () => {
  expect(resolveProvider("deepseek-v4-pro")).toBe("tencent");
  expect(resolveProvider("deepseek-v4-flash")).toBe("tencent");
  expect(resolveProvider("tencent/minimax-m3")).toBe("tencent");
  expect(qualifyModelId("deepseek-v4-pro", "tencent")).toBe("deepseek-v4-pro");
  expect(providerModelFor("tencent/deepseek-v4-pro")).toBe("tencent/deepseek-v4-pro");
});

test("tencent models are catalogued with reasoning support", () => {
  const flagship = findCatalogModel("deepseek-v4-pro");
  expect(flagship?.provider).toBe("tencent");
  expect(flagship!.thinking.length).toBeGreaterThan(0);
});

test("tencent discovery hits the Anthropic-compatible /v1/models endpoint with an x-api-key", () => {
  const req = discoveryRequest("tencent", { kind: "api_key", provider: "anthropic", token: "tk" });
  expect(req.url).toBe("https://tokenhub-intl.tencentcloudmaas.com/v1/models");
  expect(req.headers["x-api-key"]).toBe("tk");
  expect(req.headers["anthropic-version"]).toBe("2023-06-01");
});

test("tencent model list parses the OpenAI shape", () => {
  expect(parseModelsBody("tencent", { data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }] }))
    .toEqual(["tencent/deepseek-v4-pro", "tencent/deepseek-v4-flash"]);
});

test("describeProvider: tencent is api_key-ready only when a key is configured", async () => {
  const withKey = await describeProvider("tencent", {
    providers: { tencent: "tk" },
    defaultModel: "deepseek-v4-pro",
  } as never);
  expect(withKey.kind).toBe("api_key");
  expect(withKey.ready).toBe(true);
  expect(withKey.envVar).toBe("TENCENT_API_KEY");

  const noKey = await describeProvider("tencent", {
    providers: {},
    defaultModel: "deepseek-v4-pro",
  } as never);
  expect(noKey.kind).toBe("none");
  expect(noKey.ready).toBe(false);
  expect(noKey.label).toContain("TENCENT_API_KEY");
});
