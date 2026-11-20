/**
 * GoalFlow Agent Middleware
 * Pure TypeScript, zero native dependencies.
 */

import type { ToolHandler, AgentLoopResult } from "../engine";

export type MiddlewarePhase = "control" | "enhancement";

export interface AgentTurnContext {
  runId: string;
  threadId: string;
  nodeId: string;
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxHistoryTokens?: number;
  maxSteps?: number;
  tools?: Record<string, ToolHandler>;
  metadata: Record<string, unknown>;
  blocked?: { reason: string; reply?: string };
}

export interface AgentMiddleware {
  name: string;
  phase: MiddlewarePhase;
  beforeTurn?(ctx: AgentTurnContext): Promise<void> | void;
  beforeTool?(
    toolName: string,
    args: Record<string, unknown>,
    ctx: AgentTurnContext,
  ): Promise<{ allow: boolean; reason?: string }> | { allow: boolean; reason?: string };
  afterTurn?(ctx: AgentTurnContext, result: AgentLoopResult): Promise<void> | void;
}

export interface TracePayload {
  runId: string;
  nodeId: string;
  model?: string;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  done: boolean;
  stopClass?: string;
  durationMs: number;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Sorts middlewares to guarantee control-tier runs strictly before enhancement-tier.
 * Preserves relative insertion order within each tier.
 */
export function sortMiddlewares(list: AgentMiddleware[]): AgentMiddleware[] {
  const controls = list.filter((m) => m.phase === "control");
  const enhancements = list.filter((m) => m.phase === "enhancement");
  const others = list.filter((m) => m.phase !== "control" && m.phase !== "enhancement");
  return [...controls, ...enhancements, ...others];
}

/**
 * Control-tier middleware: validates input prompt length and non-emptiness before turn starts.
 */
export function createEntryGuardMiddleware(opts?: { maxPromptChars?: number }): AgentMiddleware {
  const maxPromptChars = opts?.maxPromptChars ?? 32_000;
  return {
    name: "entry-guard",
    phase: "control",
    beforeTurn(ctx) {
      if (!ctx.prompt || ctx.prompt.trim().length === 0) {
        ctx.blocked = { reason: "Prompt cannot be empty", reply: "Empty prompt rejected" };
        return;
      }
      if (ctx.prompt.length > maxPromptChars) {
        ctx.blocked = {
          reason: `Prompt exceeds maximum length of ${maxPromptChars} characters (${ctx.prompt.length})`,
          reply: `Prompt size of ${ctx.prompt.length} chars exceeds the limit of ${maxPromptChars}.`,
        };
      }
    },
  };
}

const READONLY_GUARD_EXEMPT_TOOLS = new Set([
  "read",
  "find",
  "search",
  "ls",
  "web_search",
  "calc",
  "jeox",
  "jev_decide",
]);

function shouldCallLiveQev(opts?: { fetchImpl?: typeof fetch; qevUrl?: string }): boolean {
  if (opts?.fetchImpl || opts?.qevUrl) return true;
  if (process.env.JEO_QEV_ROUTER === "0") return false;
  if (process.env.NODE_ENV === "test" && !process.env.JEO_QEV_URL?.trim()) return false;
  return true;
}

/**
 * Control-tier middleware: Jev Runtime Guard queries local qev (System 1) for high-risk tool gating.
 * Fails open cleanly with zero blocking if qev is unreachable or errors.
 */
export function createJevRuntimeGuardMiddleware(opts?: {
  qevUrl?: string;
  enabled?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  riskThreshold?: number;
}): AgentMiddleware {
  const enabled = opts?.enabled ?? true;
  const timeoutMs = opts?.timeoutMs ?? 500;
  const riskThreshold = opts?.riskThreshold ?? 0.8;

  return {
    name: "jev-runtime-guard",
    phase: "control",
    async beforeTurn(ctx) {
      if (!enabled || !shouldCallLiveQev(opts)) return;
      const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
      const qevUrl = opts?.qevUrl || process.env.JEO_QEV_URL || "http://127.0.0.1:8017/v1/systemone";

      try {
        const resp = await fetchFn(qevUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            state: {
              prompt: ctx.prompt.slice(0, 500),
              cwd: ctx.cwd,
            },
            model: "qev-0.8b-text-Q8_0",
            questions: {
              safety: {
                type: "choice",
                instructions: "Determine if this prompt is safe to execute.",
                options: ["0:safe", "1:unsafe"],
              },
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!resp.ok) return;

        const payload = (await resp.json()) as {
          blocked?: boolean;
          reason?: string;
          answers?: { safety?: { choice?: string; probabilities?: Record<string, number> } };
        };

        if (payload.blocked) {
          ctx.blocked = {
            reason: payload.reason ?? "Blocked by Jev Runtime Guard (pre-turn check)",
            reply: payload.reason ?? "Blocked by Jev Runtime Guard",
          };
          return;
        }

        const choice = payload.answers?.safety?.choice;
        const probs = payload.answers?.safety?.probabilities;
        const unsafeProb = probs?.["1:unsafe"] ?? (choice?.includes("1:unsafe") ? 1 : 0);

        if (unsafeProb >= riskThreshold) {
          ctx.blocked = {
            reason: `Blocked by Jev Runtime Guard: high risk prompt detected (${(unsafeProb * 100).toFixed(0)}%)`,
            reply: "Action blocked by security policy.",
          };
        }
      } catch {
        // Fail open cleanly on unreachable / timeout / error
      }
    },

    async beforeTool(toolName, args, ctx) {
      if (!enabled || READONLY_GUARD_EXEMPT_TOOLS.has(toolName) || !shouldCallLiveQev(opts)) {
        return { allow: true };
      }

      const fetchFn = opts?.fetchImpl ?? globalThis.fetch;
      const qevUrl = opts?.qevUrl || process.env.JEO_QEV_URL || "http://127.0.0.1:8017/v1/systemone";
      const cmd = String(args.command ?? args.path ?? args.target ?? "");

      try {
        const resp = await fetchFn(qevUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            state: {
              goal: ctx.prompt.slice(0, 500),
              tool: toolName,
              command: cmd.slice(0, 500),
              cwd: ctx.cwd,
            },
            model: "qev-0.8b-text-Q8_0",
            questions: {
              risk: {
                type: "choice",
                instructions: "Evaluate the risk level of this tool execution. High risk includes destructive system commands or data loss.",
                options: ["0:low_risk", "1:high_risk"],
              },
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!resp.ok) {
          return { allow: true }; // Fail open
        }

        const payload = (await resp.json()) as {
          allow?: boolean;
          blocked?: boolean;
          reason?: string;
          answers?: {
            risk?: { choice?: string; answer?: string; probability?: number; probabilities?: Record<string, number> };
            safe_to_execute?: { answer?: string; probability?: number; confidence?: number };
          };
        };

        if (payload.blocked === true || payload.allow === false) {
          return { allow: false, reason: payload.reason ?? "Blocked by Jev Runtime Guard" };
        }

        const safeAns = payload.answers?.safe_to_execute;
        if (safeAns?.answer === "no" && (safeAns.confidence ?? 1) >= riskThreshold) {
          return {
            allow: false,
            reason: `Blocked by Jev Runtime Guard: unsafe command detected for '${cmd}'`,
          };
        }

        const choice = payload.answers?.risk?.choice;
        const probs = payload.answers?.risk?.probabilities;
        const highRiskProb =
          probs?.["1:high_risk"] ??
          (choice?.includes("1:high_risk") || payload.answers?.risk?.answer === "yes"
            ? (payload.answers?.risk?.probability ?? 1)
            : 0);

        if (highRiskProb >= riskThreshold) {
          return {
            allow: false,
            reason: `Blocked by Jev Runtime Guard: high-risk command detected (${(highRiskProb * 100).toFixed(0)}%) for '${cmd}'`,
          };
        }

        return { allow: true };
      } catch {
        // Fail open cleanly on unreachable / timeout / fetch error
        return { allow: true };
      }
    },
  };
}

/**
 * Enhancement-tier middleware: clamps maxHistoryTokens proportionally for small context windows.
 */
export function createDynamicContextMiddleware(opts?: {
  contextWindow?: number;
  reserveRatio?: number;
}): AgentMiddleware {
  const contextWindow = opts?.contextWindow ?? 16384;
  const reserveRatio = opts?.reserveRatio ?? 0.25;

  return {
    name: "dynamic-context",
    phase: "enhancement",
    beforeTurn(ctx) {
      const targetBudget = Math.floor(contextWindow * (1 - reserveRatio));
      if (!ctx.maxHistoryTokens || ctx.maxHistoryTokens > targetBudget) {
        ctx.maxHistoryTokens = targetBudget;
      }
      ctx.metadata.dynamicContext = {
        contextWindow,
        reserveRatio,
        targetBudget,
      };
    },
  };
}

/**
 * Enhancement-tier middleware: tracks turn steps, duration, tool calls, and reports metrics.
 */
export function createMetricsMiddleware(
  sink?: (metrics: Record<string, unknown>) => void,
): AgentMiddleware {
  return {
    name: "metrics",
    phase: "enhancement",
    beforeTurn(ctx) {
      ctx.metadata._metricsStartTime = Date.now();
      ctx.metadata._metricsToolCalls = 0;
      ctx.metadata._metricsToolErrors = 0;
    },
    beforeTool(toolName, args, ctx) {
      ctx.metadata._metricsToolCalls = ((ctx.metadata._metricsToolCalls as number) ?? 0) + 1;
      return { allow: true };
    },
    afterTurn(ctx, result) {
      const startTime = (ctx.metadata._metricsStartTime as number) ?? Date.now();
      const durationMs = Date.now() - startTime;
      const metrics: Record<string, unknown> = {
        steps: result.steps,
        durationMs,
        toolCalls: ctx.metadata._metricsToolCalls ?? 0,
        toolErrors: ctx.metadata._metricsToolErrors ?? 0,
        usage: result.usage,
        done: result.done,
        doneReason: result.doneReason,
        stopClass: result.stopClass,
      };
      ctx.metadata.metrics = metrics;
      if (sink) {
        sink(metrics);
      }
    },
  };
}

/**
 * Enhancement-tier middleware: emits structured trace payloads to onTrace callback.
 */
export function createTraceCallbackMiddleware(
  onTrace: (trace: TracePayload) => void,
): AgentMiddleware {
  return {
    name: "trace-callback",
    phase: "enhancement",
    afterTurn(ctx, result) {
      const metrics = (ctx.metadata.metrics as Record<string, unknown>) ?? {};
      const durationMs = (metrics.durationMs as number) ?? 0;
      const toolCalls =
        (metrics.toolCalls as number) ?? (ctx.metadata._metricsToolCalls as number) ?? 0;
      const toolErrors =
        (metrics.toolErrors as number) ?? (ctx.metadata._metricsToolErrors as number) ?? 0;

      const trace: TracePayload = {
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        model: ctx.model,
        steps: result.steps,
        toolCalls,
        toolErrors,
        done: result.done,
        stopClass: result.stopClass,
        durationMs,
        usage: result.usage,
      };
      onTrace(trace);
    },
  };
}
