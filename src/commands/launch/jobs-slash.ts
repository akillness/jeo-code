import { createJobTool } from "../../agent/job-tool";
import type { JobRegistry } from "../../agent/job-registry";

export type JobsSlashLogger = (lines: string[]) => void;

/** Run the interactive `/jobs` view over the launch session's existing registry. */
export async function runJobsSlash(
  input: string,
  registry: JobRegistry,
  cwd: string,
  logLines: JobsSlashLogger = lines => console.log(lines.join("\n")),
): Promise<void> {
  const tokens = input.trim().split(/\s+/).filter(Boolean).slice(1);
  const action = (tokens.shift() ?? "list").toLowerCase();
  const args: Record<string, unknown> = { action };

  if (action === "start") {
    const command = tokens.join(" ").trim();
    if (!command) {
      logLines(["Usage: /jobs start <command>"]);
      return;
    }
    args.command = command;
  } else if (action === "list") {
    if (tokens.length > 0) {
      logLines(["Usage: /jobs [list|tail|await|cancel] [job-id ...]"]);
      return;
    }
  } else if (action === "tail" || action === "cancel" || action === "await") {
    const ids: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token === "--timeout-ms" || token === "--timeout") {
        const value = Number(tokens[++index]);
        if (!Number.isFinite(value) || value <= 0) {
          logLines([`Invalid timeout '${tokens[index] ?? ""}'. Use a positive number of milliseconds.`]);
          return;
        }
        args.timeoutMs = value;
        continue;
      }
      if (token.startsWith("--timeout-ms=") || token.startsWith("--timeout=")) {
        const value = Number(token.slice(token.indexOf("=") + 1));
        if (!Number.isFinite(value) || value <= 0) {
          logLines([`Invalid timeout '${token}'. Use a positive number of milliseconds.`]);
          return;
        }
        args.timeoutMs = value;
        continue;
      }
      if (token.startsWith("--")) {
        logLines([`Unknown /jobs option '${token}'.`]);
        return;
      }
      ids.push(token);
    }
    if (ids.length > 0) args.ids = ids;
  } else {
    logLines([`Unknown /jobs action '${action}'. Use list | tail | await | cancel.`]);
    return;
  }

  const result = await createJobTool(registry)(args, cwd);
  if (result.output) logLines(result.output.split("\n"));
  if (!result.success && result.error) logLines([`! ${result.error}`]);
}
