/**
 * GoalFlow Base Node, Function Node, and Agent Base Node
 * Pure TypeScript, zero native dependencies.
 */

import type { Message } from "../loop";
import {
  runAgentLoop,
  executorSystemPrompt,
  DEFAULT_TOOLS,
  type AgentLoopOptions,
  type AgentLoopResult,
  type ToolHandler,
  type ToolInvocation,
} from "../engine";
import {
  command,
  InterruptError,
  type ErrorStrategy,
  type NodeOutput,
  type StreamMode,
} from "./types";
import {
  sortMiddlewares,
  type AgentMiddleware,
  type AgentTurnContext,
} from "./middleware";
import type { Checkpointer } from "./checkpointer";

export const START = "__start__";
export const END = "__end__";
export const MAX_LOOP_ITERATIONS = 10;

export interface NodeContext<S = Record<string, unknown>> {
  runId: string;
  threadId: string;
  step: number;
  nodeLevel: number;
  signal?: AbortSignal;
  emit: (mode: StreamMode, data: unknown) => void;
  resumeValue?: unknown;
  checkpointer?: Checkpointer<S>;
}

export abstract class BaseNode<S extends Record<string, unknown>> {
  readonly id: string;
  readonly title?: string;
  readonly nodeType: string;
  errorStrategy: ErrorStrategy;
  defaultValue?: Partial<S>;
  failBranchNodeId?: string;

  constructor(opts: {
    id: string;
    title?: string;
    nodeType?: string;
    errorStrategy?: ErrorStrategy;
    defaultValue?: Partial<S>;
    failBranchNodeId?: string;
  }) {
    this.id = opts.id;
    this.title = opts.title;
    this.nodeType = opts.nodeType ?? "standard";
    this.errorStrategy = opts.errorStrategy ?? "fail";
    this.defaultValue = opts.defaultValue;
    this.failBranchNodeId = opts.failBranchNodeId;
  }

  abstract call(state: S, ctx: NodeContext<S>): Promise<NodeOutput<S>> | NodeOutput<S>;

  /**
   * Framework-managed run lifecycle: emits node_started and node_finished events,
   * handles errorStrategy, and re-throws InterruptError without modification.
   */
  async run(state: S, ctx: NodeContext<S>): Promise<NodeOutput<S>> {
    const start = Date.now();
    ctx.emit("custom", {
      type: "node_started",
      runId: ctx.runId,
      nodeId: this.id,
      title: this.title,
      timestamp: start,
    });

    try {
      const output = await this.call(state, ctx);
      const costMs = Date.now() - start;
      ctx.emit("custom", {
        type: "node_finished",
        runId: ctx.runId,
        nodeId: this.id,
        costMs,
        output,
        timestamp: Date.now(),
      });
      return output;
    } catch (err: unknown) {
      if (err instanceof InterruptError) {
        throw err;
      }

      const costMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);

      if (this.errorStrategy === "default-value") {
        const val = this.defaultValue ?? ({} as Partial<S>);
        ctx.emit("custom", {
          type: "node_finished",
          runId: ctx.runId,
          nodeId: this.id,
          costMs,
          output: val,
          timestamp: Date.now(),
        });
        return val;
      }

      if (this.errorStrategy === "fail-branch") {
        if (this.failBranchNodeId) {
          ctx.emit("custom", {
            type: "node_finished",
            runId: ctx.runId,
            nodeId: this.id,
            costMs,
            output: { error: errMsg },
            timestamp: Date.now(),
          });
          return command<S>({
            goto: [this.failBranchNodeId],
            update: { error: errMsg } as unknown as Partial<S>,
          });
        }
      }

      ctx.emit("custom", {
        type: "error",
        runId: ctx.runId,
        nodeId: this.id,
        error: errMsg,
        timestamp: Date.now(),
      });
      throw err;
    }
  }
}

/**
 * Convenience wrapper over BaseNode for lightweight inline functions.
 */
export class FunctionNode<S extends Record<string, unknown>> extends BaseNode<S> {
  private readonly handler: (state: S, ctx: NodeContext<S>) => Promise<NodeOutput<S>> | NodeOutput<S>;

  constructor(opts: {
    id: string;
    title?: string;
    nodeType?: string;
    errorStrategy?: ErrorStrategy;
    defaultValue?: Partial<S>;
    failBranchNodeId?: string;
    handler?: (state: S, ctx: NodeContext<S>) => Promise<NodeOutput<S>> | NodeOutput<S>;
    run?: (state: S, ctx: NodeContext<S>) => Promise<NodeOutput<S>> | NodeOutput<S>;
  }) {
    super(opts);
    const fn = opts.handler ?? opts.run;
    if (!fn) {
      throw new Error(`FunctionNode '${opts.id}' requires a 'handler' or 'run' function`);
    }
    this.handler = fn;
  }

  call(state: S, ctx: NodeContext<S>): Promise<NodeOutput<S>> | NodeOutput<S> {
    return this.handler(state, ctx);
  }
}

/**
 * AgentBaseNode combines GoalFlow BaseNode with jeo's Karpathy coding core loop
 * (runAgentLoop from ../engine, KARPATHY_DISCIPLINE, StepBudget, loop-guards).
 */
export abstract class AgentBaseNode<
  S extends Record<string, unknown>,
  OutputT = string,
> extends BaseNode<S> {
  readonly middlewares: AgentMiddleware[];
  readonly loopRunner: (history: Message[], opts: AgentLoopOptions) => Promise<AgentLoopResult>;
  readonly cwd?: string | ((state: S) => string);
  readonly model?: string | ((state: S) => string | undefined);
  readonly maxSteps?: number | ((state: S) => number | undefined);
  readonly maxHistoryTokens?: number;
  readonly tools?: Record<string, ToolHandler> | ((state: S) => Record<string, ToolHandler> | undefined);

  constructor(opts: {
    id: string;
    title?: string;
    nodeType?: string;
    errorStrategy?: ErrorStrategy;
    defaultValue?: Partial<S>;
    failBranchNodeId?: string;
    middlewares?: AgentMiddleware[];
    loopRunner?: (history: Message[], opts: AgentLoopOptions) => Promise<AgentLoopResult>;
    cwd?: string | ((state: S) => string);
    model?: string | ((state: S) => string | undefined);
    maxSteps?: number | ((state: S) => number | undefined);
    maxHistoryTokens?: number;
    tools?: Record<string, ToolHandler> | ((state: S) => Record<string, ToolHandler> | undefined);
  }) {
    super({
      id: opts.id,
      title: opts.title,
      nodeType: opts.nodeType ?? "agent",
      errorStrategy: opts.errorStrategy,
      defaultValue: opts.defaultValue,
      failBranchNodeId: opts.failBranchNodeId,
    });
    this.middlewares = opts.middlewares ?? [];
    this.loopRunner = opts.loopRunner ?? runAgentLoop;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.maxSteps = opts.maxSteps;
    this.maxHistoryTokens = opts.maxHistoryTokens;
    this.tools = opts.tools;
  }

  abstract buildPrompt(state: S, ctx: NodeContext<S>): string | Promise<string>;

  buildSystemPrompt?(state: S, ctx: NodeContext<S>): string | Promise<string>;

  buildCommand?(
    state: S,
    output: OutputT,
    loopResult: AgentLoopResult,
  ): NodeOutput<S> | Promise<NodeOutput<S>>;

  async call(state: S, ctx: NodeContext<S>): Promise<NodeOutput<S>> {
    const resolvedCwd =
      typeof this.cwd === "function" ? this.cwd(state) : (this.cwd ?? process.cwd());
    const resolvedModel =
      typeof this.model === "function" ? this.model(state) : this.model;
    const resolvedMaxSteps =
      typeof this.maxSteps === "function" ? this.maxSteps(state) : this.maxSteps;
    const resolvedTools =
      typeof this.tools === "function" ? this.tools(state) : (this.tools ?? DEFAULT_TOOLS);

    const prompt = await this.buildPrompt(state, ctx);
    const systemPrompt = this.buildSystemPrompt
      ? await this.buildSystemPrompt(state, ctx)
      : executorSystemPrompt();

    const turnCtx: AgentTurnContext = {
      runId: ctx.runId,
      threadId: ctx.threadId,
      nodeId: this.id,
      cwd: resolvedCwd,
      prompt,
      systemPrompt,
      model: resolvedModel,
      maxHistoryTokens: this.maxHistoryTokens,
      maxSteps: resolvedMaxSteps,
      tools: resolvedTools,
      metadata: {},
    };

    // Sort middlewares: control tier runs strictly before enhancement tier
    const sortedMiddlewares = sortMiddlewares(this.middlewares);

    for (const mw of sortedMiddlewares) {
      if (mw.beforeTurn) {
        await mw.beforeTurn(turnCtx);
        if (turnCtx.blocked) {
          break;
        }
      }
    }

    if (turnCtx.blocked) {
      ctx.emit("custom", {
        type: "control",
        runId: ctx.runId,
        action: "turn_blocked",
        details: turnCtx.blocked,
        timestamp: Date.now(),
      });

      const fakeResult: AgentLoopResult = {
        done: false,
        steps: 0,
        doneReason: turnCtx.blocked.reason,
      };

      if (this.buildCommand) {
        return await this.buildCommand(state, turnCtx.blocked.reply as OutputT, fakeResult);
      }
      return {
        error: turnCtx.blocked.reason,
        blocked: turnCtx.blocked,
      } as unknown as Partial<S>;
    }

    // Wrap tools with beforeTool checks from middlewares
    const wrappedTools: Record<string, ToolHandler> = {};
    if (resolvedTools) {
      for (const [toolName, handler] of Object.entries(resolvedTools)) {
        wrappedTools[toolName] = async (args, cwd, onProgress, signal) => {
          for (const mw of sortedMiddlewares) {
            if (mw.beforeTool) {
              const check = await mw.beforeTool(toolName, args, turnCtx);
              if (!check.allow) {
                return {
                  success: false,
                  output: "",
                  error: check.reason ?? `Tool '${toolName}' disallowed by middleware '${mw.name}'`,
                };
              }
            }
          }
          return handler(args, cwd, onProgress, signal);
        };
      }
    }

    let prevModelLen = 0;
    let prevReasoningLen = 0;
    const events: AgentLoopOptions["events"] = {
      onModelStream: (textSoFar: string) => {
        const delta = textSoFar.slice(prevModelLen);
        prevModelLen = textSoFar.length;
        if (delta && !textSoFar.trimStart().startsWith("{")) {
          ctx.emit("messages", {
            type: "text_chunk",
            runId: ctx.runId,
            nodeId: this.id,
            text: delta,
            timestamp: Date.now(),
          });
        }
      },
      onReasoningStream: (textSoFar: string) => {
        const delta = textSoFar.slice(prevReasoningLen);
        prevReasoningLen = textSoFar.length;
        if (delta) {
          ctx.emit("messages", {
            type: "reasoning_chunk",
            runId: ctx.runId,
            nodeId: this.id,
            reasoning: delta,
            timestamp: Date.now(),
          });
        }
      },
      onAssistant: (raw: string, invocation: ToolInvocation | null) => {
        const streamedThisStep = prevModelLen > 0;
        prevModelLen = 0;
        prevReasoningLen = 0;

        if (invocation) {
          ctx.emit("custom", {
            type: "tool_call",
            runId: ctx.runId,
            nodeId: this.id,
            tool: invocation.tool,
            args: invocation.arguments,
            timestamp: Date.now(),
          });
          return;
        }

        // Only emit plain prose assistant output, never raw JSON tool-call envelopes
        if (!streamedThisStep && raw && !raw.trimStart().startsWith("{")) {
          ctx.emit("messages", {
            type: "text_chunk",
            runId: ctx.runId,
            nodeId: this.id,
            text: raw,
            timestamp: Date.now(),
          });
        }
      },
      onToolResult: (tool: string, success: boolean, output: string) => {
        if (!success) {
          turnCtx.metadata._metricsToolErrors =
            ((turnCtx.metadata._metricsToolErrors as number) ?? 0) + 1;
        }
        ctx.emit("custom", {
          type: "tool_result",
          runId: ctx.runId,
          nodeId: this.id,
          tool,
          success,
          output,
          timestamp: Date.now(),
        });
      },
    };

    const history: Message[] = [{ role: "user", content: turnCtx.prompt }];

    const loopOpts: AgentLoopOptions = {
      cwd: turnCtx.cwd,
      systemPrompt: turnCtx.systemPrompt,
      model: turnCtx.model,
      maxSteps: turnCtx.maxSteps,
      maxHistoryTokens: turnCtx.maxHistoryTokens,
      tools: wrappedTools,
      signal: ctx.signal,
      events,
    };

    const loopResult = await this.loopRunner(history, loopOpts);

    for (const mw of sortedMiddlewares) {
      if (mw.afterTurn) {
        await mw.afterTurn(turnCtx, loopResult);
      }
    }

    const outputText =
      loopResult.doneReason ??
      (history[history.length - 1]?.role === "assistant" ? history[history.length - 1]?.content : "") ??
      "";

    if (this.buildCommand) {
      return await this.buildCommand(state, outputText as OutputT, loopResult);
    }

    return {
      output: outputText,
      loopResult,
    } as unknown as Partial<S>;
  }
}
