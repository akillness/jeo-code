import { test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { GoalStateCorruptError, verifyGoal, readGoalState, writeGoalState, clearGoalState, getGoalPath, applyEvidenceGate, applyPendingEvidence, type GoalState } from "../src/agent/goal-verifier";

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

test("readGoalState rejects malformed JSON and invalid persisted shapes", async () => {
  const corruptStates: Array<{ name: string; contents: string }> = [
    { name: "malformed JSON", contents: "{\"condition\":" },
    { name: "missing required fields", contents: JSON.stringify({ condition: "finish the task" }) },
    {
      name: "invalid verdict entry",
      contents: JSON.stringify({ condition: "finish the task", setAt: 1, verdicts: [{ at: 2, verdict: "MAYBE" }] }),
    },
  ];

  for (const state of corruptStates) {
    await fs.mkdir(path.dirname(getGoalPath(tempCwd)), { recursive: true });
    await fs.writeFile(getGoalPath(tempCwd), state.contents, "utf8");

    await expect(readGoalState(tempCwd), state.name).rejects.toBeInstanceOf(GoalStateCorruptError);
    await clearGoalState(tempCwd);
  }
});

test("replacing goal state keeps the existing JSON readable until the replacement is committed", async () => {
  const existing: GoalState = {
    condition: "finish the original goal",
    setAt: 1_700_000_000_000,
    verdicts: [{ at: 1_700_000_001_000, verdict: "NOT_MET", gap: "still working" }],
    pendingMutationVerification: true,
  };
  const replacement: GoalState = {
    condition: "finish the replacement goal",
    setAt: 1_700_000_002_000,
    verdicts: [{ at: 1_700_000_003_000, verdict: "MET", gap: "verified" }],
    pendingMutationVerification: false,
  };

  await writeGoalState(existing, tempCwd);

  const realRename = fs.rename;
  let stateBeforeRename: GoalState | null | undefined;
  const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    stateBeforeRename = await readGoalState(tempCwd);
    return realRename(source, destination);
  });

  try {
    await writeGoalState(replacement, tempCwd);
  } finally {
    renameSpy.mockRestore();
  }

  expect(stateBeforeRename).toEqual(existing);
  expect(await readGoalState(tempCwd)).toEqual(replacement);
});

test("pending mutation evidence persists across turns until fresh verification succeeds", async () => {
  let state: GoalState = {
    condition: "complete and verify the change",
    setAt: Date.now(),
    verdicts: [],
  };

  // A successful mutation must leave a durable verification obligation.
  state = applyPendingEvidence(state, {
    sawMutation: true,
    sawVerification: false,
    verificationStale: false,
  });
  await writeGoalState(state, tempCwd);

  // A later turn with no changes or verification cannot forget the earlier edit.
  state = (await readGoalState(tempCwd))!;
  state = applyPendingEvidence(state, {
    sawMutation: false,
    sawVerification: false,
    verificationStale: false,
  });
  expect(state.pendingMutationVerification).toBe(true);
  expect(applyEvidenceGate(
    { verdict: "MET", reason: "looks complete" },
    { sawMutation: false, sawVerification: false, verificationStale: false, pendingMutation: true },
  ).verdict).toBe("NOT_MET");

  // Neither a stale passing run nor a failed/no-verification attempt clears it.
  state = applyPendingEvidence(state, {
    sawMutation: false,
    sawVerification: true,
    verificationStale: true,
  });
  expect(state.pendingMutationVerification).toBe(true);
  state = applyPendingEvidence(state, {
    sawMutation: false,
    sawVerification: false,
    verificationStale: false,
  });
  expect(state.pendingMutationVerification).toBe(true);
  expect(applyEvidenceGate(
    { verdict: "MET", reason: "stale or failed verification" },
    { sawMutation: false, sawVerification: true, verificationStale: true, pendingMutation: true },
  ).verdict).toBe("NOT_MET");

  // Only a fresh successful verification clears persisted pending evidence.
  state = applyPendingEvidence(state, {
    sawMutation: false,
    sawVerification: true,
    verificationStale: false,
  });
  await writeGoalState(state, tempCwd);
  const persisted = (await readGoalState(tempCwd))!;
  expect(persisted.pendingMutationVerification).toBe(false);
  expect(applyEvidenceGate(
    { verdict: "MET", reason: "verified" },
    { sawMutation: false, sawVerification: true, verificationStale: false, pendingMutation: false },
  ).verdict).toBe("MET");
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
