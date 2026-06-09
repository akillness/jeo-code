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

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  title: string;
  status: TodoStatus;
}

export interface TodoToolOptions {
  /** Called with the full normalized list whenever it changes (TUI sink). */
  onChange?: (items: TodoItem[]) => void;
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
  return async (args: Record<string, any>): Promise<ToolResult> => {
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
