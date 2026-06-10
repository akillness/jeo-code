import { test, expect } from "bun:test";
import { antigravityRequest, getAntigravityUserAgent } from "../src/ai/providers/antigravity";

const cred = { kind: "oauth" as const, provider: "gemini" as const, token: "tok", projectId: "proj-1" };

test("antigravityRequest: builds Cloud Code Assist internal request with project and model", () => {
  const { url, headers, body } = antigravityRequest(
    [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "hello" },
    ],
    { model: "antigravity/gemini-3-pro-low", maxTokens: 1234 } as any,
    cred,
  );
  expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  expect(headers.authorization).toBe("Bearer tok");
  expect(headers["User-Agent"].startsWith("antigravity/")).toBe(true);
  const payload = JSON.parse(body);
  expect(payload.project).toBe("proj-1");
  expect(payload.model).toBe("gemini-3-pro-low");
  expect(payload.requestType).toBe("agent");
  expect(payload.userAgent).toBe("antigravity");
  expect(payload.request.systemInstruction.parts[0].text).toBe("sys");
  expect(payload.request.contents[0].parts[0].text).toBe("hello");
  // Upstream Antigravity removes maxOutputTokens for non-Claude models.
  expect(payload.request.generationConfig?.maxOutputTokens).toBeUndefined();
});

test("antigravityRequest: keeps maxOutputTokens for Claude models", () => {
  const payload = JSON.parse(antigravityRequest(
    [{ role: "user" as const, content: "hello" }],
    { model: "antigravity/claude-sonnet-4-5", maxTokens: 2048 } as any,
    cred,
  ).body);
  expect(payload.model).toBe("claude-sonnet-4-5");
  expect(payload.request.generationConfig.maxOutputTokens).toBe(2048);
});

test("getAntigravityUserAgent follows Antigravity platform/arch shape", () => {
  expect(getAntigravityUserAgent()).toMatch(/^antigravity\/\d+\.\d+\.\d+ .+\/.+$/);
});
