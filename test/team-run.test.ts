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
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nIn Scope:\nOut of Scope:\nFile-level Changes:\nSequencing:\nAcceptance Criteria:\nVerification:\nRisks:" } });
      if (turn === 2) return JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nFindings:\nRecommendations:\nArchitectural Status: CLEAR\nCode Review Recommendation: APPROVE" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nChanged Files:\nVerification:\nOpen Risks:" } });
    },
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
  expect(out).toContain("[DONE] All tasks in the plan executed successfully!");

  // team state advanced to complete.
  const teamState = JSON.parse(await fs.readFile(path.join(tmp, ".joc", "state", "team-state.json"), "utf-8"));
  expect(teamState.current_phase).toBe("complete");
  expect(teamState.pending_tasks.length).toBe(0);
  expect(teamState.completed_tasks.length).toBe(3);
});

test("runTeamCommand routes duplicate task names by step index, not by name", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn === 1) return JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nIn Scope:\nOut of Scope:\nFile-level Changes:\nSequencing:\nAcceptance Criteria:\nVerification:\nRisks:" } });
      return JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nFindings:\nRecommendations:\nArchitectural Status: CLEAR\nCode Review Recommendation: APPROVE" } });
    },
  }));
  const { runTeamCommand } = await import("../src/commands/team");
  await seedPlan([
    { name: "review", role: "planner" },
    { name: "review", role: "architect" },
  ]);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  const out = logs.join("\n");
  const plannerAt = out.indexOf("Subagent: Planner");
  const architectAt = out.indexOf("Subagent: Architect");
  expect(plannerAt).toBeGreaterThanOrEqual(0);
  expect(architectAt).toBeGreaterThan(plannerAt);
  const teamState = JSON.parse(await fs.readFile(path.join(tmp, ".joc", "state", "team-state.json"), "utf-8"));
  expect(teamState.completed_tasks).toEqual(["review", "review"]);
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

test("runTeamCommand refuses unknown plan subagent roles before execution", async () => {
  const { runTeamCommand } = await import("../src/commands/team");
  await seedPlan([{ name: "review design", role: "plannr" }]);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  const out = logs.join("\n");
  expect(out).toContain("unknown subagent role");
  expect(out).toContain("plannr");
  expect(out).toContain("executor, planner, architect, critic");
  expect(process.exitCode).toBe(1);
  await expect(fs.readFile(path.join(tmp, ".joc", "state", "team-state.json"), "utf-8")).rejects.toThrow();
});

test("runTeamCommand normalizes mixed-case plan roles", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nFindings:\nRecommendations:\nArchitectural Status: CLEAR\nCode Review Recommendation: APPROVE" } }),
  }));
  const { runTeamCommand } = await import("../src/commands/team");
  await seedPlan([{ name: "review design", role: "ARCHITECT" }]);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  const out = logs.join("\n");
  expect(out).toContain("Subagent: Architect");
  expect(out).toContain("[DONE] All tasks in the plan executed successfully!");
});

test("runTeamCommand surfaces the engine stop reason on subagent failure", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "read", arguments: { filePath: "missing.txt" } }),
  }));
  const { runTeamCommand } = await import("../src/commands/team");
  await seedPlan([{ name: "read missing file" }]);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  const out = logs.join("\n");
  expect(out).toContain("Stopped: repeated the same 'read' call");
  expect(out).not.toContain("Executor did not converge within");
  expect(process.exitCode).toBe(1);
});

test("runTeamCommand does not give write/edit/bash tools to read-only plan steps", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "write", arguments: { filePath: "pwn.txt", content: "mutated" } }),
  }));
  const { runTeamCommand } = await import("../src/commands/team");
  await seedPlan([{ name: "review without mutation", role: "architect" }]);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  await expect(fs.readFile(path.join(tmp, "pwn.txt"), "utf-8")).rejects.toThrow();
  const out = logs.join("\n");
  expect(out).toContain("Subagent: Architect");
  expect(out).toContain("tool write");
  expect(process.exitCode).toBe(1);
});

test("runTeamCommand halts when an architect review returns a blocking verdict", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({
      tool: "done",
      arguments: { reason: "Summary:\nFindings:\nRecommendations:\nArchitectural Status: BLOCK\nCode Review Recommendation: REQUEST CHANGES" },
    }),
  }));
  const { runTeamCommand } = await import("../src/commands/team");
  await seedPlan([{ name: "review design", role: "architect" }]);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  const out = logs.join("\n");
  expect(out).toContain("architect gated execution");
  expect(out).toContain("[ERR] Failed on task:");
  expect(process.exitCode).toBe(1);
});

test("runTeamCommand halts when a critic returns REJECT", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({
      tool: "done",
      arguments: { reason: "[REJECT]\nJustification:\nSummary:\nRequired Fixes:" },
    }),
  }));
  const { runTeamCommand } = await import("../src/commands/team");
  await seedPlan([{ name: "critique plan", role: "critic" }]);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  const out = logs.join("\n");
  expect(out).toContain("critic gated execution");
  expect(out).toContain("[ERR] Failed on task:");
  expect(process.exitCode).toBe(1);
});

test("runTeamCommand halts when a planner report misses required sections", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "planned" } }),
  }));
  const { runTeamCommand } = await import("../src/commands/team");
  await seedPlan([{ name: "plan work", role: "planner" }]);

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  const out = logs.join("\n");
  expect(out).toContain("Planner report incomplete");
  expect(out).toContain("[ERR] Failed on task:");
  expect(process.exitCode).toBe(1);
});

test("runTeamCommand refuses to run when team-state.json is corrupt (no silent restart)", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({ tool: "done", arguments: { reason: "Summary:\nChanged Files:\nVerification:" } }),
  }));
  const { runTeamCommand } = await import("../src/commands/team");
  await seedPlan([{ name: "implement it" }]);
  await fs.writeFile(path.join(tmp, ".joc", "state", "team-state.json"), "{ not json !!!");

  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  await runTeamCommand();
  console.log = origLog;

  const out = logs.join("\n");
  expect(out).toContain("team-state.json is corrupt");
  expect(out).not.toContain("[DONE]");
  expect(process.exitCode).toBe(1);
  // The corrupt file must not be overwritten/reset behind the user's back.
  expect(await fs.readFile(path.join(tmp, ".joc", "state", "team-state.json"), "utf-8")).toBe("{ not json !!!");
});
