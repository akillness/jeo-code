import { test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as loop from "../src/agent/loop";
import { approvePlan } from "../src/commands/approve";
import { runTeamEngine } from "../src/commands/team";
import { readWorkflowState, writeWorkflowState } from "../src/agent/state";

let cwd: string;
let planPath: string;
const planA = 'name: release\nsteps:\n  - name: review A\n    role: critic\n';
const planB = 'name: release\nsteps:\n  - name: review B\n    role: critic\n';
const digest = (content: string) => createHash("sha256").update(content).digest("hex");

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-plan-identity-"));
  planPath = path.join(cwd, "plan.yaml");
  await fs.mkdir(path.join(cwd, ".jeo"));
  await fs.writeFile(path.join(cwd, ".jeo", "hooks.json"), JSON.stringify({ enabled: false }));
  modelReview("REJECT");
});
afterEach(async () => {
  mock.restore();
  await fs.rm(cwd, { recursive: true, force: true });
});

async function reviewedPlan(content: string, approved = false, hash: string | undefined = digest(content)) {
  await fs.writeFile(planPath, content);
  await writeWorkflowState("ralplan", {
    active: true, skill: "ralplan", current_phase: "complete", slug: "release",
    plan_path: planPath, consensus: "okay", consensus_hash: hash, approved,
  }, cwd);
}

function modelReview(verdict: "OKAY" | "REJECT") {
  let calls = 0;
  spyOn(loop, "callLlm").mockImplementation(async () => {
    if (++calls % 2 === 1) return JSON.stringify({ tool: "read", arguments: { filePath: "plan.yaml" } });
    return JSON.stringify({ tool: "done", arguments: { reason: `[${verdict}]\nJustification: inspected plan requirements\nRequired Fixes: missing release evidence` } });
  });
}

test("an already-approved plan edited at the same path must be reviewed again", async () => {
  await reviewedPlan(planA);
  expect((await approvePlan(planPath, cwd)).ok).toBe(true);
  await fs.writeFile(planPath, planB);
  const result = await approvePlan(planPath, cwd);
  expect(result.ok).toBe(false);
  expect(result.message).toContain("modified since");
  const execution = await runTeamEngine({ cwd, io: { output: () => {} } });
  expect(execution.ok).toBe(false);
  expect(execution.reason).toContain("modified since");
  expect(await readWorkflowState("team", cwd)).toBeNull();
});

for (const approved of [false, true]) {
  test(`approval refuses missing reviewed digest even when approved=${approved}`, async () => {
    await reviewedPlan(planA, approved);
    const state = (await readWorkflowState("ralplan", cwd))!;
    delete state.consensus_hash;
    await writeWorkflowState("ralplan", state, cwd);
    const result = await approvePlan(planPath, cwd);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/consensus.*hash/i);
    if (!approved) expect((await readWorkflowState("ralplan", cwd))?.approved).toBe(false);
  });
}

test("execution refuses missing reviewed digest without accepting old completion receipts", async () => {
  await reviewedPlan(planA, true);
  const state = (await readWorkflowState("ralplan", cwd))!;
  delete state.consensus_hash;
  await writeWorkflowState("ralplan", state, cwd);
  await writeWorkflowState("team", {
    active: false, skill: "team", current_phase: "complete", slug: "release", plan_path: planPath,
    completed_tasks: ["review A"], pending_tasks: [], consensus_hash: digest(planA),
  }, cwd);
  const result = await runTeamEngine({ cwd, io: { output: () => {} } });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/consensus.*hash/i);
});

test("unchanged reviewed bytes remain idempotently approved and completed tasks are not rerun", async () => {
  await reviewedPlan(planA);
  expect((await approvePlan(planPath, cwd)).ok).toBe(true);
  modelReview("OKAY");
  expect((await runTeamEngine({ cwd, io: { output: () => {} } })).ok).toBe(true);
  expect((await readWorkflowState("team", cwd))?.completed_tasks).toEqual(["review A"]);
  modelReview("REJECT");
  expect((await approvePlan(planPath, cwd)).ok).toBe(true);
  expect((await runTeamEngine({ cwd, io: { output: () => {} } })).ok).toBe(true);
  expect((await readWorkflowState("team", cwd))?.completed_tasks).toEqual(["review A"]);
});

for (const replacement of [
  { name: "changed task names", content: planB, task: "review B" },
  { name: "unchanged task names", content: planA + "# Newly reviewed requirement: verify the release receipt\n", task: "review A" },
]) {
  test(`newly reviewed same-path same-slug plan restarts with ${replacement.name}`, async () => {
    await reviewedPlan(planA, true);
    modelReview("OKAY");
    expect((await runTeamEngine({ cwd, io: { output: () => {} } })).ok).toBe(true);
    expect((await readWorkflowState("team", cwd))?.completed_tasks).toEqual(["review A"]);
    await reviewedPlan(replacement.content, true);
    modelReview("REJECT");
    const result = await runTeamEngine({ cwd, io: { output: () => {} } });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(`"${replacement.task}"`);
    const state = await readWorkflowState("team", cwd);
    expect(state?.current_phase).toBe("failed");
    expect(state?.completed_tasks).toEqual([]);
    expect(state?.pending_tasks).toEqual([replacement.task]);
  });
}

for (const identity of ["old digest", "missing digest"] as const) {
  test(`same-path resume discards partial receipts with ${identity}`, async () => {
    await reviewedPlan(planB, true);
    await writeWorkflowState("team", {
      active: true, skill: "team", current_phase: "executing", slug: "release", plan_path: planPath,
      consensus_hash: identity === "old digest" ? digest(planA) : undefined,
      completed_tasks: ["old completed task"], pending_tasks: ["old pending task"],
    }, cwd);
    modelReview("REJECT");
    const result = await runTeamEngine({ cwd, io: { output: () => {} } });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('"review B"');
    const state = await readWorkflowState("team", cwd);
    expect(state?.completed_tasks).toEqual([]);
    expect(state?.pending_tasks).toEqual(["review B"]);
    expect(state?.failed_task).toBe("review B");
  });
}
