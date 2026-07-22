import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import type { JobRegistry, MonitorCategory } from "./job-registry";

/** One-line protocol description appended to the launch system prompt. */
export const MONITOR_TOOL_PROTOCOL_LINE =
  "monitor {command, kind, description, timeout?, persistent?} starts a turn-scoped stdout monitor. " +
  "Each newline-terminated stdout line is a notification; non-persistent monitors stop after the first line. " +
  "Use job {action:\"list\"|\"tail\"|\"await\"|\"cancel\", ids?} with its returned job id to inspect or cancel it.";

const MONITOR_CATEGORIES: readonly MonitorCategory[] = ["log", "poll", "watch", "other"];

export function createMonitorTool(registry: JobRegistry): ToolHandler {
  return async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) {
      return { success: false, output: "", error: "monitor requires a non-empty 'command'." };
    }

    const description = typeof args.description === "string" ? args.description.trim() : "";
    if (!description) {
      return { success: false, output: "", error: "monitor requires a non-empty 'description'." };
    }

    const kind = args.kind;
    if (typeof kind !== "string" || !MONITOR_CATEGORIES.includes(kind as MonitorCategory)) {
      return { success: false, output: "", error: "monitor requires 'kind' to be exactly log, poll, watch, or other." };
    }

    if (args.timeout !== undefined && (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout <= 0)) {
      return { success: false, output: "", error: "monitor 'timeout' must be a finite positive number of seconds." };
    }

    if (args.persistent !== undefined && typeof args.persistent !== "boolean") {
      return { success: false, output: "", error: "monitor 'persistent' must be a boolean." };
    }

    const resolvedCwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : cwd;
    const record = registry.startMonitor(command, resolvedCwd, {
      category: kind as MonitorCategory,
      description,
      persistent: args.persistent ?? false,
      timeout: args.timeout,
    });
    return {
      success: true,
      output: `[monitor] started '${record.id}' (persistent: ${record.persistent}). ` +
        "Use the job tool to inspect, await, or cancel it.",
    };
  };
}
