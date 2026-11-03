/**
 * `todo` tool — lets the agent declare and update a structured task plan,
 * mirroring gjc's `todo_write`. The plan is surfaced live in the TUI (a
 * status-colored checklist) so the user can see what the agent intends to do
 * and how far it has progressed.
 *
 * The model resends the full list each call with updated statuses; the tool
 * normalizes loose status strings and auto-promotes the first pending item to
 * `in_progress` when nothing is active yet.
 */
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import { currentSandboxExecution } from "./hooks";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  title: string;
  status: TodoStatus;
}

export interface TodoToolOptions {
  /** Called with the full normalized list whenever it changes (TUI sink). */
  onChange?: (items: TodoItem[]) => void;
}

interface SandboxTodoReply {
  result: ToolResult;
  todos: TodoItem[];
}

function isSandboxTodoReply(value: unknown): value is SandboxTodoReply {
  if (!value || typeof value !== "object") return false;
  const { result, todos } = value as Partial<SandboxTodoReply>;
  return !!result && typeof result.success === "boolean" && typeof result.output === "string" &&
    (result.error === undefined || typeof result.error === "string") && Array.isArray(todos) &&
    todos.every(item => !!item && typeof item.title === "string" &&
      (item.status === "pending" || item.status === "in_progress" || item.status === "done"));
}

/** One-line protocol description appended to the launch system prompt. */
export const TODO_TOOL_PROTOCOL_LINE =
  `todo   {todos:[{title,status}]}  — declare/update your task plan ` +
  `(status: pending|in_progress|done). Resend the FULL list each call, marking progress; ` +
  `keep ≤ ~8 concise items.`;

/** Normalize loose status input to a canonical TodoStatus. */
export function normalizeTodoStatus(input: unknown): TodoStatus {
  const v = String(input ?? "pending").trim().toLowerCase();
  if (v === "in_progress" || v === "in-progress" || v === "active" || v === "doing" || v === "started") return "in_progress";
  if (v === "done" || v === "complete" || v === "completed" || v === "finished") return "done";
  return "pending";
}

/** Parse a loose `todos`/`items` argument into a normalized TodoItem list. */
export function parseTodoItems(args: Record<string, any>): TodoItem[] | null {
  const raw = Array.isArray(args.todos) ? args.todos : Array.isArray(args.items) ? args.items : null;
  if (!raw) return null;
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const t = entry.trim();
      if (t) items.push({ title: t, status: "pending" });
    } else if (entry && typeof entry === "object") {
      const t = String(entry.title ?? entry.task ?? entry.label ?? entry.content ?? "").trim();
      if (t) items.push({ title: t, status: normalizeTodoStatus(entry.status) });
    }
  }
  if (!items.length) return null;
  // Auto-promote: keep exactly one logical focus when the model forgets to mark one.
  if (!items.some(i => i.status === "in_progress")) {
    const firstPending = items.find(i => i.status === "pending");
    if (firstPending) firstPending.status = "in_progress";
  }
  return items;
}

/** Render the plan as a plain checklist (used in tool output fed back to the model). */
export function renderTodoChecklist(items: TodoItem[]): string {
  return items
    .map(i => `  [${i.status === "done" ? "x" : i.status === "in_progress" ? ">" : " "}] ${i.title}`)
    .join("\n");
}

/** Build a `todo` ToolHandler. Maintains the current list in a closure. */
export function createTodoTool(opts: TodoToolOptions = {}): ToolHandler {
  let current: TodoItem[] = [];
  return async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
    const sandbox = currentSandboxExecution();
    if (sandbox) {
      const response = await sandbox.supervisor.call("__workflow", { operation: "todo", args }, { cwd, signal: sandbox.signal });
      if (!response.success) return response;
      const reply: unknown = JSON.parse(response.output);
      if (!isSandboxTodoReply(reply)) throw new Error("SANDBOX_TODO: invalid guest response");
      // Parent callback is presentation only; normalization and plan mutation ran in hands.
      if (reply.result.success) opts.onChange?.(reply.todos);
      return {
        success: reply.result.success,
        output: reply.result.output,
        ...(reply.result.error !== undefined ? { error: reply.result.error } : {}),
      };
    }
    const items = parseTodoItems(args);
    if (!items) {
      return {
        success: false,
        output: "",
        error: "todo tool requires 'todos' (array of {title, status}) or 'items' (array of strings).",
      };
    }
    current = items;
    opts.onChange?.(current);
    const done = items.filter(i => i.status === "done").length;
    return { success: true, output: `Plan updated (${done}/${items.length} done):\n${renderTodoChecklist(items)}` };
  };
}
