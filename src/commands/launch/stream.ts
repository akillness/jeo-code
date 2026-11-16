import chalk from "chalk";
import { type AgentLoopEvents } from "../../agent/engine";
import { type TaskSubEvent } from "../../agent/task-tool";
import { categoryBadge } from "../../tui/components/category-index";
import { redactSecrets, summarizeForgeInvocation } from "../../tui/components/forge";
import { sanitizeForTerminal } from "../../tui/components/code-view";
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

function sliceSurrogateSafe(s: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (s.length <= maxLen) return s;
  let end = maxLen;
  const prev = s.charCodeAt(end - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) {
    const next = s.charCodeAt(end);
    if (next >= 0xdc00 && next <= 0xdfff) end--;
  }
  return s.slice(0, end);
}

function firstOutputLine(output: string | undefined): string {
  if (!output) return "";
  const line = String(output)
    .split("\n")
    .map(l => l.trim())
    .find(l => l.length > 0);
  return line ? sliceSurrogateSafe(line.replace(/\s+/g, " "), 140) : "";
}

function streamResultSuffix(tool: string, ok: boolean, output: string | undefined): string {
  if (!ok || tool === "task") {
    const summary = firstOutputLine(cleanTaskField(output));
    return summary ? ` — ${summary}` : "";
  }
  return "";
}

function cleanTaskField(raw: string | undefined, maxRaw = 4096): string {
  if (!raw) return "";
  const clipped = sliceSurrogateSafe(raw, maxRaw);
  return redactSecrets(sanitizeForTerminal(clipped));
}

function shortenTaskModel(model: string | undefined): string {
  const clean = cleanTaskField(model, 512).replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const slash = clean.lastIndexOf("/");
  const leaf = slash >= 0 && slash + 1 < clean.length ? clean.slice(slash + 1) : clean;
  return sliceSurrogateSafe(leaf, 64);
}

export function formatTaskSubEvent(e: TaskSubEvent): string {
  // "thinking" is a live-only TUI preview (never persisted to the ledger — see
  // TaskSubEvent.kind's doc comment) and has no place in an append-only, non-TTY
  // log stream: a reasoning delta stream would otherwise fall through to the
  // "done" branch below and print a bogus "ROLE done: <reasoning text>" line for
  // every emitted preview. Empty string signals the caller to skip the line.
  if (e.kind === "thinking") return "";
  const role = sliceSurrogateSafe(cleanTaskField(e.role, 512).replace(/\s+/g, " ").trim(), 48) || "subagent";
  const roleUpper = role.toUpperCase();
  const detachedId = sliceSurrogateSafe(cleanTaskField(e.detachedId, 512).replace(/\s+/g, " ").trim(), 48);
  const roleLabel = detachedId ? `${roleUpper}[${detachedId}]`
    : e.index && e.total ? `${roleUpper}[${e.index}/${e.total}]` : roleUpper;
  const tokTag = e.tokens ? ` (${e.tokens.input + e.tokens.output} tok)` : "";
  const detail = firstOutputLine(cleanTaskField(e.detail, 4096));
  const cleanSummary = sliceSurrogateSafe(cleanTaskField(e.summary, 4096).replace(/\s+/g, " ").trim(), 140);
  const summary = cleanSummary ? ` — ${cleanSummary}` : "";
  const stepTag = e.step !== undefined && e.maxSteps !== undefined
    ? `${e.step}/${e.maxSteps}`
    : e.step !== undefined
      ? `step ${e.step}`
      : e.kind === "start" && e.maxSteps !== undefined
        ? `≤${e.maxSteps}`
        : "";
  const modelTag = shortenTaskModel(e.model);
  const metaParts = [stepTag, modelTag].filter(Boolean);
  const metaSuffix = metaParts.length > 0 ? ` ${chalk.dim(`(${metaParts.join(" · ")})`)}` : "";
  const badge = categoryBadge("subagent");
  if (e.kind === "start") return `${badge} ${chalk.magenta(`▸ ${roleLabel}`)} · ${detail}${metaSuffix}`;
  if (e.kind === "step") return `  ${badge} ${chalk.cyan(`├─ ${roleLabel}`)} · ${detail || "working"}${metaSuffix}`;
  if (e.kind === "tool") return `  ${badge} ${e.success === false ? chalk.red("├─") : chalk.green("├─")} ${roleLabel} ${e.success === false ? chalk.red("✗") : chalk.green("✓")} ${detail || "tool"}${summary}${metaSuffix}`;
  if (e.kind === "error") return `  ${badge} ${chalk.red("├─")} ${roleLabel} ${chalk.red("✗")} ${detail || "error"}${metaSuffix}`;
  return `${badge} ${e.success === false ? chalk.red("└─") : chalk.green("└─")} ${roleLabel} done${tokTag}${e.success === false ? " (incomplete)" : ""}${detail ? `: ${detail}` : ""}${metaSuffix}`;
}

export function logTaskSubEvent(e: TaskSubEvent, log: (line: string) => void = (s: string) => console.log(s)): void {
  const line = formatTaskSubEvent(e);
  if (line) log(line);
}
/** Route late detached events only to their owning session's current display. */
export function dispatchSubagentDisplay(
  event: TaskSubEvent,
  state: { sameSession: boolean; originatingTurnOpen: boolean; activeTui: boolean; turnActive: boolean },
  handlers: { original: (event: TaskSubEvent) => void; active: (event: TaskSubEvent) => void; deferred: (event: TaskSubEvent) => void; idle: (event: TaskSubEvent) => void },
): void {
  if (state.originatingTurnOpen) {
    if (!event.detachedId || state.sameSession) handlers.original(event);
  } else if (event.detachedId && state.sameSession) {
    if (state.activeTui) handlers.active(event);
    else if (event.kind === "done" || event.kind === "error") {
      if (state.turnActive) handlers.deferred(event);
      else handlers.idle(event);
    }
  }
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
      const label = pending || cleanTaskField(tool, 512);
      const mark = ok ? chalk.green("✓") : chalk.red("✗");
      log(`  ${categoryBadge(ok ? "done" : "error")} ${mark} ${label}${streamResultSuffix(tool, ok, output)}`);
      pending = "";
    },
    onNotice: (msg: string) => log(`  ${categoryBadge("progress")} ${chalk.yellow(cleanTaskField(msg))}`),
    onBudget: (_limit: number, reason: string) => {
      log(`  ${categoryBadge("progress")} ${chalk.yellow(cleanTaskField(reason))}`);
    },
    onUsage: (usage: { inputTokens: number; outputTokens: number }) => {
      latestUsage = usage;
    },
  };
}

export function shouldUseOneShotTui(noTui: boolean): boolean {
  return LaunchTui.usable(noTui);
}
