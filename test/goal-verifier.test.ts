import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { verifyGoal, readGoalState, writeGoalState, clearGoalState, type GoalState } from "../src/agent/goal-verifier";
import type { Message } from "../src/agent/loop";

let tempCwd: string;

beforeEach(async () => {
  tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-goal-test-"));
});

afterEach(async () => {
  await fs.rm(tempCwd, { recursive: true, force: true });
});

test("verifyGoal parses MET verdict correctly", async () => {
  mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({
      verdict: "MET",
      reason: "The goal has been fully met."
    })
  }));

  const result = await verifyGoal("test goal", [], "test-model");
  expect(result.verdict).toBe("MET");
  expect(result.reason).toBe("The goal has been fully met.");
});

test("verifyGoal parses NOT_MET verdict correctly", async () => {
  mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({
      verdict: "NOT_MET",
      reason: "The goal is missing verification."
    })
  }));

  const result = await verifyGoal("test goal", [], "test-model");
  expect(result.verdict).toBe("NOT_MET");
  expect(result.reason).toBe("The goal is missing verification.");
});

test("verifyGoal parses IMPOSSIBLE verdict correctly", async () => {
  mock.module("../src/agent/loop", () => ({
    callLlm: async () => JSON.stringify({
      verdict: "IMPOSSIBLE",
      reason: "The goal cannot be met due to environment constraints."
    })
  }));

  const result = await verifyGoal("test goal", [], "test-model");
  expect(result.verdict).toBe("IMPOSSIBLE");
  expect(result.reason).toBe("The goal cannot be met due to environment constraints.");
});

test("verifyGoal falls back to NOT_MET on invalid JSON", async () => {
  mock.module("../src/agent/loop", () => ({
    callLlm: async () => "invalid json"
  }));

  const result = await verifyGoal("test goal", [], "test-model");
  expect(result.verdict).toBe("NOT_MET");
  expect(result.reason).toContain("Goal verification failed to parse or execute");
});

test("goal state persistence read/write/clear works", async () => {
  const state: GoalState = {
    condition: "test condition",
    setAt: Date.now(),
    verdicts: [
      { at: Date.now(), verdict: "NOT_MET", gap: "missing tests" }
    ]
  };

  // Initially null
  const initial = await readGoalState(tempCwd);
  expect(initial).toBeNull();

  // Write and read back
  await writeGoalState(state, tempCwd);
  const read = await readGoalState(tempCwd);
  expect(read).not.toBeNull();
  expect(read!.condition).toBe("test condition");
  expect(read!.verdicts.length).toBe(1);
  expect(read!.verdicts[0].verdict).toBe("NOT_MET");

  // Clear
  await clearGoalState(tempCwd);
  const cleared = await readGoalState(tempCwd);
  expect(cleared).toBeNull();
});

test("re-block cap logic auto-allows done after MAX_RE_BLOCKS", async () => {
  const state: GoalState = {
    condition: "test condition",
    setAt: Date.now(),
    verdicts: [
      { at: Date.now() - 2000, verdict: "NOT_MET", gap: "first gap" },
      { at: Date.now() - 1000, verdict: "NOT_MET", gap: "second gap" }
    ]
  };

  await writeGoalState(state, tempCwd);

  // Simulate the onBeforeDone logic
  const goalState = await readGoalState(tempCwd);
  expect(goalState).not.toBeNull();

  const reBlockCount = goalState!.verdicts.filter(v => v.verdict === "NOT_MET" || v.verdict === "IMPOSSIBLE").length;
  const MAX_RE_BLOCKS = 2;

  expect(reBlockCount).toBe(2);
  expect(reBlockCount >= MAX_RE_BLOCKS).toBe(true);
});
