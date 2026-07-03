/**
 * `debug` tool — Node.js debugging via the in-process CDP client in
 * `debug-session.ts` (gjc `debug` parity, Node.js JS/TS ONLY — no Bun target, no
 * DAP wire protocol, no other languages; see that file's header for the full scope
 * statement). MUTATING: runs arbitrary user code as a real OS process, so it is
 * excluded from read-only subagent roles the same way `bash`/`computer` are.
 */
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import { debugSession } from "./debug-session";

/** One-line protocol description appended to the launch system prompt. */
export const DEBUG_TOOL_PROTOCOL_LINE =
  `debug {action, ...} — Node.js debugging (one active session; 'launch' replaces any previous one). ` +
  `launch {program, args?, cwd?} spawns 'node --inspect-brk' and pauses at program start; set_breakpoint ` +
  `{file, line, condition?} / remove_breakpoint {id}; continue / step_over / step_in / step_out / pause resume ` +
  `or step and report the next pause (or program exit); evaluate {expression, frame?}; stack_trace; scopes ` +
  `{frame?} (lists 'type: objectId'); variables {object_id}; threads; output (captured stdout/stderr so far); ` +
  `terminate.`;

function err(message: string): ToolResult {
  return { success: false, output: "", error: message };
}

export function createDebugTool(): ToolHandler {
  return async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
    const action = String(args.action ?? "").trim().toLowerCase();

    if (action === "launch") {
      const program = typeof args.program === "string" ? args.program.trim() : "";
      if (!program) return err(`debug {action:"launch"} requires a non-empty "program".`);
      const scriptArgs = Array.isArray(args.args) ? args.args.map((a: unknown) => String(a)) : [];
      const resolvedCwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : cwd;
      return debugSession.launch(program, scriptArgs, resolvedCwd);
    }

    if (action === "set_breakpoint") {
      const file = typeof args.file === "string" ? args.file.trim() : "";
      if (!file) return err(`debug {action:"set_breakpoint"} requires a non-empty "file".`);
      const line = typeof args.line === "number" ? args.line : parseInt(String(args.line ?? ""), 10);
      if (!Number.isFinite(line) || line < 1) return err(`debug {action:"set_breakpoint"} requires a positive integer "line".`);
      const condition = typeof args.condition === "string" && args.condition.trim() ? args.condition : undefined;
      return debugSession.setBreakpoint(file, line, cwd, condition);
    }

    if (action === "remove_breakpoint") {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return err(`debug {action:"remove_breakpoint"} requires a non-empty "id".`);
      return debugSession.removeBreakpoint(id);
    }

    if (action === "continue") return debugSession.continue();
    if (action === "step_over") return debugSession.stepOver();
    if (action === "step_in") return debugSession.stepIn();
    if (action === "step_out") return debugSession.stepOut();
    if (action === "pause") return debugSession.pause();

    if (action === "evaluate") {
      const expression = typeof args.expression === "string" ? args.expression : "";
      if (!expression.trim()) return err(`debug {action:"evaluate"} requires a non-empty "expression".`);
      const frame = typeof args.frame === "number" ? args.frame : 0;
      return debugSession.evaluate(expression, frame);
    }

    if (action === "stack_trace") return debugSession.stackTrace();

    if (action === "scopes") {
      const frame = typeof args.frame === "number" ? args.frame : 0;
      const res = debugSession.scopes(frame);
      return { success: res.success, output: res.output, error: res.error };
    }

    if (action === "variables") {
      const objectId = typeof args.object_id === "string" ? args.object_id
        : typeof args.objectId === "string" ? args.objectId : "";
      if (!objectId) return err(`debug {action:"variables"} requires a non-empty "object_id" (from a prior 'scopes' call).`);
      return debugSession.variables(objectId);
    }

    if (action === "threads") return debugSession.threads();
    if (action === "output") return { success: true, output: debugSession.output() || "(no output yet)" };
    if (action === "terminate") return debugSession.terminate();

    return err(
      `Unknown debug action '${action}'. Use launch | set_breakpoint | remove_breakpoint | continue | ` +
      `step_over | step_in | step_out | pause | evaluate | stack_trace | scopes | variables | threads | output | terminate.`,
    );
  };
}
