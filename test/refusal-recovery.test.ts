import { test, expect, mock } from "bun:test";
import { isRefusalError, friendlyProviderError } from "../src/util/provider-error";

// Regression: `✓ Search: theme` → `jeo> Error: Anthropic returned no content
// (stop_reason=refusal)` killed the whole turn on a transient safety
// false-positive. The engine must retry the step (plain resend, then a
// re-grounded retry) and only surface a FRIENDLY, actionable message after the
// bounded budget is exhausted.

test("isRefusalError matches every provider's refusal/empty-content shape", () => {
  expect(isRefusalError(new Error("Anthropic returned no content (stop_reason=refusal)."))).toBe(true);
  expect(isRefusalError(new Error("OpenAI returned no content (finish_reason=content_filter)."))).toBe(true);
  expect(isRefusalError(new Error("Gemini returned no content (SAFETY)."))).toBe(true);
  expect(isRefusalError(new Error("Gemini (Cloud Code Assist) returned no content (PROHIBITED_CONTENT)."))).toBe(true);
  // Negatives: other empty-content causes keep their own handling.
  expect(isRefusalError(new Error("Anthropic returned no content (stop_reason=max_tokens) — raise maxTokens."))).toBe(false);
  expect(isRefusalError(new Error("Rate limited (HTTP 429)"))).toBe(false);
  expect(isRefusalError(new Error("network reset"))).toBe(false);
});

test("friendlyProviderError maps refusal to an actionable line (no raw dead-end)", () => {
  const msg = friendlyProviderError(new Error("Anthropic returned no content (stop_reason=refusal)."));
  expect(msg).toContain("declined to answer");
  expect(msg).toContain("/retry");
  expect(msg).not.toContain("stop_reason=refusal."); // raw provider tail replaced
});

test("engine: one refusal is retried in place and the turn completes", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) throw new Error("Anthropic returned no content (stop_reason=refusal).");
      return JSON.stringify({ tool: "done", arguments: { reason: "finished after refusal retry" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const notices: string[] = [];
  const history = [{ role: "user" as const, content: "search the theme files" }];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 4,
    tools: {},
    events: { onNotice: m => notices.push(m) },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("finished after refusal retry");
  expect(calls).toBe(2); // free resend, no extra step burned
  expect(notices.join("\n")).toContain("provider refused the last call");
});

test("engine: persistent refusal resets tool-result context, then surfaces the friendly error", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      // Call 2 succeeds with a tool call so the history gains a tool RESULT —
      // the content the classifier-reset rung must elide on the later refusals.
      if (calls === 2) return JSON.stringify({ tool: "probe", arguments: {} });
      throw new Error("Anthropic returned no content (stop_reason=refusal).");
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const notices: string[] = [];
  const history = [{ role: "user" as const, content: "search the theme files" }];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 6,
    tools: { probe: async () => ({ success: true, output: `suspicious-looking tool output that trips the classifier\n${"filler line of file content\n".repeat(20)}` }) },
    events: { onNotice: m => notices.push(m) },
  });
  // calls: 1 refused → free resend; 2 tool call ok; 3 refused → context reset; 4 refused → stop.
  expect(calls).toBe(4);
  expect(result.done).toBe(false);
  // Anthropic contract: refusal requires a context RESET — the tool-result body is elided…
  expect(history.some(m => m.role === "user" && /elided/.test(m.content) && /Tool \[probe\]/.test(m.content))).toBe(true);
  expect(history.some(m => m.content.includes("suspicious-looking tool output"))).toBe(false);
  // …and the continuation note stays NEUTRAL (mentioning the safety layer reads as a jailbreak).
  const note = history.find(m => m.role === "user" && m.content.startsWith("(continuation)"));
  expect(note).toBeTruthy();
  expect(note!.content).not.toMatch(/safety|refus/i);
  expect(notices.join("\n")).toContain("context reset");
  // Final surface is friendly + actionable (context reset hint, OAuth/API-key guidance), not the raw shape.
  expect(result.doneReason).toContain("declined to answer");
  expect(result.doneReason).toContain("ANTHROPIC_API_KEY");
  expect(result.doneReason).not.toContain("returned no content (stop_reason=refusal)");
});
