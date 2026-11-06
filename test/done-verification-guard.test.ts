import { test, expect, spyOn, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as loop from "../src/agent/loop";
import { DEFAULT_TOOLS, runAgentLoop } from "../src/agent/engine";
import { snapshotWorkspace, WORKSPACE_SNAPSHOT_LIMITS } from "../src/agent/workspace-snapshot";
import type { Message } from "../src/ai/types";

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
      bash: async () => {
        await fs.writeFile(path.join(cwd, "mutation-marker"), "");
        return { success: true, output: "created mutation-marker" };
      },
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
      bash: async ({ command }) => {
        if (command === "bun test passing.test.ts") return { success: true, output: "1 pass\n0 fail" };
        await fs.writeFile(path.join(cwd, "mutation-marker"), "");
        return { success: true, output: "created mutation-marker" };
      },
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(calls).toBe(4);
});

test("runAgentLoop: computer action that changes a workspace file invalidates earlier verification before done", async () => {
  const steps = [pass, { tool: "computer", arguments: { action: "click", x: 10, y: 20 } }, done, pass, done];
  const calls: string[] = [];
  let llmCalls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[llmCalls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "click and verify" }], {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: {
      computer: async () => {
        calls.push("computer");
        await fs.writeFile(path.join(cwd, "ui-output.txt"), "clicked");
        return { success: true, output: "clicked" };
      },
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

// --- Workspace-snapshot mutation authority for bash/computer (plan section 1.5, 4.1-4.2) ---

const UNVERIFIED_TEXT = "You modified files this turn but have no passing verification";
const STALE_TEXT = "You verified earlier, but then modified files again";
const userSaid = (history: Message[], text: string): boolean =>
  history.some(m => m.role === "user" && m.content.includes(text));

test("runAgentLoop: read-only bash commands complete without verification (AC-1)", async () => {
  const steps = [
    { tool: "bash", arguments: { command: "date" } },
    { tool: "bash", arguments: { command: "ls -a" } },
    done,
  ];
  let calls = 0;
  const notices: string[] = [];
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "run date and ls -a" }], {
    cwd, maxSteps: 8, budget: { maxExtensions: 0 },
    tools: { bash: DEFAULT_TOOLS.bash },
    events: { onNotice: msg => { notices.push(msg); } },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(result.completionRejected).toBeUndefined();
  expect(calls).toBe(3);
  expect(notices.some(n => /done deferred/.test(n))).toBe(false);
});

test("runAgentLoop: bash that creates a workspace file needs a passing verification (AC-2)", async () => {
  const steps = [{ tool: "bash", arguments: { command: "touch created.txt" } }, done, pass, done];
  let calls = 0;
  const history: Message[] = [{ role: "user", content: "create a file and verify" }];
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: {
      bash: async ({ command }) => {
        if (command === "bun test passing.test.ts") return { success: true, output: "1 pass\n0 fail" };
        await fs.writeFile(path.join(cwd, "created.txt"), "");
        return { success: true, output: "" };
      },
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(userSaid(history, UNVERIFIED_TEXT)).toBe(true);
  expect(calls).toBe(4);
});

test("runAgentLoop: re-modifying an already-changed file is detected (AC-3)", async () => {
  const writeA = { tool: "bash", arguments: { command: "write-a" } };
  const writeB = { tool: "bash", arguments: { command: "write-b" } };
  const steps = [writeA, pass, writeB, done, pass, done];
  let calls = 0;
  const history: Message[] = [{ role: "user", content: "rewrite a.txt twice" }];
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: {
      bash: async ({ command }) => {
        if (command === "bun test passing.test.ts") return { success: true, output: "1 pass\n0 fail" };
        // Same size on purpose: only content changes between the two writes.
        await fs.writeFile(path.join(cwd, "a.txt"), command === "write-a" ? "aaaa" : "bbbb");
        return { success: true, output: "" };
      },
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(userSaid(history, STALE_TEXT)).toBe(true);
  expect(calls).toBe(6);
});

test("runAgentLoop: bash writes only under .jeo, .git or node_modules are not mutations (AC-4)", async () => {
  // Every non-excluded parent exists before the turn, so only excluded directories appear.
  await fs.mkdir(path.join(cwd, "sub"));
  await fs.mkdir(path.join(cwd, ".git"));
  const steps = [{ tool: "bash", arguments: { command: "write-excluded" } }, done];
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "touch harness state only" }], {
    cwd, maxSteps: 8, budget: { maxExtensions: 0 },
    tools: {
      bash: async () => {
        await fs.mkdir(path.join(cwd, ".jeo", "state"), { recursive: true });
        await fs.writeFile(path.join(cwd, ".jeo", "state", "x.json"), "{}");
        await fs.writeFile(path.join(cwd, ".git", "index.lock"), "");
        await fs.mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true });
        await fs.writeFile(path.join(cwd, "node_modules", "pkg", "index.js"), "");
        await fs.mkdir(path.join(cwd, "sub", "node_modules"), { recursive: true });
        await fs.writeFile(path.join(cwd, "sub", "node_modules", "y.js"), "");
        return { success: true, output: "" };
      },
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(calls).toBe(2);
});

for (const failure of [
  { name: "snapshot failure counts bash as a mutation (AC-5a)", snapshot: async () => { throw new Error("boom"); } },
  { name: "snapshot error result counts bash as a mutation (AC-5a)", snapshot: async () => ({ ok: false as const, reason: "error" as const, detail: "x" }) },
]) {
  test(`runAgentLoop: ${failure.name}`, async () => {
    const steps = [{ tool: "bash", arguments: { command: "ls" } }];
    let calls = 0;
    spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
    const result = await runAgentLoop([{ role: "user", content: "list files" }], {
      cwd, maxSteps: 12, budget: { maxExtensions: 0 },
      workspaceSnapshot: failure.snapshot,
      tools: { bash: async () => ({ success: true, output: "a.txt" }) },
    });

    expect(result.done).toBe(false);
    expect(result.completionRejected).toBe(true);
    expect(result.doneReason).toMatch(/verif/i);
    expect(result.doneReason).toContain("UNVERIFIED");
  });
}

test("runAgentLoop: over-cap snapshot counts bash as a mutation and stops re-walking (AC-5a)", async () => {
  await fs.writeFile(path.join(cwd, "one.txt"), "1");
  await fs.writeFile(path.join(cwd, "two.txt"), "2");
  const steps = [{ tool: "bash", arguments: { command: "ls" } }, { tool: "bash", arguments: { command: "pwd" } }];
  let calls = 0;
  let snapCalls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "list files" }], {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    workspaceSnapshot: (c, since) => {
      snapCalls++;
      return snapshotWorkspace(c, { ...WORKSPACE_SNAPSHOT_LIMITS, maxEntries: 1 }, since);
    },
    tools: { bash: async () => ({ success: true, output: "one.txt two.txt" }) },
  });

  expect(result.done).toBe(false);
  expect(result.completionRejected).toBe(true);
  expect(result.doneReason).toMatch(/verif/i);
  expect(result.doneReason).toContain("UNVERIFIED");
  expect(snapCalls).toBe(1);
});

test("runAgentLoop: an inconclusive snapshot is reported once and named in the done-gate message", async () => {
  const steps = [{ tool: "bash", arguments: { command: "ls" } }, { tool: "bash", arguments: { command: "pwd" } }];
  let calls = 0;
  const notices: string[] = [];
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const history: Message[] = [{ role: "user", content: "list files" }];
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    events: { onNotice: msg => { notices.push(msg); } },
    workspaceSnapshot: async () => ({ ok: false as const, reason: "error" as const, detail: "cannot read directory locked: EACCES" }),
    tools: { bash: async () => ({ success: true, output: "a.txt" }) },
  });

  // Still the safe side (AC-5a): the bash calls count as possible mutations and the gate holds.
  expect(result.completionRejected).toBe(true);
  expect(result.doneReason).toContain("UNVERIFIED");
  // ...but the reason is surfaced exactly once (two bash calls, two snapshots each) and in the gate message.
  expect(notices.filter(n => n.includes("workspace snapshot inconclusive"))).toEqual([
    "workspace snapshot inconclusive (error: cannot read directory locked: EACCES); shell calls are counted as possible file changes",
  ]);
  expect(userSaid(history, "could not measure a shell call's effect")).toBe(true);
  expect(userSaid(history, "cannot read directory locked: EACCES")).toBe(true);
});

test("runAgentLoop: a measured workspace change gets no unmeasured note", async () => {
  const steps = [{ tool: "bash", arguments: { command: "write-file" } }, done];
  let calls = 0;
  const history: Message[] = [{ role: "user", content: "write a file" }];
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: { bash: async () => { await fs.writeFile(path.join(cwd, "made.txt"), "x"); return { success: true, output: "" }; } },
  });

  expect(result.completionRejected).toBe(true);
  expect(userSaid(history, "no passing verification")).toBe(true);
  expect(userSaid(history, "could not measure")).toBe(false);
});

test("runAgentLoop: a computer click that changes no workspace file completes without verification (AC-6)", async () => {
  const steps = [{ tool: "computer", arguments: { action: "click", x: 10, y: 20 } }, done];
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "click the button" }], {
    cwd, maxSteps: 8, budget: { maxExtensions: 0 },
    tools: {
      // Mirrors computer.ts: the audit log lives under the excluded .jeo/ directory.
      computer: async () => {
        await fs.appendFile(path.join(cwd, ".jeo", "computer-audit.jsonl"), `${JSON.stringify({ action: "click" })}\n`);
        return { success: true, output: "clicked" };
      },
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(calls).toBe(2);
});

test("runAgentLoop: a computer action that writes a workspace file bounces done (AC-6)", async () => {
  const steps = [{ tool: "computer", arguments: { action: "click", x: 10, y: 20 } }, done, pass, done];
  let calls = 0;
  const history: Message[] = [{ role: "user", content: "export from the app" }];
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: {
      computer: async () => {
        await fs.writeFile(path.join(cwd, "exported.txt"), "export");
        return { success: true, output: "clicked export" };
      },
      bash: async () => ({ success: true, output: "1 pass\n0 fail" }),
    },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(userSaid(history, UNVERIFIED_TEXT)).toBe(true);
  expect(calls).toBe(4);
});

test("runAgentLoop: write still bounces done without verification (AC-7)", async () => {
  const steps = [{ tool: "write", arguments: { filePath: "a.ts", content: "updated" } }, done];
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
  const result = await runAgentLoop([{ role: "user", content: "change the workspace" }], {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    // The fake never touches the filesystem: write counts by tool name, not by snapshot.
    tools: { write: async () => ({ success: true, output: "wrote a.ts" }) },
  });

  expect(result.done).toBe(false);
  expect(result.completionRejected).toBe(true);
  expect(result.doneReason).toContain(UNVERIFIED_TEXT);
  expect(result.doneReason).toContain("UNVERIFIED");
});

for (const debug of [
  { action: "launch", accepted: false },
  { action: "stack_trace", accepted: true },
]) {
  test(`runAgentLoop: mutating debug actions still require verification (AC-7, ${debug.action})`, async () => {
    const steps = [{ tool: "debug", arguments: { action: debug.action } }, done];
    let calls = 0;
    spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? done));
    const result = await runAgentLoop([{ role: "user", content: "debug the program" }], {
      cwd, maxSteps: 12, budget: { maxExtensions: 0 },
      tools: { debug: async () => ({ success: true, output: "ok" }) },
    });

    expect(result.done).toBe(debug.accepted);
    if (debug.accepted) expect(result.doneReason).toBe("verified");
    else expect(result.doneReason).toContain(UNVERIFIED_TEXT);
  });
}

test("runAgentLoop: exhausted completion keeps the last candidate answer under UNVERIFIED (AC-9)", async () => {
  const answer = { tool: "done", arguments: { reason: "Here is the answer: 42" } };
  const steps = [{ tool: "bash", arguments: { command: "echo x > made.txt" } }, answer, answer, answer, answer];
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? answer));
  const result = await runAgentLoop([{ role: "user", content: "answer and record it" }], {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: {
      bash: async () => {
        await fs.writeFile(path.join(cwd, "made.txt"), "x\n");
        return { success: true, output: "" };
      },
    },
  });

  expect(await fs.readFile(path.join(cwd, "made.txt"), "utf8")).toBe("x\n");
  expect(result.done).toBe(false);
  expect(result.completionRejected).toBe(true);
  expect(result.doneReason).toContain("Here is the answer: 42");
  expect(result.doneReason).toContain("UNVERIFIED");
  expect(result.doneReason).toContain("completion rejected after 3 corrections");
  expect(result.doneReason).toContain("You modified files this turn");
  expect(calls).toBe(5);
});
