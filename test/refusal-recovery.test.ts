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

test("engine: second refusal re-grounds the history, third surfaces the friendly error", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      throw new Error("Anthropic returned no content (stop_reason=refusal).");
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
  expect(calls).toBe(3); // initial + plain resend + re-grounded retry, then stop
  expect(history.some(m => m.role === "user" && m.content.includes("safety layer"))).toBe(true); // re-grounding note
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("declined to answer"); // friendly, actionable
  expect(result.doneReason).not.toContain("returned no content (stop_reason=refusal)"); // raw shape gone
  expect(notices.join("\n")).toContain("re-grounding");
});
