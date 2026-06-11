import { test, expect } from "bun:test";
import { parseChatArgs } from "../src/commands/chat";

// Regression: `jeo chat --model X "hi"` used to swallow the flag into the message
// and chat with the DEFAULT model — anthropic/antigravity selections never reached
// the provider router.

test("parseChatArgs: --model is extracted, not swallowed into the message", () => {
  const r = parseChatArgs(["--model", "claude-sonnet-4-5", "Reply with exactly: OK"]);
  expect(r.model).toBe("claude-sonnet-4-5");
  expect(r.message).toBe("Reply with exactly: OK");
});

test("parseChatArgs: --model= and -m forms", () => {
  expect(parseChatArgs(["--model=antigravity/gemini-3-flash", "hi"]).model).toBe("antigravity/gemini-3-flash");
  expect(parseChatArgs(["-m", "fast", "hi"]).model).toBe("fast");
});

test("parseChatArgs: --thinking extracted alongside model", () => {
  const r = parseChatArgs(["--thinking", "high", "--model", "opus", "explain", "this"]);
  expect(r.thinking).toBe("high");
  expect(r.model).toBe("opus");
  expect(r.message).toBe("explain this");
});

test("parseChatArgs: --max-tokens is extracted for tiny smoke checks", () => {
  const r = parseChatArgs(["--model", "sonnet", "--max-tokens=16", "ok?"]);
  expect(r.model).toBe("sonnet");
  expect(r.maxTokens).toBe(16);
  expect(r.message).toBe("ok?");
});

test("parseChatArgs: --max-tokens space form ignores invalid values", () => {
  const r = parseChatArgs(["--max-tokens", "nope", "hi"]);
  expect(r.maxTokens).toBeUndefined();
  expect(r.message).toBe("hi");
});

test("parseChatArgs: no flags — message passthrough unchanged", () => {
  const r = parseChatArgs(["just", "a", "question"]);
  expect(r.model).toBeUndefined();
  expect(r.message).toBe("just a question");
});
