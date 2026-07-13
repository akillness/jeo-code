/**
 * `eval` tool — Dynamic Workflows: lets the interactive agent write actual JS
 * control flow (loops, conditionals, sequential composition) around subagent
 * dispatch, closing the gap `task`'s `tasks[]` batch cannot: `tasks[]` is ONE
 * declarative, single-stage, parallel-only fan-out — no way to pipe one
 * subagent's output into the next, branch on a result, or run N stages with a
 * barrier between them. `eval` exposes exactly three orchestration primitives
 * (`task`, `parallel`, `pipeline` — the shape this harness's own `eval` tool
 * gives the model, so the mental model transfers) plus `log`; nothing else.
 *
 * Trust model (2026 consensus — see the module-level doc below): this is NOT
 * a security sandbox. `node:vm`/`vm2`-style same-process isolation is not a
 * real security boundary (both have known escapes; a genuine one needs a
 * microVM/container, which contradicts jeo's zero-native-deps philosophy).
 * `eval` runs at the SAME trust tier as the `bash` tool — full process
 * access, gated by the identical deep-interview mutation lock. A subagent's
 * own toolset (`subagentToolset`) never includes `eval` (mirrors `task`'s own
 * exclusion), so nested eval-authored recursion cannot occur.
 *
 * WHY A WORKER (not `node:vm` or a bare `AsyncFunction`, which browser-tool.ts's
 * `{action:"run"}` uses): a bare `AsyncFunction` shares jeo's own event loop —
 * a script with a synchronous bug (`while (true) {}`, an unbounded non-yielding
 * loop) blocks that ONE shared thread forever, and `Promise.race([fn(), timeoutPromise])`
 * can NEVER preempt it: the timeout's own callback needs the same blocked
 * loop to fire (verified empirically — see this file's own test coverage).
 * A `Worker` runs on a genuinely separate OS thread; `worker.terminate()`
 * preempts it unconditionally, exactly like `bashTool`'s SIGTERM/SIGKILL
 * escalation on a spawned OS process (spawnTextWithTimeout in tools.ts) —
 * the established hard-timeout pattern this codebase already uses elsewhere,
 * just via a Worker instead of a child process (lighter, same-runtime, and
 * `task`/`parallel`/`pipeline` need no native/OS capability a Worker lacks).
 * The worker has NO live config/credential/network access of its own — every
 * `task()` call it makes crosses back to the main thread over `postMessage` as
 * an RPC request, so config/credentials/`runSubagentOnce` never leave the main
 * thread and every dispatch stays subject to the main thread's own limits
 * (MAX_EVAL_TASK_CALLS' total-call cap, an acquireFanoutSlot/releaseFanoutSlot
 * semaphore capping CONCURRENT dispatches at MAX_FANOUT regardless of whether
 * the script used parallel()/pipeline() or fired N raw task() calls directly,
 * excludedCredentialScopes, the abort signal).
 */
import { assertBashAllowed, type ToolResult } from "./tools";
import type { ToolHandler } from "./engine";
import {
  runSubagentOnce,
  MAX_FANOUT,
  type SubagentTaskConfig,
  type SubagentRunResult,
  type TaskSubEvent,
} from "./task-tool";
import { getSubagentRole, defaultSubagentRole, subagentRoleIds } from "./subagents";
import { loadProjectContext, type ProjectContextFile } from "./context-files";

export interface EvalToolOptions {
  config: SubagentTaskConfig;
  signal?: AbortSignal;
  onEvent?: (ev: TaskSubEvent) => void;
  /** Mid-turn steering drain — forwarded to every `task()` dispatch the script
   *  makes, same contract as TaskToolOptions.steer. */
  steer?: () => string[];
}

/** Structured result `task()` resolves to inside eval-authored code — a
 *  deliberately NARROWER view than the full `SubagentRunResult` (drops the
 *  internal contract/mutation-audit bookkeeping fields that belong to jeo's
 *  own callers, e.g. `team.ts`'s role gate) since orchestration script logic
 *  only needs to branch on "did it work" and "what did it say". */
export interface EvalTaskResult {
  success: boolean;
  output: string;
  error?: string;
}

function toEvalResult(r: SubagentRunResult): EvalTaskResult {
  return r.error ? { success: r.success, output: r.output, error: r.error } : { success: r.success, output: r.output };
}

/** Hard ceiling on how many `task()` dispatches ONE eval call may make.
 *  Enforced ONLY on the main thread's RPC handler (the sole path any dispatch
 *  can take — the worker has no other way to reach `runSubagentOnce`), so a
 *  script cannot bypass it via `parallel()`/`pipeline()`/a bare loop no matter
 *  how it shapes the calls. Generous (workflows genuinely chaining many small
 *  steps are the whole point of this tool) but not unbounded. */
const MAX_EVAL_TASK_CALLS = 40;

/** Hard cap on a single `parallel()`/`pipeline()` call's item-array length
 *  (queue size, not concurrency — both always run at most MAX_FANOUT at once
 *  regardless of how many items are queued behind that). Mirrors
 *  MAX_SERIAL_EXECUTOR's philosophy in task-tool.ts: an eval script is
 *  self-documenting code (unlike a one-shot `tasks[]` JSON batch), so no
 *  justification-string gate is required, but a hard ceiling still exists so
 *  a buggy/malicious loop cannot queue an unbounded batch. */
const MAX_PARALLEL_QUEUE = 20;

/** Wall-clock budget for one `eval` call — mirrors `bashTool`'s own default
 *  timeout philosophy (a runaway script must not block the turn forever).
 *  Overridable per-call via `args.timeoutMs` (capped at the same ceiling
 *  `bashTool` allows) for a script that's genuinely running many sequential
 *  subagent stages. Enforced by `worker.terminate()` — a REAL preemptive
 *  kill, not a same-thread race (see module doc). */
const DEFAULT_EVAL_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_EVAL_TIMEOUT_MS = 1_800_000; // 30 minutes — same outer ceiling as JEO_CALL_TIMEOUT_MS's default

export function evalToolProtocolLine(config?: Pick<import("./state").Config, "subagents">): string {
  return (
    `eval    {code, timeoutMs?}  — Dynamic Workflows: write an async JS function BODY (return value or throw) ` +
    `composing subagent dispatch with REAL control flow (loops/conditionals/sequencing) instead of one static tool call. ` +
    `In scope: task(role, taskText, context?) -> {success, output, error?} runs ONE subagent to completion ` +
    `(role: ${subagentRoleIds(config).join("|")}, same roles as the 'task' tool); ` +
    `parallel(thunks) -> results[] runs an array of () => Promise thunks through a bounded pool (max ${MAX_FANOUT} concurrent, input order kept); ` +
    `pipeline(items, ...stages) -> results[] maps items through one-arg async stages left-to-right with a barrier between stages, each stage itself bounded at ${MAX_FANOUT} concurrent ` +
    `(stage 1 gets the item, later stages get the previous stage's result); log(message) prints a progress line. ` +
    `Runs in an isolated worker with a hard wall-clock timeout (default ${Math.round(DEFAULT_EVAL_TIMEOUT_MS / 1000)}s, override with {timeoutMs} up to ${Math.round(MAX_EVAL_TIMEOUT_MS / 1000)}s). ` +
    `Use this ONLY when the work genuinely needs sequential composition or branching across multiple subagent calls that 'task's tasks[] (single-stage, parallel-only) cannot express — ` +
    `prefer a plain 'task' call for anything that fits in one dispatch. TRUST NOTE: eval runs with the SAME full process access as 'bash' (no sandbox) — gated by the identical interview mutation lock.`
  );
}

// ── Worker bootstrap (runs in the isolated thread) ──────────────────────────
// A fixed, non-user-authored script: the ONLY untrusted input crossing into
// the worker is the `code` string itself, delivered via postMessage (never
// string-interpolated into this bootstrap — avoids any quoting/escaping
// hazard). `task`/`parallel`/`pipeline`/`log` are defined HERE, in the
// worker's own scope, so `parallel`'s thunks and `pipeline`'s stage functions
// (arbitrary closures the script defines) never need to cross the postMessage
// boundary — only `task()`'s plain-data request/response does.
const WORKER_BOOTSTRAP = `
const MAX_FANOUT = ${MAX_FANOUT};
const MAX_PARALLEL_QUEUE = ${MAX_PARALLEL_QUEUE};
let nextReqId = 0;
const pending = new Map();

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === "task_response") {
    const resolver = pending.get(msg.id);
    if (!resolver) return;
    pending.delete(msg.id);
    if (msg.ok) resolver.resolve(msg.result);
    else resolver.reject(new Error(msg.error));
    return;
  }
  if (msg.type !== "run") return;

  const task = (role, taskText, context) => {
    const id = nextReqId++;
    const { promise, resolve, reject } = Promise.withResolvers();
    pending.set(id, { resolve, reject });
    self.postMessage({ type: "task_request", id, role, taskText, context });
    return promise;
  };

  const boundedMap = async (items, fn) => {
    if (!Array.isArray(items)) throw new Error("items must be an array.");
    if (items.length === 0) return [];
    if (items.length > MAX_PARALLEL_QUEUE) {
      throw new Error(\`item array of \${items.length} exceeds the cap of \${MAX_PARALLEL_QUEUE} — split into multiple calls.\`);
    }
    const results = new Array(items.length);
    const limit = Math.min(items.length, MAX_FANOUT);
    let next = 0;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: limit }, () => worker()));
    return results;
  };

  const parallel = (thunks) => {
    if (!Array.isArray(thunks) || thunks.some(t => typeof t !== "function")) {
      throw new Error("parallel(thunks): every element must be a () => Promise function.");
    }
    return boundedMap(thunks, (t) => t());
  };

  const pipeline = async (items, ...stages) => {
    if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages): items must be an array.");
    if (stages.length === 0) return items;
    let current = items;
    for (const stage of stages) {
      if (typeof stage !== "function") throw new Error("pipeline(): every stage must be a function.");
      current = await boundedMap(current, (v) => stage(v));
    }
    return current;
  };

  const log = (message) => {
    self.postMessage({ type: "log", message: typeof message === "string" ? message : JSON.stringify(message) });
  };

  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction("task", "parallel", "pipeline", "log", msg.code);
    const result = await fn(task, parallel, pipeline, log);
    self.postMessage({ type: "done", ok: true, result });
  } catch (e) {
    self.postMessage({ type: "done", ok: false, error: (e && e.message) ? e.message : String(e) });
  }
};
`;

/** One RPC round-trip's shape, as posted by the worker. */
interface TaskRequestMsg {
  type: "task_request";
  id: number;
  role: unknown;
  taskText: unknown;
  context: unknown;
}
interface LogMsg {
  type: "log";
  message: string;
}
interface DoneMsg {
  type: "done";
  ok: boolean;
  result?: unknown;
  error?: string;
}
type WorkerMsg = TaskRequestMsg | LogMsg | DoneMsg;

export function createEvalTool(opts: EvalToolOptions): ToolHandler {
  return async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
    const code = typeof args.code === "string" ? args.code : "";
    if (!code.trim()) {
      return { success: false, output: "", error: `eval requires a non-empty 'code' body (an async function BODY — the last expression or an explicit 'return' becomes the result).` };
    }
    // Same gate bashTool itself opens with — eval carries the identical
    // full-process trust level, so it must never bypass the interview lock a
    // plain bash call would be stopped by.
    try {
      await assertBashAllowed(cwd);
    } catch (e: any) {
      return { success: false, output: "", error: e.message ?? String(e) };
    }

    const timeoutRaw = Number(args.timeoutMs);
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.min(timeoutRaw, MAX_EVAL_TIMEOUT_MS)
      : DEFAULT_EVAL_TIMEOUT_MS;

    const logs: string[] = [];
    let taskCalls = 0;
    // Batch-scoped, shared across every task() dispatch this script makes
    // (sequential or via parallel/pipeline) — mirrors createTaskTool's
    // fan-out batchExcludedScopes: the first dispatch to hit an exhausted
    // OAuth-subscription window saves every later dispatch the same wasted round.
    const excludedCredentialScopes = new Set<string>();
    // Loaded once per eval call, shared by every task() dispatch — mirrors
    // createTaskTool's fan-out batchContext (avoids re-scanning AGENTS.md per
    // subagent when a script dispatches many in sequence/parallel).
    let projectContext: ProjectContextFile[] | undefined;
    // Concurrency chokepoint (distinct from MAX_EVAL_TASK_CALLS' total-count
    // cap above): every task() dispatch — whether made sequentially, via
    // parallel()/pipeline()'s own worker-pool bound, or via N raw concurrent
    // task() calls a script fires directly (bypassing parallel/pipeline
    // entirely, e.g. Promise.all(items.map(i => task(...)))) — passes through
    // this ONE main-thread RPC handler (task_request below), so gating
    // concurrency HERE, not just inside the worker's own boundedMap, is what
    // actually makes "at most MAX_FANOUT concurrent" unbypassable regardless
    // of how the script shapes its calls.
    let inFlight = 0;
    const fanoutQueue: Array<{ entry: () => void; remove: () => void }> = [];
    // `abortSignal` here is `rpcSignal` (settle-aware — see below), NOT
    // `combinedSignal`: a QUEUED (not yet dispatched) request must stop
    // waiting for a slot the instant the tool settles, even though nothing
    // was ever sent to runSubagentOnce for it to cancel.
    const acquireFanoutSlot = (abortSignal: AbortSignal): Promise<void> => {
      if (abortSignal.aborted) return Promise.reject(new Error("eval settled before this task() dispatch reached the front of the queue."));
      if (inFlight < MAX_FANOUT) {
        inFlight++;
        return Promise.resolve();
      }
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const entry = () => { inFlight++; resolve(); };
      const queued = { entry, remove: () => {} };
      const onQueueAbort = () => {
        const idx = fanoutQueue.indexOf(queued);
        if (idx !== -1) fanoutQueue.splice(idx, 1); // still waiting — drop it, never dispatched
        reject(new Error("eval settled while this task() dispatch was still queued."));
      };
      abortSignal.addEventListener("abort", onQueueAbort);
      queued.remove = () => abortSignal.removeEventListener("abort", onQueueAbort);
      fanoutQueue.push(queued);
      return promise.finally(queued.remove);
    };
    const releaseFanoutSlot = (): void => {
      inFlight--;
      const next = fanoutQueue.shift();
      if (next) next.entry();
    };

    const blob = new Blob([WORKER_BOOTSTRAP], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    // Combined signal: EITHER the caller's own abort (Ctrl-C / turn cancel)
    // OR this call's own timeout terminates the worker AND cancels whatever
    // task() dispatch is currently in flight on the main thread — mirrors
    // model-manager.ts's composeAbort (AbortSignal.any is native on the
    // Bun version this CLI enforces; no polyfill needed).
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combinedSignal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutController.signal])
      : timeoutController.signal;

    // Settle-aware signal (v0.8.24 fix): a script that fires `task()` WITHOUT
    // awaiting it (`task("executor", "x"); return "done";`) can have the
    // worker post `done` while that dispatch is still in flight (mid
    // `runSubagentOnce`) OR still queued behind MAX_FANOUT other dispatches.
    // Without this, the tool returns "success" to the model while a REAL
    // subagent keeps running invisibly in the background — burning LLM
    // calls/tokens/mutations whose result is silently discarded, and (for a
    // queued one) potentially never even starting the wait it's blocked on.
    // `rpcSignal` fires on EVERY settlement path (done/error/timeout/abort),
    // strictly BEFORE the tool returns, and is threaded into BOTH
    // acquireFanoutSlot (cancels a QUEUED wait) and runSubagentOnce's own
    // `signal` (cancels an IN-FLIGHT dispatch) — a fire-and-forget task()
    // gets a bounded cancellation instead of an unbounded background tail.
    const rpcSettleController = new AbortController();
    const rpcSignal = AbortSignal.any([combinedSignal, rpcSettleController.signal]);
    const settleRpc = () => rpcSettleController.abort();

    const { promise: donePromise, resolve: resolveDone, reject: rejectDone } = Promise.withResolvers<unknown>();
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      settleRpc();
      worker.terminate();
      rejectDone(new Error(
        opts.signal?.aborted
          ? "eval cancelled."
          : `eval exceeded its ${timeoutMs < 10_000 ? (timeoutMs / 1000).toFixed(1) : Math.round(timeoutMs / 1000)}s timeout (raise via {timeoutMs} up to ${Math.round(MAX_EVAL_TIMEOUT_MS / 1000)}s for a long-running workflow) — the isolated worker was terminated.`
      ));
    };
    combinedSignal.addEventListener("abort", onAbort);
    if (combinedSignal.aborted) onAbort();

    // A response racing a just-terminated worker (e.g. an in-flight
    // runSubagentOnce that was cancelled by settleRpc but still reaches its
    // own catch block a tick later) must never throw and crash the handler —
    // the worker is already gone; the response has nowhere to go.
    const safePostMessage = (msg: Record<string, unknown>): void => {
      try {
        worker.postMessage(msg);
      } catch {
        // worker already terminated — nothing to deliver to.
      }
    };

    worker.onmessage = async (ev: MessageEvent<WorkerMsg>) => {
      const msg = ev.data;
      if (settled) return;
      if (msg.type === "log") {
        logs.push(msg.message);
        opts.onEvent?.({ role: "executor", kind: "step", detail: msg.message });
        return;
      }
      if (msg.type === "done") {
        settled = true;
        settleRpc(); // cancel any fire-and-forget task() still in flight/queued
        if (msg.ok) resolveDone(msg.result);
        else rejectDone(new Error(msg.error));
        return;
      }
      if (msg.type === "task_request") {
        const { id, role: roleArg, taskText, context } = msg;
        try {
          const trimmedTask = typeof taskText === "string" ? taskText.trim() : "";
          if (!trimmedTask) throw new Error("task(role, taskText, context?): taskText must be a non-empty string.");
          const role = typeof roleArg === "string" && roleArg
            ? getSubagentRole(roleArg, opts.config)
            : defaultSubagentRole();
          if (!role) throw new Error(`Unknown subagent role '${String(roleArg)}'. Valid roles: ${subagentRoleIds(opts.config).join(", ")}.`);
          if (taskCalls >= MAX_EVAL_TASK_CALLS) {
            throw new Error(`eval script exceeded the per-call task() dispatch cap (${MAX_EVAL_TASK_CALLS}) — split the workflow across multiple eval calls.`);
          }
          taskCalls++;
          await acquireFanoutSlot(rpcSignal);
          try {
            if (projectContext === undefined) projectContext = await loadProjectContext(cwd);
            const ctxText = typeof context === "string" && context.trim() ? `\n\nContext:\n${context.trim()}` : "";
            const result = await runSubagentOnce(role, trimmedTask, ctxText, cwd, {
              config: opts.config,
              signal: rpcSignal,
              onEvent: opts.onEvent,
              steer: opts.steer,
              projectContext,
              excludedCredentialScopes,
            });
            safePostMessage({ type: "task_response", id, ok: true, result: toEvalResult(result) });
          } finally {
            releaseFanoutSlot();
          }
        } catch (e: any) {
          safePostMessage({ type: "task_response", id, ok: false, error: e?.message ?? String(e) });
        }
      }
    };
    worker.onerror = (ev: ErrorEvent) => {
      if (settled) return;
      settled = true;
      settleRpc();
      rejectDone(new Error(`eval worker crashed: ${ev.message ?? "unknown error"}`));
    };

    worker.postMessage({ type: "run", code });

    try {
      const result = await donePromise;
      const resultText = result === undefined
        ? ""
        : `\n\nReturn value:\n${typeof result === "string" ? result : JSON.stringify(result, null, 2)}`;
      const combined = `${logs.join("\n")}${resultText}`.trim();
      return { success: true, output: combined || "(eval completed with no output and no return value)" };
    } catch (e: any) {
      const combined = logs.length ? `${logs.join("\n")}\n\n` : "";
      return { success: false, output: "", error: `${combined}eval failed: ${e?.message ?? String(e)}` };
    } finally {
      settleRpc(); // backstop — every settlement path above already calls this, idempotent
      clearTimeout(timer);
      combinedSignal.removeEventListener("abort", onAbort);
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  };
}
