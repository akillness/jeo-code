import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createApproveTool } from "../src/agent/approve-tool";
import { readWorkflowState, writeWorkflowState } from "../src/agent/state";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-approve-tool-test-"));
}

test("approve tool: explicit planPath approves a schema-valid, consensus-reviewed plan", async () => {
  const dir = await tmp();
  const planPath = path.join(dir, "plan.yaml");
  const planContent = 'steps:\n  - name: "Build it"\n    role: executor\n';
  await fs.writeFile(planPath, planContent, "utf-8");
  await writeWorkflowState(
    "ralplan",
    { active: true, current_phase: "complete", skill: "ralplan", plan_path: planPath, approved: false, consensus: "okay" },
    dir,
  );

  const tool = createApproveTool();
  const res = await tool({ planPath }, dir);
  expect(res.success).toBe(true);
  expect(res.output).toContain("Plan approved successfully");

  const state = await readWorkflowState("ralplan", dir);
  expect(state?.approved).toBe(true);
});

test("approve tool: omitted planPath defaults to the active ralplan state's plan_path", async () => {
  const dir = await tmp();
  const planPath = path.join(dir, "active-plan.yaml");
  const planContent = 'steps:\n  - name: "Ship it"\n    role: executor\n';
  await fs.writeFile(planPath, planContent, "utf-8");
  await writeWorkflowState(
    "ralplan",
    { active: true, current_phase: "complete", skill: "ralplan", plan_path: planPath, approved: false, consensus: "okay" },
    dir,
  );

  const tool = createApproveTool();
  const res = await tool({}, dir);
  expect(res.success).toBe(true);

  const state = await readWorkflowState("ralplan", dir);
  expect(state?.approved).toBe(true);
});

test("approve tool: no planPath and no active ralplan state errors clearly", async () => {
  const dir = await tmp();
  const tool = createApproveTool();
  const res = await tool({}, dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("requires a 'planPath'");
});

test("approve tool: surfaces the same content gate as the CLI (missing consensus verdict)", async () => {
  const dir = await tmp();
  const planPath = path.join(dir, "no-consensus.yaml");
  await fs.writeFile(planPath, 'steps:\n  - name: "Build it"\n    role: executor\n', "utf-8");
  await writeWorkflowState(
    "ralplan",
    { active: true, current_phase: "complete", skill: "ralplan", plan_path: planPath, approved: false },
    dir,
  );

  const tool = createApproveTool();
  const res = await tool({ planPath }, dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("lacks an [OKAY] consensus verdict");

  const state = await readWorkflowState("ralplan", dir);
  expect(state?.approved).toBeFalsy();
});

test("approve tool: an already-approved plan reports success idempotently", async () => {
  const dir = await tmp();
  const planPath = path.join(dir, "already.yaml");
  await fs.writeFile(planPath, 'steps:\n  - name: "Done already"\n    role: executor\n', "utf-8");
  await writeWorkflowState(
    "ralplan",
    { active: true, current_phase: "complete", skill: "ralplan", plan_path: planPath, approved: true, consensus: "okay" },
    dir,
  );

  const tool = createApproveTool();
  const res = await tool({ planPath }, dir);
  expect(res.success).toBe(true);
  expect(res.output).toContain("already approved");
});
