import { test, expect, spyOn, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as loop from "../src/agent/loop";
import { DEFAULT_TOOLS, runAgentLoop, type ToolHandler } from "../src/agent/engine";
import { isSharedScratchRoot, snapshotWorkspace, WORKSPACE_SNAPSHOT_LIMITS, type WorkspaceSnapshotter } from "../src/agent/workspace-snapshot";
import { GUARD_LIMITS, MUTATION_NUDGE_PREFIX } from "../src/agent/loop-guards";
import { buildAnthropicMessages } from "../src/ai/providers/anthropic";
import { buildGeminiPayload } from "../src/ai/providers/gemini";
import { buildResponsesInput } from "../src/ai/providers/openai-responses";
import type { Message, ReasoningArtifact } from "../src/ai/types";

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
  expect(userSaid(history, "could not measure a shell/computer call's effect")).toBe(true);
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
  // Shell-only evidence (no built-in mutator ran) earns ONE correction, which names the changed path.
  expect(result.doneReason).toContain("completion rejected after 1 correction.");
  expect(result.doneReason).toContain("You modified files this turn");
  expect(result.doneReason).toContain("added made.txt");
  expect(calls).toBe(3);
});

// --- Ambient-writer attribution and the shell-only correction budget ---
// Incident: a read-only shell turn in a shared directory ended UNVERIFIED after three corrections because an
// unrelated process rewrote a file in the cwd during a long bash call and the snapshot bracket blamed the command.

const FULL_BUDGET = GUARD_LIMITS.MAX_DONE_CORRECTIONS;
const scripted = (steps: readonly unknown[], fallback: unknown = done) => {
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => JSON.stringify(steps[calls++] ?? fallback));
  return { calls: () => calls };
};
const repeatStep = <T>(count: number, step: T): T[] => Array.from({ length: count }, () => step);
const readOnlyBash = { tool: "bash", arguments: { command: "cat status.txt" } };
const countUserMessages = (history: Message[], text: string): number =>
  history.filter(m => m.role === "user" && m.content.includes(text)).length;
const toolResultsOf = (history: Message[]) => history.flatMap(m => m.toolResults ?? []);

/**
 * A bash stub standing in for the real shell: recognized verifiers pass (or fail), `write-NAME` creates NAME,
 * and every other command is "read-only" yet an unrelated process writes heartbeat.json while it runs.
 */
const ambientBash = (opts: { failingVerifierMayMutate?: boolean } = {}) => {
  let beat = 0;
  return async (args: Record<string, any>) => {
    const command = String(args.command ?? "");
    if (command === "bun test passing.test.ts") return { success: true, output: "1 pass\n0 fail" };
    if (command === "bun test failing.test.ts") {
      return { success: false, output: "0 pass\n1 fail", error: "test exited 1", mutationMayHaveOccurred: opts.failingVerifierMayMutate === true };
    }
    const named = /^write-(\S+)$/.exec(command);
    // Distinct lengths so a rewrite is visible without relying on mtime resolution.
    await fs.writeFile(path.join(cwd, named ? named[1] : "heartbeat.json"), "x".repeat(++beat));
    return { success: true, output: "status ok" };
  };
};
const ok = async () => ({ success: true, output: "ok" });
type Tools = Record<string, ToolHandler>;

for (const ambient of [
  { name: "a new file", seed: undefined as string | undefined, expected: "added heartbeat.json" },
  { name: "a rewritten file", seed: "{}", expected: "modified heartbeat.json" },
]) {
  test(`runAgentLoop: an unrelated process writing during a read-only shell call is named and earns exactly one correction (${ambient.name})`, async () => {
    // Fails against the old gate: no path was named and the same block was retried MAX_DONE_CORRECTIONS times.
    if (ambient.seed !== undefined) await fs.writeFile(path.join(cwd, "heartbeat.json"), ambient.seed);
    const llm = scripted([readOnlyBash, ...repeatStep(FULL_BUDGET + 1, done)]);
    const history: Message[] = [{ role: "user", content: "show me status.txt" }];
    const result = await runAgentLoop(history, {
      cwd, maxSteps: 12, budget: { maxExtensions: 0 },
      tools: { bash: ambientBash() },
    });

    expect(result.done).toBe(false);
    expect(result.completionRejected).toBe(true);
    expect(result.doneReason).toContain("UNVERIFIED");
    expect(result.doneReason).toContain("completion rejected after 1 correction.");
    expect(result.doneReason).not.toContain("corrections.");
    // The rejection tells the model WHICH path the host saw change, so it can recognize it is not its own.
    expect(userSaid(history, ambient.expected)).toBe(true);
    expect(userSaid(history, "Something other than your commands may have written them")).toBe(true);
    expect(userSaid(history, "Only a passing verification command clears this check")).toBe(true);
    expect(result.doneReason).toContain(ambient.expected);
    // bash, the first rejected done, then the second done that stops the loop: no further model rounds.
    expect(countUserMessages(history, UNVERIFIED_TEXT)).toBe(1);
    expect(llm.calls()).toBe(3);
  });
}

for (const write of [
  // Excluded directories are invisible to the snapshot, so an ambient write there never blocks done.
  { rel: ".git/index.lock", blocked: false },
  { rel: ".jeo/state/heartbeat.json", blocked: false },
  { rel: "node_modules/pkg/index.js", blocked: false },
  { rel: "sub/node_modules/y.js", blocked: false },
  // Controls: the very same write outside the excluded directories is seen (and named).
  { rel: "heartbeat.json", blocked: true },
  { rel: "sub/heartbeat.json", blocked: true },
]) {
  test(`runAgentLoop: ambient write to ${write.rel} ${write.blocked ? "is attributed and blocks done once" : "does not block done"}`, async () => {
    // Boundary of the new behavior: only paths the snapshot actually records can block, and only once.
    await fs.mkdir(path.join(cwd, "sub"));
    const llm = scripted([readOnlyBash, ...repeatStep(FULL_BUDGET + 1, done)]);
    const history: Message[] = [{ role: "user", content: "show me status.txt" }];
    const result = await runAgentLoop(history, {
      cwd, maxSteps: 12, budget: { maxExtensions: 0 },
      tools: {
        bash: async () => {
          const file = path.join(cwd, write.rel);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, "{}");
          return { success: true, output: "status ok" };
        },
      },
    });

    if (write.blocked) {
      expect(result.done).toBe(false);
      expect(result.doneReason).toContain("completion rejected after 1 correction.");
      expect(userSaid(history, `added ${write.rel}`)).toBe(true);
      expect(llm.calls()).toBe(3);
    } else {
      expect(result.done).toBe(true);
      expect(result.doneReason).toBe("verified");
      expect(userSaid(history, UNVERIFIED_TEXT)).toBe(false);
      expect(llm.calls()).toBe(2);
    }
  });
}

for (const scenario of [
  { name: "a successful built-in edit", steps: [edit], tools: { edit: ok } },
  // The definite mutation must win in either order: a shell-bracket change never lowers the cap.
  { name: "an edit followed by a shell-bracket change", steps: [edit, readOnlyBash], tools: { edit: ok } },
  { name: "a shell-bracket change followed by an edit", steps: [readOnlyBash, edit], tools: { edit: ok } },
  { name: "a write after a shell-bracket change", steps: [readOnlyBash, { tool: "write", arguments: { filePath: "a.ts", content: "x" } }], tools: { write: ok } },
  { name: "a mkdir after a shell-bracket change", steps: [readOnlyBash, { tool: "mkdir", arguments: { path: "new-dir" } }], tools: { mkdir: ok } },
  { name: "a delete after a shell-bracket change", steps: [readOnlyBash, { tool: "delete", arguments: { path: "old.txt" } }], tools: { delete: ok } },
  { name: "an ast_edit after a shell-bracket change", steps: [readOnlyBash, { tool: "ast_edit", arguments: { pattern: "a", replacement: "b", paths: ["a.ts"] } }], tools: { ast_edit: ok } },
  { name: "an lsp_rename after a shell-bracket change", steps: [readOnlyBash, { tool: "lsp_rename", arguments: { file: "a.ts", line: 1, symbol: "a", new_name: "b" } }], tools: { lsp_rename: ok } },
  { name: "an eval after a shell-bracket change", steps: [readOnlyBash, { tool: "eval", arguments: { code: "1" } }], tools: { eval: ok } },
  { name: "a debug launch after a shell-bracket change", steps: [readOnlyBash, { tool: "debug", arguments: { action: "launch" } }], tools: { debug: ok } },
  { name: "a monitor start after a shell-bracket change", steps: [readOnlyBash, { tool: "monitor", arguments: { action: "start" } }], tools: { monitor: ok } },
  { name: "a job start after a shell-bracket change", steps: [readOnlyBash, { tool: "job", arguments: { action: "start" } }], tools: { job: ok } },
  {
    name: "a delegated tool that reports a possible file change",
    steps: [readOnlyBash, { tool: "remote_apply", arguments: {} }],
    tools: { remote_apply: async () => ({ success: true, output: "applied", mutationMayHaveOccurred: true }) },
  },
  {
    name: "a failing verifier that reports a possible file change",
    steps: [readOnlyBash, fail],
    tools: { bash: ambientBash({ failingVerifierMayMutate: true }) },
  },
] as { name: string; steps: unknown[]; tools: Tools }[]) {
  test(`runAgentLoop: ${scenario.name} keeps the full completion budget`, async () => {
    // Fails if any definite mutator were treated as shell-only: the model would get one correction, not the full budget.
    const llm = scripted([...scenario.steps, ...repeatStep(FULL_BUDGET + 1, done)]);
    const history: Message[] = [{ role: "user", content: "change things and report" }];
    const result = await runAgentLoop(history, {
      cwd, maxSteps: 16, budget: { maxExtensions: 0 },
      tools: { bash: ambientBash(), ...scenario.tools },
    });

    expect(result.done).toBe(false);
    expect(result.completionRejected).toBe(true);
    expect(result.doneReason).toContain(`completion rejected after ${FULL_BUDGET} corrections.`);
    expect(countUserMessages(history, UNVERIFIED_TEXT)).toBe(FULL_BUDGET);
    expect(llm.calls()).toBe(scenario.steps.length + FULL_BUDGET + 1);
  });
}

test("runAgentLoop: a shell change plus a failing post-turn hook keeps the full completion budget", async () => {
  // Fails if a hook failure were counted as shell-only: the hook is something the model CAN fix, so it needs the full budget.
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-gate-config-"));
  const savedConfigDir = process.env.JEO_CONFIG_DIR;
  process.env.JEO_CONFIG_DIR = configDir;
  try {
    await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
      defaultModel: "claude-sonnet-4-5",
      providers: {},
      hooks: { enabled: true, hooks: [{ event: "post-turn", match: { tool: "bash" }, run: "echo 'hook red' && exit 1" }] },
    }));
    // beforeEach disabled hooks for this project; remove that opt-out so the configured hook runs.
    await fs.rm(path.join(cwd, ".jeo", "hooks.json"));
    const llm = scripted([readOnlyBash, ...repeatStep(FULL_BUDGET + 1, done)]);
    const history: Message[] = [{ role: "user", content: "show me status.txt" }];
    const result = await runAgentLoop(history, {
      cwd, maxSteps: 12, budget: { maxExtensions: 0 },
      tools: { bash: ambientBash() },
    });

    expect(result.done).toBe(false);
    expect(result.completionRejected).toBe(true);
    expect(result.doneReason).toContain(`completion rejected after ${FULL_BUDGET} corrections.`);
    expect(result.doneReason).toContain("FAILING (non-zero exit)");
    expect(countUserMessages(history, "FAILING (non-zero exit)")).toBe(FULL_BUDGET);
    expect(llm.calls()).toBe(1 + FULL_BUDGET + 1);
  } finally {
    if (savedConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
    else process.env.JEO_CONFIG_DIR = savedConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
  }
});

for (const nudge of [
  { name: "no caller nudge", onBeforeDone: () => null, corrections: 1, text: "completion rejected after 1 correction." },
  { name: "a caller nudge returned together with the shell-only block", onBeforeDone: () => "Caller check: also summarize status.txt.", corrections: FULL_BUDGET, text: `completion rejected after ${FULL_BUDGET} corrections.` },
]) {
  test(`runAgentLoop: shell-only block with ${nudge.name} gets ${nudge.corrections} correction(s)`, async () => {
    // Same script both times; only the nudge differs. A nudge is not shell-only evidence, so it keeps the full budget.
    const llm = scripted([readOnlyBash, ...repeatStep(FULL_BUDGET + 1, done)]);
    const history: Message[] = [{ role: "user", content: "show me status.txt" }];
    const result = await runAgentLoop(history, {
      cwd, maxSteps: 12, budget: { maxExtensions: 0 },
      tools: { bash: ambientBash() },
      events: { onBeforeDone: nudge.onBeforeDone },
    });

    expect(result.done).toBe(false);
    expect(result.completionRejected).toBe(true);
    expect(result.doneReason).toContain(nudge.text);
    expect(llm.calls()).toBe(1 + nudge.corrections + 1);
    if (nudge.corrections > 1) {
      // The model sees the gate's reason and the caller's nudge in the same corrective message.
      expect(history.some(m => m.role === "user" && m.content.includes(UNVERIFIED_TEXT) && m.content.includes("Caller check:"))).toBe(true);
    }
  });
}

test("runAgentLoop: an unmeasurable snapshot is still shell-only evidence (one correction, no path list)", async () => {
  // Boundary: a bracket that could not measure counts as a possible change but never as a definite one.
  const llm = scripted([readOnlyBash, ...repeatStep(FULL_BUDGET + 1, done)]);
  const history: Message[] = [{ role: "user", content: "show me status.txt" }];
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    workspaceSnapshot: async () => { throw new Error("boom"); },
    tools: { bash: async () => ({ success: true, output: "status ok" }) },
  });

  expect(result.completionRejected).toBe(true);
  expect(result.doneReason).toContain("completion rejected after 1 correction.");
  expect(userSaid(history, "could not measure a shell/computer call's effect")).toBe(true);
  expect(userSaid(history, "the host saw these paths change")).toBe(false);
  expect(llm.calls()).toBe(3);
});

test("runAgentLoop: a passing verifier after a shell-only block clears the gate", async () => {
  // Verification still lifts a shell-only block: the single correction asks for proof and the proof is accepted.
  const llm = scripted([{ tool: "bash", arguments: { command: "write-a.txt" } }, done, pass, done]);
  const history: Message[] = [{ role: "user", content: "write a.txt and verify" }];
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: { bash: ambientBash() },
  });

  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(result.completionRejected).toBeUndefined();
  expect(countUserMessages(history, UNVERIFIED_TEXT)).toBe(1);
  expect(userSaid(history, "added a.txt")).toBe(true);
  expect(llm.calls()).toBe(4);
});

test("runAgentLoop: verification resets the correction count so a later shell change gets a fresh correction", async () => {
  // Fails if the verifier did not reset doneCorrections: the second block would stop at once (5 calls, no stale message).
  const llm = scripted([
    { tool: "bash", arguments: { command: "write-a.txt" } }, done, // shell-only block: correction 1 of 1
    pass,                                                           // verifier clears it and resets the count
    { tool: "bash", arguments: { command: "write-b.txt" } }, done, // stale block: a FRESH single correction
    done,                                                           // exhausted again: the loop stops
  ]);
  const history: Message[] = [{ role: "user", content: "write two files with a check between" }];
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 14, budget: { maxExtensions: 0 },
    tools: { bash: ambientBash() },
  });

  expect(result.done).toBe(false);
  expect(result.completionRejected).toBe(true);
  expect(result.doneReason).toContain("completion rejected after 1 correction.");
  expect(countUserMessages(history, UNVERIFIED_TEXT)).toBe(1);
  expect(countUserMessages(history, STALE_TEXT)).toBe(1);
  expect(result.doneReason).toContain("added b.txt");
  // The passing verification spent the earlier evidence: a.txt (written before it) is not blamed again.
  expect(result.doneReason).not.toContain("a.txt");
  expect(llm.calls()).toBe(6);
});

// --- Shared scratch cwd: shell and computer calls are not bracketed where unrelated processes write ---

const scratchDirs: string[] = [];
afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * A fresh, realpath'd directory the test declares a shared scratch root through `scratchRoots`. Hermetic: no env
 * mutation (TMPDIR/HOME are process-global and other test files cache node:os) and never the real $HOME or temp dir.
 */
async function scratchRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jeo-scratch-root-")));
  scratchDirs.push(root);
  // Without these the tests below would pass vacuously: the root is scratch, a directory inside it is not.
  expect(isSharedScratchRoot(root, [root])).toBe(true);
  expect(isSharedScratchRoot(path.join(root, "project"), [root])).toBe(false);
  await fs.mkdir(path.join(root, ".jeo"));
  await fs.writeFile(path.join(root, ".jeo", "hooks.json"), JSON.stringify({ enabled: false }));
  return root;
}

test("runAgentLoop: bash is not snapshot-bracketed when cwd is a shared scratch root", async () => {
  // Fails against the old gate: the bracket blamed the shell call for the file and blocked done after 3 rounds.
  const root = await scratchRoot();
  let snapshotCalls = 0;
  const notices: string[] = [];
  const llm = scripted([
    { tool: "bash", arguments: { command: "write-heartbeat.json" } },
    { tool: "bash", arguments: { command: "cat status.txt" } },
    done,
  ]);
  const history: Message[] = [{ role: "user", content: "show me status.txt" }];
  const result = await runAgentLoop(history, {
    cwd: root, scratchRoots: [root], maxSteps: 12, budget: { maxExtensions: 0 },
    events: { onNotice: msg => { notices.push(msg); } },
    workspaceSnapshot: (c, since) => {
      snapshotCalls++;
      return snapshotWorkspace(c, WORKSPACE_SNAPSHOT_LIMITS, since);
    },
    tools: {
      bash: async ({ command }) => {
        if (command === "write-heartbeat.json") await fs.writeFile(path.join(root, "heartbeat.json"), "{}");
        return { success: true, output: "status ok" };
      },
    },
  });

  expect(await fs.readFile(path.join(root, "heartbeat.json"), "utf8")).toBe("{}");
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(llm.calls()).toBe(3);
  expect(snapshotCalls).toBe(0);
  // Told once (not per call) why shell calls here are unchecked, naming the directory.
  const scratchNotices = notices.filter(n => n.includes("shared scratch directory"));
  expect(scratchNotices).toHaveLength(1);
  expect(scratchNotices[0]).toContain(root);
  expect(notices.some(n => /done deferred/.test(n))).toBe(false);
  expect(scratchNotices[0]).toBe(`cwd ${root} is a shared scratch directory: shell and computer calls here are not checked for file changes`);
  // Nothing was measured, and the record says so (rather than claiming a clean `mutation:false` measurement).
  expect(toolResultsOf(history).map(r => r.workspace)).toStrictEqual([
    { mutation: false, skipped: "scratch" },
    { mutation: false, skipped: "scratch" },
  ]);
});

test("runAgentLoop: a project directory nested inside a shared scratch root stays gated", async () => {
  // Boundary: only the scratch root itself is exempt; a mkdtemp child is a real project and keeps the bracket.
  const root = await scratchRoot();
  const project = await fs.mkdtemp(path.join(root, "project-"));
  await fs.mkdir(path.join(project, ".jeo"));
  await fs.writeFile(path.join(project, ".jeo", "hooks.json"), JSON.stringify({ enabled: false }));
  expect(isSharedScratchRoot(project, [root])).toBe(false);
  let snapshotCalls = 0;
  const notices: string[] = [];
  const llm = scripted([{ tool: "bash", arguments: { command: "write-made.txt" } }, ...repeatStep(FULL_BUDGET + 1, done)]);
  const history: Message[] = [{ role: "user", content: "create made.txt" }];
  const result = await runAgentLoop(history, {
    cwd: project, scratchRoots: [root], maxSteps: 12, budget: { maxExtensions: 0 },
    events: { onNotice: msg => { notices.push(msg); } },
    workspaceSnapshot: (c, since) => {
      snapshotCalls++;
      return snapshotWorkspace(c, WORKSPACE_SNAPSHOT_LIMITS, since);
    },
    tools: { bash: async () => { await fs.writeFile(path.join(project, "made.txt"), "x"); return { success: true, output: "" }; } },
  });

  expect(result.done).toBe(false);
  expect(result.completionRejected).toBe(true);
  expect(result.doneReason).toContain("completion rejected after 1 correction.");
  expect(userSaid(history, "added made.txt")).toBe(true);
  expect(snapshotCalls).toBe(2); // one before/after pair for the single bash call
  expect(notices.some(n => n.includes("shared scratch directory"))).toBe(false);
  expect(llm.calls()).toBe(3);
});

test("runAgentLoop: in a shared scratch cwd computer and bash calls are skipped and recorded as skipped", async () => {
  // Fails against the earlier behavior, which still bracketed computer calls and so blamed them for unrelated writes.
  const root = await scratchRoot();
  let snapshotCalls = 0;
  const notices: string[] = [];
  const llm = scripted([
    { tool: "computer", arguments: { action: "click", x: 1, y: 2 } },
    { tool: "bash", arguments: { command: "write-heartbeat.json" } },
    { tool: "computer", arguments: { action: "screenshot" } },
    pass,
    done,
  ]);
  const history: Message[] = [{ role: "user", content: "export from the app and check status" }];
  const result = await runAgentLoop(history, {
    cwd: root, scratchRoots: [root], maxSteps: 12, budget: { maxExtensions: 0 },
    events: { onNotice: msg => { notices.push(msg); } },
    workspaceSnapshot: (c, since) => {
      snapshotCalls++;
      return snapshotWorkspace(c, WORKSPACE_SNAPSHOT_LIMITS, since);
    },
    tools: {
      // The handler's own cwd argument is the scratch root, so these writes land exactly where a bracket would look.
      computer: async (_args: Record<string, any>, dir: string) => {
        await fs.writeFile(path.join(dir, "exported.txt"), "x");
        return { success: true, output: "clicked" };
      },
      bash: async ({ command }) => {
        if (command === "bun test passing.test.ts") return { success: true, output: "1 pass\n0 fail" };
        await fs.writeFile(path.join(root, "heartbeat.json"), "{}");
        return { success: true, output: "status ok" };
      },
    },
  });

  expect(await fs.readFile(path.join(root, "exported.txt"), "utf8")).toBe("x"); // premise: both writes really happened
  expect(await fs.readFile(path.join(root, "heartbeat.json"), "utf8")).toBe("{}");
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("verified");
  expect(llm.calls()).toBe(5);
  expect(snapshotCalls).toBe(0);
  // One notice for the whole turn, shared by the computer and bash calls.
  expect(notices.filter(n => n.includes("shared scratch directory"))).toEqual([
    `cwd ${root} is a shared scratch directory: shell and computer calls here are not checked for file changes`,
  ]);
  const results = toolResultsOf(history);
  expect(results.map(r => r.workspace)).toStrictEqual([
    { mutation: false, skipped: "scratch" },
    { mutation: false, skipped: "scratch" },
    undefined,
    undefined,
  ]);
  // The observe-only screenshot and the recognized verifier were never candidates for a bracket: no `workspace` key at all.
  expect("workspace" in results[2]).toBe(false);
  expect("workspace" in results[3]).toBe(false);
});

test("runAgentLoop: in a shared scratch cwd a built-in edit is still a definite mutation with the full budget", async () => {
  // Boundary: scratch status only exempts shell and computer calls; built-in tools keep their evidence rules.
  const root = await scratchRoot();
  let snapshotCalls = 0;
  const llm = scripted([edit, ...repeatStep(FULL_BUDGET + 1, done)]);
  const result = await runAgentLoop([{ role: "user", content: "change the workspace" }], {
    cwd: root, scratchRoots: [root], maxSteps: 12, budget: { maxExtensions: 0 },
    workspaceSnapshot: (c, since) => {
      snapshotCalls++;
      return snapshotWorkspace(c, WORKSPACE_SNAPSHOT_LIMITS, since);
    },
    tools: { edit: ok },
  });

  expect(result.done).toBe(false);
  expect(result.completionRejected).toBe(true);
  expect(result.doneReason).toContain(`completion rejected after ${FULL_BUDGET} corrections.`);
  expect(snapshotCalls).toBe(0);
  expect(llm.calls()).toBe(1 + FULL_BUDGET + 1);
});

for (const row of [
  { name: "the cwd is listed in scratchRoots", roots: (dir: string): readonly string[] | undefined => [dir], scratch: true },
  // Default roots ($HOME, /, the temp dirs) do not include an ordinary mkdtemp project dir that merely sits inside one.
  { name: "scratchRoots is omitted and the cwd is an ordinary project dir under the temp dir", roots: (): readonly string[] | undefined => undefined, scratch: false },
  // An explicit empty list replaces the defaults: nothing is scratch.
  { name: "scratchRoots is empty", roots: (): readonly string[] | undefined => [], scratch: false },
  // Only an exact match counts: listing an ancestor does not exempt the directories inside it.
  { name: "scratchRoots lists only an ancestor of the cwd", roots: (dir: string): readonly string[] | undefined => [path.dirname(dir)], scratch: false },
]) {
  test(`runAgentLoop: a bash write is ${row.scratch ? "skipped (not blamed)" : "bracketed and blocks done once"} when ${row.name}`, async () => {
    // Pins the seam: `scratchRoots` alone decides whether a cwd is scratch, and only on an exact match.
    let snapshotCalls = 0;
    const notices: string[] = [];
    const llm = scripted([{ tool: "bash", arguments: { command: "write-made.txt" } }, ...repeatStep(FULL_BUDGET + 1, done)]);
    const history: Message[] = [{ role: "user", content: "create made.txt" }];
    const result = await runAgentLoop(history, {
      cwd, scratchRoots: row.roots(cwd), maxSteps: 12, budget: { maxExtensions: 0 },
      events: { onNotice: msg => { notices.push(msg); } },
      workspaceSnapshot: (c, since) => {
        snapshotCalls++;
        return snapshotWorkspace(c, WORKSPACE_SNAPSHOT_LIMITS, since);
      },
      tools: { bash: ambientBash() },
    });

    expect(await fs.readFile(path.join(cwd, "made.txt"), "utf8")).toHaveLength(1); // premise: the write happened
    if (row.scratch) {
      expect(result.done).toBe(true);
      expect(result.doneReason).toBe("verified");
      expect(snapshotCalls).toBe(0);
      expect(notices.filter(n => n.includes("shared scratch directory"))).toHaveLength(1);
      expect(llm.calls()).toBe(2);
    } else {
      expect(result.done).toBe(false);
      expect(result.completionRejected).toBe(true);
      expect(result.doneReason).toContain("completion rejected after 1 correction.");
      expect(userSaid(history, "added made.txt")).toBe(true);
      expect(snapshotCalls).toBe(2); // one before/after pair for the single bash call
      expect(notices.some(n => n.includes("shared scratch directory"))).toBe(false);
      expect(llm.calls()).toBe(3);
    }
  });
}

// --- Persisted workspace evidence on tool results ---

test("runAgentLoop: bracketed bash results persist their workspace evidence and other tools carry none", async () => {
  // Contract: the audit record is exact per call, and only bracketed calls have one.
  const llm = scripted([
    { tool: "bash", arguments: { command: "cat status.txt" } },
    { tool: "bash", arguments: { command: "write-x.txt" } },
    read,
    edit,
    pass,
    done,
  ]);
  const history: Message[] = [{ role: "user", content: "inspect, write x.txt, verify" }];
  const bash = async (args: Record<string, any>) => {
    if (args.command === "write-x.txt") await fs.writeFile(path.join(cwd, "x.txt"), "x");
    return args.command === "bun test passing.test.ts" ? { success: true, output: "1 pass\n0 fail" } : { success: true, output: "ok" };
  };
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 14, budget: { maxExtensions: 0 },
    tools: { bash, read: async () => ({ success: true, output: "source" }), edit: ok },
  });

  expect(result.done).toBe(true);
  expect(llm.calls()).toBe(6);
  const results = toolResultsOf(history);
  expect(results).toHaveLength(5);
  expect(results[0].workspace).toStrictEqual({ mutation: false });
  expect(results[1].workspace).toStrictEqual({ mutation: true, changed: "added x.txt" });
  // read, edit and the recognized verifier are never snapshot-bracketed: no `workspace` key at all.
  for (const unbracketed of results.slice(2)) expect("workspace" in unbracketed).toBe(false);
});

for (const failure of [
  {
    name: "a snapshot error before the call",
    snapshotter: (): WorkspaceSnapshotter => async () => ({ ok: false, reason: "error", detail: "cannot read directory locked: EACCES" }),
    inconclusive: "error: cannot read directory locked: EACCES",
  },
  {
    name: "a snapshot cap hit after the call",
    snapshotter: (): WorkspaceSnapshotter => {
      let snaps = 0;
      return (c, since) => ++snaps === 1
        ? snapshotWorkspace(c, WORKSPACE_SNAPSHOT_LIMITS, since)
        : Promise.resolve({ ok: false as const, reason: "cap" as const, detail: "workspace snapshot exceeded 2000 ms" });
    },
    inconclusive: "cap: workspace snapshot exceeded 2000 ms",
  },
]) {
  test(`runAgentLoop: ${failure.name} is persisted as inconclusive evidence without a path list`, async () => {
    // Contract: an unmeasurable bracket is recorded as a (counted) mutation with the reason, never with invented paths.
    scripted([readOnlyBash, ...repeatStep(FULL_BUDGET + 1, done)]);
    const history: Message[] = [{ role: "user", content: "show me status.txt" }];
    await runAgentLoop(history, {
      cwd, maxSteps: 12, budget: { maxExtensions: 0 },
      workspaceSnapshot: failure.snapshotter(),
      tools: { bash: async () => ({ success: true, output: "status ok" }) },
    });

    expect(toolResultsOf(history)[0].workspace).toStrictEqual({ mutation: true, inconclusive: failure.inconclusive });
  });
}

test("runAgentLoop: computer calls persist evidence only when they can affect state", async () => {
  // Contract: an observe-only action is not gated (no record); a state-changing one records what it changed or that nothing did.
  scripted([
    { tool: "computer", arguments: { action: "click", x: 1, y: 1 } },
    { tool: "computer", arguments: { action: "screenshot" } },
    { tool: "computer", arguments: { action: "click", x: 2, y: 2 } },
    pass,
    done,
  ]);
  const history: Message[] = [{ role: "user", content: "export from the app" }];
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 14, budget: { maxExtensions: 0 },
    tools: {
      computer: async args => {
        if (args.action === "click" && args.x === 1) await fs.writeFile(path.join(cwd, "exported.txt"), "export");
        // Mirrors computer.ts: the audit log lives under the excluded .jeo/ directory.
        if (args.action === "click" && args.x === 2) await fs.appendFile(path.join(cwd, ".jeo", "computer-audit.jsonl"), "{}\n");
        return { success: true, output: "ok" };
      },
      bash: async () => ({ success: true, output: "1 pass\n0 fail" }),
    },
  });

  expect(result.done).toBe(true);
  const results = toolResultsOf(history);
  expect(results[0].workspace).toStrictEqual({ mutation: true, changed: "added exported.txt" });
  expect("workspace" in results[1]).toBe(false);
  expect(results[2].workspace).toStrictEqual({ mutation: false });
});

test("runAgentLoop: a rewrite and a new file are named modified-first in the persisted evidence", async () => {
  // Contract: `changed` lists modified, then added paths, each sorted, exactly as the gate message will show them.
  await fs.writeFile(path.join(cwd, "m.txt"), "old");
  scripted([readOnlyBash, ...repeatStep(FULL_BUDGET + 1, done)]);
  const history: Message[] = [{ role: "user", content: "show me status.txt" }];
  await runAgentLoop(history, {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: {
      bash: async () => {
        await fs.writeFile(path.join(cwd, "z.txt"), "z");
        await fs.writeFile(path.join(cwd, "a.txt"), "a");
        await fs.writeFile(path.join(cwd, "m.txt"), "rewritten");
        return { success: true, output: "status ok" };
      },
    },
  });

  expect(toolResultsOf(history)[0].workspace).toStrictEqual({ mutation: true, changed: "modified m.txt; added a.txt; added z.txt" });
  expect(userSaid(history, "modified m.txt; added a.txt; added z.txt")).toBe(true);
});

test("runAgentLoop: persisted workspace evidence never reaches a provider wire payload", async () => {
  // Contract: `workspace` is host-side audit data. Replay the REAL history through each native adapter (forced onto
  // its tool_result path by same-model reasoning artifacts) and prove none of it is serialized.
  scripted([{ tool: "bash", arguments: { command: "write-x.txt" } }, pass, done]);
  const history: Message[] = [{ role: "user", content: "write x.txt and verify" }];
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 12, budget: { maxExtensions: 0 },
    tools: { bash: ambientBash() },
  });
  expect(result.done).toBe(true);
  expect(toolResultsOf(history)[0].workspace).toStrictEqual({ mutation: true, changed: "added x.txt" }); // premise

  const artifacts: ReasoningArtifact[] = [
    { provider: "anthropic", model: "claude-sonnet-4-5", text: "t", signature: "sig-a" },
    { provider: "openai", model: "gpt-5", itemId: "rs_1", encrypted: "enc" },
    { provider: "gemini", model: "gemini-2.5-flash", thoughtSignature: "sig-g" },
  ];
  const replay = history.map((m): Message => m.role === "assistant" && m.toolUse?.length ? { ...m, reasoningArtifacts: artifacts } : m);
  const wires = {
    anthropic: JSON.stringify(buildAnthropicMessages(replay, "claude-sonnet-4-5", true)),
    openai: JSON.stringify(buildResponsesInput(replay, "gpt-5")),
    gemini: JSON.stringify(buildGeminiPayload(replay, { model: "gemini-2.5-flash" }).payload),
  };

  // Non-vacuous: each adapter really took its native tool-result path for these turns.
  expect(wires.anthropic).toContain('"type":"tool_result"');
  expect(wires.openai).toContain('"type":"function_call_output"');
  expect(wires.gemini).toContain('"functionResponse"');
  for (const wire of Object.values(wires)) expect(wire).not.toMatch(/"(workspace|mutation|changed|inconclusive)"\s*:/);
});

// --- Launch-style nudges, the separate shell-only counter, evidence reset by verification, prose answers ---

/** Mirrors launch.ts's onBeforeDone: an unverified mutation is restated under MUTATION_NUDGE_PREFIX. */
const launchNudge = (_reason: string, evidence: { sawMutation: boolean; sawVerification: boolean; verificationStale: boolean }): string | null =>
  evidence.sawMutation && !(evidence.sawVerification && !evidence.verificationStale)
    ? `${MUTATION_NUDGE_PREFIX} Run a relevant test/build/typecheck/lint after the last change (e.g. 'bun test'), then call done again.`
    : null;
const todoNudge = 'Your todo list still shows 1 unfinished item(s): "write tests". Reconcile the plan first, then call done again.';
const deferredNotices = (notices: string[]): string[] => notices.filter(n => /done deferred/.test(n));
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

for (const nudge of [
  { name: "a launch-style nudge that restates the gate", onBeforeDone: launchNudge, corrections: 1 },
  { name: "a todo-style nudge", onBeforeDone: () => todoNudge, corrections: FULL_BUDGET },
  // Boundary: only a nudge that STARTS with the gate prefix is a restatement; the same words mid-text are independent.
  { name: "a nudge that merely contains the gate prefix mid-text", onBeforeDone: () => `Also reconcile todos. ${MUTATION_NUDGE_PREFIX} Run a test.`, corrections: FULL_BUDGET },
]) {
  test(`runAgentLoop: shell-only block with ${nudge.name} gets ${nudge.corrections} correction(s)`, async () => {
    // Fails against the earlier engine for the launch row: the restating nudge counted as independent, so the full
    // budget applied in the interactive loop and the shell-only cap could never take effect.
    const notices: string[] = [];
    const llm = scripted([readOnlyBash, ...repeatStep(FULL_BUDGET + 1, done)]);
    const history: Message[] = [{ role: "user", content: "show me status.txt" }];
    const result = await runAgentLoop(history, {
      cwd, maxSteps: 14, budget: { maxExtensions: 0 },
      tools: { bash: ambientBash() },
      events: { onNotice: msg => { notices.push(msg); }, onBeforeDone: nudge.onBeforeDone },
    });

    expect(result.done).toBe(false);
    expect(result.completionRejected).toBe(true);
    expect(llm.calls()).toBe(1 + nudge.corrections + 1);
    const rejections = history.filter(m => m.role === "user" && m.content.includes(UNVERIFIED_TEXT));
    expect(rejections).toHaveLength(nudge.corrections);
    // The gate's own text is never duplicated inside one rejection.
    for (const rejection of rejections) expect(occurrences(rejection.content, UNVERIFIED_TEXT)).toBe(1);
    expect(rejections[0].content).toContain("added heartbeat.json");
    if (nudge.corrections === 1) {
      expect(result.doneReason).toContain("completion rejected after 1 correction.");
      // The restatement is dropped: no user message carries it, and the stop text shows the gate reason exactly once.
      expect(countUserMessages(history, MUTATION_NUDGE_PREFIX)).toBe(0);
      expect(result.doneReason).not.toContain(MUTATION_NUDGE_PREFIX);
      expect(occurrences(result.doneReason ?? "", UNVERIFIED_TEXT)).toBe(1);
      expect(deferredNotices(notices)).toEqual(["done deferred — completion correction 1/1"]);
    } else {
      expect(result.doneReason).toContain(`completion rejected after ${FULL_BUDGET} corrections.`);
      // An independent nudge is appended to the gate message, once per rejection.
      for (const rejection of rejections) expect(occurrences(rejection.content, nudge.onBeforeDone("", { sawMutation: true, sawVerification: false, verificationStale: false }) ?? "")).toBe(1);
      expect(deferredNotices(notices)).toEqual(
        Array.from({ length: FULL_BUDGET }, (_, i) => `done deferred — completion correction ${i + 1}/${FULL_BUDGET}`),
      );
    }
  });
}

test("runAgentLoop: a gate-restating nudge with no gate block (carried pending) is returned and keeps the full budget", async () => {
  // Boundary of the restatement drop: it only applies when the engine's own gate blocks. Here sawMutation is false
  // (the pending mutation came from an earlier turn), so the nudge is the only reason to defer and must be honoured.
  const carried = `${MUTATION_NUDGE_PREFIX} Run a relevant test, then call done again.`;
  const llm = scripted([read, ...repeatStep(FULL_BUDGET + 1, done)]);
  const history: Message[] = [{ role: "user", content: "finish the earlier change" }];
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 14, budget: { maxExtensions: 0 },
    tools: { read: async () => ({ success: true, output: "source" }) },
    events: { onBeforeDone: () => carried },
  });

  expect(result.done).toBe(false);
  expect(result.completionRejected).toBe(true);
  expect(result.doneReason).toContain(`completion rejected after ${FULL_BUDGET} corrections.`);
  expect(result.doneReason).toContain(carried);
  expect(countUserMessages(history, carried)).toBe(FULL_BUDGET);
  expect(userSaid(history, UNVERIFIED_TEXT)).toBe(false); // the engine's gate never blocked
  expect(llm.calls()).toBe(1 + FULL_BUDGET + 1);
});

test("runAgentLoop: an earlier non-gate nudge does not use up the correction that names the shell-changed paths", async () => {
  // Fails with one shared counter: the todo nudge would already have spent a correction, so the first shell-only
  // block would stop at once and the model would never be told which paths changed.
  let asked = 0;
  const notices: string[] = [];
  const llm = scripted([done, readOnlyBash, done, done]);
  const history: Message[] = [{ role: "user", content: "show me status.txt" }];
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 14, budget: { maxExtensions: 0 },
    tools: { bash: ambientBash() },
    events: { onNotice: msg => { notices.push(msg); }, onBeforeDone: () => (asked++ === 0 ? todoNudge : null) },
  });

  expect(result.done).toBe(false);
  expect(result.completionRejected).toBe(true);
  expect(userSaid(history, todoNudge)).toBe(true);
  expect(countUserMessages(history, "added heartbeat.json")).toBe(1); // the path-naming correction was delivered once
  expect(llm.calls()).toBe(4);
  // The notice reports the limit that actually applied to each deferral.
  expect(deferredNotices(notices)).toEqual([
    `done deferred — completion correction 1/${FULL_BUDGET}`,
    "done deferred — completion correction 1/1",
  ]);
});

test("runAgentLoop: a successful todo call resets the correction budget", async () => {
  // Pins the todo-clear reset: after the reset the nudge gets a fresh full budget instead of stopping at once.
  const llm = scripted([done, done, { tool: "todo", arguments: { todos: [] } }, ...repeatStep(FULL_BUDGET + 1, done)]);
  const history: Message[] = [{ role: "user", content: "wrap up" }];
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 16, budget: { maxExtensions: 0 },
    tools: { todo: ok },
    events: { onBeforeDone: () => todoNudge },
  });

  expect(result.completionRejected).toBe(true);
  expect(countUserMessages(history, todoNudge)).toBe(2 + FULL_BUDGET);
  expect(llm.calls()).toBe(2 + 1 + FULL_BUDGET + 1);
});

for (const scenario of [
  // After a passing verification the earlier evidence is spent, so a later unrelated shell write is shell-only again.
  { name: "an edit, a passing verifier, then an unrelated shell write is shell-only again", steps: [edit, pass, readOnlyBash], corrections: 1 },
  // Boundary: only PRIOR evidence is cleared. A new built-in mutation after the pass is definite again.
  { name: "an edit, a passing verifier, a second edit, then a shell write is definite again", steps: [edit, pass, edit, readOnlyBash], corrections: FULL_BUDGET },
]) {
  test(`runAgentLoop: ${scenario.name}`, async () => {
    // Fails if definiteMutation survived the verification: the first row would get the full budget with no path named.
    const llm = scripted([...scenario.steps, ...repeatStep(FULL_BUDGET + 1, done)]);
    const history: Message[] = [{ role: "user", content: "change, verify, then show me status.txt" }];
    const result = await runAgentLoop(history, {
      cwd, maxSteps: 16, budget: { maxExtensions: 0 },
      tools: { bash: ambientBash(), edit: ok },
    });

    expect(result.done).toBe(false);
    expect(result.completionRejected).toBe(true);
    expect(llm.calls()).toBe(scenario.steps.length + scenario.corrections + 1);
    expect(countUserMessages(history, STALE_TEXT)).toBe(scenario.corrections);
    if (scenario.corrections === 1) {
      expect(result.doneReason).toContain("completion rejected after 1 correction.");
      // The stale-gate message names the unrelated path.
      expect(userSaid(history, "added heartbeat.json")).toBe(true);
      expect(result.doneReason).toContain("added heartbeat.json");
    } else {
      expect(result.doneReason).toContain(`completion rejected after ${FULL_BUDGET} corrections.`);
      expect(userSaid(history, "the host saw these paths change")).toBe(false);
    }
  });
}

test("runAgentLoop: a passing verification also clears an earlier unmeasured-snapshot reason", async () => {
  // Fails if the unmeasured reason survived the verification: a later, fully measured change would be blamed on
  // "could not measure" instead of naming its path.
  let snaps = 0;
  const llm = scripted([readOnlyBash, pass, { tool: "bash", arguments: { command: "write-b.txt" } }, done, done]);
  const history: Message[] = [{ role: "user", content: "check status, verify, then write b.txt" }];
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 14, budget: { maxExtensions: 0 },
    // Only the very first snapshot fails (a transient read error); every later one is measured.
    workspaceSnapshot: (c, since) => ++snaps === 1
      ? Promise.resolve({ ok: false as const, reason: "error" as const, detail: "transient read error" })
      : snapshotWorkspace(c, WORKSPACE_SNAPSHOT_LIMITS, since),
    tools: { bash: ambientBash() },
  });

  expect(result.completionRejected).toBe(true);
  expect(result.doneReason).toContain("completion rejected after 1 correction.");
  expect(userSaid(history, STALE_TEXT)).toBe(true);
  expect(userSaid(history, "added b.txt")).toBe(true);
  expect(userSaid(history, "could not measure")).toBe(false);
  expect(llm.calls()).toBe(5);
});

test("runAgentLoop: a prose-only turn keeps the full completion budget through onBeforeDone", async () => {
  // Pins the plain-text completion path: with no tools every reply is a final answer, the only gate is onBeforeDone,
  // and it is bounded by the full budget (the shell-only cap lives in the engine's own gate, not here).
  const notices: string[] = [];
  let replies = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => { replies++; return "The answer is 42."; });
  const history: Message[] = [{ role: "user", content: "what is the answer?" }];
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 14, budget: { maxExtensions: 0 },
    tools: {},
    events: { onNotice: msg => { notices.push(msg); }, onBeforeDone: () => `${MUTATION_NUDGE_PREFIX} Run a relevant test, then call done again.` },
  });

  expect(result.done).toBe(false);
  expect(result.completionRejected).toBe(true);
  expect(result.doneReason).toContain("The answer is 42.");
  expect(result.doneReason).toContain(`completion rejected after ${FULL_BUDGET} corrections.`);
  expect(replies).toBe(FULL_BUDGET + 1);
  expect(deferredNotices(notices)).toEqual(
    Array.from({ length: FULL_BUDGET }, (_, i) => `done deferred — completion correction ${i + 1}/${FULL_BUDGET}`),
  );
});

test("runAgentLoop: prose answers after a shell-only block reach the same single correction", async () => {
  // End to end for a model that answers in prose: each answer is bounced as an invalid tool call until it is
  // salvaged as a `done`, which then meets the shell-only cap (the launch nudge restating the gate is dropped).
  const prose = "The status file says everything is fine.";
  let replies = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => (replies++ === 0 ? JSON.stringify(readOnlyBash) : prose));
  const history: Message[] = [{ role: "user", content: "show me status.txt" }];
  const result = await runAgentLoop(history, {
    cwd, maxSteps: 24, budget: { maxExtensions: 0 },
    tools: { bash: ambientBash() },
    events: { onBeforeDone: launchNudge },
  });

  const bounces = GUARD_LIMITS.MAX_PARSE_BOUNCES;
  expect(result.done).toBe(false);
  expect(result.completionRejected).toBe(true);
  expect(result.doneReason).toContain("UNVERIFIED");
  expect(result.doneReason).toContain(prose);
  expect(result.doneReason).toContain("completion rejected after 1 correction.");
  // One bash call, then two rounds of (bounces + the salvaged answer): one rejection with the path, then the stop.
  expect(replies).toBe(1 + 2 * (bounces + 1));
  expect(countUserMessages(history, "was not a valid tool call")).toBe(2 * bounces);
  expect(countUserMessages(history, UNVERIFIED_TEXT)).toBe(1);
  expect(userSaid(history, "added heartbeat.json")).toBe(true);
  expect(countUserMessages(history, MUTATION_NUDGE_PREFIX)).toBe(0);
});
