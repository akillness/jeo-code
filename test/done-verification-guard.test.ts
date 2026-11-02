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

for (const mutation of [
  { tool: "write", arguments: { filePath: "a.ts", content: "updated" } },
  { tool: "edit", arguments: { filePath: "a.ts", editBlock: "x" } },
  { tool: "mkdir", arguments: { path: "new-dir" } },
  { tool: "delete", arguments: { path: "obsolete.txt" } },
  { tool: "ast_edit", arguments: { pattern: "oldName", replacement: "newName", paths: ["a.ts"] } },
  { tool: "lsp_rename", arguments: { file: "a.ts", line: 1, symbol: "oldName", new_name: "newName" } },
]) {
  test(`runAgentLoop: successful ${mutation.tool} requires later passing verification`, async () => {
    const steps = [mutation, done];
    let calls = 0;
    spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
    const result = await runAgentLoop([{ role: "user", content: "change the workspace" }], {
      cwd, maxSteps: 12, budget: { maxExtensions: 0 },
      tools: {
        [mutation.tool]: async () => ({ success: true, output: "workspace changed" }),
      },
    });

    expect(result.done).toBe(false);
    expect(result.doneReason).toMatch(/verif/i);
  });
}

test("runAgentLoop: successful bash workspace mutation requires later passing verification", async () => {
  const steps = [
    { tool: "bash", arguments: { command: "touch mutation-marker" } },
    done,
  ];
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "change the workspace" }], {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: {
      bash: async () => ({ success: true, output: "created mutation-marker" }),
    },
  });

  expect(result.done).toBe(false);
  expect(result.doneReason).toMatch(/verif/i);
});

test("runAgentLoop: caller-approved completion cannot override missing runtime verification", async () => {
  const steps = [edit, done];
  let calls = 0;
  let callerApprovals = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "change and verify" }], {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: { edit: async () => ({ success: true, output: "updated" }) },
    events: { onBeforeDone: () => { callerApprovals++; return null; } },
  });

  expect(result.done).toBe(false);
  expect(result.doneReason).toMatch(/verif/i);
  expect(callerApprovals).toBeGreaterThan(0);
  expect(calls).toBeGreaterThan(1);
});

test("runAgentLoop: cmd alias verifier permits done after a mutation", async () => {
  const steps = [
    edit,
    { tool: "bash", arguments: { cmd: "bun test passing.test.ts" } },
    done,
  ];
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "change and verify" }], {
    cwd, maxSteps: 8, budget: { maxExtensions: 0 },
    tools: {
      edit: async () => ({ success: true, output: "updated a.ts" }),
      bash: async () => ({ success: true, output: "1 pass\n0 fail" }),
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(calls).toBe(3);
});


test("runAgentLoop: bash mutation requires an invoked passing verifier before done", async () => {
  const steps = [
    { tool: "bash", arguments: { command: "touch mutation-marker" } },
    done,
    pass,
    done,
  ];
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "change and verify" }], {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: {
      bash: async ({ command }) => command === "bun test passing.test.ts"
        ? { success: true, output: "1 pass\n0 fail" }
        : { success: true, output: "created mutation-marker" },
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(calls).toBe(4);
});

test("runAgentLoop: successful computer action invalidates earlier verification before done", async () => {
  const steps = [pass, { tool: "computer", arguments: { action: "click", x: 10, y: 20 } }, done, pass, done];
  const calls: string[] = [];
  let llmCalls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[llmCalls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "click and verify" }], {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: {
      computer: async () => { calls.push("computer"); return { success: true, output: "clicked" }; },
      bash: async () => { calls.push("verifier"); return { success: true, output: "1 pass\n0 fail" }; },
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(calls).toEqual(["verifier", "computer", "verifier"]);
  expect(llmCalls).toBe(5);
});

for (const action of ["screenshot", "wait"]) {
  test(`runAgentLoop: computer ${action} keeps earlier verification valid`, async () => {
    const steps = [pass, { tool: "computer", arguments: { action } }, done];
    const calls: string[] = [];
    let llmCalls = 0;
    spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[llmCalls++] ?? done));
    const result = await runAgentLoop([{ role: "user", content: `inspect with ${action}` }], {
      cwd, maxSteps: 8, budget: { maxExtensions: 0 },
      tools: {
        computer: async () => { calls.push("computer"); return { success: true, output: "observed" }; },
        bash: async () => { calls.push("verifier"); return { success: true, output: "1 pass\n0 fail" }; },
      },
    });

    expect(result.done).toBe(true);
    expect(result.doneReason).toBe("verified");
    expect(calls).toEqual(["verifier", "computer"]);
    expect(llmCalls).toBe(3);
  });
}




test("runAgentLoop: failed write after partial workspace mutation invalidates prior verification", async () => {
  const steps = [pass, { tool: "write", arguments: { filePath: "partial-mutation.txt", content: "changed before failure" } }, done, pass, done];
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "change and verify" }], {
    cwd, maxSteps: 8, budget: { maxExtensions: 0 },
    tools: {
      write: async ({ filePath, content }) => {
        await fs.writeFile(path.join(cwd, filePath), content);
        return { success: false, output: "write failed after partial change", error: "disk error", mutationMayHaveOccurred: true };
      },
      bash: async () => ({ success: true, output: "1 pass\\n0 fail" }),
    },
  });

  expect(await fs.readFile(path.join(cwd, "partial-mutation.txt"), "utf8")).toBe("changed before failure");
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(calls).toBe(5);
});

test("runAgentLoop: failed write with possible partial mutation requires fresh verification", async () => {
  const steps = [pass, { tool: "write", arguments: { filePath: "uncertain-mutation.txt", content: "attempted change" } }, done, pass, done];
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "change and verify" }], {
    cwd, maxSteps: 8, budget: { maxExtensions: 0 },
    tools: {
      write: async () => ({
        success: false,
        output: "write failed after a possible partial change",
        error: "disk error",
        mutationMayHaveOccurred: true,
      }),
      bash: async () => ({ success: true, output: "1 pass\\n0 fail" }),
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(calls).toBe(5);
});

test("runAgentLoop: failed write without possible mutation keeps passing verification valid", async () => {
  const steps = [pass, { tool: "write", arguments: { filePath: "unchanged.txt", content: "attempted change" } }, done];
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "change and verify" }], {
    cwd, maxSteps: 8, budget: { maxExtensions: 0 },
    tools: {
      write: async () => ({ success: false, output: "write rejected", error: "permission denied" }),
      bash: async () => ({ success: true, output: "1 pass\\n0 fail" }),
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(calls).toBe(3);
});



for (const mutation of [
  { tool: "write", arguments: { filePath: "a.ts", content: "updated" } },
  { tool: "edit", arguments: { filePath: "a.ts", editBlock: "x" } },
  { tool: "mkdir", arguments: { path: "new-dir" } },
  { tool: "delete", arguments: { path: "obsolete.txt" } },
  { tool: "ast_edit", arguments: { pattern: "oldName", replacement: "newName", paths: ["a.ts"] } },
  { tool: "lsp_rename", arguments: { file: "a.ts", line: 1, symbol: "oldName", new_name: "newName" } },
]) {
  test(`runAgentLoop: ${mutation.tool} permits done after a subsequent passing verification`, async () => {
    const steps = [mutation, pass, done];
    let calls = 0;
    spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
    const result = await runAgentLoop([{ role: "user", content: "change and verify" }], {
      cwd, maxSteps: 8, budget: { maxExtensions: 0 },
      tools: {
        [mutation.tool]: async () => ({ success: true, output: "workspace changed" }),
        bash: async () => ({ success: true, output: "1 pass\n0 fail" }),
      },
    });

    expect(result.done).toBe(true);
    expect(result.doneReason).toBe("verified");
    expect(calls).toBe(3);
  });
}



for (const verificationLike of [
  { command: "git status", output: "?? test-output.txt" },
  { command: "cat test.log", output: "tests passed" },
]) {
  test(`runAgentLoop: ${verificationLike.command} text cannot verify a workspace mutation`, async () => {
    const steps = [edit, { tool: "bash", arguments: { command: verificationLike.command } }, done];
    let calls = 0;
    spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
    const result = await runAgentLoop([{ role: "user", content: "change and inspect" }], {
      cwd, maxSteps: 12, budget: { maxExtensions: 0 },
      tools: {
        edit: async () => ({ success: true, output: "updated" }),
        bash: async () => ({ success: true, output: verificationLike.output }),
      },
    });

    expect(result.done).toBe(false);
    expect(result.doneReason).toMatch(/verif/i);
  });
}

test("runAgentLoop: lsp_rename preview does not require verification", async () => {
  const steps = [{
    tool: "lsp_rename",
    arguments: { file: "a.ts", line: 1, symbol: "oldName", new_name: "newName", apply: false },
  }, done];
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "preview a rename" }], {
    cwd, maxSteps: 8, budget: { maxExtensions: 0 },
    tools: {
      lsp_rename: async () => ({ success: true, output: "rename preview" }),
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(calls).toBe(2);
});

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
