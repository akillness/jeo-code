import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runPostTurnHooks } from "../src/agent/hooks";

// cycle 13 (plan/gjc-inheritance.md): post-turn hook output FEEDBACK. A post-turn
// hook (e.g. `tsc --noEmit`) that exits non-zero now feeds its diagnostics back to
// the model so it can self-correct in-loop — realized via the EXISTING hooks
// extension point (no new dependency, no core bloat). The tool's own ok/fail is
// unchanged; output is surfaced only on non-zero exit; timeouts surface nothing.

const testDir = path.join(os.tmpdir(), `jeo-ptf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const globalConfigDir = path.join(testDir, "global-config");
const projectDir = path.join(testDir, "project");
let originalConfigDir: string | undefined;

async function setHook(hook: Record<string, any>): Promise<void> {
  const globalConfig = {
    defaultModel: "claude-sonnet-4-5",
    providers: {},
    hooks: { enabled: true, hooks: [hook] },
  };
  await fs.writeFile(path.join(globalConfigDir, "config.json"), JSON.stringify(globalConfig), "utf-8");
  // No local override — exercise the global hook path.
  try { await fs.unlink(path.join(projectDir, ".jeo", "hooks.json")); } catch {}
}

beforeAll(async () => {
  originalConfigDir = process.env.JEO_CONFIG_DIR;
  await fs.mkdir(globalConfigDir, { recursive: true });
  await fs.mkdir(path.join(projectDir, ".jeo"), { recursive: true });
  process.env.JEO_CONFIG_DIR = globalConfigDir;
});

afterAll(async () => {
  if (originalConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = originalConfigDir;
  await fs.rm(testDir, { recursive: true, force: true });
});

test("non-zero post-turn hook returns its output as a model-facing diagnostic", async () => {
  await setHook({ event: "post-turn", match: { tool: "edit" }, run: "echo 'TS2304 cannot find name foo' && exit 2" });
  const { diags, ran } = await runPostTurnHooks(projectDir, "edit", { filePath: "x.ts" }, true, "ok", undefined, () => {});
  expect(ran).toBe(1);
  expect(diags.length).toBe(1);
  expect(diags[0].exitCode).toBe(2);
  expect(diags[0].output).toContain("TS2304 cannot find name foo");
});

test("clean (exit 0) post-turn hook yields no diagnostic", async () => {
  await setHook({ event: "post-turn", run: "echo 'all good'" });
  const { diags, ran } = await runPostTurnHooks(projectDir, "edit", {}, true, "ok", undefined, () => {});
  expect(ran).toBe(1); // hook RAN clean — distinct from "no hook matched"
  expect(diags).toEqual([]);
});

test("timed-out post-turn hook surfaces only the advisory notice, no partial output", async () => {
  await setHook({ event: "post-turn", run: "echo partial && sleep 1 && exit 1", timeoutMs: 10 });
  let notice = "";
  const { diags, ran } = await runPostTurnHooks(projectDir, "edit", {}, true, "ok", undefined, (m) => { notice = m; });
  expect(diags).toEqual([]);
  expect(ran).toBe(0); // timed out ≠ ran to completion
  expect(notice).toContain("timed out");
});

test("match.tool gates which tool the hook fires for (strict equality)", async () => {
  await setHook({ event: "post-turn", match: { tool: "edit" }, run: "echo nope && exit 1" });
  expect((await runPostTurnHooks(projectDir, "read", {}, true, "ok", undefined, () => {})).diags).toEqual([]);
  expect((await runPostTurnHooks(projectDir, "edit", {}, true, "ok", undefined, () => {})).diags.length).toBe(1);
});

test("engine appends hook diagnostics to the edit result block; tool stays (ok)", async () => {
  await setHook({ event: "post-turn", match: { tool: "edit" }, run: "echo 'TS2345 type error' && exit 1" });
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "edit", arguments: { filePath: "a.ts", editBlock: "x" } }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  await runAgentLoop(history, {
    cwd: projectDir,
    maxSteps: 1,
    budget: { maxExtensions: 0 },
    tools: { edit: async () => ({ success: true, output: "Successfully updated a.ts" }) },
  });
  const toolMsg = history.find(m => m.role === "user" && m.content.includes("Tool [edit] result"));
  expect(toolMsg).toBeDefined();
  expect(toolMsg!.content).toContain("Tool [edit] result (ok):"); // guard: edit succeeded
  expect(toolMsg!.content).toContain("[post-turn hook");
  expect(toolMsg!.content).toContain("TS2345 type error"); // diagnostics surfaced to model
});

test("a project-wide post-turn hook runs ONCE for a multi-call batch, not per edit", async () => {
  await setHook({ event: "post-turn", match: { tool: "edit" }, run: "echo dupdiag && exit 1" });
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({
      tools: [
        { tool: "edit", arguments: { filePath: "a.ts", editBlock: "x" } },
        { tool: "edit", arguments: { filePath: "b.ts", editBlock: "y" } },
      ],
    }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  await runAgentLoop(history, {
    cwd: projectDir,
    maxSteps: 1,
    budget: { maxExtensions: 0 },
    tools: { edit: async (a: any) => ({ success: true, output: `updated ${a.filePath}` }) },
  });
  const toolMsg = history.find(m => m.role === "user" && m.content.includes("Tool [edit] result"))!;
  // The hook matches both edits but runs a SINGLE time for the batch → one
  // diagnostic block, no per-result duplication and so no cross-reference.
  expect(toolMsg.content.split("exit 1]:").length - 1).toBe(1);
  expect(toolMsg.content).not.toContain("same diagnostics as above");
});

// cycle 14a (plan/gjc-inheritance.md round 4): match.tool accepts `|`-separated
// multi-tool values so one post-edit hook covers edit AND write in one entry
// (round-3 critic A5 follow-up, explicitly endorsed as separable).

test("hookMatchesTool: exact, |-separated, whitespace-tolerant, no partials", async () => {
  const { hookMatchesTool } = await import("../src/agent/hooks");
  expect(hookMatchesTool(undefined, "edit")).toBe(true); // no match = all tools
  expect(hookMatchesTool("edit", "edit")).toBe(true);
  expect(hookMatchesTool("edit|write", "write")).toBe(true);
  expect(hookMatchesTool("edit | write", "edit")).toBe(true); // trimmed
  expect(hookMatchesTool("edit|write", "read")).toBe(false);
  expect(hookMatchesTool("edit", "edi")).toBe(false); // no prefix matching
});

test("a single edit|write hook fires for both tools, not for read", async () => {
  await setHook({ event: "post-turn", match: { tool: "edit|write" }, run: "echo multi && exit 1" });
  expect((await runPostTurnHooks(projectDir, "edit", {}, true, "ok", undefined, () => {})).diags.length).toBe(1);
  expect((await runPostTurnHooks(projectDir, "write", {}, true, "ok", undefined, () => {})).diags.length).toBe(1);
  expect((await runPostTurnHooks(projectDir, "read", {}, true, "ok", undefined, () => {})).diags).toEqual([]);
});

// F1 (round 4, architect agent://5-Round4Discovery): a RED post-turn hook is a
// pending failure the done guard enforces — done after a failing hook gets ONE
// pushback naming the hook, even when an earlier bash "verification" succeeded.
// A later CLEAN hook run clears the pending failure.

test("done after a red hook gets a pushback naming the hook; second done passes", async () => {
  await setHook({ event: "post-turn", match: { tool: "edit" }, run: "echo 'TS999 broken' && exit 1" });
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) return JSON.stringify({ tool: "bash", arguments: { command: "bun test ok" } });
      if (calls === 2) return JSON.stringify({ tool: "edit", arguments: { filePath: "a.ts", editBlock: "x" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "finished" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const result = await runAgentLoop(history, {
    cwd: projectDir,
    maxSteps: 8,
    budget: { maxExtensions: 0 },
    tools: {
      bash: async () => ({ success: true, output: "1 pass 0 fail" }), // sawVerification=true
      edit: async () => ({ success: true, output: "updated a.ts" }),
    },
  });
  expect(result.done).toBe(true);
  const pushback = history.find(m => m.role === "user" && m.content.includes("FAILING (non-zero exit)"));
  expect(pushback).toBeDefined(); // guard fired DESPITE the earlier green bash
  expect(pushback!.content).toContain('post-turn hook "echo');
  expect(calls).toBe(4); // bash, edit, done(pushed back), done(escape hatch)
});

test("a later clean hook run clears the pending failure — done passes first try", async () => {
  const flag = path.join(projectDir, "fixed.flag");
  try { await fs.unlink(flag); } catch {}
  await setHook({ event: "post-turn", match: { tool: "edit" }, run: `[ -f ${flag} ] || { echo red; exit 1; }` });
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) return JSON.stringify({ tool: "edit", arguments: { filePath: "a.ts", editBlock: "x" } }); // hook red
      if (calls === 2) return JSON.stringify({ tool: "edit", arguments: { filePath: "a.ts", editBlock: "y" } }); // fix → hook green
      if (calls === 3) return JSON.stringify({ tool: "bash", arguments: { command: "bun test" } }); // verification
      return JSON.stringify({ tool: "done", arguments: { reason: "finished" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const result = await runAgentLoop(history, {
    cwd: projectDir,
    maxSteps: 8,
    budget: { maxExtensions: 0 },
    tools: {
      edit: async (a: any) => {
        if (a.editBlock === "y") await fs.writeFile(flag, "ok"); // the "fix"
        return { success: true, output: "updated a.ts" };
      },
      bash: async () => ({ success: true, output: "5 pass 0 fail" }),
    },
  });
  expect(result.done).toBe(true);
  expect(calls).toBe(4); // edit(red), edit(fix→green), bash verify, done — NO pushback
  expect(history.some(m => m.role === "user" && m.content.includes("FAILING (non-zero exit)"))).toBe(false);
  await fs.unlink(flag).catch(() => {});
});

// Stale-verification gate: a passing test/build that PREDATES the last mutation is
// no longer trustworthy. done after verify→edit gets ONE pushback to re-verify; the
// non-stale order (edit→verify→done) passes untouched.

test("done after verify-then-edit gets a stale-verification pushback", async () => {
  await setHook({ event: "post-turn", run: "echo ok" }); // clean hook, never blocks
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) return JSON.stringify({ tool: "bash", arguments: { command: "bun test" } }); // verify
      if (calls === 2) return JSON.stringify({ tool: "edit", arguments: { filePath: "a.ts", editBlock: "x" } }); // mutate AFTER verify
      return JSON.stringify({ tool: "done", arguments: { reason: "finished" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const result = await runAgentLoop(history, {
    cwd: projectDir,
    maxSteps: 8,
    budget: { maxExtensions: 0 },
    tools: {
      bash: async () => ({ success: true, output: "1 pass 0 fail" }),
      edit: async () => ({ success: true, output: "updated a.ts" }),
    },
  });
  expect(result.done).toBe(true);
  const pushback = history.find(m => m.role === "user" && m.content.includes("no longer reflects the current tree"));
  expect(pushback).toBeDefined();
  expect(calls).toBe(4); // bash, edit, done(stale pushback), done(escape hatch)
});

test("done after edit-then-verify is NOT stale — passes first try", async () => {
  await setHook({ event: "post-turn", run: "echo ok" });
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      if (calls === 1) return JSON.stringify({ tool: "edit", arguments: { filePath: "a.ts", editBlock: "x" } }); // mutate
      if (calls === 2) return JSON.stringify({ tool: "bash", arguments: { command: "bun test" } }); // verify AFTER edit
      return JSON.stringify({ tool: "done", arguments: { reason: "finished" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history = [{ role: "system" as const, content: "sys" }];
  const result = await runAgentLoop(history, {
    cwd: projectDir,
    maxSteps: 8,
    budget: { maxExtensions: 0 },
    tools: {
      edit: async () => ({ success: true, output: "updated a.ts" }),
      bash: async () => ({ success: true, output: "1 pass 0 fail" }),
    },
  });
  expect(result.done).toBe(true);
  expect(history.some(m => m.role === "user" && m.content.includes("no longer reflects the current tree"))).toBe(false);
  expect(calls).toBe(3); // edit, bash verify, done — no pushback
});