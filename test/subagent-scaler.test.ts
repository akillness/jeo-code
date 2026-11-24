import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig } from "../src/agent/config-schema";
import { evalToolProtocolLine } from "../src/agent/eval-tool";
import * as loop from "../src/agent/loop";
import { SubagentRegistry } from "../src/agent/subagent-registry";
import {
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  SubagentScaler,
  getSharedSubagentScaler,
  resetSharedSubagentScaler,
  resolveScalerCeilings,
  type SubagentScalerConfig,
} from "../src/agent/subagent-scaler";
import { getSubagentRole } from "../src/agent/subagents";
import { createTaskTool, resolveRoleFanoutLimit, runSubagentOnce } from "../src/agent/task-tool";

const VALID_EXECUTOR_DONE = JSON.stringify({
  tool: "done",
  arguments: {
    reason: "Summary: completed\nChanged Files: none\nVerification: checked",
  },
});

const VALID_PLANNER_DONE = JSON.stringify({
  tool: "done",
  arguments: {
    reason: [
      "Summary: plan ready",
      "In Scope: scaler tests",
      "Out of Scope: production edits",
      "File-level Changes: test/subagent-scaler.test.ts",
      "Sequencing: unit then integration",
      "Acceptance Criteria: tests pass",
      "Verification: bun test",
      "Risks: none",
    ].join("\n"),
  },
});

const MEANINGFUL_JUSTIFICATION =
  "Each task inspects an independent module with zero shared state and disjoint files.";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-scaler-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetSharedSubagentScaler();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("SubagentScaler: role-split dynamic scaling and ceiling resolution", () => {
  const ceilingCases: Array<{
    name: string;
    config: SubagentScalerConfig;
    expected: { dynamicEnabled: boolean; readOnlyCeiling: number; executorCeiling: number };
  }> = [
    {
      name: "explicit max ceiling splits read-only 16 vs conservative executor 6",
      config: { subagentConcurrency: 16, subagentDynamicScaling: true },
      expected: { dynamicEnabled: true, readOnlyCeiling: 16, executorCeiling: 6 },
    },
    {
      name: "low overall ceiling bounds executor when subagentExecutorConcurrency is unset",
      config: { subagentConcurrency: 4, subagentDynamicScaling: true },
      expected: { dynamicEnabled: true, readOnlyCeiling: 4, executorCeiling: 4 },
    },
    {
      name: "explicit subagentExecutorConcurrency within 1..8 applies up to 8",
      config: { subagentConcurrency: 16, subagentExecutorConcurrency: 8 },
      expected: { dynamicEnabled: true, readOnlyCeiling: 16, executorCeiling: 8 },
    },
    {
      name: "subagentExecutorConcurrency above 8 is clamped to 8",
      config: { subagentConcurrency: 16, subagentExecutorConcurrency: 14 },
      expected: { dynamicEnabled: true, readOnlyCeiling: 16, executorCeiling: 8 },
    },
    {
      name: "subagentExecutorConcurrency below 1 is clamped to 1",
      config: { subagentConcurrency: 12, subagentExecutorConcurrency: 0 },
      expected: { dynamicEnabled: true, readOnlyCeiling: 12, executorCeiling: 1 },
    },
    {
      name: "negative subagentExecutorConcurrency is clamped to 1",
      config: { subagentConcurrency: 12, subagentExecutorConcurrency: -3 },
      expected: { dynamicEnabled: true, readOnlyCeiling: 12, executorCeiling: 1 },
    },
    {
      name: "fractional ceilings truncate toward zero",
      config: { subagentConcurrency: 9.9, subagentExecutorConcurrency: 3.7 },
      expected: { dynamicEnabled: true, readOnlyCeiling: 9, executorCeiling: 3 },
    },
    {
      name: "subagentConcurrency above 16 clamps read-only ceiling to 16",
      config: { subagentConcurrency: 40 },
      expected: { dynamicEnabled: true, readOnlyCeiling: 16, executorCeiling: 6 },
    },
    {
      name: "subagentConcurrency below 1 clamps both ceilings to 1",
      config: { subagentConcurrency: 0 },
      expected: { dynamicEnabled: true, readOnlyCeiling: 1, executorCeiling: 1 },
    },
    {
      name: "static mode with explicit concurrency honors fixed read-only and executor ceilings",
      config: { subagentDynamicScaling: false, subagentConcurrency: 10, subagentExecutorConcurrency: 4 },
      expected: { dynamicEnabled: false, readOnlyCeiling: 10, executorCeiling: 4 },
    },
    {
      name: "static mode with low concurrency caps unset executor to ceiling",
      config: { subagentDynamicScaling: false, subagentConcurrency: 3 },
      expected: { dynamicEnabled: false, readOnlyCeiling: 3, executorCeiling: 3 },
    },
  ];

  for (const tc of ceilingCases) {
    test(`resolveScalerCeilings: ${tc.name}`, () => {
      expect(resolveScalerCeilings(tc.config)).toEqual(tc.expected);
    });
  }

  test("read-only starts at min(6, ceiling) and auto-scales up to 16 on demand without scaling executor", () => {
    let now = 1_000;
    const scaler = new SubagentScaler({ subagentConcurrency: 16 }, { now: () => now });

    // Read-only starts at base 6 while healthy, then expands on demand up to 16.
    expect(scaler.effectiveLimit(true)).toBe(6);
    expect(scaler.effectiveLimit(true, 10)).toBe(10);
    expect(scaler.effectiveLimit(true, 16)).toBe(16);
    expect(scaler.effectiveLimit(true, 24)).toBe(16);
    // Lower subsequent demand or non-finite demand does not shrink an active healthy budget.
    expect(scaler.effectiveLimit(true, 3)).toBe(16);
    expect(scaler.effectiveLimit(true, Number.NaN)).toBe(16);
    expect(scaler.effectiveLimit(true, Number.POSITIVE_INFINITY)).toBe(16);

    // Executor ignores demand scale-up and stays at its conservative ceiling.
    expect(scaler.effectiveLimit(false)).toBe(6);
    expect(scaler.effectiveLimit(false, 16)).toBe(6);

    // Low ceiling starts read-only at min(6, ceiling) and never scales past it.
    const low = new SubagentScaler({ subagentConcurrency: 4 }, { now: () => now });
    expect(low.effectiveLimit(true)).toBe(4);
    expect(low.effectiveLimit(true, 12)).toBe(4);
    expect(low.effectiveLimit(false, 12)).toBe(4);
  });

  test("executor respects explicit subagentExecutorConcurrency and never exceeds it on demand", () => {
    const cappedAt3 = new SubagentScaler({ subagentConcurrency: 16, subagentExecutorConcurrency: 3 });
    expect(cappedAt3.effectiveLimit(false, 16)).toBe(3);
    expect(cappedAt3.effectiveLimit(true, 12)).toBe(12);

    const cappedAt8 = new SubagentScaler({ subagentConcurrency: 16, subagentExecutorConcurrency: 8 });
    expect(cappedAt8.effectiveLimit(false, 16)).toBe(8);
  });
});

describe("SubagentScaler: HTTP 429 backoff, cooldown, and gradual recovery", () => {
  test("recordRateLimit halves active limit down to floor 1 and suppresses scale-up during 30s cooldown", () => {
    let now = 10_000;
    const scaler = new SubagentScaler({ subagentConcurrency: 16 }, { now: () => now });

    // Scale read-only up to 16 first.
    expect(scaler.effectiveLimit(true, 16)).toBe(16);

    // First 429 halves 16 -> 8 and starts 30s cooldown.
    scaler.recordRateLimit(true);
    expect(scaler.effectiveLimit(true, 16)).toBe(8);
    expect(scaler.snapshot()).toEqual({
      readOnlyLimit: 8,
      readOnlyCeiling: 16,
      executorLimit: 6,
      executorCeiling: 6,
      inCooldown: true,
      consecutiveRateLimits: 1,
    });

    // 1ms before cooldown ends: still in cooldown, demand scale-up & successes are suppressed.
    now = 10_000 + DEFAULT_RATE_LIMIT_COOLDOWN_MS - 1;
    expect(scaler.snapshot().inCooldown).toBe(true);
    expect(scaler.effectiveLimit(true, 16)).toBe(8);
    scaler.recordSuccess(true);
    scaler.recordSuccess(true);
    scaler.recordSuccess(true);
    expect(scaler.effectiveLimit(true, 16)).toBe(8);
    expect(scaler.snapshot().consecutiveRateLimits).toBe(1);

    // Repeated 429s halve with floor 1: 8 -> 4 -> 2 -> 1 -> 1.
    scaler.recordRateLimit(true);
    expect(scaler.effectiveLimit(true)).toBe(4);
    scaler.recordRateLimit(true);
    expect(scaler.effectiveLimit(true)).toBe(2);
    scaler.recordRateLimit(true);
    expect(scaler.effectiveLimit(true)).toBe(1);
    scaler.recordRateLimit(true);
    expect(scaler.effectiveLimit(true)).toBe(1);
    expect(scaler.snapshot().consecutiveRateLimits).toBe(5);
  });

  test("post-cooldown recovery steps up by +2 only after consecutive successes and blocks immediate demand spike", () => {
    let now = 5_000;
    const scaler = new SubagentScaler({ subagentConcurrency: 16 }, { now: () => now });

    expect(scaler.effectiveLimit(true, 16)).toBe(16);
    scaler.recordRateLimit(true); // 16 -> 8, cooldown until 35_000

    // Exact cooldown expiry boundary: cooldown ends, but backed-off flag still blocks instant spike to 16.
    now = 5_000 + DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    expect(scaler.snapshot().inCooldown).toBe(false);
    expect(scaler.effectiveLimit(true, 16)).toBe(8);

    // 1st post-cooldown success resets consecutiveRateLimits but does not raise limit yet.
    scaler.recordSuccess(true);
    expect(scaler.snapshot().consecutiveRateLimits).toBe(0);
    expect(scaler.effectiveLimit(true, 16)).toBe(8);

    // 2nd consecutive success steps 8 -> 10.
    scaler.recordSuccess(true);
    expect(scaler.effectiveLimit(true, 16)).toBe(10);

    // 3rd -> still 10; 4th -> 12; 5th & 6th -> 14; 7th & 8th -> 16 (ceiling reached).
    scaler.recordSuccess(true);
    expect(scaler.effectiveLimit(true)).toBe(10);
    scaler.recordSuccess(true);
    expect(scaler.effectiveLimit(true)).toBe(12);
    scaler.recordSuccess(true);
    scaler.recordSuccess(true);
    expect(scaler.effectiveLimit(true)).toBe(14);
    scaler.recordSuccess(true);
    scaler.recordSuccess(true);
    expect(scaler.effectiveLimit(true)).toBe(16);

    // Further successes never exceed ceiling.
    scaler.recordSuccess(true);
    scaler.recordSuccess(true);
    expect(scaler.effectiveLimit(true)).toBe(16);
  });

  test("a 429 during partial recovery resets recovery progress, halves again, and restarts cooldown", () => {
    let now = 0;
    const scaler = new SubagentScaler({ subagentConcurrency: 16 }, { now: () => now });

    scaler.effectiveLimit(true, 16);
    scaler.recordRateLimit(true); // 16 -> 8, cooldown until 30_000

    now = 30_000;
    scaler.recordSuccess(true); // 1 of 2 successes accrued
    expect(scaler.effectiveLimit(true)).toBe(8);

    // New 429 interrupts recovery: halves 8 -> 4, clears recovery count, cooldown until 60_000.
    scaler.recordRateLimit(true);
    expect(scaler.effectiveLimit(true)).toBe(4);
    expect(scaler.snapshot().inCooldown).toBe(true);

    now = 60_000;
    // Must take a FULL 2 consecutive successes (not 1) to recover 4 -> 6.
    scaler.recordSuccess(true);
    expect(scaler.effectiveLimit(true)).toBe(4);
    scaler.recordSuccess(true);
    expect(scaler.effectiveLimit(true)).toBe(6);
  });

  test("role backoff is isolated per role while cooldown pauses read-only scale-up", () => {
    let now = 1_000;
    const scaler = new SubagentScaler(
      { subagentConcurrency: 16, subagentExecutorConcurrency: 6 },
      { now: () => now },
    );

    // Executor hits 429 -> executor halves 6 -> 3, read-only limit stays at 6,
    // but read-only cannot scale up above 6 while cooldown is active.
    scaler.recordRateLimit(false);
    expect(scaler.effectiveLimit(false)).toBe(3);
    expect(scaler.effectiveLimit(true, 14)).toBe(6);

    // Once cooldown expires, read-only (not backed off) can scale on demand again,
    // while executor recovers gradually 3 -> 5 -> 6 via pairs of successes.
    now = 1_000 + DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    expect(scaler.effectiveLimit(true, 14)).toBe(14);
    expect(scaler.effectiveLimit(false)).toBe(3);

    scaler.recordSuccess(false);
    expect(scaler.effectiveLimit(false)).toBe(3);
    scaler.recordSuccess(false);
    expect(scaler.effectiveLimit(false)).toBe(5);
    scaler.recordSuccess(false);
    scaler.recordSuccess(false);
    expect(scaler.effectiveLimit(false)).toBe(6);
  });
});

describe("SubagentScaler: static mode and configure() transitions", () => {
  test("static mode (subagentDynamicScaling: false) returns fixed ceiling and ignores demand and 429 halving", () => {
    let now = 2_000;
    const scaler = new SubagentScaler(
      { subagentDynamicScaling: false, subagentConcurrency: 10, subagentExecutorConcurrency: 4 },
      { now: () => now },
    );

    expect(scaler.effectiveLimit(true)).toBe(10);
    expect(scaler.effectiveLimit(true, 16)).toBe(10);
    expect(scaler.effectiveLimit(false, 16)).toBe(4);

    // 429s do not halve limits in static mode.
    scaler.recordRateLimit(true);
    scaler.recordRateLimit(false);
    expect(scaler.effectiveLimit(true, 16)).toBe(10);
    expect(scaler.effectiveLimit(false, 16)).toBe(4);

    // Post-cooldown successes do not drift limits in static mode.
    now += DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    scaler.recordSuccess(true);
    scaler.recordSuccess(true);
    expect(scaler.effectiveLimit(true)).toBe(10);
    expect(scaler.effectiveLimit(false)).toBe(4);
  });

  test("configure() preserves active backoff and cooldown while clamping to updated ceilings", () => {
    let now = 1_000;
    const scaler = new SubagentScaler({ subagentConcurrency: 16 }, { now: () => now });

    scaler.effectiveLimit(true, 16);
    scaler.recordRateLimit(true); // 16 -> 8, inCooldown until 31_000

    // Updating ceiling to 12 keeps backed-off limit at 8 and preserves cooldown.
    scaler.configure({ subagentConcurrency: 12 });
    expect(scaler.snapshot()).toMatchObject({
      readOnlyLimit: 8,
      readOnlyCeiling: 12,
      inCooldown: true,
    });

    // Lowering ceiling below active backed-off limit clamps live limit down to 5.
    scaler.configure({ subagentConcurrency: 5 });
    expect(scaler.snapshot()).toMatchObject({
      readOnlyLimit: 5,
      readOnlyCeiling: 5,
      inCooldown: true,
    });

    // Switching to static mode immediately returns the fixed configured ceiling.
    scaler.configure({ subagentConcurrency: 9, subagentDynamicScaling: false });
    expect(scaler.effectiveLimit(true)).toBe(9);
  });
});

describe("config-schema: subagent concurrency validation", () => {
  const baseConfig = { defaultModel: "anthropic/claude-sonnet-4-6" };

  const validCases: Array<{ name: string; patch: Record<string, unknown> }> = [
    { name: "subagentConcurrency lower bound 1", patch: { subagentConcurrency: 1 } },
    { name: "subagentConcurrency mid value 6", patch: { subagentConcurrency: 6 } },
    { name: "subagentConcurrency upper bound 16", patch: { subagentConcurrency: 16 } },
    { name: "subagentExecutorConcurrency lower bound 1", patch: { subagentExecutorConcurrency: 1 } },
    { name: "subagentExecutorConcurrency mid value 6", patch: { subagentExecutorConcurrency: 6 } },
    { name: "subagentExecutorConcurrency upper bound 8", patch: { subagentExecutorConcurrency: 8 } },
    { name: "subagentDynamicScaling true", patch: { subagentDynamicScaling: true } },
    { name: "subagentDynamicScaling false", patch: { subagentDynamicScaling: false } },
    {
      name: "all three fields combined at boundaries",
      patch: { subagentConcurrency: 16, subagentExecutorConcurrency: 8, subagentDynamicScaling: true },
    },
  ];

  for (const tc of validCases) {
    test(`parseConfig accepts ${tc.name}`, () => {
      const res = parseConfig({ ...baseConfig, ...tc.patch });
      expect(res.ok).toBe(true);
      if (res.ok) {
        for (const [k, v] of Object.entries(tc.patch)) {
          expect((res.config as Record<string, unknown>)[k]).toBe(v);
        }
      }
    });
  }

  const invalidCases: Array<{ name: string; field: string; patch: Record<string, unknown> }> = [
    { name: "subagentConcurrency = 0", field: "subagentConcurrency", patch: { subagentConcurrency: 0 } },
    { name: "subagentConcurrency = -1", field: "subagentConcurrency", patch: { subagentConcurrency: -1 } },
    { name: "subagentConcurrency = 17", field: "subagentConcurrency", patch: { subagentConcurrency: 17 } },
    { name: "subagentConcurrency = 4.5 (non-int)", field: "subagentConcurrency", patch: { subagentConcurrency: 4.5 } },
    { name: "subagentConcurrency = '8' (string)", field: "subagentConcurrency", patch: { subagentConcurrency: "8" } },
    { name: "subagentExecutorConcurrency = 0", field: "subagentExecutorConcurrency", patch: { subagentExecutorConcurrency: 0 } },
    { name: "subagentExecutorConcurrency = -2", field: "subagentExecutorConcurrency", patch: { subagentExecutorConcurrency: -2 } },
    { name: "subagentExecutorConcurrency = 9", field: "subagentExecutorConcurrency", patch: { subagentExecutorConcurrency: 9 } },
    { name: "subagentExecutorConcurrency = 2.5 (non-int)", field: "subagentExecutorConcurrency", patch: { subagentExecutorConcurrency: 2.5 } },
    { name: "subagentExecutorConcurrency = '6' (string)", field: "subagentExecutorConcurrency", patch: { subagentExecutorConcurrency: "6" } },
    { name: "subagentDynamicScaling = 'true' (string)", field: "subagentDynamicScaling", patch: { subagentDynamicScaling: "true" } },
    { name: "subagentDynamicScaling = 1 (number)", field: "subagentDynamicScaling", patch: { subagentDynamicScaling: 1 } },
    { name: "subagentDynamicScaling = null", field: "subagentDynamicScaling", patch: { subagentDynamicScaling: null } },
  ];

  for (const tc of invalidCases) {
    test(`parseConfig rejects ${tc.name}`, () => {
      const res = parseConfig({ ...baseConfig, ...tc.patch });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.message).toContain(tc.field);
      }
    });
  }
});

describe("resolveRoleFanoutLimit and task-tool role-split enforcement", () => {
  test("resolveRoleFanoutLimit uses injected scaler cleanly and respects role split + backoff", () => {
    let now = 1_000;
    const scaler = new SubagentScaler(
      { subagentConcurrency: 14, subagentExecutorConcurrency: 5 },
      { now: () => now },
    );

    expect(resolveRoleFanoutLimit(undefined, true, 12, scaler)).toBe(12);
    expect(resolveRoleFanoutLimit(undefined, false, 12, scaler)).toBe(5);

    scaler.recordRateLimit(true); // 12 -> 6
    expect(resolveRoleFanoutLimit(undefined, true, 14, scaler)).toBe(6);
    expect(resolveRoleFanoutLimit(undefined, false, 14, scaler)).toBe(5);
  });

  test("resolveRoleFanoutLimit updates shared scaler when no override scaler is passed", () => {
    resetSharedSubagentScaler();
    expect(resolveRoleFanoutLimit({ subagentConcurrency: 12, subagentExecutorConcurrency: 4 }, true, 10)).toBe(10);
    expect(resolveRoleFanoutLimit({ subagentConcurrency: 12, subagentExecutorConcurrency: 4 }, false, 10)).toBe(4);
    expect(getSharedSubagentScaler().snapshot()).toMatchObject({
      readOnlyLimit: 10,
      readOnlyCeiling: 12,
      executorLimit: 4,
      executorCeiling: 4,
    });
  });

  test("detached launches: 7th executor is blocked at cap 6 while 7th and 8th read-only roles succeed up to ceiling", async () => {
    const cwd = await makeTempDir();
    const reg = new SubagentRegistry();
    const gate = Promise.withResolvers<string>();
    const scaler = new SubagentScaler({ subagentConcurrency: 8, subagentExecutorConcurrency: 6 });
    const callSpy = spyOn(loop, "callLlm").mockImplementation(() => gate.promise);

    const tool = createTaskTool({
      config: { defaultModel: "ollama/fast", subagents: {}, subagentConcurrency: 8, subagentExecutorConcurrency: 6 },
      registry: reg,
      scaler,
    });

    try {
      // Fill 6 unsettled executor runs.
      for (let i = 1; i <= 6; i++) {
        const res = await tool({ role: "executor", task: `exec ${i}`, detached: true }, cwd);
        expect(res.success).toBe(true);
      }
      expect(reg.pending()).toHaveLength(6);

      // 7th executor must be blocked at executor cap 6.
      const blockedExec = await tool({ role: "executor", task: "exec 7", detached: true }, cwd);
      expect(blockedExec.success).toBe(false);
      expect(blockedExec.error).toContain("6 unsettled runs for executor role");
      expect(reg.pending()).toHaveLength(6);

      // 7th and 8th read-only (planner) launches scale dynamically and succeed up to ceiling 8.
      const ro7 = await tool({ role: "planner", task: "plan 7", detached: true }, cwd);
      expect(ro7.success).toBe(true);
      expect(ro7.output).toContain("[detached] launched");
      expect(reg.pending()).toHaveLength(7);

      const ro8 = await tool({ role: "planner", task: "plan 8", detached: true }, cwd);
      expect(ro8.success).toBe(true);
      expect(reg.pending()).toHaveLength(8);

      // 9th read-only is blocked at read-only ceiling 8.
      const blockedRo9 = await tool({ role: "planner", task: "plan 9", detached: true }, cwd);
      expect(blockedRo9.success).toBe(false);
      expect(blockedRo9.error).toContain("8 unsettled runs for read-only role");
      expect(reg.pending()).toHaveLength(8);
    } finally {
      reg.cancelAll();
      gate.resolve(VALID_EXECUTOR_DONE);
      await reg.awaitIds(reg.list().map(r => r.id));
      callSpy.mockRestore();
    }
  });

  test("detached launches enforce live 429-backed-off executor limit", async () => {
    const cwd = await makeTempDir();
    const reg = new SubagentRegistry();
    const gate = Promise.withResolvers<string>();
    let now = 5_000;
    const scaler = new SubagentScaler({ subagentExecutorConcurrency: 6 }, { now: () => now });
    scaler.recordRateLimit(false); // halves executor limit 6 -> 3
    const callSpy = spyOn(loop, "callLlm").mockImplementation(() => gate.promise);

    const tool = createTaskTool({
      config: { defaultModel: "ollama/fast", subagents: {}, subagentExecutorConcurrency: 6 },
      registry: reg,
      scaler,
    });

    try {
      for (let i = 1; i <= 3; i++) {
        const res = await tool({ role: "executor", task: `exec ${i}`, detached: true }, cwd);
        expect(res.success).toBe(true);
      }
      const blocked4 = await tool({ role: "executor", task: "exec 4", detached: true }, cwd);
      expect(blocked4.success).toBe(false);
      expect(blocked4.error).toContain("3 unsettled runs for executor role");
    } finally {
      reg.cancelAll();
      gate.resolve(VALID_EXECUTOR_DONE);
      await reg.awaitIds(reg.list().map(r => r.id));
      callSpy.mockRestore();
    }
  });

  test("batch fan-out: rejects 7-task executor batch at cap 6 while running 7-task read-only batch at concurrency 7", async () => {
    const cwd = await makeTempDir();
    const scaler = new SubagentScaler({ subagentConcurrency: 16, subagentExecutorConcurrency: 6 });

    let inFlight = 0;
    let peakInFlight = 0;
    let totalCalls = 0;
    const allSevenEntered = Promise.withResolvers<void>();
    const releaseWave = Promise.withResolvers<void>();

    const callSpy = spyOn(loop, "callLlm").mockImplementation(async () => {
      totalCalls++;
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (inFlight === 7) allSevenEntered.resolve();
      await releaseWave.promise;
      inFlight--;
      return VALID_PLANNER_DONE;
    });

    const tool = createTaskTool({
      config: { defaultModel: "ollama/fast", subagents: {}, subagentConcurrency: 16, subagentExecutorConcurrency: 6 },
      scaler,
    });

    try {
      // 7 executor tasks must be refused BEFORE launching any worker.
      const execBatch = await tool(
        {
          role: "executor",
          tasks: Array.from({ length: 7 }, (_, i) => `edit file ${i + 1}`),
          justification: MEANINGFUL_JUSTIFICATION,
        },
        cwd,
      );
      expect(execBatch.success).toBe(false);
      expect(execBatch.error).toContain("Executor fan-out of 7 exceeds the batch cap of 6");
      expect(totalCalls).toBe(0);

      // 7 read-only planner tasks scale up and execute all 7 concurrently.
      const plannerRun = tool(
        {
          role: "planner",
          tasks: Array.from({ length: 7 }, (_, i) => `analyze module ${i + 1}`),
          justification: MEANINGFUL_JUSTIFICATION,
        },
        cwd,
      );

      await allSevenEntered.promise;
      expect(peakInFlight).toBe(7);
      releaseWave.resolve();

      const plannerRes = await plannerRun;
      expect(plannerRes.success).toBe(true);
      expect(plannerRes.output).toContain("7/7 completed (concurrency 7)");
    } finally {
      releaseWave.resolve();
      callSpy.mockRestore();
    }
  });

  test("batch fan-out: respects expanded executor cap up to 8 and rejects 9", async () => {
    const cwd = await makeTempDir();
    const scaler = new SubagentScaler({ subagentConcurrency: 16, subagentExecutorConcurrency: 8 });
    let inFlight = 0;
    let peakInFlight = 0;
    const allEightEntered = Promise.withResolvers<void>();
    const releaseWave = Promise.withResolvers<void>();

    const callSpy = spyOn(loop, "callLlm").mockImplementation(async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (inFlight === 8) allEightEntered.resolve();
      await releaseWave.promise;
      inFlight--;
      return VALID_EXECUTOR_DONE;
    });

    const tool = createTaskTool({
      config: { defaultModel: "ollama/fast", subagents: {}, subagentConcurrency: 16, subagentExecutorConcurrency: 8 },
      scaler,
    });

    try {
      // 9 executor tasks exceed max executor batch cap of 8.
      const tooWide = await tool(
        {
          role: "executor",
          tasks: Array.from({ length: 9 }, (_, i) => `edit ${i + 1}`),
          justification: MEANINGFUL_JUSTIFICATION,
        },
        cwd,
      );
      expect(tooWide.success).toBe(false);
      expect(tooWide.error).toContain("Executor fan-out of 9 exceeds the batch cap of 8");

      // 8 executor tasks run concurrently when subagentExecutorConcurrency is 8.
      const exec8Run = tool(
        {
          role: "executor",
          tasks: Array.from({ length: 8 }, (_, i) => `edit ${i + 1}`),
          justification: MEANINGFUL_JUSTIFICATION,
        },
        cwd,
      );
      await allEightEntered.promise;
      expect(peakInFlight).toBe(8);
      releaseWave.resolve();

      const exec8Res = await exec8Run;
      expect(exec8Res.success).toBe(true);
      expect(exec8Res.output).toContain("8/8 completed (concurrency 8)");
    } finally {
      releaseWave.resolve();
      callSpy.mockRestore();
    }
  });

  test("batch fan-out: backed-off scaler caps live concurrency for read-only batches", async () => {
    const cwd = await makeTempDir();
    let now = 2_000;
    const scaler = new SubagentScaler({ subagentConcurrency: 16 }, { now: () => now });
    scaler.effectiveLimit(true, 8);
    scaler.recordRateLimit(true); // halves 8 -> 4 and enters cooldown

    let inFlight = 0;
    let peakInFlight = 0;
    const firstWaveFull = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const callSpy = spyOn(loop, "callLlm").mockImplementation(async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (inFlight === 4) firstWaveFull.resolve();
      await release.promise;
      inFlight--;
      return VALID_PLANNER_DONE;
    });

    const tool = createTaskTool({
      config: { defaultModel: "ollama/fast", subagents: {}, subagentConcurrency: 16 },
      scaler,
    });

    try {
      const batchRun = tool(
        {
          role: "planner",
          tasks: Array.from({ length: 8 }, (_, i) => `review ${i + 1}`),
          justification: MEANINGFUL_JUSTIFICATION,
        },
        cwd,
      );

      await firstWaveFull.promise;
      // Give the microtask queue a chance to launch any illegal 5th worker if cap were broken.
      await Promise.resolve();
      await Promise.resolve();
      expect(peakInFlight).toBe(4);

      release.resolve();
      const res = await batchRun;
      expect(res.success).toBe(true);
      expect(peakInFlight).toBe(4);
      expect(res.output).toContain("8/8 completed (concurrency 4)");
    } finally {
      release.resolve();
      callSpy.mockRestore();
    }
  });

  test("runSubagentOnce feeds live 429 rate-limits and post-cooldown successes back into SubagentScaler", async () => {
    const cwd = await makeTempDir();
    let now = 10_000;
    const scaler = new SubagentScaler({ subagentConcurrency: 16 }, { now: () => now });
    const planner = getSubagentRole("planner")!;

    // Scale read-only up to 12 before triggering a real 429 from callLlm.
    expect(scaler.effectiveLimit(true, 12)).toBe(12);

    const rateLimitSpy = spyOn(loop, "callLlm").mockRejectedValue(new Error("HTTP 429 Too Many Requests"));
    try {
      const failed = await runSubagentOnce(planner, "review architecture", "", cwd, {
        config: { defaultModel: "ollama/fast", subagents: {}, subagentConcurrency: 16 },
        scaler,
      });
      expect(failed.success).toBe(false);
      expect(scaler.snapshot()).toMatchObject({
        readOnlyLimit: 6,
        inCooldown: true,
        consecutiveRateLimits: 1,
      });
    } finally {
      rateLimitSpy.mockRestore();
    }

    // Advance clock past 30s cooldown and complete 2 healthy runs -> recovers 6 -> 8.
    now += DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    const okSpy = spyOn(loop, "callLlm").mockResolvedValue(VALID_PLANNER_DONE);
    try {
      const first = await runSubagentOnce(planner, "review part 1", "", cwd, {
        config: { defaultModel: "ollama/fast", subagents: {}, subagentConcurrency: 16 },
        scaler,
      });
      expect(first.success).toBe(true);
      expect(scaler.effectiveLimit(true)).toBe(6);

      const second = await runSubagentOnce(planner, "review part 2", "", cwd, {
        config: { defaultModel: "ollama/fast", subagents: {}, subagentConcurrency: 16 },
        scaler,
      });
      expect(second.success).toBe(true);
      expect(scaler.effectiveLimit(true)).toBe(8);
    } finally {
      okSpy.mockRestore();
    }
  });

  test("evalToolProtocolLine reflects split vs equal role ceilings", () => {
    const split = evalToolProtocolLine({ subagentConcurrency: 16, subagentExecutorConcurrency: 6 });
    expect(split).toContain("up to 16 concurrent for read-only roles, 6 for executor (429-adaptive)");

    const equal = evalToolProtocolLine({ subagentConcurrency: 4 });
    expect(equal).toContain("max 4 concurrent");
  });
});
