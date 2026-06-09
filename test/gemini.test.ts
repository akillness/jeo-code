import { test, expect } from "bun:test";
import { geminiRequest } from "../src/ai/providers/gemini";

const cred = { kind: "api_key" as const, provider: "gemini" as const, token: "k" };

test("geminiRequest: coalesces consecutive same-role turns (Gemini strict alternation)", () => {
  const messages = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "u1" },
    { role: "user" as const, content: "u2" }, // consecutive user (e.g. compaction summary + tool-result)
    { role: "assistant" as const, content: "a1" },
    { role: "user" as const, content: "u3" },
  ];
  const { body } = geminiRequest(messages, { model: "gemini-2.5-flash" } as any, cred, "generateContent");
  const payload = JSON.parse(body);
  // system is lifted out; the two consecutive users merge into one content with two parts.
  expect(payload.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
  expect(payload.contents[0].parts.map((p: any) => p.text)).toEqual(["u1", "u2"]);
  expect(payload.systemInstruction.parts[0].text).toBe("sys");
});

test("geminiRequest: single turns map through unchanged (no spurious merging)", () => {
  const messages = [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "yo" },
    { role: "user" as const, content: "bye" },
  ];
  const { body } = geminiRequest(messages, { model: "gemini-2.5-flash" } as any, cred, "generateContent");
  const payload = JSON.parse(body);
  expect(payload.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
  expect(payload.contents.every((c: any) => c.parts.length === 1)).toBe(true);
});
