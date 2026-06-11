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
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-spill-"));
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
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-spill2-"));
  const history = [{ role: "system" as const, content: "s" }];
  await runAgentLoop(history, { cwd, maxSteps: 5, tools: { small: async () => ({ success: true, output: "tiny" }) } });
  expect(history.some(m => m.content.includes(".joc/artifacts"))).toBe(false);
});

test("runAgentLoop: a FAILED tool with huge error output also spills", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      return turn === 1
        ? JSON.stringify({ tool: "boom", arguments: {} })
        : JSON.stringify({ tool: "done", arguments: { reason: "ok" } });
    },
  }));
  const { runAgentLoop, TOOL_SPILL_THRESHOLD } = await import("../src/agent/engine");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-spill3-"));
  const hugeErr = "E".repeat(TOOL_SPILL_THRESHOLD + 3000);
  const history = [{ role: "system" as const, content: "s" }];
  await runAgentLoop(history, { cwd, maxSteps: 5, tools: { boom: async () => ({ success: false, output: "", error: hugeErr }) } });
  expect(history.some(m => m.content.includes("saved to .joc/artifacts/tool-results/"))).toBe(true);
});

test("spillToolResult: retention caps the artifact directory at MAX_TOOL_ARTIFACTS", async () => {
  const { spillToolResult, MAX_TOOL_ARTIFACTS } = await import("../src/agent/engine");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-artgc-"));
  for (let i = 0; i < MAX_TOOL_ARTIFACTS + 10; i++) {
    await spillToolResult("t", `payload ${i}`, cwd);
  }
  const left = await fs.readdir(path.join(cwd, ".joc", "artifacts", "tool-results"));
  expect(left.length).toBeLessThanOrEqual(MAX_TOOL_ARTIFACTS);
});
