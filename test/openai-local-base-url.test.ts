import { test, expect } from "bun:test";
import { credentialForCall } from "../src/ai/model-manager";
import type { Credential } from "../src/auth";

const oauth: Credential = { kind: "oauth", provider: "openai", token: "chatgpt-oauth-token" };
const base = "http://localhost:1234/v1";

test("credentialForCall: local OpenAI base URL + OAuth downgrades to keyless (avoids Codex)", () => {
  // OAuth would route to the hardcoded Codex backend and drop the base URL; downgrade to keyless
  // so the request actually hits the local server via /chat/completions.
  const out = credentialForCall("openai", oauth, { providers: {} }, base);
  expect(out.kind).toBe("none");
  expect(out.provider).toBe("openai");
});

test("credentialForCall: local OpenAI base URL prefers a configured api key over OAuth", () => {
  const out = credentialForCall("openai", oauth, { providers: { openai: "sk-local" } }, base);
  expect(out.kind).toBe("api_key");
  expect(out.kind === "api_key" && out.token).toBe("sk-local");
});

test("credentialForCall: OpenAI OAuth WITHOUT a base URL is preserved (Codex path)", () => {
  const out = credentialForCall("openai", oauth, { providers: {} }, undefined);
  expect(out).toBe(oauth); // unchanged → adapter routes via OAuth/Codex
});

test("credentialForCall: a non-openai provider is never downgraded by a base URL", () => {
  const anthropicOauth: Credential = { kind: "oauth", provider: "anthropic", token: "t" };
  expect(credentialForCall("anthropic", anthropicOauth, { providers: {} }, base)).toBe(anthropicOauth);
});

test("credentialForCall: a local api_key credential passes through unchanged", () => {
  const key: Credential = { kind: "api_key", provider: "openai", token: "sk-x" };
  expect(credentialForCall("openai", key, { providers: { openai: "sk-x" } }, base)).toBe(key);
});
