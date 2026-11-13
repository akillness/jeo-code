import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as loop from "../src/agent/loop";
import { createTaskTool } from "../src/agent/task-tool";

for (const failureBoundary of ["setup", "steering"] as const) {
  test(`task fan-out: a ${failureBoundary} failure preserves its error and the independent sibling report`, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-task-"));
    const siblingStarted = Promise.withResolvers<void>();
    const siblingFinished = Promise.withResolvers<void>();
    const provider = Promise.withResolvers<string>();
    const report = "Summary: sibling review completed\nFindings: no defects\nRecommendations: retain implementation\nArchitectural Status: CLEAR\nCode Review Recommendation: APPROVE";
    const callLlm = spyOn(loop, "callLlm").mockImplementation(async () => {
      siblingStarted.resolve();
      return provider.promise;
    });
    let steeringFailed = false;
    const tool = createTaskTool({
      config: { defaultModel: "ollama/fast", subagents: {} },
      onSubagentMessage: record => {
        if (failureBoundary === "setup" && record.message.role === "user" && record.message.content === "fail setup") {
          throw new Error("ledger write failed");
        }
      },
      steer: () => {
        if (failureBoundary === "steering" && !steeringFailed) {
          steeringFailed = true;
          throw new Error("steering inbox unavailable");
        }
        return [];
      },
      onEvent: event => {
        if (event.kind === "done") siblingFinished.resolve();
      },
    });
    const batch = tool({ role: "architect", tasks: ["fail setup", "independent sibling"] }, cwd)
      .catch(error => ({ success: false, output: `unexpected escaped batch error: ${String(error)}` }));

    try {
      await siblingStarted.promise;
      provider.resolve(JSON.stringify({ tool: "done", arguments: { reason: report } }));
      const result = await batch;
      expect(result.success).toBe(false);
      expect(result.output).toContain("1/2 completed");
      expect(result.output).toContain(failureBoundary === "setup" ? "ledger write failed" : "steering inbox unavailable");
      expect(result.output).toContain(report);
      expect(result.output).toContain("### Task 1/2");
      expect(result.output).toContain("### Task 2/2");
    } finally {
      provider.resolve(JSON.stringify({ tool: "done", arguments: { reason: report } }));
      await siblingFinished.promise;
      await batch;
      callLlm.mockRestore();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
}
