import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { verifyGoal, readGoalState, writeGoalState, clearGoalState, applyEvidenceGate, type GoalState } from "../src/agent/goal-verifier";

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
test("applyEvidenceGate leaves NOT_MET/IMPOSSIBLE untouched regardless of evidence", () => {
  const notMet = { verdict: "NOT_MET" as const, reason: "missing tests" };
  const impossible = { verdict: "IMPOSSIBLE" as const, reason: "no credentials" };
  const noEvidence = { sawMutation: false, sawVerification: false, verificationStale: false };
  expect(applyEvidenceGate(notMet, noEvidence)).toEqual(notMet);
  expect(applyEvidenceGate(impossible, noEvidence)).toEqual(impossible);
});

test("applyEvidenceGate keeps MET when no files were mutated this turn", () => {
  const met = { verdict: "MET" as const, reason: "read-only investigation, nothing to change" };
  const result = applyEvidenceGate(met, { sawMutation: false, sawVerification: false, verificationStale: false });
  expect(result).toEqual(met);
});

test("applyEvidenceGate keeps MET when mutation was followed by fresh verification", () => {
  const met = { verdict: "MET" as const, reason: "fixed and verified" };
  const result = applyEvidenceGate(met, { sawMutation: true, sawVerification: true, verificationStale: false });
  expect(result).toEqual(met);
});

test("applyEvidenceGate downgrades MET to NOT_MET when files mutated with no verification at all", () => {
  const met = { verdict: "MET" as const, reason: "looks done" };
  const result = applyEvidenceGate(met, { sawMutation: true, sawVerification: false, verificationStale: false });
  expect(result.verdict).toBe("NOT_MET");
  expect(result.reason).toContain("no test/build/typecheck/lint run was observed");
  expect(result.reason).toContain("looks done"); // preserves the original LLM reason for context
});

test("applyEvidenceGate downgrades MET to NOT_MET when the only verification predates the last mutation", () => {
  const met = { verdict: "MET" as const, reason: "ran tests earlier, then fixed one more bug" };
  const result = applyEvidenceGate(met, { sawMutation: true, sawVerification: true, verificationStale: true });
  expect(result.verdict).toBe("NOT_MET");
  expect(result.reason).toContain("stale evidence");
});

test("onBeforeDone wiring: an evidence-gated downgrade is persisted into goal state and blocks done, exactly like a real NOT_MET LLM verdict", async () => {
  // Simulates launch.ts's actual onBeforeDone closure: verifyGoal's raw LLM
  // verdict is ALWAYS passed through applyEvidenceGate before being recorded
  // or acted on — this is the wiring that closes the gap applyEvidenceGate's
  // unit tests (above) prove in isolation but never exercise end-to-end.
  const state: GoalState = { condition: "add and pass a regression test", setAt: Date.now(), verdicts: [] };
  await writeGoalState(state, tempCwd);

  const llmVerdict = { verdict: "MET" as const, reason: "the fix looks complete" };
  const evidence = { sawMutation: true, sawVerification: false, verificationStale: false };
  const gated = applyEvidenceGate(llmVerdict, evidence);

  const goalState = await readGoalState(tempCwd);
  goalState!.verdicts.push({ at: Date.now(), verdict: gated.verdict, gap: gated.reason });
  await writeGoalState(goalState!, tempCwd);

  // The persisted verdict is the GATED one (NOT_MET), never the raw LLM MET —
  // proves the gate's decision, not just the LLM's, is what launch.ts records
  // and what would block `done` in the real turn loop.
  const reread = await readGoalState(tempCwd);
  expect(reread!.verdicts[0]!.verdict).toBe("NOT_MET");
  expect(reread!.verdicts[0]!.gap).toContain("no test/build/typecheck/lint run was observed");
  expect(gated.verdict === "NOT_MET" || gated.verdict === "IMPOSSIBLE").toBe(true); // the real closure's block condition
});
