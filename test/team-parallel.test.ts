import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PlanSchema, parseYaml } from "../src/agent/plan";

// `jeo team` executes a CONTIGUOUS run of `parallel_group`-marked plan steps
// concurrently, each isolated in its own git worktree, then merges each
// successful worker's committed branch back in array order. These tests use
// REAL git repos in throwaway `fs.mkdtemp` directories — git itself is never
// mocked, only the LLM (`../src/agent/loop`'s `callLlm`), mirroring
// `test/team-run.test.ts`.

const origCwd = process.cwd();
let tmp = "";
const logs: string[] = [];
const origLog = console.log;

afterEach(async () => {
  console.log = origLog;
  process.exitCode = 0;
  process.chdir(origCwd);
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  tmp = "";
  logs.length = 0;
});

function git(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

async function initRepo(dir: string): Promise<void> {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(dir, "README.md"), "root\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

interface SeedStep {
  name: string;
  role?: string;
  parallel_group?: string;
}

async function seedParallelPlan(steps: SeedStep[], seedFiles: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-team-par-"));
  await initRepo(dir);
  if (Object.keys(seedFiles).length > 0) {
    for (const [rel, content] of Object.entries(seedFiles)) {
      await fs.writeFile(path.join(dir, rel), content);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "seed"]);
  }
  const planPath = path.join(dir, "plan.yaml");
  const yaml = [
    "name: demo-plan",
    "steps:",
    ...steps.flatMap(s => [
      `  - name: ${s.name}`,
      ...(s.role ? [`    role: ${s.role}`] : []),
      ...(s.parallel_group ? [`    parallel_group: ${s.parallel_group}`] : []),
    ]),
  ].join("\n");
  await fs.writeFile(planPath, yaml + "\n");
  const stateDir = path.join(dir, ".jeo", "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "ralplan-state.json"),
    JSON.stringify({ active: true, current_phase: "complete", skill: "ralplan", slug: "demo", plan_path: planPath, approved: true }),
  );
  return dir;
}

/** Extract the current todo's task name from the subagent prompt's own user message. */
function taskNameFromMessages(messages: any[]): string {
  const content = String(messages[1]?.content ?? "");
  const m = content.match(/Current todo: \d+\/\d+ "([^"]+)"/);
  return m?.[1] ?? "unknown";
}

function worktreeDir(tmpDir: string, index: number): string {
  return path.join(tmpDir, ".jeo", "team-worktrees", `demo-${index}`);
}

const doneOk = { tool: "done", arguments: { reason: "Summary: done\nChanged Files: x\nVerification: ran" } };
function writeAction(filePath: string, content: string) {
  return { tool: "write", arguments: { path: filePath, content } };
}
/** A bash command containing "test" satisfies the agent loop's verification gate
 *  (`VERIFY_SIGNAL_RE` in `src/agent/loop-guards.ts`) so a mutating step's `done`
 *  is accepted instead of being nudged back for "no verification ran". */
const verifyAction = { tool: "bash", arguments: { command: "echo test ok" } };
/** Evidence-gate satisfying read call — every seeded plan writes plan.yaml to
 *  its temp dir, so this always resolves against a real file. */
const readAction = { tool: "read", arguments: { filePath: "plan.yaml" } };
const criticOkay = { tool: "done", arguments: { reason: "[OKAY]\nJustification: verified against the repo." } };

/**
 * Per-task scripted `callLlm` mock: each named task gets its OWN ordered list of
 * tool-call actions (write/bash/done); once a task's script is exhausted, its
 * last action repeats. A per-task call counter (not a shared turn number) keeps
 * concurrently-dispatched parallel-group tasks from stepping on each other.
 */
function scriptedCallLlm(scripts: Record<string, Array<() => any>>) {
  const counters = new Map<string, number>();
  return async (messages: any[]) => {
    const name = taskNameFromMessages(messages);
    const script = scripts[name] ?? [() => doneOk];
    const n = counters.get(name) ?? 0;
    counters.set(name, n + 1);
    const action = script[Math.min(n, script.length - 1)]!();
    return JSON.stringify(action);
  };
}

test("PlanSchema rejects the same parallel_group value on two non-contiguous steps", () => {
  const yaml = `
steps:
  - name: "step A"
    parallel_group: g1
  - name: "step B"
  - name: "step C"
    parallel_group: g1
`;
  const result = PlanSchema.safeParse(parseYaml(yaml));
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.some(i => i.message.includes('reuses parallel_group "g1"') && i.message.includes("contiguous"))).toBe(true);
  }
});

test("PlanSchema accepts a plan mixing grouped and ungrouped steps, and a plain ungrouped plan is unaffected", () => {
  const mixed = PlanSchema.safeParse(parseYaml(`
steps:
  - name: "solo before"
  - name: "group step 1"
    parallel_group: g1
  - name: "group step 2"
    parallel_group: g1
  - name: "solo after"
  - name: "verify"
    role: critic
`));
  expect(mixed.success).toBe(true);
  if (mixed.success) {
    expect(mixed.data.steps.map(s => s.parallel_group)).toEqual([undefined, "g1", "g1", undefined, undefined]);
  }

  // No regression: a regular ungrouped plan (no parallel_group anywhere) still validates.
  const plain = PlanSchema.safeParse(parseYaml(`
steps:
  - name: "Task A"
  - name: "Task B"
  - name: "verify"
    role: critic
`));
  expect(plain.success).toBe(true);
});

test("PlanSchema accepts a size-1 parallel_group (degenerates to a normal step)", () => {
  const result = PlanSchema.safeParse(parseYaml(`
steps:
  - name: "lone group step"
    parallel_group: solo-group
  - name: "next step"
  - name: "verify"
    role: critic
`));
  expect(result.success).toBe(true);
});

test("a size-1 parallel_group runs through the ordinary serial path, identically to an ungrouped step", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: scriptedCallLlm({
      "lone group step": [() => writeAction("solo.txt", "solo\n"), () => verifyAction, () => doneOk],
      "verify": [() => readAction, () => criticOkay],
    }),
  }));
  const { runTeamCommand } = await import("../src/commands/team");
  tmp = await seedParallelPlan([{ name: "lone group step", parallel_group: "solo-group" }, { name: "verify", role: "critic" }]);
  process.chdir(tmp);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  const out = logs.join("\n");
  // The serial path's own per-task banner is used, not the parallel-group dispatch banner.
  expect(out).toContain('Current task: "lone group step"');
  expect(out).not.toContain("Dispatching parallel group");
  expect(fssync.existsSync(path.join(tmp, "solo.txt"))).toBe(true);

  const teamState = JSON.parse(await fs.readFile(path.join(tmp, ".jeo", "state", "team-state.json"), "utf-8"));
  expect(teamState.current_phase).toBe("complete");
});

test("a two-step parallel_group with both steps mutating different files, both succeeding, merges both into the final repo", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: scriptedCallLlm({
      "write file a": [() => writeAction("a.txt", "a content\n"), () => verifyAction, () => doneOk],
      "write file b": [() => writeAction("b.txt", "b content\n"), () => verifyAction, () => doneOk],
      "verify": [() => readAction, () => criticOkay],
    }),
  }));
  const { runTeamCommand } = await import("../src/commands/team");
  tmp = await seedParallelPlan([
    { name: "write file a", parallel_group: "g1" },
    { name: "write file b", parallel_group: "g1" },
    { name: "verify", role: "critic" },
  ]);
  process.chdir(tmp);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  expect(process.exitCode).toBe(0);

  // Both files present in the final repo state (merged back into cwd).
  expect(fssync.existsSync(path.join(tmp, "a.txt"))).toBe(true);
  expect(fssync.existsSync(path.join(tmp, "b.txt"))).toBe(true);

  // git log shows both step commits merged.
  const log = git(tmp, ["log", "--all", "--oneline"]).stdout;
  expect(log).toContain("write file a");
  expect(log).toContain("write file b");

  // Worktrees cleaned up.
  expect(fssync.existsSync(worktreeDir(tmp, 0))).toBe(false);
  expect(fssync.existsSync(worktreeDir(tmp, 1))).toBe(false);

  const teamState = JSON.parse(await fs.readFile(path.join(tmp, ".jeo", "state", "team-state.json"), "utf-8"));
  expect(teamState.current_phase).toBe("complete");
  expect(teamState.completed_tasks).toEqual(["write file a", "write file b", "verify"]);
  expect(teamState.pending_tasks).toEqual([]);
});

test("a two-step parallel_group where one step has a contract-incomplete done reason fails without merging either step", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: scriptedCallLlm({
      "write file a": [() => writeAction("a.txt", "a content\n"), () => verifyAction, () => doneOk],
      // "fails contract": done without the executor's required markers.
      "broken step": [() => ({ tool: "done", arguments: { reason: "I think I am finished." } })],
    }),
  }));
  const { runTeamCommand } = await import("../src/commands/team");
  tmp = await seedParallelPlan([
    { name: "write file a", parallel_group: "g1" },
    { name: "broken step", parallel_group: "g1" },
    { name: "verify", role: "critic" },
  ]);
  process.chdir(tmp);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  expect(process.exitCode).toBe(1);

  // Neither step's changes reached the real repo root — nothing was merged.
  expect(fssync.existsSync(path.join(tmp, "a.txt"))).toBe(false);

  // The succeeding step's worktree is left on disk, not silently discarded.
  expect(fssync.existsSync(worktreeDir(tmp, 0))).toBe(true);
  expect(fssync.existsSync(path.join(worktreeDir(tmp, 0), "a.txt"))).toBe(true);

  const teamState = JSON.parse(await fs.readFile(path.join(tmp, ".jeo", "state", "team-state.json"), "utf-8"));
  expect(teamState.current_phase).toBe("failed");
  expect(teamState.failed_task).toBe("broken step");
});

test("a two-step parallel_group with a genuine merge conflict aborts cleanly and does not pick a winner", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: scriptedCallLlm({
      "edit shared A": [() => writeAction("shared.txt", "AAAA\n"), () => verifyAction, () => doneOk],
      "edit shared B": [() => writeAction("shared.txt", "BBBB\n"), () => verifyAction, () => doneOk],
    }),
  }));
  const { runTeamCommand } = await import("../src/commands/team");
  tmp = await seedParallelPlan(
    [
      { name: "edit shared A", parallel_group: "g1" },
      { name: "edit shared B", parallel_group: "g1" },
      { name: "verify", role: "critic" },
    ],
    { "shared.txt": "orig\n" },
  );
  process.chdir(tmp);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  expect(process.exitCode).toBe(1);
  const out = logs.join("\n");
  expect(out).toContain("Merge conflict");

  // No silent conflict resolution: the repo is back to a clean HEAD, not
  // mid-conflict (ignore the untracked plan.yaml/.jeo/ noise from the fixture).
  const trackedStatus = git(tmp, ["status", "--porcelain"]).stdout
    .split("\n")
    .filter(l => l.trim() && !l.startsWith("??"));
  expect(trackedStatus).toEqual([]);
  expect(fssync.existsSync(path.join(tmp, ".git", "MERGE_HEAD"))).toBe(false);

  const teamState = JSON.parse(await fs.readFile(path.join(tmp, ".jeo", "state", "team-state.json"), "utf-8"));
  expect(teamState.current_phase).toBe("failed");
  expect(["edit shared A", "edit shared B"]).toContain(teamState.failed_task);
});
