import { test, expect, afterEach } from "bun:test";
import { isUnsupportedToolsError, stripNativeTools, openaiAdapter } from "../src/ai/providers/openai";
import type { Credential } from "../src/auth";

const JINJA_ERR = JSON.stringify({
  error: 'Error rendering prompt with jinja template: "Cannot call something that is not a function: got UndefinedValue".',
});
const bodyWithTools = JSON.stringify({
  model: "gemma",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ type: "function", function: { name: "read", parameters: {} } }],
  tool_choice: "auto",
  stream: true,
  stream_options: { include_usage: true },
});

test("isUnsupportedToolsError: true for a jinja-template 400 when the request carried tools", () => {
  expect(isUnsupportedToolsError(bodyWithTools, JINJA_ERR)).toBe(true);
});

test("isUnsupportedToolsError: matches the 'does not support tools' phrasing (llama.cpp/vLLM)", () => {
  expect(isUnsupportedToolsError(bodyWithTools, "this model does not support tools")).toBe(true);
});

test("isUnsupportedToolsError: false when the request had no tools (a real 400)", () => {
  const noTools = JSON.stringify({ model: "gemma", messages: [], tools: [] });
  expect(isUnsupportedToolsError(noTools, JINJA_ERR)).toBe(false);
  expect(isUnsupportedToolsError(JSON.stringify({ model: "gemma" }), JINJA_ERR)).toBe(false);
});

test("isUnsupportedToolsError: false for an unrelated 400 (context length) even with tools present", () => {
  expect(isUnsupportedToolsError(bodyWithTools, "context length exceeded: 9000 > 8192")).toBe(false);
});

test("isUnsupportedToolsError: false when the request body is not valid JSON", () => {
  expect(isUnsupportedToolsError("not json", JINJA_ERR)).toBe(false);
});

test("stripNativeTools: drops tools + tool_choice and preserves every other field", () => {
  const out = JSON.parse(stripNativeTools(bodyWithTools)) as Record<string, unknown>;
  expect(out.tools).toBeUndefined();
  expect(out.tool_choice).toBeUndefined();
  expect(out.model).toBe("gemma");
  expect(out.stream).toBe(true);
  expect(out.stream_options).toEqual({ include_usage: true });
});

test("stripNativeTools: never injects response_format (some LM Studio builds reject json_object)", () => {
  const out = JSON.parse(stripNativeTools(bodyWithTools)) as Record<string, unknown>;
  expect(out.response_format).toBeUndefined();
});


// --- adapter-level: a 400 jinja error triggers exactly one tool-less retry that succeeds ---

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const keyless: Credential = { kind: "none", provider: "openai" };

test("openaiAdapter.call: retries once without native tools on a jinja-template 400, then succeeds", async () => {
  const bodies: string[] = [];
  let calls = 0;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls++;
    bodies.push(init.body);
    if (calls === 1) {
      // First attempt carries `tools` → backend 400s on the broken template.
      return new Response(JINJA_ERR, { status: 400 });
    }
    // Retry (tools stripped) → model answers via JSON-in-prose.
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"tool":"done"}' } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const text = await openaiAdapter.call(
    [{ role: "user", content: "hi" }],
    { model: "lmstudio/gemma", baseUrl: "http://localhost:1234/v1", jsonMode: true, tools: [{ name: "done", description: "d", parameters: { type: "object", properties: {} } }] },
    keyless,
  );

  expect(calls).toBe(2);
  expect(text).toBe('{"tool":"done"}');
  // First request sent tools; the retry stripped them (no response_format forced, since
  // some LM Studio builds reject json_object — the system prompt drives JSON instead).
  expect(JSON.parse(bodies[0]).tools).toBeDefined();
  const retryBody = JSON.parse(bodies[1]);
  expect(retryBody.tools).toBeUndefined();
  expect(retryBody.response_format).toBeUndefined();

});

test("openaiAdapter.call: a 400 unrelated to tools is NOT retried and surfaces the error", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: "context length exceeded" }), { status: 400 });
  }) as unknown as typeof fetch;

  await expect(
    openaiAdapter.call(
      [{ role: "user", content: "hi" }],
      { model: "lmstudio/gemma", baseUrl: "http://localhost:1234/v1", jsonMode: true, tools: [{ name: "done", description: "d", parameters: { type: "object", properties: {} } }] },
      keyless,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1); // no retry
});
