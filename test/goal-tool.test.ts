import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createGoalTool } from "../src/agent/goal-tool";
import { readGoalState, writeGoalState, type GoalState } from "../src/agent/goal-verifier";

let tempCwd: string;

beforeEach(async () => {
  tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-goal-tool-test-"));
});

afterEach(async () => {
  await fs.rm(tempCwd, { recursive: true, force: true });
});

test("goal tool: set with a condition persists GoalState and returns confirmation", async () => {
  const tool = createGoalTool();
  const res = await tool({ action: "set", condition: "ship the feature" }, tempCwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("ship the feature");

  const state = await readGoalState(tempCwd);
  expect(state).not.toBeNull();
  expect(state!.condition).toBe("ship the feature");
  expect(state!.verdicts).toEqual([]);
});

test("goal tool: set with an empty/missing condition errors", async () => {
  const tool = createGoalTool();

  let res = await tool({ action: "set" }, tempCwd);
  expect(res.success).toBe(false);
  expect(res.error).toContain("requires a non-empty");

  res = await tool({ action: "set", condition: "   " }, tempCwd);
  expect(res.success).toBe(false);
  expect(res.error).toContain("requires a non-empty");
});

test("goal tool: get with no goal set reports no goal", async () => {
  const tool = createGoalTool();
  const res = await tool({ action: "get" }, tempCwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("No goal set");
});

test("goal tool: get after set reports the condition and verdict state", async () => {
  const tool = createGoalTool();
  await tool({ action: "set", condition: "make tests green" }, tempCwd);
  const res = await tool({ action: "get" }, tempCwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("make tests green");
});

test("goal tool: get reflects the latest verdict when one exists", async () => {
  const state: GoalState = {
    condition: "test condition",
    setAt: Date.now(),
    verdicts: [
      { at: Date.now() - 1000, verdict: "NOT_MET", gap: "first gap" },
      { at: Date.now(), verdict: "NOT_MET", gap: "missing tests" },
    ],
  };
  await writeGoalState(state, tempCwd);

  const tool = createGoalTool();
  const res = await tool({ action: "get" }, tempCwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("NOT_MET");
  expect(res.output).toContain("missing tests");
});

test("goal tool: clear removes a set goal", async () => {
  const tool = createGoalTool();
  await tool({ action: "set", condition: "temporary goal" }, tempCwd);
  const res = await tool({ action: "clear" }, tempCwd);
  expect(res.success).toBe(true);

  const state = await readGoalState(tempCwd);
  expect(state).toBeNull();
});

test("goal tool: unknown action fails with a clear message", async () => {
  const tool = createGoalTool();
  const res = await tool({ action: "bogus" }, tempCwd);
  expect(res.success).toBe(false);
  expect(res.error).toContain("Unknown goal action");
  expect(res.error).toContain("bogus");
});

test("goal tool: default action (omitted) behaves like get", async () => {
  const tool = createGoalTool();
  const res = await tool({}, tempCwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("No goal set");
});
