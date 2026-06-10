import { test, expect, afterEach } from "bun:test";
import { normalizeOllamaBaseUrl } from "../src/ai/providers/ollama";

const ORIG = process.env.OLLAMA_HOST;
afterEach(() => {
  if (ORIG === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = ORIG;
});

test("normalizeOllamaBaseUrl: prepends http:// to a bare host:port (the OLLAMA_HOST convention)", () => {
  expect(normalizeOllamaBaseUrl("127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
  expect(normalizeOllamaBaseUrl("localhost:11434/")).toBe("http://localhost:11434");
});

test("normalizeOllamaBaseUrl: keeps an explicit scheme and strips trailing slash", () => {
  expect(normalizeOllamaBaseUrl("https://ollama.example.com/")).toBe("https://ollama.example.com");
  expect(normalizeOllamaBaseUrl("http://localhost:11434")).toBe("http://localhost:11434");
});

test("normalizeOllamaBaseUrl: falls back to OLLAMA_HOST then the default", () => {
  delete process.env.OLLAMA_HOST;
  expect(normalizeOllamaBaseUrl()).toBe("http://localhost:11434");
  process.env.OLLAMA_HOST = "10.0.0.5:11434";
  expect(normalizeOllamaBaseUrl()).toBe("http://10.0.0.5:11434");
});

test("normalizeOllamaBaseUrl: resolved URL is parseable by fetch's URL", () => {
  expect(() => new URL(`${normalizeOllamaBaseUrl("127.0.0.1:11434")}/api/chat`)).not.toThrow();
});
