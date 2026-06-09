import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

afterEach(() => mock.restore());

test("runAgentLoop: oversized tool output is spilled to a recoverable artifact + noted", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      return turn === 1
        ? JSON.stringify({ tool: "big", arguments: {} })
        : JSON.stringify({ tool: "done", arguments: { reason: "ok" } });
    },
  }));
  const { runAgentLoop, TOOL_SPILL_THRESHOLD } = await import("../src/agent/engine");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "joc-spill-"));
  const huge = "X".repeat(TOOL_SPILL_THRESHOLD + 5000);
  const history = [{ role: "system" as const, content: "s" }];
  await runAgentLoop(history, { cwd, maxSteps: 5, tools: { big: async () => ({ success: true, output: huge }) } });

  const noted = history.find(m => m.content.includes("saved to .joc/artifacts/tool-results/"));
  expect(noted).toBeTruthy();
  const m = noted!.content.match(/saved to (\.joc\/artifacts\/tool-results\/[^\s]+)/);
  expect(m).toBeTruthy();
  const full = await fs.readFile(path.join(cwd, m![1]), "utf-8");
  expect(full.length).toBe(huge.length); // full output recoverable, not just the preview
});

test("runAgentLoop: small tool output is NOT spilled", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      return turn === 1
        ? JSON.stringify({ tool: "small", arguments: {} })
        : JSON.stringify({ tool: "done", arguments: { reason: "ok" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "joc-spill2-"));
  const history = [{ role: "system" as const, content: "s" }];
  await runAgentLoop(history, { cwd, maxSteps: 5, tools: { small: async () => ({ success: true, output: "tiny" }) } });
  expect(history.some(m => m.content.includes(".joc/artifacts"))).toBe(false);
});
