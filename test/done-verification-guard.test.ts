import { test, expect, spyOn, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as loop from "../src/agent/loop";
import { runAgentLoop } from "../src/agent/engine";

let cwd: string;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-verification-gate-"));
  await fs.mkdir(path.join(cwd, ".jeo"));
  await fs.writeFile(path.join(cwd, ".jeo", "hooks.json"), JSON.stringify({ enabled: false }));
});
afterEach(async () => {
  mock.restore();
  await fs.rm(cwd, { recursive: true, force: true });
});

const edit = { tool: "edit", arguments: { filePath: "a.ts", editBlock: "x" } };
const read = { tool: "read", arguments: { filePath: "a.ts" } };
const pass = { tool: "bash", arguments: { command: "bun test passing.test.ts" } };
const fail = { tool: "bash", arguments: { command: "bun test failing.test.ts" } };
const done = { tool: "done", arguments: { reason: "verified" } };

for (const scenario of [
  { name: "a read after rejected done cannot excuse unverified mutation", steps: [edit, done, read], accepted: false },
  { name: "repeated done and unrelated action cannot excuse unverified mutation", steps: [edit, done, done, read], accepted: false },
  { name: "later failed verification invalidates earlier successful evidence", steps: [edit, pass, fail], accepted: false },
  { name: "a mutation after successful verification requires fresh evidence", steps: [edit, pass, { ...edit, arguments: { filePath: "b.ts", editBlock: "y" } }], accepted: false },
  { name: "successful verification after a failure restores eligibility", steps: [edit, pass, fail, read, pass], accepted: true },
  { name: "mutation followed by successful verification can complete", steps: [edit, pass], accepted: true },
  { name: "read-only work can complete without verification", steps: [read], accepted: true },
]) {
  test(`runAgentLoop: ${scenario.name}`, async () => {
    let calls = 0;
    spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(scenario.steps[calls++] ?? done));
    const result = await runAgentLoop([{ role: "user", content: "complete the task" }], {
      cwd, maxSteps: 12, budget: { maxExtensions: 0 },
      tools: {
        edit: async () => ({ success: true, output: "updated" }),
        read: async () => ({ success: true, output: "source content" }),
        bash: async args => args.command === "bun test failing.test.ts"
          ? { success: false, output: "0 pass\n1 fail", error: "test exited 1" }
          : { success: true, output: "1 pass\n0 fail" },
      },
    });
    expect(result.done).toBe(scenario.accepted);
    if (scenario.accepted) {
      expect(result.doneReason).toBe("verified");
      expect(calls).toBe(scenario.steps.length + 1);
    } else {
      expect(result.doneReason).toMatch(/verif/i);
      expect(result.doneReason).not.toBe("verified");
      expect(calls).toBeLessThanOrEqual(12);
    }
  });
}

test("runAgentLoop: a rejected edit does not invent a successful mutation", async () => {
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(calls++ === 0 ? edit : done));
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd, maxSteps: 10, budget: { maxExtensions: 0 },
    tools: { edit: async () => ({ success: false, output: "", error: "no match" }) },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(calls).toBe(2);
});
