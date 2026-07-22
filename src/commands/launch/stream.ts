import chalk from "chalk";
import { type AgentLoopEvents } from "../../agent/engine";
import { type TaskSubEvent } from "../../agent/task-tool";
import { type MonitorJobEvent } from "../../agent/job-registry";
import { categoryBadge } from "../../tui/components/category-index";
import { summarizeForgeInvocation } from "../../tui/components/forge";
import { formatDuration, formatUsage } from "../../tui/components/duration";
import { LaunchTui } from "../../tui/app";

const GATED_OUTPUT_METHODS = new Set(["write", "cursorTo", "moveCursor", "clearLine", "clearScreenDown", "_write", "_writev"]);
export function gatedStdout(real: NodeJS.WriteStream, gated: () => boolean): NodeJS.WriteStream {
  return new Proxy(real, {
    get(target, prop, _receiver) {
      if (typeof prop === "string" && GATED_OUTPUT_METHODS.has(prop)) {
        return (...args: any[]) => {
          if (gated()) {
            const cb = args[args.length - 1]; // honor readline's write callback so it never stalls
            if (typeof cb === "function") cb();
            return true;
          }
          return (target as any)[prop](...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as NodeJS.WriteStream;
}

function firstOutputLine(output: string | undefined): string {
  if (!output) return "";
  const line = String(output)
    .split("\n")
    .map(l => l.trim())
    .find(l => l.length > 0);
  return line ? line.replace(/\s+/g, " ").slice(0, 140) : "";
}

function streamResultSuffix(tool: string, ok: boolean, output: string | undefined): string {
  const summary = firstOutputLine(output);
  if (!summary) return "";
  if (!ok || tool === "task") return ` — ${summary}`;
  return "";
}

export function formatTaskSubEvent(e: TaskSubEvent): string {
  const role = e.role || "subagent";
  const detachedLabel = e.detached && e.id ? ` [${e.id}]` : "";
  const roleLabel = `${e.index && e.total ? `${role.toUpperCase()}[${e.index}/${e.total}]` : role.toUpperCase()}${detachedLabel}`;
  const tokTag = e.tokens ? ` (${e.tokens.input + e.tokens.output} tok)` : "";
  const detail = firstOutputLine(e.detail);
  const summary = e.summary ? ` — ${e.summary}` : "";
  const badge = categoryBadge("subagent");
  if (e.kind === "start") return `${badge} ${chalk.magenta(`▸ ${roleLabel}`)} · ${detail}`.slice(0, 240);
  if (e.kind === "step") return `  ${badge} ${chalk.cyan(`├─ ${roleLabel}`)} · ${detail || "working"}`;
  if (e.kind === "tool") return `  ${badge} ${e.success === false ? chalk.red("├─") : chalk.green("├─")} ${roleLabel} ${e.success === false ? chalk.red("✗") : chalk.green("✓")} ${detail || "tool"}${summary}`;
  if (e.kind === "error") return `  ${badge} ${chalk.red("├─")} ${roleLabel} ${chalk.red("✗")} ${detail || "error"}`;
  // "thinking" is a live-only TUI preview (never persisted to the ledger — see
  // TaskSubEvent.kind's doc comment) and has no place in an append-only, non-TTY
  // log stream: a reasoning delta stream would otherwise fall through to the
  // "done" branch below and print a bogus "ROLE done: <reasoning text>" line for
  // every emitted preview. Empty string signals the caller to skip the line.
  if (e.kind === "thinking") return "";
  return `${badge} ${e.success === false ? chalk.red("└─") : chalk.green("└─")} ${roleLabel} done${tokTag}${e.success === false ? " (incomplete)" : ""}${detail ? `: ${detail}` : ""}`;
}

export function logTaskSubEvent(e: TaskSubEvent, log: (line: string) => void = (s: string) => console.log(s)): void {
  const line = formatTaskSubEvent(e);
  if (line) log(line);
}
export function formatMonitorJobEvent(e: MonitorJobEvent): string {
  const label = `${e.record.id} · ${e.record.category} · ${e.record.description}`;
  if (e.type === "start") return `${categoryBadge("progress")} ${chalk.cyan("monitor ▸")} ${label}`.slice(0, 240);
  if (e.type === "line") {
    const line = firstOutputLine(e.line);
    return `${categoryBadge("progress")} ${chalk.cyan("monitor │")} ${label}${line ? ` — ${line}` : ""}`.slice(0, 240);
  }
  return `${categoryBadge("progress")} ${chalk.cyan("monitor └")} ${label} ${chalk.dim("done")}`.slice(0, 240);
}

export function logMonitorJobEvent(e: MonitorJobEvent, log: (line: string) => void = (s: string) => console.log(s)): void {
  log(formatMonitorJobEvent(e));
}

export function createStreamEvents(
  _maxSteps: number,
  log: (line: string) => void = (s: string) => console.log(s),
  now: () => number = Date.now,
): AgentLoopEvents {
  let pending = "";
  let latestUsage: { inputTokens: number; outputTokens: number } | undefined;
  const startTime = now();

  return {
    onStep: () => {},
    onAssistant: (_raw: string, invocation: { tool?: string; arguments?: unknown } | null) => {
      const tool = typeof invocation?.tool === "string" ? invocation.tool.trim() : "";
      if (!tool || tool === "done") return;
      pending = summarizeForgeInvocation(tool, invocation?.arguments).title;
      const elapsedMs = now() - startTime;
      let suffix = "";
      if (elapsedMs >= 1000) suffix += ` · ${formatDuration(elapsedMs)}`;
      if (latestUsage) suffix += ` · ${formatUsage(latestUsage)}`;
      log(`${categoryBadge("progress")} ${pending}${suffix ? chalk.dim(suffix) : ""}`);
    },
    onToolResult: (tool: string, ok: boolean, output?: string) => {
      const label = pending || tool;
      const mark = ok ? chalk.green("✓") : chalk.red("✗");
      log(`  ${categoryBadge(ok ? "done" : "error")} ${mark} ${label}${streamResultSuffix(tool, ok, output)}`);
      pending = "";
    },
    onNotice: (msg: string) => log(`  ${categoryBadge("progress")} ${chalk.yellow(msg)}`),
    onBudget: (_limit: number, reason: string) => {
      log(`  ${categoryBadge("progress")} ${chalk.yellow(reason)}`);
    },
    onUsage: (usage: { inputTokens: number; outputTokens: number }) => {
      latestUsage = usage;
    },
  };
}

export function shouldUseOneShotTui(noTui: boolean): boolean {
  return LaunchTui.usable(noTui);
}
