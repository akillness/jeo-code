import { test, expect, mock } from "bun:test";
import { extractJsonObject, tryExtractJsonObject } from "../src/agent/json";

test("extractJsonObject: pure JSON", () => {
  expect(extractJsonObject('{"tool":"done","arguments":{"reason":"x"}}')).toEqual({
    tool: "done",
    arguments: { reason: "x" },
  });
});

test("extractJsonObject: fenced JSON", () => {
  const text = "Here you go:\n```json\n{\"tool\":\"read\",\"arguments\":{\"filePath\":\"a.ts\"}}\n```\n";
  expect(extractJsonObject(text)).toEqual({ tool: "read", arguments: { filePath: "a.ts" } });
});

test("extractJsonObject: prose wrapping + trailing commentary", () => {
  const text = 'I will write the file. {"tool":"write","arguments":{"filePath":"x","content":"hi"}} Done.';
  expect(extractJsonObject(text)).toEqual({ tool: "write", arguments: { filePath: "x", content: "hi" } });
});

test("extractJsonObject: braces inside string values are not miscounted", () => {
  const text = '{"tool":"bash","arguments":{"command":"echo \\"{not a brace}\\""}}';
  expect(extractJsonObject(text)).toEqual({ tool: "bash", arguments: { command: 'echo "{not a brace}"' } });
});

test("tryExtractJsonObject: returns null on garbage", () => {
  expect(tryExtractJsonObject("no json here at all")).toBeNull();
});

test("extractJsonObject: throws on garbage", () => {
  expect(() => extractJsonObject("totally not json")).toThrow();
});

// --- engine loop, with callLlm mocked via module mock ---

test("runAgentLoop: dispatches a tool then completes on done", async () => {
  const calls: string[] = [];
  // Mock the LLM: first return a write tool call, then a done.
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return JSON.stringify({ tool: "echotool", arguments: { v: 1 } });
      return JSON.stringify({ tool: "done", arguments: { reason: "all set" } });
    },
  }));

  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "go" }];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 5,
    tools: {
      echotool: async args => {
        calls.push(`echotool:${JSON.stringify(args)}`);
        return { success: true, output: "echoed" };
      },
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("all set");
  expect(calls).toEqual(['echotool:{"v":1}']);
  // [system,user] + [assistant,result] for echotool (done turn does not append)
  expect(history.length).toBe(4);
  expect(history.some(m => m.content.includes("Tool [echotool] result (ok)"))).toBe(true);
});

test("runAgentLoop: unknown tool surfaces error and keeps going until cap", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "nope", arguments: {} }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 3, tools: {} });
  expect(result.done).toBe(false);
  expect(result.steps).toBe(3);
  expect(history.some(m => m.content.includes("Unknown tool: nope"))).toBe(true);
});

test("runAgentLoop: invalid JSON is fed back to the model for repair", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return "I am thinking out loud with no JSON.";
      return JSON.stringify({ tool: "done", arguments: { reason: "recovered" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const result = await runAgentLoop(history, { cwd: process.cwd(), maxSteps: 5 });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("recovered");
  expect(history.some(m => m.content.includes("not a valid tool call"))).toBe(true);
});
