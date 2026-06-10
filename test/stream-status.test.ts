import { test, expect } from "bun:test";
import { createStreamEvents } from "../src/commands/launch";

function stripAnsi(str: string): string {
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

// Merged stream contract: the step header is LAZY (printed at onAssistant once the
// tool target is known, never for done/invalid replies) and carries gjc-style
// elapsed-duration + cumulative-token-usage suffixes.

test("step header carries duration and usage suffixes once available", () => {
  let clock = 1_000_000;
  const logs: string[] = [];
  const ev = createStreamEvents(25, s => logs.push(stripAnsi(s)), () => clock);

  // Step 1: instant — no duration suffix, no usage yet.
  ev.onStep!(1);
  expect(logs.length).toBe(0); // lazy: nothing until the tool is known
  ev.onAssistant!("", { tool: "read", arguments: { filePath: "src/a.ts" } });
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("[step 1/25] read src/a.ts");
  expect(logs[0]).not.toContain("tokens");

  // Usage arrives, time passes 72s: step 2 header shows both suffixes.
  ev.onUsage!({ inputTokens: 14_200, outputTokens: 1_100 });
  clock += 72_000;
  ev.onStep!(2);
  ev.onAssistant!("", { tool: "bash", arguments: { command: "bun test" } });
  expect(logs.length).toBe(2);
  expect(logs[1]).toContain("[step 2/25]");
  expect(logs[1]).toContain("1m 12s");
  expect(logs[1]).toContain("14.2k in / 1.1k out tokens");
});

test("done and invalid replies emit no step line", () => {
  const logs: string[] = [];
  const ev = createStreamEvents(25, s => logs.push(stripAnsi(s)), () => 0);
  ev.onStep!(1);
  ev.onAssistant!("", { tool: "done", arguments: { reason: "finished" } });
  ev.onAssistant!("not json", null);
  expect(logs).toEqual([]);
});

test("tool results keep the classified ok/fail badges", () => {
  const logs: string[] = [];
  const ev = createStreamEvents(4, s => logs.push(stripAnsi(s)), () => 0);
  ev.onStep!(1);
  ev.onAssistant!("", { tool: "bash", arguments: { command: "bun test" } });
  ev.onToolResult!("bash", false, "exit 1\nboom");
  const out = logs.join("\n");
  expect(out).toContain("[step 1/4] bash command");
  expect(out).toContain("✗");
  expect(out).toContain("exit 1");
});
