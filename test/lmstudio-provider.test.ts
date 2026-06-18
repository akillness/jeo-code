import { test, expect } from "bun:test";
import { resolveProvider, qualifyModelId, providerModelFor } from "../src/ai/model-manager";
import { discoveryRequest, parseModelsBody } from "../src/ai/model-discovery";
import { PROVIDER_NAMES, providerEnvVar, describeProvider } from "../src/ai/provider-status";
import { companyLabel } from "../src/ai/model-catalog";

// LM Studio is a first-class, keyless, OpenAI-compatible LOCAL provider (default
// http://localhost:1234/v1) — wired alongside ollama.

test("lmstudio is a registered provider name (shows in /provider)", () => {
  expect(PROVIDER_NAMES).toContain("lmstudio");
  expect(providerEnvVar("lmstudio")).toBeUndefined(); // keyless: no *_API_KEY
  expect(companyLabel("lmstudio")).toBe("LM Studio");
});

test("lmstudio model ids route to the lmstudio provider and pass through unchanged", () => {
  expect(resolveProvider("lmstudio/qwen2.5-coder")).toBe("lmstudio");
  expect(qualifyModelId("qwen2.5-coder", "lmstudio")).toBe("lmstudio/qwen2.5-coder");
  // already-qualified id is not double-prefixed
  expect(qualifyModelId("lmstudio/qwen2.5-coder", "lmstudio")).toBe("lmstudio/qwen2.5-coder");
  // prefixed ids pass through to the wire untouched (adapter strips the prefix)
  expect(providerModelFor("lmstudio/qwen2.5-coder")).toBe("lmstudio/qwen2.5-coder");
});

test("lmstudio discovery hits the OpenAI-compatible /models endpoint (keyless GET)", () => {
  const def = discoveryRequest("lmstudio", undefined);
  expect(def.url).toBe("http://localhost:1234/v1/models");
  expect(def.headers).toEqual({});
  const custom = discoveryRequest("lmstudio", undefined, "http://127.0.0.1:4321/v1");
  expect(custom.url).toBe("http://127.0.0.1:4321/v1/models");
});

test("lmstudio model list is parsed from OpenAI shape and provider-qualified", () => {
  expect(parseModelsBody("lmstudio", { data: [{ id: "qwen2.5-coder" }, { id: "llama-3.1-8b" }] }))
    .toEqual(["lmstudio/qwen2.5-coder", "lmstudio/llama-3.1-8b"]);
  expect(parseModelsBody("lmstudio", {})).toEqual([]);
});

test("describeProvider: lmstudio is keyless and always ready with its base URL", async () => {
  const s = await describeProvider("lmstudio", {
    providers: {},
    defaultModel: "claude-sonnet-4-5",
    lmstudioBaseUrl: "http://localhost:1234/v1",
  } as never);
  expect(s.kind).toBe("keyless");
  expect(s.ready).toBe(true);
  expect(s.baseUrl).toBe("http://localhost:1234/v1");
  expect(s.envVar).toBeUndefined();
});
