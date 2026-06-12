import { test, expect, mock } from "bun:test";
import { StepBudget, DYNAMIC_HARD_CAP, dynamicStepBudgetConfig, resolveStepBudgetConfig } from "../src/agent/step-budget";

// ---------- unit: config resolution ----------

test("resolveStepBudgetConfig: defaults derive from the base budget", () => {
  const cfg = resolveStepBudgetConfig(20, {});
  expect(cfg.baseSteps).toBe(20);
  expect(cfg.extensionSteps).toBe(10); // ceil(20/2)
  expect(cfg.maxExtensions).toBe(2);
  expect(cfg.hardCap).toBe(60); // base * 3
  expect(cfg.windowSize).toBe(8);
});

test("resolveStepBudgetConfig: env vars tune the flow and are clamped", () => {
  const cfg = resolveStepBudgetConfig(10, {
    JEO_STEP_EXTENSIONS: "99", // clamped to 8
    JEO_STEP_EXTENSION_SIZE: "5",
    JEO_STEP_HARD_CAP: "4", // below base → raised to base
    JEO_STEP_WINDOW: "1", // below min → raised to 2
  });
  expect(cfg.maxExtensions).toBe(8);
  expect(cfg.extensionSteps).toBe(5);
  expect(cfg.hardCap).toBe(10);
  expect(cfg.windowSize).toBe(2);
});

test("resolveStepBudgetConfig: caller overrides beat env (bounded delegation)", () => {
  const cfg = resolveStepBudgetConfig(10, { JEO_STEP_EXTENSIONS: "5" }, { maxExtensions: 0 });
  expect(cfg.maxExtensions).toBe(0);
});

// ---------- unit: extension decisions ----------

const baseCfg = resolveStepBudgetConfig(4, {});

test("StepBudget: extends on a progressing window (ok ratio + distinct targets)", () => {
  const b = new StepBudget({ ...baseCfg, extensionSteps: 3, maxExtensions: 2, hardCap: 12 });
  b.record("read:a", true);
  b.record("read:b", true);
  b.record("bash:test", false);
  b.record("edit:c", true);
  const d = b.tryExtend();
  expect(d.extend).toBe(true);
  expect(d.limit).toBe(7); // 4 + 3
  expect(d.reason).toContain("progress detected");
  expect(b.extensionsUsed()).toBe(1);
});

test("StepBudget: declines when the window is mostly failures (fail-fast)", () => {
  const b = new StepBudget(baseCfg);
  b.record("bash:a", false);
  b.record("bash:b", false);
  b.record("read:c", true);
  const d = b.tryExtend();
  expect(d.extend).toBe(false);
  expect(d.reason).toContain("no recent progress");
  expect(b.limit()).toBe(4);
});

test("StepBudget: declines a single-signature spin even when it succeeds", () => {
  const b = new StepBudget(baseCfg);
  b.record("find:same", true);
  b.record("find:same", true);
  b.record("find:same", true);
  const d = b.tryExtend();
  expect(d.extend).toBe(false);
  expect(d.reason).toContain("distinct");
});

test("StepBudget: respects maxExtensions and the hard cap", () => {
  const b = new StepBudget({ ...baseCfg, extensionSteps: 10, maxExtensions: 3, hardCap: 9 });
  b.record("read:a", true);
  b.record("read:b", true);
  // First extension is clamped at the hard cap…
  expect(b.tryExtend()).toMatchObject({ extend: true, limit: 9 });
  // …after which the cap declines further extensions even with budget left.
  const d = b.tryExtend();
  expect(d.extend).toBe(false);
  expect(d.reason).toContain("hard step cap");

  const c = new StepBudget({ ...baseCfg, extensionSteps: 1, maxExtensions: 1, hardCap: 99 });
  c.record("read:a", true);
  c.record("read:b", true);
  expect(c.tryExtend().extend).toBe(true);
  const d2 = c.tryExtend();
  expect(d2.extend).toBe(false);
  expect(d2.reason).toContain("extension budget exhausted");
});

test("StepBudget: maxExtensions 0 restores the legacy fixed counter", () => {
  const b = new StepBudget({ ...baseCfg, maxExtensions: 0 });
  b.record("read:a", true);
  b.record("read:b", true);
  const d = b.tryExtend();
  expect(d.extend).toBe(false);
  expect(d.reason).toContain("disabled");
});

// ---------- integration: engine retry flow ----------

test("runAgentLoop: a progressing turn extends past maxSteps and completes (gjc retry flow)", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      // 5 distinct successful tool calls, then done — base budget is only 3.
      if (calls <= 5) return JSON.stringify({ tool: "work", arguments: { n: calls } });
      return JSON.stringify({ tool: "done", arguments: { reason: "finished after extension" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const budgets: { limit: number; reason: string }[] = [];
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 3,
    budget: { maxExtensions: 2, extensionSteps: 4, hardCap: 12 },
    tools: { work: async () => ({ success: true, output: "ok" }) },
    events: { onBudget: (limit, reason) => budgets.push({ limit, reason }) },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("finished after extension");
  expect(result.steps).toBe(6); // past the base budget of 3
  expect(budgets.length).toBe(1);
  expect(budgets[0]!.limit).toBe(7);
  expect(budgets[0]!.reason).toContain("step budget extended to 7");
});

test("runAgentLoop: a stalled turn does NOT extend — consolidates at the base budget", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_h: unknown, options: { jsonMode?: boolean }) => {
      if (options?.jsonMode === false) return "wrap-up: nothing worked";
      calls++;
      // Distinct but ALWAYS-FAILING calls (kept under the consecutive-failure guard
      // by alternating one success of the same repeated signature).
      if (calls % 4 === 0) return JSON.stringify({ tool: "ok", arguments: {} });
      return JSON.stringify({ tool: "boom", arguments: { n: calls } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const budgets: number[] = [];
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 6,
    budget: { maxExtensions: 2, extensionSteps: 4, hardCap: 18, minProgressRatio: 0.5 },
    tools: {
      boom: async () => ({ success: false, output: "", error: "broken" }),
      ok: async () => ({ success: true, output: "fine" }),
    },
    events: { onBudget: limit => budgets.push(limit) },
  });
  expect(result.done).toBe(false);
  expect(budgets).toEqual([]); // never extended
  expect(result.steps).toBe(6); // stopped at the base budget
  expect(result.doneReason).toContain("no recent progress");
});

test("runAgentLoop: extensions stop at the hard cap and the wrap-up names the flow", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_h: unknown, options: { jsonMode?: boolean }) => {
      if (options?.jsonMode === false) return "consolidated state";
      calls++;
      return JSON.stringify({ tool: "work", arguments: { n: calls } }); // never done
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const budgets: number[] = [];
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 2,
    budget: { maxExtensions: 8, extensionSteps: 2, hardCap: 6 },
    tools: { work: async () => ({ success: true, output: "ok" }) },
    events: { onBudget: limit => budgets.push(limit) },
  });
  expect(result.done).toBe(false);
  expect(budgets).toEqual([4, 6]); // two extensions up to the cap, never past it
  expect(result.steps).toBe(6);
  expect(result.doneReason).toContain("step budget of 6 reached after 2 extension(s)");
  expect(result.doneReason).toContain("hard step cap 6 reached");
});

// ---------- unit: dynamic (process-driven) budget ----------

test("dynamicStepBudgetConfig: no small hardcoded ceiling — unlimited extensions, large safety cap", () => {
  const cfg = dynamicStepBudgetConfig({});
  expect(cfg.baseSteps).toBe(24);
  expect(cfg.maxExtensions).toBe(Number.POSITIVE_INFINITY);
  expect(cfg.hardCap).toBe(DYNAMIC_HARD_CAP); // termination guarantee, not a 100-step stop
});

test("dynamicStepBudgetConfig: env restores a bounded budget; caller overrides win", () => {
  const bounded = dynamicStepBudgetConfig({ JEO_STEP_BASE: "10", JEO_STEP_EXTENSIONS: "1", JEO_STEP_HARD_CAP: "12" });
  expect(bounded.baseSteps).toBe(10);
  expect(bounded.maxExtensions).toBe(1);
  expect(bounded.hardCap).toBe(12);
  const overridden = dynamicStepBudgetConfig({}, { maxExtensions: 0 });
  expect(overridden.maxExtensions).toBe(0);
});

test("StepBudget: a dynamic budget keeps extending while NOVEL progress continues", () => {
  const b = new StepBudget(dynamicStepBudgetConfig({}, { baseSteps: 2, extensionSteps: 3 }));
  b.record("read:a", true);
  for (let i = 1; i <= 50; i++) {
    // Each extension requires at least one never-seen signature (anti-cycling rule).
    b.record(`read:${i}`, true);
    const d = b.tryExtend();
    expect(d.extend).toBe(true);
    expect(d.limit).toBe(2 + 3 * i);
  }
  expect(b.extensionsUsed()).toBe(50);
  // Merely cycling previously-seen calls earns no further extension.
  b.record("read:a", true);
  b.record("read:1", true);
  const spin = b.tryExtend();
  expect(spin.extend).toBe(false);
  expect(spin.reason).toContain("novel");
});

test("runAgentLoop: dynamic budget (maxSteps 0) never stops a progressing turn at a hardcoded count", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      calls++;
      // 12 distinct successful tool calls — far past the 3-step rolling base — then done.
      if (calls <= 12) return JSON.stringify({ tool: "work", arguments: { n: calls } });
      return JSON.stringify({ tool: "done", arguments: { reason: "finished organically" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const budgets: number[] = [];
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 0, // dynamic: the process decides when the turn ends, not a count
    budget: { baseSteps: 3, extensionSteps: 2, windowSize: 4 },
    tools: { work: async () => ({ success: true, output: "ok" }) },
    events: { onBudget: limit => budgets.push(limit) },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("finished organically");
  expect(result.steps).toBe(13);
  expect(budgets).toEqual([5, 7, 9, 11, 13]); // extensions kept flowing while progressing
});

test("runAgentLoop: dynamic budget consolidates a wrap-up when progress stalls (never runs forever)", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_h: unknown, options: { jsonMode?: boolean }) => {
      if (options?.jsonMode === false) return "dynamic wrap-up: stalled state collected";
      calls++;
      // Distinct but mostly-failing calls (one repeated-ok every 4th keeps the
      // consecutive-failure guard from tripping first).
      if (calls % 4 === 0) return JSON.stringify({ tool: "ok", arguments: {} });
      return JSON.stringify({ tool: "boom", arguments: { n: calls } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const budgets: number[] = [];
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 0, // dynamic
    budget: { baseSteps: 6, extensionSteps: 4, windowSize: 8 },
    tools: {
      boom: async () => ({ success: false, output: "", error: "broken" }),
      ok: async () => ({ success: true, output: "fine" }),
    },
    events: { onBudget: limit => budgets.push(limit) },
  });
  expect(result.done).toBe(false);
  expect(budgets).toEqual([]); // a stalled window earns no extension even unbounded
  expect(result.steps).toBe(6); // stopped at the rolling base, not at a hardcoded 100
  expect(result.doneReason).toContain("dynamic wrap-up: stalled state collected");
  expect(result.doneReason).toContain("no recent progress");
});
test("StepBudget: the dynamic safety cap terminates even an always-novel turn", () => {
  const b = new StepBudget(dynamicStepBudgetConfig({}, { baseSteps: 2, extensionSteps: 100 }));
  let novel = 0;
  for (let i = 0; i < 1000; i++) {
    b.record(`read:novel-${novel++}`, true);
    b.record(`read:novel-${novel++}`, true);
    const d = b.tryExtend();
    if (!d.extend) {
      expect(d.reason).toContain("hard step cap");
      expect(d.limit).toBe(DYNAMIC_HARD_CAP);
      return;
    }
  }
  throw new Error("dynamic budget never hit its safety cap");
});

test("runAgentLoop: dynamic budget terminates a model that cycles two successful calls forever", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_h: unknown, options: { jsonMode?: boolean }) => {
      if (options?.jsonMode === false) return "cycle wrap-up";
      calls++;
      // Infinite A↔B ping-pong of always-successful identical calls: passes the
      // ok-ratio AND distinct checks — before the novelty rule this looped forever.
      return JSON.stringify({ tool: "read", arguments: { f: calls % 2 === 0 ? "a" : "b" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const budgets: number[] = [];
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 0, // dynamic
    budget: { baseSteps: 3, extensionSteps: 2, windowSize: 4 },
    tools: { read: async () => ({ success: true, output: "data" }) },
    events: { onBudget: limit => budgets.push(limit) },
  });
  expect(result.done).toBe(false);
  expect(budgets).toEqual([5]); // one extension while a/b were still novel, then never again
  expect(result.steps).toBe(5);
  expect(result.doneReason).toContain("no novel tool calls");
  expect(calls).toBeLessThan(10); // terminated promptly, not at the 600-step cap
});

test("runAgentLoop: a mostly-failing batch with one trivial success earns no extension (per-call scoring)", async () => {
  let calls = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_h: unknown, options: { jsonMode?: boolean }) => {
      if (options?.jsonMode === false) return "batch wrap-up";
      calls++;
      // Each step: one always-ok read + two always-failing NOVEL calls. Scored per
      // BATCH this looked like a 100%-ok progressing window and extended forever;
      // scored per CALL the window ok-ratio is ~1/3 and the extension declines.
      return JSON.stringify({
        tools: [
          { tool: "read", arguments: { f: "same" } },
          { tool: "boom", arguments: { n: calls * 2 } },
          { tool: "boom", arguments: { n: calls * 2 + 1 } },
        ],
      });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const budgets: number[] = [];
  const result = await runAgentLoop([{ role: "user", content: "go" }], {
    cwd: process.cwd(),
    maxSteps: 0, // dynamic
    budget: { baseSteps: 3, extensionSteps: 4, windowSize: 8 },
    tools: {
      read: async () => ({ success: true, output: "data" }),
      boom: async () => ({ success: false, output: "", error: "broken" }),
    },
    events: { onBudget: limit => budgets.push(limit) },
  });
  expect(result.done).toBe(false);
  expect(budgets).toEqual([]); // never extended
  expect(result.steps).toBe(3); // stopped at the rolling base
  expect(result.doneReason).toContain("no recent progress");
});
