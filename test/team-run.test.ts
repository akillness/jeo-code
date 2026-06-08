import { test, expect, mock, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Full-command integration: runTeamCommand reads an approved ralplan plan,
// routes each step to its declared subagent role, and runs the loop. The LLM is
// mocked to converge immediately so we verify the orchestration, not a model.

const origCwd = process.cwd();
let tmp = "";
const logs: string[] = [];
const origLog = console.log;

afterEach(async () => {
  console.log = origLog;
  process.exitCode = 0; // runTeamCommand sets exitCode=1 on failure paths; don't leak it to the runner
  process.chdir(origCwd);
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  tmp = "";
  logs.length = 0;
});

async function seedPlan(steps: { name: string; role?: string }[]): Promise<void> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "joc-team-"));
  const planPath = path.join(tmp, "plan.yaml");
  const yaml = ["name: demo-plan", "steps:", ...steps.flatMap(s => [`  - name: ${s.name}`, ...(s.role ? [`    role: ${s.role}`] : [])])].join("\n");
  await fs.writeFile(planPath, yaml + "\n");
  const stateDir = path.join(tmp, ".joc", "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "ralplan-state.json"),
    JSON.stringify({ active: true, current_phase: "complete", skill: "ralplan", slug: "demo", plan_path: planPath, approved: true }),
  );
  process.chdir(tmp);
}

test("runTeamCommand routes each step to its declared subagent role and completes", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "task done" } }),
  }));
  const { runTeamCommand } = await import("../src/commands/team");

  await seedPlan([
    { name: "design the api", role: "planner" },
    { name: "review the design", role: "architect" },
    { name: "implement it" }, // no role → executor fallback
  ]);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  const out = logs.join("\n");
  // Each step dispatched to the right role (subagent header line).
  expect(out).toContain("Subagent: Planner");
  expect(out).toContain("Subagent: Architect");
  expect(out).toContain("Subagent: Executor"); // role-less step fell back
  expect(out).toContain("[SUCCESS] All tasks in the plan executed successfully!");

  // team state advanced to complete.
  const teamState = JSON.parse(await fs.readFile(path.join(tmp, ".joc", "state", "team-state.json"), "utf-8"));
  expect(teamState.current_phase).toBe("complete");
  expect(teamState.pending_tasks.length).toBe(0);
  expect(teamState.completed_tasks.length).toBe(3);
});

test("runTeamCommand refuses an unapproved plan", async () => {
  const { runTeamCommand } = await import("../src/commands/team");
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "joc-team-na-"));
  const stateDir = path.join(tmp, ".joc", "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "ralplan-state.json"),
    JSON.stringify({ active: true, current_phase: "complete", skill: "ralplan", slug: "demo", plan_path: path.join(tmp, "p.yaml"), approved: false }),
  );
  process.chdir(tmp);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  expect(logs.join("\n")).toContain("not approved");
});
