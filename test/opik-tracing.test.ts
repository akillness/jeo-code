import { test, expect, describe } from "bun:test";
import {
  opikEnabled,
  resolveOpikConfig,
  uuidv7,
  computeScores,
  isVerificationStep,
  buildTracePayload,
  buildSpanPayload,
  buildScorePayload,
  createOpikTracer,
  wrapEvents,
} from "../src/agent/opik-tracer";
import type { AgentLoopEvents } from "../src/agent/engine";

type Env = Record<string, string | undefined>;
const ON: Env = { JEO_OPIK: "1", OPIK_API_KEY: "key-123", COMET_WORKSPACE: "jeo" };

describe("opikEnabled gate (I1)", () => {
  test("off unless explicitly truthy", () => {
    expect(opikEnabled({})).toBe(false);
    expect(opikEnabled({ JEO_OPIK: "0" })).toBe(false);
    expect(opikEnabled({ JEO_OPIK: "false" })).toBe(false);
    expect(opikEnabled({ JEO_OPIK: "" })).toBe(false);
  });
  test("on for 1/true/yes/on (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "On"]) {
      expect(opikEnabled({ JEO_OPIK: v })).toBe(true);
    }
  });
});

describe("resolveOpikConfig", () => {
  test("defaults + trailing-slash normalization", () => {
    const c = resolveOpikConfig({ OPIK_API_KEY: "k", OPIK_URL_OVERRIDE: "https://x/opik/api/" });
    expect(c.baseUrl).toBe("https://x/opik/api");
    expect(c.workspace).toBe("jeo");
    expect(c.projectName).toBe("jeo");
    expect(c.apiKey).toBe("k");
  });
  test("defaults when unset", () => {
    const c = resolveOpikConfig({});
    expect(c.baseUrl).toBe("https://www.comet.com/opik/api");
    expect(c.apiKey).toBeUndefined();
  });
});

describe("uuidv7", () => {
  test("valid v7 shape, time-ordered", () => {
    const a = uuidv7(1000);
    const b = uuidv7(2000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // higher timestamp => lexicographically greater prefix
    expect(b.slice(0, 12) > a.slice(0, 12)).toBe(true);
  });
});

describe("computeScores (eval surface)", () => {
  test("completed + verified flags", () => {
    expect(computeScores({ done: true, steps: 1, verificationRan: true })).toMatchObject({ completed: 1, verified: 1 });
    expect(computeScores({ done: false, steps: 1, verificationRan: false })).toMatchObject({ completed: 0, verified: 0 });
  });
  test("efficiency is 1 at one step and decreases monotonically", () => {
    const e1 = computeScores({ done: true, steps: 1, verificationRan: false }).efficiency;
    const e4 = computeScores({ done: true, steps: 4, verificationRan: false }).efficiency;
    const e16 = computeScores({ done: true, steps: 16, verificationRan: false }).efficiency;
    expect(e1).toBe(1);
    expect(e1).toBeGreaterThan(e4);
    expect(e4).toBeGreaterThan(e16);
    expect(e4).toBeCloseTo(0.5, 4);
  });
  test("steps floored at 1 (no divide-by-zero / NaN)", () => {
    expect(computeScores({ done: true, steps: 0, verificationRan: false }).efficiency).toBe(1);
  });
});

describe("isVerificationStep", () => {
  test("bash + test/tsc/build output is a verification signal", () => {
    expect(isVerificationStep("bash", "bun test passed")).toBe(true);
    expect(isVerificationStep("bash", "running tsc --noEmit")).toBe(true);
    expect(isVerificationStep("bash", "echo hello")).toBe(false);
    expect(isVerificationStep("read", "bun test")).toBe(false);
  });
});

describe("payload builders", () => {
  test("trace payload carries name/input/output/usage", () => {
    const p = buildTracePayload({
      id: "t1",
      project: "jeo",
      meta: { name: "do X", input: "do X please", tags: ["jeo"] },
      startTime: 0,
      endTime: 1000,
      output: "done",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(p.id).toBe("t1");
    expect(p.project_name).toBe("jeo");
    expect(p.name).toBe("do X");
    expect((p.input as any).message).toBe("do X please");
    expect((p.output as any).result).toBe("done");
    expect((p.metadata as any).usage.total_tokens).toBe(15);
  });
  test("span payload links to trace and truncates output", () => {
    const big = "x".repeat(9000);
    const p = buildSpanPayload({
      id: "s1",
      traceId: "t1",
      project: "jeo",
      rec: { step: 2, tool: "bash", success: true, output: big, startTime: 0, endTime: 5 },
    });
    expect(p.trace_id).toBe("t1");
    expect(p.name).toBe("step 2: bash");
    expect((p.output as any).output.length).toBe(4000);
  });
  test("score payload has the three eval metrics", () => {
    const p = buildScorePayload({
      traceId: "t1",
      project: "jeo",
      scores: { completed: 1, verified: 0, efficiency: 0.5 },
    });
    const names = (p.scores as any[]).map(s => s.name).sort();
    expect(names).toEqual(["completed", "efficiency", "verified"]);
    for (const s of p.scores as any[]) {
      expect(s.id).toBe("t1");
      expect(s.source).toBe("sdk");
    }
  });
});

describe("createOpikTracer no-op guarantee (I1)", () => {
  test("disabled => no-op, zero fetch", async () => {
    let calls = 0;
    const fetchSpy = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    const t = createOpikTracer({ name: "x" }, {}, fetchSpy);
    expect(t.enabled).toBe(false);
    t.startTurn();
    t.step({ step: 1, tool: "read", success: true, output: "", startTime: 0, endTime: 1 });
    t.usage({ inputTokens: 1, outputTokens: 1 });
    await t.endTurn({ done: true, steps: 1 });
    expect(calls).toBe(0);
  });
  test("enabled but no API key => no-op", async () => {
    let calls = 0;
    const fetchSpy = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    const t = createOpikTracer({ name: "x" }, { JEO_OPIK: "1" }, fetchSpy);
    expect(t.enabled).toBe(false);
    await t.endTurn({ done: true, steps: 1 });
    expect(calls).toBe(0);
  });
});

describe("createOpikTracer live path (A2/A4)", () => {
  test("emits trace + span + scores exactly once", async () => {
    const seen: { url: string; method: string; body: any }[] = [];
    const fetchSpy = (async (url: any, init: any) => {
      seen.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const t = createOpikTracer({ name: "do X", input: "do X" }, ON, fetchSpy);
    expect(t.enabled).toBe(true);
    t.startTurn();
    t.step({ step: 1, tool: "bash", success: true, output: "bun test ok", startTime: 0, endTime: 5 });
    t.usage({ inputTokens: 100, outputTokens: 40 });
    await t.endTurn({ done: true, steps: 1, output: "finished" });

    const traceCalls = seen.filter(s => s.url.endsWith("/v1/private/traces/batch"));
    const spanCalls = seen.filter(s => s.url.endsWith("/v1/private/spans/batch"));
    const scoreCalls = seen.filter(s => s.url.endsWith("/v1/private/traces/feedback-scores"));
    expect(traceCalls.length).toBe(1);
    expect(spanCalls.length).toBe(1);
    expect(scoreCalls.length).toBe(1);
    expect(scoreCalls[0]!.method).toBe("PUT");
    // verified score is 1 because the bash step output had a test signal
    const verified = (scoreCalls[0]!.body.scores as any[]).find(s => s.name === "verified");
    expect(verified.value).toBe(1);
    expect(traceCalls[0]!.body.traces[0].metadata.usage.total_tokens).toBe(140);
  });
  test("endTurn is idempotent (only one flush)", async () => {
    let calls = 0;
    const fetchSpy = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    const t = createOpikTracer({ name: "x" }, ON, fetchSpy);
    await t.endTurn({ done: true, steps: 1 });
    const after = calls;
    await t.endTurn({ done: true, steps: 1 });
    expect(calls).toBe(after);
  });
  test("thrown fetch is swallowed (A3/I2)", async () => {
    const fetchSpy = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const t = createOpikTracer({ name: "x" }, ON, fetchSpy);
    t.step({ step: 1, tool: "read", success: true, output: "", startTime: 0, endTime: 1 });
    // must not reject
    await expect(t.endTurn({ done: true, steps: 1 })).resolves.toBeUndefined();
  });
  test("Authorization header carries the key; no secret elsewhere (I3)", async () => {
    let authHeader: string | undefined;
    const fetchSpy = (async (_url: any, init: any) => {
      authHeader = init.headers["Authorization"];
      expect(init.headers["Comet-Workspace"]).toBe("jeo");
      return new Response("{}");
    }) as unknown as typeof fetch;
    const t = createOpikTracer({ name: "x" }, ON, fetchSpy);
    await t.endTurn({ done: true, steps: 1 });
    expect(authHeader).toBe("key-123");
  });
});

describe("wrapEvents (composition)", () => {
  test("delegates every original callback and feeds the tracer", () => {
    const order: string[] = [];
    const stepped: number[] = [];
    const base: AgentLoopEvents = {
      onStep: s => { order.push("step"); stepped.push(s); },
      onAssistant: () => order.push("assistant"),
      onToolResult: () => order.push("toolresult"),
      onUsage: () => order.push("usage"),
    };
    const recorded: any[] = [];
    const tracer = {
      enabled: true,
      startTurn() {},
      step: (r: any) => recorded.push(r),
      usage: (u: any) => recorded.push(u),
      async endTurn() {},
    };
    const w = wrapEvents(base, tracer as any);
    w.onStep?.(3);
    w.onAssistant?.("raw", { tool: "bash" });
    w.onToolResult?.("bash", true, "ok");
    w.onUsage?.({ inputTokens: 1, outputTokens: 2 });
    expect(order).toEqual(["step", "assistant", "toolresult", "usage"]);
    expect(stepped).toEqual([3]);
    // tracer saw the tool step (with the current step number) and usage
    expect(recorded.some(r => r.tool === "bash" && r.step === 3)).toBe(true);
    expect(recorded.some(r => r.inputTokens === 1)).toBe(true);
  });
  test("disabled tracer => returns original events untouched", () => {
    const base: AgentLoopEvents = { onStep: () => {} };
    const noop = { enabled: false } as any;
    expect(wrapEvents(base, noop)).toBe(base);
  });
  test("tracer.step throwing never escapes the callback (I2)", () => {
    const base: AgentLoopEvents = { onToolResult: () => {} };
    const tracer = {
      enabled: true,
      startTurn() {},
      step() { throw new Error("boom"); },
      usage() { throw new Error("boom"); },
      async endTurn() {},
    };
    const w = wrapEvents(base, tracer as any);
    expect(() => w.onToolResult?.("bash", true, "x")).not.toThrow();
    expect(() => w.onUsage?.({ inputTokens: 1, outputTokens: 1 })).not.toThrow();
  });
});
