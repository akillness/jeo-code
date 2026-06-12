import { test, expect, mock, afterAll } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeWorkflowState, readWorkflowState } from "../src/agent/state";

// Round-7 (architect ref 7-Round7Workflow) — workflow ledger integrity:
//  #1 a team-state left over from a PREVIOUS plan must not make the next plan
//     no-op into a false "all executed" success;
//  #2 ultragoal must not fabricate per-criterion PASS from a global signal
//     (verification theater): the suite runs ONCE, criteria are recorded as
//     UNVERIFIED, and the run/cli "--help always passes" loophole is gone.

const realTools = { ...(await import("../src/agent/tools")) };
afterAll(() => {
  mock.module("../src/agent/tools", () => realTools);
});

async function tmpProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-wfint-"));
}

const DONE = JSON.stringify({
  tool: "done",
  arguments: { reason: "Summary: did the task Changed Files: none Verification: covered by suite" },
});

async function seedApprovedPlan(dir: string, slug: string, planFile: string, taskName: string): Promise<string> {
  const planPath = path.join(dir, planFile);
  await fs.writeFile(planPath, `steps:\n  - name: "${taskName}"\n    role: executor\n`);
  await writeWorkflowState("ralplan", {
    active: false,
    current_phase: "complete",
    skill: "ralplan",
    slug,
    plan_path: planPath,
    approved: true,
  }, dir);
  return planPath;
}

test("team: stale state from a previous plan restarts execution instead of no-opping (round-7 #1)", async () => {
  const dir = await tmpProject();
  await mock.module("../src/agent/loop", () => ({ callLlm: async () => DONE }));

  // Plan A ran to completion earlier — its team-state has pending=[].
  const planAPath = path.join(dir, "plan-a.yaml");
  await fs.writeFile(planAPath, `steps:\n  - name: "old task"\n    role: executor\n`);
  await writeWorkflowState("team", {
    active: true,
    current_phase: "complete",
    skill: "team",
    slug: "plan-a",
    plan_path: planAPath,
    completed_tasks: ["old task"],
    pending_tasks: [],
  }, dir);

  // A NEW approved plan B arrives.
  await seedApprovedPlan(dir, "plan-b", "plan-b.yaml", "plan B task");

  const lines: string[] = [];
  const { runTeamEngine } = await import("../src/commands/team");
  const res = await runTeamEngine({ cwd: dir, io: { output: l => lines.push(l) } });

  expect(res.ok).toBe(true);
  expect(lines.some(l => l.includes("New plan detected"))).toBe(true);
  const state = await readWorkflowState("team", dir);
  expect(state?.slug).toBe("plan-b");
  expect(state?.completed_tasks).toEqual(["plan B task"]); // plan B actually RAN
  expect(state?.current_phase).toBe("complete");
  expect(state?.active).toBe(false); // execution finished — flag flipped
  await fs.rm(dir, { recursive: true, force: true });
});

test("team: same-plan state still resumes (no spurious restart)", async () => {
  const dir = await tmpProject();
  await mock.module("../src/agent/loop", () => ({ callLlm: async () => DONE }));
  const planPath = await seedApprovedPlan(dir, "plan-x", "plan-x.yaml", "only task");
  // Same plan, already fully executed — resume semantics: nothing re-runs.
  await writeWorkflowState("team", {
    active: true,
    current_phase: "complete",
    skill: "team",
    slug: "plan-x",
    plan_path: planPath,
    completed_tasks: ["only task"],
    pending_tasks: [],
  }, dir);

  const lines: string[] = [];
  const { runTeamEngine } = await import("../src/commands/team");
  const res = await runTeamEngine({ cwd: dir, io: { output: l => lines.push(l) } });
  expect(res.ok).toBe(true);
  expect(lines.some(l => l.includes("New plan detected"))).toBe(false);
  const state = await readWorkflowState("team", dir);
  expect(state?.completed_tasks).toEqual(["only task"]); // untouched, not re-run
  await fs.rm(dir, { recursive: true, force: true });
});

async function seedInterview(dir: string): Promise<void> {
  const seedPath = path.join(dir, "seed.yaml");
  await fs.writeFile(seedPath, [
    "acceptance_criteria:",
    '  - "CLI run works end to end"', // pre-fix: 'run'/'cli' → --help → guaranteed PASS
    '  - "Feature X behaves correctly"',
    "",
  ].join("\n"));
  await writeWorkflowState("deep-interview", {
    active: false,
    current_phase: "complete",
    skill: "deep-interview",
    slug: "honest",
    seed_path: seedPath,
  }, dir);
}

test("ultragoal: suite runs ONCE; criteria are UNVERIFIED, never fabricated PASS (round-7 #2)", async () => {
  const dir = await tmpProject();
  await seedInterview(dir);
  const bashCalls: string[] = [];
  await mock.module("../src/agent/tools", () => ({
    ...realTools,
    bashTool: async (cmd: string) => {
      bashCalls.push(cmd);
      return { success: true, output: "120 pass 0 fail" };
    },
  }));
  const { runUltragoalEngine } = await import("../src/commands/ultragoal");
  const res = await runUltragoalEngine({ cwd: dir, io: { output: () => {} } });

  expect(res.ok).toBe(true);
  expect(bashCalls).toEqual(["bun test"]); // ONE suite run; no --help loophole
  const report = await fs.readFile(path.join(dir, ".joc", "state", "ultragoal-report.md"), "utf-8");
  expect(report).toContain("UNVERIFIED");
  expect(report).not.toContain("✅ PASSED"); // no fabricated per-criterion pass
  const state = await readWorkflowState("ultragoal", dir);
  expect(state?.status).toBe("SUITE_GREEN");
  expect(state?.suite_green).toBe(true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("ultragoal: a red suite fails the run and the criteria record says FAILED", async () => {
  const dir = await tmpProject();
  await seedInterview(dir);
  await mock.module("../src/agent/tools", () => ({
    ...realTools,
    bashTool: async () => ({ success: false, output: "2 fail" }),
  }));
  const { runUltragoalEngine } = await import("../src/commands/ultragoal");
  const res = await runUltragoalEngine({ cwd: dir, io: { output: () => {} } });

  expect(res.ok).toBe(false);
  const report = await fs.readFile(path.join(dir, ".joc", "state", "ultragoal-report.md"), "utf-8");
  expect(report).toContain("❌ FAILED");
  const state = await readWorkflowState("ultragoal", dir);
  expect(state?.status).toBe("FAILED");
  expect(state?.suite_green).toBe(false);
  await fs.rm(dir, { recursive: true, force: true });
});
