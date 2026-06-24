import { test, expect, afterEach } from "bun:test";
import { resolveOllamaNumCtx, DEFAULT_OLLAMA_NUM_CTX, ollamaAdapter } from "../src/ai/providers/ollama";

const ORIG_NUM = process.env.OLLAMA_NUM_CTX;
const ORIG_LEN = process.env.OLLAMA_CONTEXT_LENGTH;
const realFetch = globalThis.fetch;
afterEach(() => {
  if (ORIG_NUM === undefined) delete process.env.OLLAMA_NUM_CTX;
  else process.env.OLLAMA_NUM_CTX = ORIG_NUM;
  if (ORIG_LEN === undefined) delete process.env.OLLAMA_CONTEXT_LENGTH;
  else process.env.OLLAMA_CONTEXT_LENGTH = ORIG_LEN;
  globalThis.fetch = realFetch;
});

test("resolveOllamaNumCtx: explicit per-call value wins over env and default", () => {
  process.env.OLLAMA_NUM_CTX = "8192";
  expect(resolveOllamaNumCtx(40960)).toBe(40960);
});

test("resolveOllamaNumCtx: falls back to OLLAMA_NUM_CTX, then OLLAMA_CONTEXT_LENGTH, then default", () => {
  delete process.env.OLLAMA_NUM_CTX;
  delete process.env.OLLAMA_CONTEXT_LENGTH;
  expect(resolveOllamaNumCtx()).toBe(DEFAULT_OLLAMA_NUM_CTX);
  process.env.OLLAMA_CONTEXT_LENGTH = "32768";
  expect(resolveOllamaNumCtx()).toBe(32768);
  process.env.OLLAMA_NUM_CTX = "12000";
  expect(resolveOllamaNumCtx()).toBe(12000); // OLLAMA_NUM_CTX takes precedence
});

test("resolveOllamaNumCtx: ignores zero / negative / non-numeric and uses the default", () => {
  delete process.env.OLLAMA_NUM_CTX;
  delete process.env.OLLAMA_CONTEXT_LENGTH;
  expect(resolveOllamaNumCtx(0)).toBe(DEFAULT_OLLAMA_NUM_CTX);
  expect(resolveOllamaNumCtx(-5)).toBe(DEFAULT_OLLAMA_NUM_CTX);
  process.env.OLLAMA_NUM_CTX = "not-a-number";
  expect(resolveOllamaNumCtx()).toBe(DEFAULT_OLLAMA_NUM_CTX);
});

test("ollamaAdapter.call: sends an explicit num_ctx so the prompt fits the loaded window", async () => {
  delete process.env.OLLAMA_NUM_CTX;
  delete process.env.OLLAMA_CONTEXT_LENGTH;
  let sentBody = "";
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sentBody = init.body;
    return new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 });
  }) as unknown as typeof fetch;

  await ollamaAdapter.call(
    [{ role: "user", content: "hi" }],
    { model: "ollama/deepseek-r1:1.5b", baseUrl: "http://localhost:11434" },
  );

  const body = JSON.parse(sentBody) as { options: { num_ctx?: number } };
  expect(body.options.num_ctx).toBe(DEFAULT_OLLAMA_NUM_CTX);
});

test("ollamaAdapter.call: a per-call numCtx overrides the default on the wire", async () => {
  let sentBody = "";
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sentBody = init.body;
    return new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 });
  }) as unknown as typeof fetch;

  await ollamaAdapter.call(
    [{ role: "user", content: "hi" }],
    { model: "ollama/deepseek-r1:1.5b", baseUrl: "http://localhost:11434", numCtx: 65536 },
  );

  const body = JSON.parse(sentBody) as { options: { num_ctx?: number } };
  expect(body.options.num_ctx).toBe(65536);
});
