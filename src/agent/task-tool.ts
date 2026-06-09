/**
 * `task` tool — lets the interactive agent (and any tool-loop caller) delegate a
 * bounded sub-assignment to one of the bundled subagent roles
 * (executor / planner / architect / critic), mirroring gjc's `task` role-agent
 * surface.
 *
 * The subagent runs its own `runAgentLoop` with a role-specific system prompt,
 * model, step budget, and toolset (read-only roles physically cannot mutate the
 * repo). Subagents are spawned with `subagentToolset(role)`, which never includes
 * `task` itself, so delegation cannot recurse infinitely.
 */
import { runAgentLoop, type ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import type { Message } from "./loop";
import type { Config } from "./state";
import {
  getSubagentRole,
  defaultSubagentRole,
  subagentSystemPrompt,
  subagentToolset,
  resolveSubagentModel,
  resolveSubagentMaxSteps,
  subagentRoleIds,
} from "./subagents";

/** Lifecycle event emitted while a delegated subagent runs. */
export interface TaskSubEvent {
  role: string;
  kind: "start" | "tool" | "done" | "error";
  detail?: string;
  success?: boolean;
}

export interface TaskToolOptions {
  /** Resolves per-role model + step overrides; `defaultModel` is the fallback. */
  config: Pick<Config, "defaultModel" | "subagents">;
  /** Forwarded to the subagent loop so Ctrl-C cancels nested work too. */
  signal?: AbortSignal;
  /** Optional live sink (e.g. plain-stream rendering of nested progress). */
  onEvent?: (ev: TaskSubEvent) => void;
}

/** One-line protocol description appended to the launch system prompt. */
export const TASK_TOOL_PROTOCOL_LINE =
  `task   {role, task, context?}    — delegate a bounded sub-task to a subagent ` +
  `(role: ${subagentRoleIds().join("|")}; executor can edit, planner/architect/critic are read-only). ` +
  `Returns the subagent's findings; integrate them yourself.`;

/**
 * Build a `task` ToolHandler bound to a config + (optional) abort signal. The
 * handler accepts `{ role?, task | prompt | assignment, context? }`.
 */
export function createTaskTool(opts: TaskToolOptions): ToolHandler {
  return async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
    const roleArg = typeof args.role === "string" ? args.role.trim() : "";
    const role = roleArg ? getSubagentRole(roleArg) : defaultSubagentRole();
    if (!role) {
      return {
        success: false,
        output: "",
        error: `Unknown subagent role '${roleArg}'. Valid roles: ${subagentRoleIds().join(", ")}.`,
      };
    }
    const taskText = String(args.task ?? args.prompt ?? args.assignment ?? "").trim();
    if (!taskText) {
      return {
        success: false,
        output: "",
        error: `task tool requires a non-empty 'task' (the sub-assignment). Valid roles: ${subagentRoleIds().join(", ")}.`,
      };
    }
    const contextRaw = typeof args.context === "string" ? args.context.trim() : "";
    const context = contextRaw ? `\n\nContext:\n${contextRaw}` : "";

    const model = resolveSubagentModel(role.id, opts.config);
    const maxSteps = resolveSubagentMaxSteps(role.id, opts.config);
    const history: Message[] = [
      { role: "system", content: subagentSystemPrompt(role) },
      { role: "user", content: `${taskText}${context}` },
    ];

    const trace: string[] = [];
    opts.onEvent?.({ role: role.id, kind: "start", detail: taskText });
    const result = await runAgentLoop(history, {
      cwd,
      model,
      maxSteps,
      signal: opts.signal,
      tools: subagentToolset(role),
      events: {
        onToolResult: (tool, success) => {
          trace.push(`  ${success ? "✓" : "✗"} ${tool}`);
          opts.onEvent?.({ role: role.id, kind: "tool", detail: tool, success });
        },
        onError: msg => opts.onEvent?.({ role: role.id, kind: "error", detail: msg }),
      },
    });
    opts.onEvent?.({ role: role.id, kind: "done", detail: result.doneReason, success: result.done });

    const reason = result.doneReason?.trim() || `(subagent reached the ${result.steps}-step limit without signaling done)`;
    const header = `[${role.title} subagent] ${result.done ? "completed" : "stopped"} in ${result.steps} step(s) on ${model}.`;
    const body = trace.length ? `\nSteps:\n${trace.join("\n")}` : "";
    return { success: result.done, output: `${header}${body}\n\nResult:\n${reason}` };
  };
}
