import { test, expect } from "bun:test";
import { openaiRequest } from "../src/ai/providers/openai";

test("openaiRequest reasoning models (o3-mini)", () => {
  const messages = [{ role: "user" as const, content: "hello" }];
  const options = { model: "openai/o3-mini", maxTokens: 2500 };
  const cred = { kind: "api_key" as const, provider: "openai" as const, token: "test-token" };
  const req = openaiRequest(messages, options, cred, false);
  const body = JSON.parse(req.body);

  expect(body.model).toBe("o3-mini");
  expect(body.max_completion_tokens).toBe(2500);
  expect(body.max_tokens).toBeUndefined();
  expect(body.temperature).toBeUndefined();
});

test("openaiRequest non-reasoning models (gpt-4o)", () => {
  const messages = [{ role: "user" as const, content: "hello" }];
  const options = { model: "openai/gpt-4o", maxTokens: 2500, temperature: 0.7 };
  const cred = { kind: "api_key" as const, provider: "openai" as const, token: "test-token" };
  const req = openaiRequest(messages, options, cred, false);
  const body = JSON.parse(req.body);

  expect(body.model).toBe("gpt-4o");
  expect(body.max_tokens).toBe(2500);
  expect(body.temperature).toBe(0.7);
  expect(body.max_completion_tokens).toBeUndefined();
});

test("openaiRequest reasoning gate is digit-count agnostic (gpt-6 stays reasoning)", () => {
  // gpt-6+ must NOT silently lose reasoning the way opus-4-8 did. Mirrors the
  // generalized gate in inferCatalogMetadata (model-catalog.ts).
  const messages = [{ role: "user" as const, content: "hello" }];
  const cred = { kind: "api_key" as const, provider: "openai" as const, token: "test-token" };
  const req = openaiRequest(messages, { model: "openai/gpt-6", maxTokens: 3000, reasoningEffort: "high" }, cred, false);
  const body = JSON.parse(req.body);
  expect(body.max_completion_tokens).toBe(3000);
  expect(body.reasoning_effort).toBe("high");
  expect(body.temperature).toBeUndefined();
});