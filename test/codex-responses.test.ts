import { test, expect } from "bun:test";
import { codexResponsesRequest, parseResponsesEvent } from "../src/ai/providers/openai-responses";

const oauth = { kind: "oauth" as const, provider: "openai" as const, token: "x.y.z" };

test("codexResponsesRequest: forwards reasoningEffort as reasoning.effort", () => {
  const withEffort = JSON.parse(
    codexResponsesRequest([{ role: "user", content: "hi" }], { model: "gpt-5.5", reasoningEffort: "high" } as any, oauth).body,
  );
  expect(withEffort.reasoning).toEqual({ effort: "high" });

  const without = JSON.parse(
    codexResponsesRequest([{ role: "user", content: "hi" }], { model: "gpt-5.5" } as any, oauth).body,
  );
  expect(without.reasoning).toBeUndefined();
});

test("codexResponsesRequest: drops out-of-enum reasoningEffort instead of forwarding it", () => {
  const invalid = JSON.parse(
    codexResponsesRequest([{ role: "user", content: "hi" }], { model: "gpt-5.5", reasoningEffort: "max" } as any, oauth).body,
  );
  expect(invalid.reasoning).toBeUndefined();
});

test("parseResponsesEvent: captures usage on response.incomplete (not just completed)", () => {
  const incomplete = parseResponsesEvent(
    JSON.stringify({ type: "response.incomplete", response: { usage: { input_tokens: 12, output_tokens: 3 } } }),
  );
  expect(incomplete.usage).toEqual({ inputTokens: 12, outputTokens: 3 });

  const completed = parseResponsesEvent(
    JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 7 } } }),
  );
  expect(completed.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
});

test("parseResponsesEvent: delta + error events still parse", () => {
  expect(parseResponsesEvent(JSON.stringify({ type: "response.output_text.delta", delta: "hello" }))).toEqual({ delta: "hello" });
  expect(parseResponsesEvent(JSON.stringify({ type: "response.failed", response: { error: { message: "boom" } } })).error).toBe("boom");
});
