import { test, expect } from "bun:test";
import { openaiAdapter } from "../src/ai/providers/openai";
import { anthropicAdapter } from "../src/ai/providers/anthropic";
import { geminiAdapter } from "../src/ai/providers/gemini";
import type { CallOptions } from "../src/ai/types";

test("openaiAdapter preserves selected live model ids and only strips provider prefix", async () => {
  const prevFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    seen.push(body.model);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const cred = { kind: "api_key", provider: "openai", token: "k" } as const;
    await openaiAdapter.call([{ role: "user", content: "hi" }], { model: "gpt-4o-mini" }, cred);
    await openaiAdapter.call([{ role: "user", content: "hi" }], { model: "openai/custom-live" }, cred);
  } finally {
    globalThis.fetch = prevFetch;
  }
  expect(seen).toEqual(["gpt-4o-mini", "custom-live"]);
});

test("anthropicAdapter preserves selected Claude ids and only strips provider prefix", async () => {
  const prevFetch = globalThis.fetch;
  let sent = "";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent = body.model;
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const cred = { kind: "api_key", provider: "anthropic", token: "k" } as const;
    const opts: CallOptions = { model: "anthropic/claude-sonnet-4-20250514" };
    await anthropicAdapter.call([{ role: "user", content: "hi" }], opts, cred);
  } finally {
    globalThis.fetch = prevFetch;
  }
  expect(sent).toBe("claude-sonnet-4-20250514");
});

test("geminiAdapter strips google/gemini prefixes before request URL", async () => {
  const prevFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const cred = { kind: "api_key", provider: "gemini", token: "k" } as const;
    await geminiAdapter.call([{ role: "user", content: "hi" }], { model: "google/gemini-2.5-flash" }, cred);
    await geminiAdapter.call([{ role: "user", content: "hi" }], { model: "gemini/gemini-2.5-pro" }, cred);
  } finally {
    globalThis.fetch = prevFetch;
  }
  expect(urls[0]).toContain("models/gemini-2.5-flash:generateContent");
  expect(urls[1]).toContain("models/gemini-2.5-pro:generateContent");
});
