import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

afterEach(() => mock.restore());

// Regression: a single default `read` of a ~400-line file must reach the model in
// full. Before the read-budget split, the generic 4000-char cap re-shrank every
// read to ~100 lines (head 2400 + tail 1600), so the model never saw the middle of
// a file it explicitly opened. The read tool reads up to 500 lines; READ_OUTPUT_MAX
// must be large enough that those lines are not truncated back out on the way to the
// model.
test("runAgentLoop: a single read of a 400-line file reaches the model in full (no ~100-line re-shrink)", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      return turn === 1
        ? JSON.stringify({ tool: "read", arguments: { filePath: "bigfile.txt" } })
        : JSON.stringify({ tool: "done", arguments: { reason: "ok" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-readbudget-"));
  const body = Array.from({ length: 400 }, (_, i) =>
    `LINE ${String(i + 1).padStart(4, "0")}: the quick brown fox jumps over the lazy dog number ${i + 1}`,
  ).join("\n");
  await fs.writeFile(path.join(cwd, "bigfile.txt"), body, "utf-8");

  const history = [{ role: "system" as const, content: "s" }];
  await runAgentLoop(history, { cwd, maxSteps: 5 }); // no `tools` → real DEFAULT_TOOLS (read)

  const readResult = history.find(m => m.content.includes("LINE 0001"));
  expect(readResult).toBeTruthy();
  // The decisive assertion: the FAR end of the file is visible, not dropped by a cap.
  expect(readResult!.content).toContain("LINE 0200"); // middle — lost under the old head/tail 4k cut
  expect(readResult!.content).toContain("LINE 0400"); // last line — present in full
  expect(readResult!.content).not.toContain("chars truncated");
});
