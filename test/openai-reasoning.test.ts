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
