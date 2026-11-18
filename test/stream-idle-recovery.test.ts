import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, mock, test, vi } from "bun:test";
import { createModelManager, retryableStream, streamIdleMs } from "../src/ai/model-manager";
import type { CallOptions, Message as AiMessage, ProviderAdapter } from "../src/ai/types";
import { runAgentLoop } from "../src/agent/engine";
import type { Message } from "../src/agent/loop";
import { defaultRetryable, isMidStreamIdleError, isStreamIdleError } from "../src/util/retry";
import { readOpsLogSummary } from "../src/util/ops-log";

let tmpConfigDir = "";
const prevConfigDir = process.env.JEO_CONFIG_DIR;
const prevStreamIdle = process.env.JEO_STREAM_IDLE_MS;

beforeEach(() => {
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "jeo-stream-idle-test-"));
  process.env.JEO_CONFIG_DIR = tmpConfigDir;
  delete process.env.JEO_STREAM_IDLE_MS;
});

afterEach(() => {
  mock.restore();
  if (prevConfigDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = prevConfigDir;
  if (prevStreamIdle === undefined) delete process.env.JEO_STREAM_IDLE_MS;
  else process.env.JEO_STREAM_IDLE_MS = prevStreamIdle;
  if (tmpConfigDir) fs.rmSync(tmpConfigDir, { recursive: true, force: true });
});

test("streamIdleMs scales default window by reasoningEffort while honoring JEO_STREAM_IDLE_MS", () => {
  expect(streamIdleMs({})).toBe(300_000);
  expect(streamIdleMs({}, "low")).toBe(300_000);
  expect(streamIdleMs({}, "medium")).toBe(300_000);
  expect(streamIdleMs({}, "high")).toBe(600_000);
  expect(streamIdleMs({}, "xhigh")).toBe(900_000);
  expect(streamIdleMs({ JEO_STREAM_IDLE_MS: "45000" }, "xhigh")).toBe(45_000);
});

test("retryableStream: attempt #2 gets a fresh idleMs window even if caller lastActivityAt was stale from attempt #1", async () => {
  const staleActivityFromAttempt1 = Date.now() - 60_000;
  let attempts = 0;
  const attemptTimings: number[] = [];

  const makeIter = (): AsyncIterator<string> => {
    attempts++;
    const attemptNo = attempts;
    const started = Date.now();
    let idx = 0;
    return {
      next: async () => {
        if (attemptNo === 1) {
          return new Promise<IteratorResult<string>>(() => {});
        }
        if (idx === 0) {
          // Takes 12ms on attempt #2 (well within 40ms idleMs) — previously failed in 0ms!
          await new Promise(r => setTimeout(r, 12));
          attemptTimings.push(Date.now() - started);
          idx++;
          return { value: "ok", done: false };
        }
        return { value: undefined as unknown as string, done: true };
      },
    };
  };

  const out: string[] = [];
  for await (const c of retryableStream(
    makeIter,
    { retries: 2, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable },
    { idleMs: 40, lastActivityAt: () => staleActivityFromAttempt1 },
  )) {
    out.push(c);
  }

  expect(attempts).toBe(2);
  expect(out).toEqual(["ok"]);
  expect(attemptTimings[0]).toBeGreaterThanOrEqual(8);
});

test("createModelManager().stream steps down reasoningEffort across pre-first-chunk stream idle retries and logs ops event", async () => {
  process.env.JEO_STREAM_IDLE_MS = "20";
  const seenEfforts: Array<CallOptions["reasoningEffort"]> = [];

  const fakeAdapter: ProviderAdapter = {
    name: "openai",
    async call() {
      return "unused";
    },
    async *stream(_messages: AiMessage[], opts: CallOptions) {
      seenEfforts.push(opts.reasoningEffort);
      if (seenEfforts.length < 3) {
        await new Promise<void>((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return;
      }
      yield "recovered-chunk";
    },
  };

  const mm = createModelManager(async () => ({
    adapter: fakeAdapter,
    callOptions: {
      model: "gpt-5",
      reasoningEffort: "xhigh",
    },
    credential: { kind: "none", provider: "openai" },
    retry: { retries: 3, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable },
    provider: "openai",
    baseUrl: undefined,
  }));

  const chunks: string[] = [];
  for await (const chunk of mm.stream([{ role: "user", content: "hi" }])) {
    chunks.push(chunk);
  }

  expect(chunks).toEqual(["recovered-chunk"]);
  expect(seenEfforts).toEqual(["xhigh", "high", "medium"]);

  const summary = readOpsLogSummary();
  expect(summary.opsLog.exists).toBe(true);
  expect(summary.recentStreamIdles).toBe(2);
});

test("mid-stream stream idle sets midStreamIdle=true and engine recovers instead of halting turn", async () => {
  let thrownErr: unknown;
  const makeIter = (): AsyncIterator<string> => {
    let idx = 0;
    return {
      next: async () => {
        if (idx++ === 0) return { value: "{\"tool\":", done: false };
        return new Promise<IteratorResult<string>>(() => {});
      },
    };
  };

  try {
    for await (const _ of retryableStream(
      makeIter,
      { retries: 2, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable },
      { idleMs: 15 },
    )) {
      // consume first chunk, stall on second
    }
  } catch (err) {
    thrownErr = err;
  }

  expect(isStreamIdleError(thrownErr)).toBe(true);
  expect(isMidStreamIdleError(thrownErr)).toBe(true);

  process.env.JEO_TRANSIENT_NETWORK_BACKOFF_BASE_MS = "1";
  try {
    let calls = 0;
    const notices: string[] = [];
    const history: Message[] = [
      { role: "system", content: "Core instructions only." },
      { role: "user", content: "run task" },
    ];
    await mock.module("../src/agent/loop", () => ({
      callLlm: async () => {
        calls++;
        if (calls === 1) throw thrownErr;
        return JSON.stringify({ tool: "done", arguments: { reason: "recovered from mid-stream idle" } });
      },
    }));
    const result = await runAgentLoop(history, {
      cwd: process.cwd(),
      maxSteps: 6,
      budget: { maxExtensions: 0 },
      tools: {},
      events: { onNotice: msg => notices.push(msg) },
    });

    expect(result.done).toBe(true);
    expect(result.doneReason).toBe("recovered from mid-stream idle");
    expect(calls).toBe(2);
    expect(notices.some(n => /mid-response provider fault/.test(n) && /auto-retry #1/.test(n))).toBe(true);
  } finally {
    delete process.env.JEO_TRANSIENT_NETWORK_BACKOFF_BASE_MS;
  }
});

test("retryableStream: early consumer break calls iter.return() to close the underlying stream", async () => {
  let returnCalls = 0;
  const makeIter = (): AsyncIterator<string> => {
    let idx = 0;
    return {
      next: async () => {
        idx++;
        if (idx <= 3) return { value: `chunk-${idx}`, done: false };
        return { value: undefined as unknown as string, done: true };
      },
      return: async () => {
        returnCalls++;
        return { value: undefined as unknown as string, done: true };
      },
    };
  };

  const received: string[] = [];
  for await (const chunk of retryableStream(
    makeIter,
    { retries: 1, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable },
    { idleMs: 500 },
  )) {
    received.push(chunk);
    if (received.length === 1) break;
  }

  expect(received).toEqual(["chunk-1"]);
  expect(returnCalls).toBe(1);
});

test("retryableStream: mid-stream iterator error and mid-stream idle both call iter.return() to close the underlying stream", async () => {
  let errReturnCalls = 0;
  let errAttempts = 0;
  const makeErrIter = (): AsyncIterator<string> => {
    errAttempts++;
    let idx = 0;
    return {
      next: async () => {
        if (idx++ === 0) return { value: "first", done: false };
        throw new Error("socket closed mid-stream");
      },
      return: async () => {
        errReturnCalls++;
        return { value: undefined as unknown as string, done: true };
      },
    };
  };

  const received: string[] = [];
  let caughtErr: unknown;
  try {
    for await (const chunk of retryableStream(
      makeErrIter,
      { retries: 3, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable },
      { idleMs: 500 },
    )) {
      received.push(chunk);
    }
  } catch (err) {
    caughtErr = err;
  }

  expect(received).toEqual(["first"]);
  expect(errAttempts).toBe(1);
  expect(errReturnCalls).toBe(1);
  expect((caughtErr as Error).message).toBe("socket closed mid-stream");

  let idleReturnCalls = 0;
  vi.useFakeTimers();
  try {
    const stalledSecondChunk = Promise.withResolvers<IteratorResult<string>>();
    const makeStallIter = (): AsyncIterator<string> => {
      let idx = 0;
      return {
        next: async () => {
          if (idx++ === 0) return { value: "first", done: false };
          return stalledSecondChunk.promise;
        },
        return: async () => {
          idleReturnCalls++;
          return { value: undefined as unknown as string, done: true };
        },
      };
    };

    const stream = retryableStream(
      makeStallIter,
      { retries: 2, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable },
      { idleMs: 50 },
    );
    const first = await stream.next();
    expect(first).toEqual({ value: "first", done: false });

    const secondPromise = stream.next();
    vi.advanceTimersByTime(60);
    let idleErr: unknown;
    try {
      await secondPromise;
    } catch (err) {
      idleErr = err;
    }
    expect(isStreamIdleError(idleErr)).toBe(true);
    expect(isMidStreamIdleError(idleErr)).toBe(true);
    expect(idleReturnCalls).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("retryableStream: 5000-chunk stream succeeds cleanly with idleWatchdog across multiple idle-sized spans without spurious idle errors", async () => {
  vi.useFakeTimers();
  try {
    const startNow = Date.now();
    let onIdleCalls = 0;
    const totalChunks = 5000;
    const makeIter = (): AsyncIterator<string> => {
      let idx = 0;
      return {
        next: async () => {
          if (idx >= totalChunks) return { value: undefined as unknown as string, done: true };
          // Periodically advance fake time by 25ms (< 100ms idleMs) so total elapsed virtual
          // time (9 * 25ms = 225ms) exceeds idleMs without any single gap stalling.
          if (idx > 0 && idx % 500 === 0) {
            vi.advanceTimersByTime(25);
          }
          const value = `c${idx}`;
          idx++;
          return { value, done: false };
        },
      };
    };

    let count = 0;
    let firstChunk: string | undefined;
    let lastChunk: string | undefined;
    for await (const chunk of retryableStream(
      makeIter,
      { retries: 1, baseDelayMs: 1, sleep: async () => {}, isRetryable: defaultRetryable },
      { idleMs: 100, onIdle: () => { onIdleCalls++; } },
    )) {
      if (count === 0) firstChunk = chunk;
      lastChunk = chunk;
      count++;
    }

    expect(count).toBe(totalChunks);
    expect(firstChunk).toBe("c0");
    expect(lastChunk).toBe(`c${totalChunks - 1}`);
    expect(onIdleCalls).toBe(0);
    expect(Date.now() - startNow).toBeGreaterThanOrEqual(225);
  } finally {
    vi.useRealTimers();
  }
});
