import { test, expect, mock, afterEach } from "bun:test";
import type { Message } from "../src/agent/loop";

afterEach(() => mock.restore());

// ── Cycle guard ────────────────────────────────────────────────────────────
// The exact-repeat guard only sees IDENTICAL consecutive steps. An A↔B
// alternation (re-read one file ↔ re-run one command, forever) dodged it and
// burned the whole budget while the user watched "thinking" never end. The
// cycle guard detects a recent window cycling through ≤2 distinct step
// signatures: one corrective bounce, then a hard stop if the spin persists.

test("cycle guard: an A↔B ping-pong gets ONE corrective bounce, then the model can recover with done", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (history: Message[]) => {
      turn++;
      // After the corrective bounce lands in history, finish cleanly.
      if (history.some(m => m.role === "user" && m.content.includes("You are cycling through the same"))) {
        return JSON.stringify({ tool: "done", arguments: { reason: "recovered from cycle" } });
      }
      // Alternate two distinct calls — never identical consecutively.
      return turn % 2 === 1
        ? JSON.stringify({ tool: "probe", arguments: { which: "A" } })
        : JSON.stringify({ tool: "probe", arguments: { which: "B" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  let probeRuns = 0;
  const history: Message[] = [{ role: "system", content: "sys" }];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 30,
    budget: { maxExtensions: 0 },
    tools: { probe: async () => { probeRuns++; return { success: true, output: "ok" }; } },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("recovered from cycle");
  // The detected cycling step was NOT executed (bounce skips execution).
  expect(probeRuns).toBeLessThan(turn);
  expect(history.some(m => m.content.includes("You are cycling through the same"))).toBe(true);
});

test("cycle guard: a ping-pong that survives the correction stops the turn", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    // Stubborn alternation forever — ignores the corrective bounce.
    callLlm: async () => {
      turn++;
      return turn % 2 === 1
        ? JSON.stringify({ tool: "probe", arguments: { which: "A" } })
        : JSON.stringify({ tool: "probe", arguments: { which: "B" } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const result = await runAgentLoop([{ role: "system", content: "sys" }], {
    cwd: process.cwd(),
    maxSteps: 40,
    budget: { maxExtensions: 0 },
    tools: { probe: async () => ({ success: true, output: "ok" }) },
  });
  expect(result.done).toBe(false);
  expect(result.doneReason).toContain("cycled through the same tool calls");
  expect(result.stopClass).toBe("cycle"); // tagged so the caller can capture the stall into failure memory
  // Stopped by the guard, far before the 40-step budget.
  expect(result.steps).toBeLessThan(20);
});

test("cycle guard: genuinely progressing turns (distinct targets) are never bounced", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      if (turn > 8) return JSON.stringify({ tool: "done", arguments: { reason: "all distinct" } });
      return JSON.stringify({ tool: "probe", arguments: { n: turn } }); // every step distinct
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const history: Message[] = [{ role: "system", content: "sys" }];
  const result = await runAgentLoop(history, {
    cwd: process.cwd(),
    maxSteps: 20,
    budget: { maxExtensions: 0 },
    tools: { probe: async () => ({ success: true, output: "ok" }) },
  });
  expect(result.done).toBe(true);
  expect(result.doneReason).toBe("all distinct");
  expect(history.some(m => m.content.includes("You are cycling through the same"))).toBe(false);
});

// ── Turn wall-clock stall budget ───────────────────────────────────────────
// Step budgets bound the COUNT of model calls; JEO_TURN_MAX_MS bounds the TIME a
// turn may spend WITHOUT PROGRESS (no executed tool step) — the definitive
// "thinking can never spin forever" guarantee. A turn that keeps executing tools
// is NOT killed by the clock (field regression: an absolute 30m budget measured
// from turn start terminated genuinely progressing autonomous runs mid-work).

test("turnMaxMs: defaults to 30 minutes, honors JEO_TURN_MAX_MS, 0 disables", async () => {
  const { turnMaxMs } = await import("../src/agent/engine");
  expect(turnMaxMs({})).toBe(30 * 60 * 1000);
  expect(turnMaxMs({ JEO_TURN_MAX_MS: "5000" })).toBe(5000);
  expect(turnMaxMs({ JEO_TURN_MAX_MS: "0" })).toBe(0);
  expect(turnMaxMs({ JEO_TURN_MAX_MS: "garbage" })).toBe(30 * 60 * 1000);
  expect(turnMaxMs({ JEO_TURN_MAX_MS: "-5" })).toBe(30 * 60 * 1000);
});

test("turn stall budget: a turn that keeps executing tools outlives JEO_TURN_MAX_MS", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      await new Promise(r => setTimeout(r, 25)); // each step costs real wall time
      if (turn > 6) return JSON.stringify({ tool: "done", arguments: { reason: "long run finished" } });
      return JSON.stringify({ tool: "probe", arguments: { n: turn } }); // always novel, always executed
    },
  }));
  const saved = process.env.JEO_TURN_MAX_MS;
  process.env.JEO_TURN_MAX_MS = "60"; // total run (~175ms) far exceeds the budget …
  try {
    const { runAgentLoop } = await import("../src/agent/engine");
    const result = await runAgentLoop([{ role: "system", content: "sys" }], {
      cwd: process.cwd(),
      maxSteps: 10_000,
      tools: { probe: async () => ({ success: true, output: "ok" }) },
    });
    // … but every step executed a tool (progress), so the stall clock never fired.
    expect(result.done).toBe(true);
    expect(result.doneReason).toBe("long run finished");
  } finally {
    if (saved === undefined) delete process.env.JEO_TURN_MAX_MS; else process.env.JEO_TURN_MAX_MS = saved;
  }
});

test("turn stall budget: a spin with NO tool progress consolidates after JEO_TURN_MAX_MS", async () => {
  await mock.module("../src/agent/loop", () => ({
    callLlm: async (_h: Message[], options: { jsonMode?: boolean } = {}) => {
      // The post-budget consolidation call is plain-prose (jsonMode false).
      if (options.jsonMode === false) return "wrap-up: work so far summarized";
      // Every main-step call refuses → the refusal ladder + backoff spin: zero
      // tool executions, so the stall clock keeps ticking from turn start.
      throw new Error("OpenAI returned no content (finish_reason=content_filter)");
    },
  }));
  const savedMax = process.env.JEO_TURN_MAX_MS;
  const savedBackoff = process.env.JEO_REFUSAL_BACKOFF_BASE_MS;
  process.env.JEO_TURN_MAX_MS = "60";
  process.env.JEO_REFUSAL_BACKOFF_BASE_MS = "1"; // keep the rung-4 backoff waits tiny
  try {
    const { runAgentLoop } = await import("../src/agent/engine");
    const result = await runAgentLoop([{ role: "system", content: "sys" }], {
      cwd: process.cwd(),
      maxSteps: 10_000,
      tools: { probe: async () => ({ success: true, output: "ok" }) },
    });
    expect(result.done).toBe(false);
    expect(result.doneReason).toContain("wrap-up: work so far summarized");
    expect(result.doneReason).toContain("turn time budget");
    expect(result.doneReason).toContain("no tool progress");
  } finally {
    if (savedMax === undefined) delete process.env.JEO_TURN_MAX_MS; else process.env.JEO_TURN_MAX_MS = savedMax;
    if (savedBackoff === undefined) delete process.env.JEO_REFUSAL_BACKOFF_BASE_MS; else process.env.JEO_REFUSAL_BACKOFF_BASE_MS = savedBackoff;
  }
});

test("turn stall budget: a model call that NEVER resolves is force-aborted once the remaining budget elapses (real timer interrupt, not just the passive top-of-loop check)", async () => {
  // This is the exact "genuinely forever" hang: the mocked callLlm never settles unless
  // its signal aborts — mirroring a stream stuck in a blocked await with no wall-clock.
  // The passive turnBudgetMs check alone could never catch this (the loop never re-
  // iterates while parked on the await); only a real timer-driven abort can.
  await mock.module("../src/agent/loop", () => ({
    callLlm: (_h: Message[], options: { signal?: AbortSignal } = {}) => new Promise((_resolve, reject) => {
      const signal = options.signal;
      if (!signal) return; // never resolves — would hang the test if the engine had no interrupt
      if (signal.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
      signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
    }),
  }));
  const saved = process.env.JEO_TURN_MAX_MS;
  process.env.JEO_TURN_MAX_MS = "50";
  try {
    const { runAgentLoop } = await import("../src/agent/engine");
    const result = await runAgentLoop([{ role: "system", content: "sys" }], {
      cwd: process.cwd(),
      maxSteps: 10,
      tools: { probe: async () => ({ success: true, output: "ok" }) },
    });
    // Force-aborted, not hung: the turn reports a clear stall outcome.
    expect(result.done).toBe(false);
    expect(result.doneReason).toContain("turn stall budget");
    expect(result.doneReason).toContain("JEO_TURN_MAX_MS");
  } finally {
    if (saved === undefined) delete process.env.JEO_TURN_MAX_MS; else process.env.JEO_TURN_MAX_MS = saved;
  }
}, 5_000); // generous OUTER test timeout — must resolve well under it via the internal timer

test("turn stall budget: the internal interrupt timer is re-armed across a normal multi-step turn and does NOT prematurely abort it (regression guard)", async () => {
  // Each step takes longer than the stall budget on its own, but every step executes a
  // tool (progress resets lastProgressAt, which re-arms the interrupt for the FULL
  // remaining window each time) — so a legitimately long multi-step turn must survive.
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      await new Promise(r => setTimeout(r, 30)); // longer than the 20ms stall budget alone
      if (turn > 4) return JSON.stringify({ tool: "done", arguments: { reason: "multi-step run finished" } });
      return JSON.stringify({ tool: "probe", arguments: { n: turn } });
    },
  }));
  const saved = process.env.JEO_TURN_MAX_MS;
  process.env.JEO_TURN_MAX_MS = "20";
  try {
    const { runAgentLoop } = await import("../src/agent/engine");
    const result = await runAgentLoop([{ role: "system", content: "sys" }], {
      cwd: process.cwd(),
      maxSteps: 10_000,
      tools: { probe: async () => ({ success: true, output: "ok" }) },
    });
    expect(result.done).toBe(true);
    expect(result.doneReason).toBe("multi-step run finished");
  } finally {
    if (saved === undefined) delete process.env.JEO_TURN_MAX_MS; else process.env.JEO_TURN_MAX_MS = saved;
  }
});

// ── Signature hashing (memory bound) ───────────────────────────────────────

test("hashSignature: stable, fixed-size, distinct for distinct inputs", async () => {
  const { hashSignature } = await import("../src/agent/step-budget");
  const big = "write:" + JSON.stringify({ filePath: "a.ts", content: "x".repeat(100_000) });
  const h1 = hashSignature(big);
  expect(h1).toBe(hashSignature(big)); // deterministic
  expect(h1.length).toBeLessThan(20); // fixed-size digest, not the 100k payload
  expect(hashSignature(big + "!")).not.toBe(h1);
  expect(hashSignature("read:{}")).not.toBe(hashSignature("read:{} ")); // whitespace-sensitive
});

// ── stopClass tagging ───────────────────────────────────────────────────────
// A guard-detected dead end is tagged on the result so the caller (launch.ts)
// can capture the stall into failure memory. Distinct from budget/cancel stops.

test("consecutive-failure stop tags result.stopClass = consecutive_failure", async () => {
  let turn = 0;
  await mock.module("../src/agent/loop", () => ({
    callLlm: async () => {
      turn++;
      // Distinct args each step (dodges repeat/cycle guards) but every call fails.
      return JSON.stringify({ tool: "probe", arguments: { n: turn } });
    },
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const result = await runAgentLoop([{ role: "system", content: "sys" }], {
    cwd: process.cwd(),
    maxSteps: 40,
    budget: { maxExtensions: 0 },
    tools: { probe: async () => ({ success: false, output: "boom" }) },
  });
  expect(result.done).toBe(false);
  expect(result.stopClass).toBe("consecutive_failure");
});

test("repeat stop tags result.stopClass = repeat", async () => {
  await mock.module("../src/agent/loop", () => ({
    // The exact same call forever — ignores the corrective bounce.
    callLlm: async () => JSON.stringify({ tool: "probe", arguments: { same: 1 } }),
  }));
  const { runAgentLoop } = await import("../src/agent/engine");
  const result = await runAgentLoop([{ role: "system", content: "sys" }], {
    cwd: process.cwd(),
    maxSteps: 40,
    budget: { maxExtensions: 0 },
    tools: { probe: async () => ({ success: true, output: "ok" }) },
  });
  expect(result.done).toBe(false);
  expect(result.stopClass).toBe("repeat");
});
