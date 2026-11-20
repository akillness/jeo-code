/**
 * GoalFlow Graph Engine
 * StateGraph, CompiledWorkflow, fan-out/fan-in barriers, loop-cap, HITL interrupt & resume.
 * Pure TypeScript, zero native dependencies.
 */

import * as crypto from "node:crypto";
import {
  isCommand,
  isSend,
  InterruptError,
  type NodeOutput,
  type ReviewDecision,
  type ReviewRecord,
  type Send,
  type StreamTuple,
  type CheckpointRecord,
  type RunStatus,
} from "./types";
import {
  START,
  END,
  MAX_LOOP_ITERATIONS,
  type BaseNode,
  type NodeContext,
} from "./node";
import type { Checkpointer } from "./checkpointer";

class AsyncTupleQueue {
  private readonly buffer: StreamTuple[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(tuple: StreamTuple): void {
    if (this.closed) return;
    this.buffer.push(tuple);
    if (this.waiter) {
      const wake = this.waiter;
      this.waiter = null;
      wake();
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const wake = this.waiter;
      this.waiter = null;
      wake();
    }
  }

  async *drain(): AsyncGenerator<StreamTuple> {
    while (true) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  const count = Math.min(limit, items.length);
  const workers = Array.from({ length: count }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface ConditionalEdgeConfig<S> {
  routerFn: (state: S) => string | string[] | Promise<string | string[]>;
  pathMap?: Record<string, string>;
}

export type StateReducers<S> = {
  [K in keyof S as string extends K
    ? never
    : number extends K
      ? never
      : symbol extends K
        ? never
        : K]?: (prev: S[K], next: S[K]) => S[K];
};

export interface CompileOptions<S = Record<string, unknown>> {
  name?: string;
  recursionLimit?: number;
  maxConcurrency?: number;
  reducers?: StateReducers<S>;
}

export class CompiledWorkflow<S extends Record<string, unknown>> {
  readonly name: string;
  readonly recursionLimit: number;
  readonly maxConcurrency: number;
  private readonly nodes: Map<string, BaseNode<S>>;
  private readonly edges: Map<string, string>;
  private readonly conditionalEdges: Map<string, ConditionalEdgeConfig<S>>;
  private readonly nodeLevels: Map<string, number>;
  private readonly reducers?: StateReducers<S>;

  constructor(opts: {
    name: string;
    nodes: Map<string, BaseNode<S>>;
    edges: Map<string, string>;
    conditionalEdges: Map<string, ConditionalEdgeConfig<S>>;
    recursionLimit?: number;
    maxConcurrency?: number;
    reducers?: StateReducers<S>;
  }) {
    this.name = opts.name;
    this.nodes = opts.nodes;
    this.edges = opts.edges;
    this.conditionalEdges = opts.conditionalEdges;
    this.recursionLimit = opts.recursionLimit ?? 50;
    this.maxConcurrency = opts.maxConcurrency ?? 6;
    this.reducers = opts.reducers;
    this.nodeLevels = this.computeNodeLevels();
  }

  private mergeState(current: S, patch: Partial<S>): S {
    if (!this.reducers) {
      return { ...current, ...patch };
    }
    const next: S = { ...current };
    const reducerMap = this.reducers as Record<
      string,
      ((prev: unknown, next: unknown) => unknown) | undefined
    >;
    for (const key of Object.keys(patch) as Array<keyof S>) {
      const reducer = reducerMap[String(key)];
      const nextVal = patch[key] as S[keyof S];
      if (reducer && key in current) {
        next[key] = reducer(current[key], nextVal) as S[keyof S];
      } else {
        next[key] = nextVal;
      }
    }
    return next;
  }

  private computeNodeLevels(): Map<string, number> {
    const levels = new Map<string, number>();
    const queue: Array<{ id: string; level: number }> = [];

    const startTarget = this.edges.get(START);
    if (startTarget && this.nodes.has(startTarget)) {
      levels.set(startTarget, 0);
      queue.push({ id: startTarget, level: 0 });
    } else {
      for (const id of this.nodes.keys()) {
        levels.set(id, 0);
        queue.push({ id, level: 0 });
        break;
      }
    }

    const maxHops = this.nodes.size * 2;
    let hops = 0;

    while (queue.length > 0 && hops < maxHops) {
      hops++;
      const item = queue.shift()!;
      const currentLevel = item.level;

      const direct = this.edges.get(item.id);
      if (direct && direct !== END && this.nodes.has(direct)) {
        const nextLevel = currentLevel + 1;
        const cur = levels.get(direct);
        if (cur === undefined || nextLevel > cur) {
          levels.set(direct, nextLevel);
          queue.push({ id: direct, level: nextLevel });
        }
      }

      const cond = this.conditionalEdges.get(item.id);
      if (cond?.pathMap) {
        for (const target of Object.values(cond.pathMap)) {
          if (target !== END && this.nodes.has(target)) {
            const nextLevel = currentLevel + 1;
            const cur = levels.get(target);
            if (cur === undefined || nextLevel > cur) {
              levels.set(target, nextLevel);
              queue.push({ id: target, level: nextLevel });
            }
          }
        }
      }
    }

    for (const id of this.nodes.keys()) {
      if (!levels.has(id)) {
        levels.set(id, 0);
      }
    }

    return levels;
  }

  getNode(id: string): BaseNode<S> | undefined {
    return this.nodes.get(id);
  }

  /**
   * Resumes a paused/interrupted workflow run from its last checkpoint.
   * Passes resumeValue ONLY to the paused node, and continues downstream WITHOUT re-running completed upstream nodes!
   */
  async *resume(
    runId: string,
    review: { decision: ReviewDecision; input?: string; feedback?: string },
    opts: { checkpointer: Checkpointer<S>; signal?: AbortSignal },
  ): AsyncGenerator<StreamTuple> {
    const record = await opts.checkpointer.load(runId);
    if (!record) {
      throw new Error(`Checkpoint not found for runId '${runId}'`);
    }
    if (record.status !== "interrupted") {
      throw new Error(`Cannot resume workflow in status '${record.status}'. Expected 'interrupted'.`);
    }
    if (!record.currentNodeId) {
      throw new Error(`Cannot resume workflow: currentNodeId is missing.`);
    }

    const reviewRecord: ReviewRecord = {
      interruptId: record.pendingInterrupt?.interruptId ?? crypto.randomUUID(),
      nodeId: record.currentNodeId,
      decision: review.decision,
      input: review.input,
      feedback: review.feedback,
      decidedAt: new Date().toISOString(),
    };

    const updatedReviews = [...(record.reviews ?? []), reviewRecord];
    record.reviews = updatedReviews;
    record.pendingInterrupt = undefined;
    record.status = "running";
    record.updatedAt = new Date().toISOString();
    await opts.checkpointer.save(record);

    yield* this.streamInternal(record.state, {
      runId: record.runId,
      threadId: record.threadId,
      checkpointer: opts.checkpointer,
      signal: opts.signal,
      initialActiveNodes: [record.currentNodeId],
      completedNodes: new Set(record.completedNodes),
      initialCycleCounts: record.nodeCycleCounts,
      reviews: updatedReviews,
      resumeValue: reviewRecord,
      resumeNodeId: record.currentNodeId,
      step: record.step,
      createdAt: record.createdAt,
    });
  }

  async *stream(
    initialState: S,
    opts?: {
      runId?: string;
      threadId?: string;
      checkpointer?: Checkpointer<S>;
      signal?: AbortSignal;
    },
  ): AsyncGenerator<StreamTuple> {
    let startNodeId: string | undefined;

    if (this.edges.has(START)) {
      startNodeId = this.edges.get(START);
    } else if (this.conditionalEdges.has(START)) {
      const cond = this.conditionalEdges.get(START)!;
      const res = await cond.routerFn(initialState);
      const target = Array.isArray(res) ? res[0] : res;
      startNodeId = cond.pathMap?.[target] ?? target;
    } else {
      for (const id of this.nodes.keys()) {
        startNodeId = id;
        break;
      }
    }

    if (!startNodeId || !this.nodes.has(startNodeId)) {
      throw new Error("Cannot stream workflow: no entry node found from START.");
    }

    yield* this.streamInternal(initialState, {
      runId: opts?.runId,
      threadId: opts?.threadId,
      checkpointer: opts?.checkpointer,
      signal: opts?.signal,
      initialActiveNodes: [startNodeId],
      completedNodes: new Set<string>(),
      reviews: [],
      step: 0,
      createdAt: new Date().toISOString(),
    });
  }

  private async *streamInternal(
    initialState: S,
    params: {
      runId?: string;
      threadId?: string;
      checkpointer?: Checkpointer<S>;
      signal?: AbortSignal;
      initialActiveNodes: string[];
      completedNodes: Set<string>;
      initialCycleCounts?: Record<string, number>;
      reviews: ReviewRecord[];
      resumeValue?: unknown;
      resumeNodeId?: string;
      step: number;
      createdAt: string;
      onCheckpoint?: (record: CheckpointRecord<S>) => void;
    },
  ): AsyncGenerator<StreamTuple> {
    const runId = params.runId ?? crypto.randomUUID();
    const threadId = params.threadId ?? crypto.randomUUID();

    let state: S = { ...initialState };
    const completedNodes = new Set(params.completedNodes);
    const reviews = [...params.reviews];
    let step = params.step;
    const createdAt = params.createdAt;
    let activeNodes = [...params.initialActiveNodes];
    let pendingSends: Send[] = [];
    const nodeCycleCounts = new Map<string, number>(
      Object.entries(params.initialCycleCounts ?? {}),
    );
    // Decrement by 1 for the resumed node so resuming a paused node does not double-count its interrupted attempt
    if (params.resumeNodeId && nodeCycleCounts.has(params.resumeNodeId)) {
      const prev = nodeCycleCounts.get(params.resumeNodeId)!;
      if (prev > 0) nodeCycleCounts.set(params.resumeNodeId, prev - 1);
    }

    let currentResumeValue = params.resumeValue;
    let currentResumeNodeId = params.resumeNodeId;

    const startTime = Date.now();

    yield {
      mode: "custom",
      nodeId: START,
      data: {
        type: "workflow_started",
        runId,
        workflowName: this.name,
        timestamp: startTime,
      },
      timestamp: startTime,
    };

    const saveCheckpoint = async (
      status: RunStatus,
      currentNodeId: string | null,
      pendingInterrupt?: InterruptError["payload"],
      error?: string,
      output?: string,
    ): Promise<CheckpointRecord<S>> => {
      const record: CheckpointRecord<S> = {
        runId,
        threadId,
        workflowName: this.name,
        status,
        state: { ...state },
        currentNodeId,
        step,
        completedNodes: Array.from(completedNodes),
        nodeCycleCounts: Object.fromEntries(nodeCycleCounts),
        pendingInterrupt,
        reviews: [...reviews],
        output,
        error,
        createdAt,
        updatedAt: new Date().toISOString(),
      };
      params.onCheckpoint?.(record);
      if (params.checkpointer) {
        await params.checkpointer.save(record);
      }
      return record;
    };

    while (activeNodes.length > 0 || pendingSends.length > 0) {
      step++;
      const currentNodeIdRef = activeNodes[0] ?? pendingSends[0]?.node ?? null;

      if (params.signal?.aborted) {
        await saveCheckpoint("cancelled", currentNodeIdRef);
        yield {
          mode: "custom",
          nodeId: currentNodeIdRef ?? START,
          data: {
            type: "workflow_finished",
            runId,
            status: "cancelled",
            costMs: Date.now() - startTime,
            timestamp: Date.now(),
          },
          timestamp: Date.now(),
        };
        return;
      }

      if (step > this.recursionLimit) {
        const err = `Recursion limit of ${this.recursionLimit} exceeded in workflow '${this.name}'`;
        await saveCheckpoint("failed", currentNodeIdRef, undefined, err);
        yield {
          mode: "custom",
          nodeId: currentNodeIdRef ?? START,
          data: {
            type: "error",
            runId,
            nodeId: currentNodeIdRef ?? undefined,
            error: err,
            timestamp: Date.now(),
          },
          timestamp: Date.now(),
        };
        yield {
          mode: "custom",
          nodeId: currentNodeIdRef ?? START,
          data: {
            type: "workflow_finished",
            runId,
            status: "failed",
            costMs: Date.now() - startTime,
            timestamp: Date.now(),
          },
          timestamp: Date.now(),
        };
        return;
      }

      // Check node cycle count (MAX_LOOP_ITERATIONS = 10 per node)
      for (const nid of activeNodes) {
        const count = (nodeCycleCounts.get(nid) ?? 0) + 1;
        nodeCycleCounts.set(nid, count);
        if (count > MAX_LOOP_ITERATIONS) {
          const loopErr = `Loop iteration limit of ${MAX_LOOP_ITERATIONS} exceeded for node '${nid}'`;
          await saveCheckpoint("failed", nid, undefined, loopErr);
          yield {
            mode: "custom",
            nodeId: nid,
            data: {
              type: "error",
              runId,
              nodeId: nid,
              error: loopErr,
              timestamp: Date.now(),
            },
            timestamp: Date.now(),
          };
          yield {
            mode: "custom",
            nodeId: nid,
            data: {
              type: "workflow_finished",
              runId,
              status: "failed",
              costMs: Date.now() - startTime,
              timestamp: Date.now(),
            },
            timestamp: Date.now(),
          };
          return;
        }
      }

      type StepNodeExecutionResult = {
        nodeId: string;
        output?: NodeOutput<S>;
        interrupt?: InterruptError;
        error?: unknown;
      };

      type TaskItem = {
        node: BaseNode<S>;
        stateOverride?: S;
      };

      const tasksToRun: TaskItem[] = [
        ...activeNodes
          .map((nid) => this.nodes.get(nid))
          .filter((n): n is BaseNode<S> => Boolean(n))
          .map((node) => ({ node })),
        ...pendingSends
          .map((s) => {
            const node = this.nodes.get(s.node);
            return node
              ? { node, stateOverride: { ...state, ...s.payload } as S }
              : null;
          })
          .filter((t): t is NonNullable<typeof t> => t !== null),
      ];

      // Real-time streaming queue: yield tuples live as nodes emit them rather than blocking until wave completion
      const liveQueue = new AsyncTupleQueue();
      const wavePromise = mapConcurrent(
        tasksToRun,
        this.maxConcurrency,
        async (task): Promise<StepNodeExecutionResult> => {
          const { node, stateOverride } = task;
          const isTargetOfResume = currentResumeNodeId === node.id;
          const nodeContext: NodeContext<S> = {
            runId,
            threadId,
            step,
            nodeLevel: this.nodeLevels.get(node.id) ?? 0,
            signal: params.signal,
            resumeValue: isTargetOfResume ? currentResumeValue : undefined,
            checkpointer: params.checkpointer,
            emit: (mode, data) => {
              liveQueue.push({
                mode,
                nodeId: node.id,
                data,
                timestamp: Date.now(),
              });
            },
          };

          try {
            const out = await node.run(stateOverride ?? state, nodeContext);
            return { nodeId: node.id, output: out };
          } catch (err: unknown) {
            if (err instanceof InterruptError) {
              return { nodeId: node.id, interrupt: err };
            }
            return { nodeId: node.id, error: err };
          }
        },
      ).finally(() => liveQueue.close());

      for await (const tuple of liveQueue.drain()) {
        yield tuple;
      }
      const results = await wavePromise;

      if (currentResumeNodeId) {
        currentResumeValue = undefined;
        currentResumeNodeId = undefined;
      }

      // Apply any completed sibling outputs before handling an interrupt in the same wave
      const completedResults = results.filter((r) => !r.interrupt && !r.error);
      const interruptedResult = results.find((r) => r.interrupt !== undefined);
      if (interruptedResult && interruptedResult.interrupt) {
        for (const r of completedResults) {
          completedNodes.add(r.nodeId);
          if (isCommand<S>(r.output) && r.output.update) {
            state = this.mergeState(state, r.output.update);
          } else if (r.output && typeof r.output === "object" && !Array.isArray(r.output)) {
            state = this.mergeState(state, r.output as Partial<S>);
          }
        }
        const payload = interruptedResult.interrupt.payload;
        await saveCheckpoint("interrupted", interruptedResult.nodeId, payload);
        yield {
          mode: "custom",
          nodeId: interruptedResult.nodeId,
          data: {
            type: "interrupt",
            runId,
            payload,
            timestamp: Date.now(),
          },
          timestamp: Date.now(),
        };
        yield {
          mode: "custom",
          nodeId: interruptedResult.nodeId,
          data: {
            type: "workflow_finished",
            runId,
            status: "interrupted",
            costMs: Date.now() - startTime,
            timestamp: Date.now(),
          },
          timestamp: Date.now(),
        };
        return;
      }

      // Check for unhandled node error
      const failedResult = results.find((r) => r.error !== undefined);
      if (failedResult && failedResult.error) {
        const errObj = failedResult.error;
        const errMsg = errObj instanceof Error ? errObj.message : String(errObj);
        await saveCheckpoint("failed", failedResult.nodeId, undefined, errMsg);
        yield {
          mode: "custom",
          nodeId: failedResult.nodeId,
          data: {
            type: "error",
            runId,
            nodeId: failedResult.nodeId,
            error: errMsg,
            timestamp: Date.now(),
          },
          timestamp: Date.now(),
        };
        yield {
          mode: "custom",
          nodeId: failedResult.nodeId,
          data: {
            type: "workflow_finished",
            runId,
            status: "failed",
            costMs: Date.now() - startTime,
            timestamp: Date.now(),
          },
          timestamp: Date.now(),
        };
        return;
      }

      // Process outputs and resolve next active nodes
      const nextActiveSet = new Set<string>();
      const nextSends: Send[] = [];

      for (const r of results) {
        completedNodes.add(r.nodeId);
        const out = r.output;

        if (isCommand<S>(out)) {
          if (out.update) {
            state = this.mergeState(state, out.update);
          }
          if (out.goto) {
            const targets = Array.isArray(out.goto) ? out.goto : [out.goto];
            for (const t of targets) {
              if (t && t !== END) nextActiveSet.add(t);
            }
          }
        } else if (Array.isArray(out)) {
          if (out.length > 0 && isSend(out[0])) {
            const sends = out as unknown as Send[];
            for (const s of sends) {
              if (s.node && s.node !== END) {
                nextSends.push(s);
              }
            }
          } else {
            const targets = out as string[];
            for (const t of targets) {
              if (t && t !== END) nextActiveSet.add(t);
            }
          }
        } else if (out && typeof out === "object") {
          state = this.mergeState(state, out as Partial<S>);
          await this.routeNext(r.nodeId, state, nextActiveSet);
        } else {
          await this.routeNext(r.nodeId, state, nextActiveSet);
        }
      }

      // Fan-in barrier: deduplicated nextActiveSet + explicit Send[] fan-out wave
      activeNodes = Array.from(nextActiveSet);
      pendingSends = nextSends;
    }

    // Workflow completed
    const finalOutput =
      (state as Record<string, unknown>).finalOutput ?? (state as Record<string, unknown>).output;
    const outputStr = typeof finalOutput === "string" ? finalOutput : undefined;
    await saveCheckpoint("completed", null, undefined, undefined, outputStr);

    yield {
      mode: "custom",
      nodeId: END,
      data: {
        type: "workflow_finished",
        runId,
        status: "completed",
        output: finalOutput,
        costMs: Date.now() - startTime,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    };
  }

  private async routeNext(nodeId: string, state: S, nextActiveSet: Set<string>): Promise<void> {
    const cond = this.conditionalEdges.get(nodeId);
    if (cond) {
      const res = await cond.routerFn(state);
      const targets = Array.isArray(res) ? res : [res];
      for (const t of targets) {
        const mapped = cond.pathMap?.[t] ?? t;
        if (mapped && mapped !== END) {
          nextActiveSet.add(mapped);
        }
      }
      return;
    }

    const direct = this.edges.get(nodeId);
    if (direct && direct !== END) {
      nextActiveSet.add(direct);
    }
  }

  async run(
    initialState: S,
    opts?: {
      runId?: string;
      threadId?: string;
      checkpointer?: Checkpointer<S>;
      signal?: AbortSignal;
    },
  ): Promise<CheckpointRecord<S>> {
    const runId = opts?.runId ?? crypto.randomUUID();
    let capturedCheckpoint: CheckpointRecord<S> | undefined;

    let startNodeId: string | undefined;
    if (this.edges.has(START)) {
      startNodeId = this.edges.get(START);
    } else if (this.conditionalEdges.has(START)) {
      const cond = this.conditionalEdges.get(START)!;
      const res = await cond.routerFn(initialState);
      const target = Array.isArray(res) ? res[0] : res;
      startNodeId = cond.pathMap?.[target] ?? target;
    } else {
      for (const id of this.nodes.keys()) {
        startNodeId = id;
        break;
      }
    }
    if (!startNodeId || !this.nodes.has(startNodeId)) {
      throw new Error("Cannot run workflow: no entry node found from START.");
    }

    for await (const _ of this.streamInternal(initialState, {
      runId,
      threadId: opts?.threadId,
      checkpointer: opts?.checkpointer,
      signal: opts?.signal,
      initialActiveNodes: [startNodeId],
      completedNodes: new Set<string>(),
      reviews: [],
      step: 0,
      createdAt: new Date().toISOString(),
      onCheckpoint: (record) => {
        capturedCheckpoint = record;
      },
    })) {
      // Drain stream
    }

    if (opts?.checkpointer) {
      const loaded = await opts.checkpointer.load(runId);
      if (loaded) return loaded;
    }
    if (!capturedCheckpoint) {
      throw new Error(`Workflow '${this.name}' ended without producing a checkpoint.`);
    }
    return capturedCheckpoint;
  }
}

/**
 * StateGraph Builder for GoalFlow workflows.
 */
export class StateGraph<S extends Record<string, unknown>> {
  private readonly nodes = new Map<string, BaseNode<S>>();
  private readonly edges = new Map<string, string>();
  private readonly conditionalEdges = new Map<string, ConditionalEdgeConfig<S>>();

  addNode(node: BaseNode<S>): this {
    if (this.nodes.has(node.id)) {
      throw new Error(`Node with id '${node.id}' already exists in StateGraph.`);
    }
    this.nodes.set(node.id, node);
    return this;
  }

  addEdge(from: string, to: string): this {
    this.edges.set(from, to);
    return this;
  }

  addConditionalEdges(
    from: string,
    routerFn: (state: S) => string | string[] | Promise<string | string[]>,
    pathMap?: Record<string, string>,
  ): this {
    this.conditionalEdges.set(from, { routerFn, pathMap });
    return this;
  }

  compile(opts?: CompileOptions<S>): CompiledWorkflow<S> {
    return new CompiledWorkflow<S>({
      name: opts?.name ?? "default_workflow",
      nodes: new Map(this.nodes),
      edges: new Map(this.edges),
      conditionalEdges: new Map(this.conditionalEdges),
      recursionLimit: opts?.recursionLimit,
      maxConcurrency: opts?.maxConcurrency,
      reducers: opts?.reducers,
    });
  }
}
