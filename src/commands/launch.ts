import { createInterface } from "node:readline/promises";
import { runAgentLoop, executorSystemPrompt, DEFAULT_TOOLS, TOOL_PROTOCOL, type AgentLoopEvents } from "../agent/engine";
import { initialDynamicStepLimit } from "../agent/step-budget";
import { createTaskTool, TASK_TOOL_PROTOCOL_LINE, type TaskSubEvent } from "../agent/task-tool";
import { createTodoTool, TODO_TOOL_PROTOCOL_LINE } from "../agent/todo-tool";
import { LaunchTui } from "../tui/app";
import { runDeepInterviewEngine } from "./deep-interview";
import { runRalplanEngine } from "./ralplan";
import { runTeamEngine } from "./team";
import { runUltragoalEngine } from "./ultragoal";
import { skillsPromptSection, loadSkills, formatSkill, buildSkillTask, getSkillFrom, skillSlashAliases, workflowSkillsForPrompt, parseSkillInvocation, looksLikeSkillEcho, type SkillDoc } from "../skills/catalog";
import { interactiveOAuthLogin } from "./auth";
import { logoutOAuth } from "../auth";
import type { AuthProvider } from "../auth";
import { matchSlash, isSlashAttempt, formatSlashCommandList, formatSlashPreview, slashPreviewMatches, type SlashCommandInfo } from "../tui/components/slash";
import { staticCompletionContext, readlineCompleter, formatCompletionPreview, tokenize, type CompletionContext } from "../tui/components/autocomplete";
import { EVOLUTION_STAGES, animateAsciiArt } from "../tui/components/ascii-art";
import { getEvolutionTip } from "../tui/components/evolution";
import { renderWelcome } from "../tui/components/welcome";
import { checkForUpdate } from "../util/update-check";
import { renderUpdateBox } from "../tui/components/update-box";
import { supportsUnicode } from "../tui/components/capability";
import pkg from "../../package.json";
import chalk from "chalk";
import { callLlm, type Message } from "../agent/loop";
import { friendlyProviderError } from "../util/provider-error";
import { readGlobalConfig, saveConfigPatch } from "../agent/state";
import { rememberModelPatch, recentModelsForDisplay } from "../agent/model-recency";
import { describeModel, describeAllProviders, thinkingMaxTokens, discoverModels, flattenModels, resolveSelection, catalogMetadata, resolveRoleModel, enrichAll, sortByCapability, knownCount, MODEL_CATALOG, fuzzyMatchCatalog, CODEX_MODELS, qualifyModelId } from "../ai";
import type { ProviderModelsResult, PickEntry, ProviderName, ModelRole, ThinkLevel } from "../ai";

import { listAliases } from "../ai/model-registry";

import { SUBAGENT_ROLES, getSubagentRole, resolveSubagentModel, resolveSubagentMaxSteps, parseMaxSteps, withSubagentSetting, clearSubagentSetting } from "../agent/subagents";
import {
  formatModelLine,
  formatAliasLines,
  formatProviderPanel,
  formatAgentsPanel,
  formatAgentDetail,
  formatConfigPanel,

  liveModelKnown,
  formatPickListWithCapabilities,
  formatCapabilityLine,
  formatCatalogTable,
  formatCanonicalCatalogTable,
} from "../tui/components/config-panel";
import { liveModelPicker, renderLiveModelPicker } from "../tui/components/live-model-picker";
import { skillPicker, renderSkillPicker } from "../tui/components/skill-picker";
import { providerPicker, renderProviderPicker } from "../tui/components/provider-picker";
import { detectLanguage, languageLabel, parseLineRange, sliceLines, formatCodeBlock, formatDiff } from "../tui/components/code-view";
import { categoryBadge } from "../tui/components/category-index";
import { renderInputFrame } from "../tui/components/input-box";
import { renderStatusBar } from "../tui/components/status";
import { detectColorLevel } from "../tui/components/color";
import { readClipboardImage } from "../util/clipboard-image";
import { formatTranscript } from "../tui/components/transcript";
import type { ImageAttachment } from "../ai/types";
import { renderMarkdownTables } from "../tui/components/markdown-table";
import { summarizeForgeInvocation } from "../tui/components/forge";
import { formatDuration, formatUsage } from "../tui/components/duration";

import { findTool, searchTool } from "../agent/tools";
import { loadProjectContext, withProjectContext } from "../agent/context-files";
import { maybeCompact, historyTokens } from "../agent/compaction";
import * as path from "node:path";
import * as fs from "node:fs";
import { listThemes, resolveTheme, themeGradient, accentPaint, accentShadowPaint } from "../tui/components/themes";
import {
  createSession,
  appendMessage,
  appendMessages,
  loadSession,
  listSessions,
  latestSessionId,
  exportSession,
  renameSession,
  deleteSession,
  sessionPath,
  appendCompaction,
} from "../agent/session";
import { clearLine, cursorUp, toColumn, truncate as truncateAnsi, size as terminalSize } from "../tui/terminal";

export interface LaunchFlags {
  list: boolean;
  resume: boolean;
  resumeId?: string;
  noSession: boolean;
  noTui: boolean;
  /** Explicit step cap from --max-steps; 0 = dynamic (process-driven budget that
   *  keeps extending while the turn shows progress — no hardcoded step ceiling). */
  maxSteps: number;
  message: string;
  tmux: boolean;
  worktree?: string;
  model?: string;
  provider?: ProviderName;
  modelRole?: ModelRole;
  thinking?: ThinkLevel;
  errors: string[];
  print?: boolean;
  appendSystemPromptRaw?: string;
  appendSystemPrompt?: string;
  noSkills: boolean;
  skills?: string;
  noTools: boolean;
  tools?: string;
  systemPromptRaw?: string;
  systemPrompt?: string;
}

const PROVIDER_DEFAULT: Record<ProviderName, string> = { anthropic: "sonnet", openai: "gpt-5.5", gemini: "flash", antigravity: "antigravity/gemini-3-pro-high", ollama: "fast" };

function takeValue(args: string[], index: number, inlinePrefix: string): { value?: string; nextIndex: number } {
  const current = args[index]!;
  if (current.startsWith(inlinePrefix)) return { value: current.slice(inlinePrefix.length), nextIndex: index };
  const next = args[index + 1];
  if (next && !next.startsWith("-")) return { value: next, nextIndex: index + 1 };
  return { nextIndex: index };
}

function isProviderName(input: string | undefined): input is ProviderName {
  return input === "anthropic" || input === "openai" || input === "gemini" || input === "antigravity" || input === "ollama";
}

function isThinkingLevel(input: string | undefined): input is ThinkLevel {
  return input === "minimal" || input === "low" || input === "medium" || input === "high" || input === "xhigh";
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}

function tmuxSafeNamePart(input: string, max = 32): string {
  const safe = input.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "value";
  if (safe.length <= max) return safe;
  return `${safe.slice(0, Math.max(1, max - 7))}-${hashString(input)}`;
}

function tmuxRuntimeSuffix(flags: LaunchFlags): string {
  const parts: string[] = [];
  if (flags.provider) parts.push(`provider-${flags.provider}`);
  if (flags.model) parts.push(`model-${tmuxSafeNamePart(flags.model)}`);
  else if (flags.modelRole) parts.push(flags.modelRole);
  if (flags.thinking) parts.push(`think-${flags.thinking}`);
  // Only an EXPLICIT --max-steps cap names the session; the dynamic default (0) adds nothing.
  if (flags.maxSteps > 0) parts.push(`steps-${flags.maxSteps}`);
  if (parts.length === 0) return "";
  const joined = parts.join("-");
  const suffix = joined.length <= 72 ? joined : `${joined.slice(0, 65)}-${hashString(joined)}`;
  return `-${suffix}`;
}

/**
 * Base tmux session name for `jeo --tmux`. Keyed on the working DIRECTORY (not just the
 * git branch) so two different projects/worktrees on the same branch (e.g. `main`)
 * never share a base. {@link uniqueTmuxSessionName} then makes each concurrent invocation
 * fully independent, so a second `jeo --tmux` never attaches to (and mirrors) the first.
 */
export function tmuxSessionName(cwd: string, branch: string, flags: LaunchFlags): string {
  const dirTag = `${tmuxSafeNamePart(path.basename(cwd) || "root", 16)}-${hashString(cwd)}`;
  const base = branch ? `jeo-${branch}-${dirTag}` : `jeo-${dirTag}`;
  return base + tmuxRuntimeSuffix(flags);
}

/**
 * Count uncommitted git entries for the `⑂ <branch> ?N` footer dirty flag (gjc parity).
 * One `git status --porcelain` spawn per CALL; callers invoke it once per turn start, not
 * per render. Returns undefined when not a repo / git absent / clean.
 */
export function gitDirtyCount(cwd: string): number | undefined {
  try {
    const res = Bun.spawnSync(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "ignore" });
    if (res.exitCode !== 0) return undefined;
    const n = res.stdout.toString().split("\n").filter(l => l.trim().length > 0).length;
    return n || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Allocate + create an INDEPENDENT tmux session from a base name. Each separate,
 * concurrent `jeo --tmux` invocation gets its OWN session instead of attaching to (and
 * mirroring) one another process already created: try `base`, then `base-2`, `base-3`, …
 * The create itself is the guard, so this is race-safe — two processes starting at the
 * same instant can't both win `base`. `tryCreate` must attempt to create the named session
 * and return `"ok"` (created — it's ours), `"taken"` (name already live / lost the race →
 * try the next suffix), or `"error:<msg>"` (a real failure → abort). Sessions die with
 * their jeo process, so a sequential re-run reuses the clean base; only live overlap is
 * suffixed.
 */
export type TmuxCreateResult = "ok" | "taken" | `error:${string}`;
export function allocateTmuxSession(
  base: string,
  tryCreate: (name: string) => TmuxCreateResult,
): { name: string } | { error: string } {
  for (let n = 1; n <= 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const result = tryCreate(candidate);
    if (result === "ok") return { name: candidate };
    if (result === "taken") continue;
    return { error: result.slice("error:".length) };
  }
  return { error: `could not allocate a free tmux session name for ${base} (1000 already live?)` };
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * True when `jeo --tmux` runs INSIDE an existing tmux session and should enable
 * session-scoped mouse mode for the CURRENT session: no jeo-owned session is created
 * on this path, so without `mouse on` tmux ignores the wheel entirely and the
 * mid-turn scrollback (ledger lines flushed above the live frame) is unreachable.
 * Skipped for jeo-spawned sessions (JOC_TMUX_LAUNCHED=1 — the creator already set
 * it) and when JOC_TMUX_MOUSE=0 opts out.
 */
export function shouldEnableCurrentTmuxMouse(env: Record<string, string | undefined>): boolean {
  return !!env.TMUX
    && (env.JEO_TMUX_LAUNCHED ?? env.JOC_TMUX_LAUNCHED) !== "1"
    && (env.JEO_TMUX_MOUSE ?? env.JOC_TMUX_MOUSE) !== "0";
}

/**
 * A `process.stdout` view whose visible-output methods become no-ops while `gated()` is
 * true. Used as readline's `output` so that, while the boxed slash-preview footer is armed,
 * readline's OWN prompt/echo is suppressed and only our box is visible — no duplicated raw
 * `jeo>` line. The previous approach monkeypatched `rl._writeToOutput`, a Node internal Bun
 * does not expose (so on Bun both inputs showed at once). Gating the shared `output` stream
 * works on both runtimes. Our footer is written straight to `process.stdout`, never through
 * this proxy, so it always renders. Geometry/everything else is forwarded unchanged.
 */
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
  const detail = firstOutputLine(e.detail);
  const summary = e.summary ? ` — ${e.summary}` : "";
  const step = e.step && e.maxSteps ? ` step ${e.step}/${e.maxSteps}` : "";
  // Lead every nested-subagent line with the [AGENT] category badge so the stream
  // is classifiable at a glance (parity with the live TUI and `jeo team`).
  const badge = categoryBadge("subagent");
  if (e.kind === "start") return `${badge} ${chalk.magenta(`▸ [${role}]`)} ${detail}`.slice(0, 240);
  if (e.kind === "step") return `  ${badge} ${chalk.cyan(`[${role}${step}]`)} ${detail || "working"}`;
  if (e.kind === "tool") return `  ${badge} [${role}] ${e.success === false ? chalk.red("✗") : chalk.green("✓")} ${detail || "tool"}${summary}`;
  if (e.kind === "error") return `  ${badge} [${role}] ${chalk.red("✗")} ${detail || "error"}`;
  return `${badge} ${chalk.magenta(`◂ [${role}]`)} done${e.success === false ? " (incomplete)" : ""}${detail ? `: ${detail}` : ""}`;
}

function logTaskSubEvent(e: TaskSubEvent, log: (line: string) => void = (s: string) => console.log(s)): void {
  log(formatTaskSubEvent(e));
}


/**
 * Plain (non-TTY / `--no-tui`) progress sink — the cmd-mode equivalent of the live TUI, and
 * the gjc-parity fix for "I typed a request but saw no steps/results". The old sink only
 * logged tool RESULTS, so a turn that finished without a tool call (or before the first
 * result) printed nothing but the final reply. This surfaces every STEP, the tool it is about
 * to run (with the real file/command target via `summarizeForgeInvocation`), and each result —
 * tracking the current step + pending invocation across the engine's
 * onStep → onAssistant → onToolResult sequence.
 */
export function createStreamEvents(
  maxSteps: number,
  log: (line: string) => void = (s: string) => console.log(s),
  now: () => number = Date.now,
): AgentLoopEvents {
  let step = 0;
  let cap = maxSteps;
  let pending = "";
  let latestUsage: { inputTokens: number; outputTokens: number } | undefined;
  const startTime = now();

  return {
    onStep: (n: number) => {
      // Lazy header: recorded here, printed once the tool call is known (onAssistant).
      // A `done` / invalid reply therefore emits no step line at all.
      step = n;
    },
    onAssistant: (_raw: string, invocation: { tool?: string; arguments?: unknown } | null) => {
      const tool = typeof invocation?.tool === "string" ? invocation.tool.trim() : "";
      if (!tool || tool === "done") return;
      pending = summarizeForgeInvocation(tool, invocation?.arguments).title;
      // gjc-style live status unit: step header + tool target + elapsed + token usage.
      const elapsedMs = now() - startTime;
      let suffix = "";
      if (elapsedMs >= 1000) suffix += ` · ${formatDuration(elapsedMs)}`;
      if (latestUsage) suffix += ` · ${formatUsage(latestUsage)}`;
      log(`${categoryBadge("progress")} ${chalk.cyan(`[step ${step}/${cap}]`)} ${pending}${suffix ? chalk.dim(suffix) : ""}`);
    },
    onToolResult: (tool: string, ok: boolean, output?: string) => {
      const label = pending || tool;
      const mark = ok ? chalk.green("✓") : chalk.red("✗");
      log(`  ${categoryBadge(ok ? "done" : "error")} ${mark} ${label}${streamResultSuffix(tool, ok, output)}`);
      pending = "";
    },
    onNotice: (msg: string) => log(`  ${categoryBadge("progress")} ${chalk.yellow(msg)}`),
    onBudget: (limit: number, reason: string) => {
      // gjc-style retry flow: keep the `[step N/M]` denominator honest after an extension.
      cap = limit;
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

export interface InFlightAbortHarness {
  controller: AbortController;
  handleSigint(): void;
  handleData(chunk: string | Uint8Array): void;
  dispose(): void;
}

interface AbortHarnessOptions {
  controller?: AbortController;
  captureEsc?: boolean;
  stdin?: {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?(raw: boolean): void;
    resume?(): void;
    on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
    off(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
  };
  onAbortNotice?: (message: string) => void;
  onHardExit?: () => void;
  /** Invoked when stray escape-sequence noise (wheel scroll etc.) arrives mid-turn. */
  onNoise?: () => void;
}

export function createInFlightAbortHarness(opts: AbortHarnessOptions = {}): InFlightAbortHarness {
  const controller = opts.controller ?? new AbortController();
  const stdin = opts.stdin ?? process.stdin;
  const captureEsc = opts.captureEsc === true && !!stdin.isTTY;
  const wasRaw = !!stdin.isRaw;
  let rawChanged = false;

  const abortNow = (message: string) => {
    if (controller.signal.aborted) return false;
    opts.onAbortNotice?.(message);
    controller.abort();
    return true;
  };

  const handleSigint = () => {
    if (abortNow("Cancelling current run… Press Ctrl-C again to exit.")) return;
    opts.onHardExit?.();
  };

  const handleData = (chunk: string | Uint8Array) => {
    if (!captureEsc || controller.signal.aborted) return;
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (text === "\u001b") {
      abortNow("ESC pressed — cancelling current run…");
      return;
    }
    // Raw mode swallows the terminal's SIGINT generation: Ctrl-C arrives as data.
    if (text.includes("\u0003")) {
      handleSigint();
      return;
    }
    // Anything else arriving mid-turn (mouse-wheel arrow bursts, stray escape
    // sequences) may have disturbed the screen — auto-heal with a full repaint.
    if (text.includes("\u001b")) {
      opts.onNoise?.();
    }
  };

  process.on("SIGINT", handleSigint);
  if (captureEsc) {
    stdin.on("data", handleData);
    if (stdin.setRawMode && !wasRaw) {
      stdin.setRawMode(true);
      rawChanged = true;
    }
    stdin.resume?.();
  }

  return {
    controller,
    handleSigint,
    handleData,
    dispose() {
      process.removeListener("SIGINT", handleSigint);
      if (captureEsc) {
        stdin.off("data", handleData);
        if (rawChanged) stdin.setRawMode?.(false);
      }
    },
  };
}

/** The exact resume command printed on REPL exit (and testable in isolation) —
 *  same convention as the `--list` handler's hint. */
export function formatResumeHint(sessionId: string): string {
  return `Resume with: jeo launch --resume ${sessionId}`;
}
export function parseFlags(args: string[], cwd: string = process.cwd()): LaunchFlags {
  // maxSteps 0 = dynamic: the engine's process-driven budget extends itself while the
  // turn shows progress instead of stopping at a hardcoded count (old default: 100).
  const flags: LaunchFlags = { list: false, resume: false, noSession: false, noTui: false, maxSteps: 0, message: "", tmux: false, errors: [], print: false, noSkills: false, noTools: false };
  const rest: string[] = [];
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a === "--list") {
      flags.list = true;
    } else if (a === "-p" || a === "--print") {
      flags.print = true;
      flags.noTui = true;
    } else if (a === "--tmux") {
      flags.tmux = true;
    } else if (a === "--worktree") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags.worktree = next;
        i++;
      }
    } else if (a.startsWith("--worktree=")) {
      flags.worktree = a.slice("--worktree=".length);
    } else if (a === "--no-session") {
      flags.noSession = true;
    } else if (a === "--no-tui") {
      flags.noTui = true;
    } else if (a === "--max-steps") {
      const n = parseInt(args[i + 1] ?? "", 10);
      if (Number.isFinite(n) && n > 0) {
        flags.maxSteps = n;
        i++;
      }
    } else if (a.startsWith("--max-steps=")) {
      const n = parseInt(a.slice(12), 10);
      if (Number.isFinite(n) && n > 0) flags.maxSteps = n;
    } else if (a === "--model") {
      const { value, nextIndex } = takeValue(args, i, "--model=");
      if (value) flags.model = value;
      else flags.errors.push("--model requires a value");
      i = nextIndex;
    } else if (a.startsWith("--model=")) {
      const { value } = takeValue(args, i, "--model=");
      if (value) flags.model = value;
      else flags.errors.push("--model requires a value");
    } else if (a === "--provider") {
      const { value, nextIndex } = takeValue(args, i, "--provider=");
      const normalized = value?.toLowerCase();
      if (isProviderName(normalized)) flags.provider = normalized;
      else flags.errors.push("--provider must be one of: anthropic, openai, gemini, ollama");
      i = nextIndex;
    } else if (a.startsWith("--provider=")) {
      const { value } = takeValue(args, i, "--provider=");
      const normalized = value?.toLowerCase();
      if (isProviderName(normalized)) flags.provider = normalized;
      else flags.errors.push("--provider must be one of: anthropic, openai, gemini, ollama");
    } else if (a === "--thinking") {
      const { value, nextIndex } = takeValue(args, i, "--thinking=");
      const normalized = value?.toLowerCase();
      if (isThinkingLevel(normalized)) flags.thinking = normalized;
      else flags.errors.push("--thinking must be one of: minimal, low, medium, high, xhigh");
      i = nextIndex;
    } else if (a.startsWith("--thinking=")) {
      const { value } = takeValue(args, i, "--thinking=");
      const normalized = value?.toLowerCase();
      if (isThinkingLevel(normalized)) flags.thinking = normalized;
      else flags.errors.push("--thinking must be one of: minimal, low, medium, high, xhigh");
    } else if (a === "--smol" || a === "--slow" || a === "--plan") {
      flags.modelRole = a.slice(2) as ModelRole;
    } else if (a === "--resume" || a === "--continue" || a === "-c") {
      flags.resume = true;
      const next = args[i + 1];
      if (next && UUID_REGEX.test(next)) {
        flags.resumeId = next;
        i++;
      }
    } else if (a.startsWith("--resume=") || a.startsWith("--continue=") || a.startsWith("-c=")) {
      flags.resume = true;
      const eqIdx = a.indexOf("=");
      const val = a.slice(eqIdx + 1);
      if (UUID_REGEX.test(val)) {
        flags.resumeId = val;
      } else {
        rest.push(val);
      }
    } else if (a === "--append-system-prompt") {
      const { value, nextIndex } = takeValue(args, i, "--append-system-prompt=");
      if (value) {
        flags.appendSystemPromptRaw = value;
      } else {
        flags.errors.push("--append-system-prompt requires a value");
      }
      i = nextIndex;
    } else if (a.startsWith("--append-system-prompt=")) {
      const { value } = takeValue(args, i, "--append-system-prompt=");
      if (value) {
        flags.appendSystemPromptRaw = value;
      } else {
        flags.errors.push("--append-system-prompt requires a value");
      }
    } else if (a === "--no-skills") {
      flags.noSkills = true;
    } else if (a === "--skills") {
      const { value, nextIndex } = takeValue(args, i, "--skills=");
      if (value) flags.skills = value;
      else flags.errors.push("--skills requires a value");
      i = nextIndex;
    } else if (a.startsWith("--skills=")) {
      const { value } = takeValue(args, i, "--skills=");
      if (value) flags.skills = value;
      else flags.errors.push("--skills requires a value");
    } else if (a === "--no-tools") {
      flags.noTools = true;
    } else if (a === "--tools") {
      const { value, nextIndex } = takeValue(args, i, "--tools=");
      if (value) flags.tools = value;
      else flags.errors.push("--tools requires a value");
      i = nextIndex;
    } else if (a.startsWith("--tools=")) {
      const { value } = takeValue(args, i, "--tools=");
      if (value) flags.tools = value;
      else flags.errors.push("--tools requires a value");
    } else if (a === "--system-prompt") {
      const { value, nextIndex } = takeValue(args, i, "--system-prompt=");
      if (value) flags.systemPromptRaw = value;
      else flags.errors.push("--system-prompt requires a value");
      i = nextIndex;
    } else if (a.startsWith("--system-prompt=")) {
      const { value } = takeValue(args, i, "--system-prompt=");
      if (value) flags.systemPromptRaw = value;
      else flags.errors.push("--system-prompt requires a value");
    } else {
      rest.push(a);
    }
  }
  flags.message = rest.join(" ").trim();

  if (flags.print && !flags.message) {
    flags.errors.push("-p/--print requires a message argument");
  }

  if (flags.appendSystemPromptRaw) {
    if (flags.appendSystemPromptRaw.startsWith("@")) {
      const filePath = flags.appendSystemPromptRaw.slice(1);
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      try {
        flags.appendSystemPrompt = fs.readFileSync(absPath, "utf8");
      } catch (err) {
        flags.errors.push(`failed to read system prompt file: ${(err as Error).message}`);
      }
    } else {
      flags.appendSystemPrompt = flags.appendSystemPromptRaw;
    }
  }
  if (flags.systemPromptRaw) {
    if (flags.systemPromptRaw.startsWith("@")) {
      const filePath = flags.systemPromptRaw.slice(1);
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      try {
        flags.systemPrompt = fs.readFileSync(absPath, "utf8");
      } catch (err) {
        flags.errors.push(`failed to read system prompt file: ${(err as Error).message}`);
      }
    } else {
      flags.systemPrompt = flags.systemPromptRaw;
    }
  }

  return flags;
}
export function matchSkillGlob(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  if (!p.includes("*")) {
    return p === n;
  }
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = "^" + escaped.replace(/\*/g, ".*") + "$";
  const regex = new RegExp(regexStr);
  return regex.test(n);
}

export function filterToolMap(
  tools: Record<string, any>,
  allowlist: string[]
): Record<string, any> {
  const result: Record<string, any> = {};
  for (const name of allowlist) {
    if (name in tools) {
      result[name] = tools[name];
    }
  }
  return result;
}
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "read   {filePath, lineRange?, raw?} — read a file (lineRange \"a-b\",\"a-\",\"a\",\"a+n\",\"a-b,c-d\"; raw: verbatim, no line numbers)",
  write: "write  {filePath, content}         — create/overwrite a file",
  edit: "edit   {filePath, editBlock}       — ≔A..B replace lines; ≔A+ insert after line A; ≔$ append EOF (payload on next line)",
  bash: "bash   {command, timeoutMs?, cwd?, env?} — run a shell command (cwd: subdir; env: extra vars)",
  find: "find   {globPattern}               — find files by name",
  search: "search {pattern, globPattern?, ignoreCase?, context?, maxMatches?} — grep (context: N lines around each match)",
  ls: "ls     {dirPath}                   — list a directory's entries (dirs first)",
};

export function buildToolProtocol(allowedTools: Set<string>): string {
  const lines: string[] = ["You have these tools (call exactly ONE per step):"];
  let num = 1;
  for (const name of ["read", "write", "edit", "bash", "find", "search", "ls"]) {
    if (allowedTools.has(name)) {
      lines.push(`${num}. ${TOOL_DESCRIPTIONS[name]}`);
      num++;
    }
  }
  lines.push(`${num}. done   {reason?}                   — call when the task is fully implemented AND verified`);
  lines.push("");
  lines.push("Reply with STRICT JSON only — no code fences. You MAY include an optional leading");
  lines.push('"reasoning" string (one short sentence on your plan, shown live to the user) before "tool":');
  lines.push('{ "reasoning": "<one short sentence>", "tool": "<name>", "arguments": { ... } }');
  return lines.join("\n");
}

/**
 * Resolve a git worktree path (gjc `--worktree <path>` parity). If the path
 * already exists it is reused as-is; otherwise a new worktree is created on a
 * branch derived from the path basename. Returns the absolute worktree path.
 */
function resolveWorktree(cwd: string, wt: string): string {
  const abs = path.isAbsolute(wt) ? wt : path.resolve(cwd, wt);
  if (fs.existsSync(abs)) return abs;
  if (!Bun.which("git")) {
    console.error("error: --worktree requires git on PATH");
    process.exit(1);
  }
  const branch = (path.basename(abs).replace(/[^a-zA-Z0-9_-]/g, "-") || "jeo-wt");
  const withBranch = Bun.spawnSync(["git", "worktree", "add", "-b", branch, abs], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (withBranch.exitCode !== 0) {
    // Branch may already exist; retry attaching the existing branch.
    const plain = Bun.spawnSync(["git", "worktree", "add", abs], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (plain.exitCode !== 0) {
      console.error(
        `error: failed to create git worktree at ${abs}: ${withBranch.stderr.toString().trim()}`,
      );
      process.exit(1);
    }
  }
  return abs;
}

export async function runLaunchCommand(args: string[]): Promise<void> {
  let cwd = process.cwd();
  const flags = parseFlags(args, cwd);
  if (flags.errors.length) {
    for (const err of flags.errors) {
      console.error(`error: ${err}`);
    }
    process.exitCode = 1;
    return;
  }

  if (flags.worktree) {
    const wt = resolveWorktree(cwd, flags.worktree);
    if (wt !== cwd) {
      process.chdir(wt);
      cwd = wt;
      if ((process.env.JEO_TMUX_LAUNCHED ?? process.env.JOC_TMUX_LAUNCHED) !== "1") console.log(`Using worktree: ${wt}`);
    }
  }
  let branch: string | undefined;
  try {
    // Same git invocation the tmux session-naming path uses (symbolic-ref is
    // quiet + fails cleanly on detached HEAD, so no "HEAD" placeholder leaks).
    const gitRes = Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (gitRes.exitCode === 0) {
      const out = gitRes.stdout.toString().trim();
      branch = out || undefined;
    }
  } catch {}
  const cfg = await readGlobalConfig();
  const defaultModel = cfg.defaultModel;
  const initialSessionModel =
    flags.model ??
    (flags.modelRole ? resolveRoleModel(flags.modelRole, cfg) : flags.provider ? PROVIDER_DEFAULT[flags.provider] : undefined);
  if (flags.provider && initialSessionModel) {
    const { provider } = await describeModel(initialSessionModel);
    if (provider !== flags.provider) {
      console.log(`error: selected model '${initialSessionModel}' resolves to ${provider}, not requested provider ${flags.provider}.`);
      return;
    }
  }

  if (flags.tmux) {
    if (!process.env.TMUX && (process.env.JEO_TMUX_LAUNCHED ?? process.env.JOC_TMUX_LAUNCHED) !== "1") {
      const tmuxBin = Bun.which("tmux");
      if (tmuxBin) {
        let branch = "";
        try {
          const gitRes = Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
            cwd,
            stdout: "pipe",
            stderr: "ignore",
          });
          if (gitRes.exitCode === 0) {
            branch = gitRes.stdout.toString().trim().replace(/[^a-zA-Z0-9_-]/g, "-");
          }
        } catch {}
        const sessionBase = tmuxSessionName(cwd, branch, flags);

        // Strip orchestration flags: the worktree is already the tmux session
        // cwd (`-c cwd` below), so the inner process inherits it directly.
        const innerArgs: string[] = [];
        for (let j = 0; j < args.length; j++) {
          const a = args[j];
          if (a === "--tmux") continue;
          if (a === "--worktree") { j++; continue; }
          if (a.startsWith("--worktree=")) continue;
          innerArgs.push(a);
        }
        const entrypoint = process.argv[1] || "jeo";
        const resolvedEntrypoint = path.isAbsolute(entrypoint) ? entrypoint : path.resolve(cwd, entrypoint);
        let cmd: string[] = [];
        if (entrypoint.endsWith(".ts") || entrypoint.endsWith(".js") || entrypoint.endsWith(".mjs")) {
          cmd = [process.execPath, resolvedEntrypoint];
        } else {
          cmd = [resolvedEntrypoint];
        }

        const innerCmd = `exec env JOC_TMUX_LAUNCHED=1 ${[...cmd, "launch", ...innerArgs].map(shellQuote).join(" ")}`;

        // Create a fresh, independent session (race-safe: the create is the guard).
        const alloc = allocateTmuxSession(sessionBase, name => {
          const created = Bun.spawnSync([tmuxBin, "new-session", "-d", "-s", name, "-c", cwd, innerCmd]);
          if (created.exitCode === 0) return "ok";
          const err = created.stderr.toString().trim();
          if (/duplicate session/i.test(err)) return "taken"; // another jeo grabbed this name
          return `error:${err || `tmux new-session exited ${created.exitCode}`}`;
        });
        if ("error" in alloc) {
          console.error(`Error: Failed to create tmux session: ${alloc.error}`);
          process.exit(1);
        }
        const sessionName = alloc.name;
        // Wheel scrolling inside jeo-owned tmux sessions: enable tmux mouse mode
        // (session-scoped — never -g) so wheel-up enters copy-mode over the REAL
        // pane history and wheel-down at the bottom drops back out. Opt out with
        // JOC_TMUX_MOUSE=0. Best-effort: an old tmux without the option is fine.
        if ((process.env.JEO_TMUX_MOUSE ?? process.env.JOC_TMUX_MOUSE) !== "0") {
          try { Bun.spawnSync([tmuxBin, "set-option", "-t", `=${sessionName}`, "mouse", "on"]); } catch { /* best-effort */ }
        }
        console.log(
          sessionName === sessionBase
            ? `Starting new tmux session: ${sessionName}`
            : `Starting new independent tmux session: ${sessionName} (another live jeo session already owns ${sessionBase}; reattach later with: tmux attach -t ${sessionName})`,
        );

        const attach = Bun.spawn([tmuxBin, "attach-session", "-t", `=${sessionName}`], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        await attach.exited;
        return;
      } else {
        console.warn("warning: tmux is not available on PATH. Launching directly...");
      }
    } else if (shouldEnableCurrentTmuxMouse(process.env)) {
      // `jeo --tmux` INSIDE an existing tmux session: no new session is created, but
      // wheel scrolling still needs tmux mouse mode — without it tmux ignores the
      // wheel entirely, so the live-turn scrollback contract (ledger lines flushed
      // above the inline frame) is unreachable ("scroll doesn't work"). Session-
      // scoped (never -g), best-effort; JOC_TMUX_MOUSE=0 opts out.
      const tmuxBin = Bun.which("tmux");
      if (tmuxBin) {
        try { Bun.spawnSync([tmuxBin, "set-option", "mouse", "on"]); } catch { /* best-effort */ }
      }
    }
  }


  // --list: print persisted sessions and exit.
  if (flags.list) {
    const sessions = await listSessions(cwd);
    if (sessions.length === 0) {
      console.log("No saved sessions in .joc/sessions/.");
      return;
    }
    console.log("Saved sessions (newest first):");
    for (const s of sessions) {
      console.log(`  ${s.id}  ${s.timestamp}  (${s.messageCount} msgs)  ${s.preview}`);
    }
    console.log("\nResume with: jeo launch --resume <id>");
    return;
  }

  // pi-style: load project context (JEO.md / AGENTS.md / .joc/context.md / CLAUDE.md) into the prompt.
  const contextFiles = await loadProjectContext(cwd);

  const KNOWN_TOOLS = new Set(["read", "write", "edit", "bash", "find", "search", "ls", "task", "todo"]);
  let allowedTools = new Set(KNOWN_TOOLS);

  if (flags.noTools) {
    allowedTools = new Set();
  } else if (flags.tools) {
    const list = flags.tools.split(",").map(t => t.trim()).filter(Boolean);
    const valid: string[] = [];
    for (const name of list) {
      if (KNOWN_TOOLS.has(name)) {
        valid.push(name);
      } else {
        console.error(`Warning: Unknown tool name ignored: ${name}`);
      }
    }
    allowedTools = new Set(valid);
  }

  let resolvedSkills: SkillDoc[] = [];
  if (!flags.noSkills) {
    const loaded = await loadSkills(cwd);
    if (flags.skills) {
      const patterns = flags.skills.split(",").map(p => p.trim()).filter(Boolean);
      resolvedSkills = loaded.filter(s => patterns.some(p => matchSkillGlob(p, s.name)));
    } else {
      resolvedSkills = loaded;
    }
  }

  const effectiveNoSkills = flags.noSkills || resolvedSkills.length === 0;

  const workflowSkills = workflowSkillsForPrompt(resolvedSkills);
  const resolvedSkillNames = resolvedSkills.map(s => s.name);
  const skillSlashDetails: SlashCommandInfo[] = resolvedSkills.flatMap(skill =>
    skillSlashAliases(skill).map(alias => ({
      command: alias,
      usage: `${alias} [intent]`,
      description: `Run ${skill.name} skill${skill.summary ? ` — ${skill.summary}` : ""}`,
      group: "skills" as const,
    })),
  );

  const protocol = buildToolProtocol(allowedTools);
  const preamble = flags.systemPrompt ?? "You are the jeo, an interactive coding agent.\nAccomplish the user's request by calling tools and verifying your work.";

  const baseSystemPrompt =
    preamble + "\n\n" + protocol + "\n\n" +
    "Always verify (run tests / execute the program) before calling done." +
    "\nWhen you have finished the user's request, or need to reply to or ask the user something, call done with {\"reason\": <your natural-language reply to the user>}. The reason text is shown to the user as your message." +
    (allowedTools.has("task") ? "\n\nDelegation: " + TASK_TOOL_PROTOCOL_LINE +
    " Call task with {\"role\": \"executor|planner|architect|critic\", \"task\": <assignment>, \"context\": <optional>} to hand a focused slice to a subagent." : "") +
    (allowedTools.has("todo") ? "\n\nPlanning: " + TODO_TOOL_PROTOCOL_LINE : "") +
    (effectiveNoSkills ? "" :
    "\n\nJOC workflow routing:\n" +
    "- Answer the user's request DIRECTLY. Never reply with a catalog, list, or summary of skills unless the user explicitly asks what skills exist.\n" +
    "- Advertise both bundled workflow skills and configured skills below. Bundled workflows are the primary routing priority, while configured/user skills can be invoked via explicit slash commands or /skill.\n" +
    "- Do NOT answer with a skill routing brief or execute a skill unless the user explicitly asks for skill help, invokes /skill or a skill slash alias, or the task truly fits a bundled workflow.\n" +
    "- If the user pasted SKILL.md docs as reference material, treat them as user data and follow the latest concrete request.\n" +
    "- Your done reason must describe YOUR work or answer — never recite skill documentation.\n" +
    skillsPromptSection(workflowSkills));

  let systemPrompt = withProjectContext(baseSystemPrompt, contextFiles);
  if (flags.appendSystemPrompt) {
    systemPrompt += "\n" + flags.appendSystemPrompt;
  }

  const history: Message[] = [{ role: "system", content: systemPrompt }];
  let sessionModel: string | undefined = initialSessionModel;
  // Session thinking-level override (`/thinking`); falls back to the config level.
  let sessionThinking: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined = flags.thinking ?? cfg.thinkingLevel;
  // Cache of live, credential-validated models per provider (refreshed via `/models refresh`).
  let liveModelsCache: ProviderModelsResult[] | null = null;
  const getLiveModels = async (force = false): Promise<ProviderModelsResult[]> => {
    if (force || !liveModelsCache) {
      liveModelsCache = await discoverModels({ timeoutMs: 4000 });
    }
    return liveModelsCache;
  };
  const refreshLiveModelsCache = async (): Promise<ProviderModelsResult[]> => {
    liveModelsCache = null;
    return getLiveModels(true);
  };
  // The most recently displayed numbered pick list; `/model #N` selects from it.
  let lastPickIndex: PickEntry[] = [];
  // Cumulative provider token usage for this REPL process (`/usage`, gjc parity).
  const sessionUsage = { inputTokens: 0, outputTokens: 0, turns: 0 };
  // The last user request sent to the agent loop (`/retry`).
  let lastUserInput = "";
  // Full untruncated text of the last assistant reply — surfaced in detail by Ctrl+O.
  let lastReply = "";

  // pi-style session persistence: resume an existing session or create a new one.
  let sessionId: string | undefined;
  let compactionSeq = 0;
  if (!flags.noSession) {
    if (flags.resume) {
      const id = flags.resumeId ?? (await latestSessionId(cwd));
      if (!id) {
        console.log("No session to resume. Starting a new one.");
        sessionId = (await createSession(cwd)).id;
      } else {
        try {
          const { messages } = await loadSession(id, cwd);
          for (const m of messages) history.push(m);
          sessionId = id;
          console.log(`Resumed session ${id} (${messages.length} messages).`);
        } catch (err) {
          console.log(`Could not resume ${id}: ${(err as Error).message}. Starting fresh.`);
          sessionId = (await createSession(cwd)).id;
        }
      }
    } else {
      sessionId = (await createSession(cwd)).id;
    }
  }

  // `step N/M` display seed: the explicit --max-steps cap, else the dynamic budget's
  // rolling base — the engine's onBudget event keeps the denominator honest as it grows.
  const initialStepLimit = flags.maxSteps > 0 ? flags.maxSteps : initialDynamicStepLimit();
  // Plain (non-TTY / --no-tui) progress sink — the cmd-mode equivalent of the live TUI.
  const streamEvents = createStreamEvents(initialStepLimit);


  // Run one conversational turn: compact, persist user msg, run the loop, persist + return the reply.
  // When `useTui`, a live TUI renders the turn and prints the final reply itself (rendered=true).
  const runTurn = async (
    userInput: string,
    useTui: boolean,
    images?: ImageAttachment[]
  ): Promise<{ done: boolean; steps: number; reply: string; rendered: boolean; usage: string }> => {
    const turnConfig = await readGlobalConfig();
    const activeModel = sessionModel || turnConfig.defaultModel;
    const contextTokens = catalogMetadata(activeModel)?.contextTokens;

    const compRes = await maybeCompact(history, {
      model: sessionModel,
      contextTokens,
    });
    
    if (compRes.error) {
      throw new Error(compRes.error);
    }

    if (compRes.compacted && sessionId && compRes.replacesThrough !== undefined) {
      const summaryText = compRes.summary ?? `[Earlier conversation omitted: ${compRes.removed} messages — summary unavailable]`;
      await appendCompaction(sessionId, ++compactionSeq, summaryText, compRes.replacesThrough, cwd);
    }

    const beforeLen = history.length;
    if (images?.length && catalogMetadata(activeModel)?.images === false) {
      console.log(`! ${activeModel} does not advertise image input — sending the attachment anyway.`);
    }
    history.push(images?.length ? { role: "user", content: userInput, images } : { role: "user", content: userInput });

    // `turnConfig` was read before compaction so both the compactor and delegated
    // task tool see mid-session config changes (e.g. `/agents <role> <model>`).
    const { provider: activeProvider } = await describeModel(activeModel);
    // Dirty count is recomputed at each turn start (gjc parity P1.B5: per-turn, not
    // per-render) so `?N` grows as the agent edits files; one spawn/turn, not per frame.
    const turnDirtyCount = branch ? gitDirtyCount(cwd) : undefined;
    const tui = useTui ? new LaunchTui({ model: activeModel, provider: activeProvider, sessionId, maxSteps: initialStepLimit, cwd, branch, dirtyCount: turnDirtyCount, thinking: sessionThinking }) : null;
    tui?.setContextUsage(historyTokens(history), contextTokens);
    tui?.setTurnTitle(userInput); // gjc-parity turn title → HUD + tmux pane title (no LLM call)
    let result;
    try {
      if (tui) tui.start();
      const harness = createInFlightAbortHarness({
        captureEsc: !!tui,
        onNoise: () => tui?.repaint(),
        onAbortNotice: msg => {
          if (tui) tui.events().onNotice?.(msg);
          else console.log(msg);
        },
        onHardExit: () => {
          if (tui) tui.finish("Cancelled.");
          process.exit(130);
        },
      });
      const ac = harness.controller;
      try {
        const fullTools = {
          ...DEFAULT_TOOLS,
          task: createTaskTool({
            config: { ...turnConfig, defaultModel: activeModel },
            signal: ac.signal,
            onEvent: useTui
              ? (e => tui?.onSubagentEvent(e))
              : (e => logTaskSubEvent(e)),
          }),
          todo: createTodoTool({ onChange: items => tui?.setTodos(items) }),
        };
        const tools = filterToolMap(fullTools, Array.from(allowedTools));
        result = await runAgentLoop(history, {
          cwd,
          tools,
          maxSteps: flags.maxSteps,
          model: sessionModel,
          maxTokens: sessionThinking ? thinkingMaxTokens(sessionThinking) : undefined,
          signal: ac.signal,
          events: tui ? tui.events() : streamEvents,
        });
        if (result.done && looksLikeSkillEcho(result.doneReason ?? "", resolvedSkills)) {
          history.push({
            role: "user",
            content:
              "Your previous reply was skill-document content, not an answer. Answer my actual request directly now — " +
              "use tools if needed, then call done with a concise reply in your own words. Do not quote skill docs.",
          });
          const retry = await runAgentLoop(history, {
            cwd,
            tools,
            maxSteps: Math.min(6, flags.maxSteps > 0 ? flags.maxSteps : 6),
            budget: { maxExtensions: 0 },
            model: sessionModel,
            maxTokens: sessionThinking ? thinkingMaxTokens(sessionThinking) : undefined,
            signal: ac.signal,
            events: tui ? tui.events() : streamEvents,
          });
          const usage =
            result.usage && retry.usage
              ? {
                  inputTokens: result.usage.inputTokens + retry.usage.inputTokens,
                  outputTokens: result.usage.outputTokens + retry.usage.outputTokens,
                }
              : retry.usage ?? result.usage;
          result = { ...retry, steps: result.steps + retry.steps, usage };
        }
      } finally {
        harness.dispose();
      }
    } catch (err) {
      if (tui) tui.finish(`! ${friendlyProviderError(err)}`);
      throw err;
    }
    // A completed turn with an empty done-reason must NOT masquerade as a step-limit
    // failure ("reached the 3-step limit" after the model called done at step 3).
    const reply = result.doneReason
      || (result.done
        ? `(done in ${result.steps} step${result.steps === 1 ? "" : "s"} — the model returned no summary)`
        : `(reached the ${result.steps}-step limit without signaling done)`);
    // Full-fidelity persistence: append every message the engine added this turn
    // (user prompt + intermediate tool-call/tool-result turns), then the final reply.
    if (sessionId) {
      // One batched fs append for the whole turn (was: one awaited append per message).
      await appendMessages(sessionId, history.slice(beforeLen), cwd);
    }
    history.push({ role: "assistant", content: reply });
    if (sessionId) await appendMessage(sessionId, { role: "assistant", content: reply }, cwd);
    if (tui) tui.finish(reply);
    if (result.usage) {
      sessionUsage.inputTokens += result.usage.inputTokens;
      sessionUsage.outputTokens += result.usage.outputTokens;
    }
    sessionUsage.turns++;
    const usage = result.usage ? `  (${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens)` : "";
    return { done: result.done, steps: result.steps, reply, rendered: !!tui, usage };
  };


  const joinedArgs = flags.message;
  const isOneShot = flags.print || joinedArgs.length > 0 || !process.stdin.isTTY;

  if (isOneShot) {
    let messageContent = joinedArgs;
    if (!process.stdin.isTTY && joinedArgs.length === 0) {
      messageContent = (await Bun.stdin.text()).trim();
    }
    if (!messageContent) {
      console.log("No input provided.");
      return;
    }
    const skillInvocation = parseSkillInvocation(messageContent, resolvedSkills);
    if (skillInvocation) {
      const isBundleWorkflow = ["deep-interview", "ralplan", "team", "ultragoal"].includes(skillInvocation.skill.name);
      if (isBundleWorkflow) {
        const startMsg: Message = {
          role: "system",
          content: `[workflow:${skillInvocation.skill.name}:start]${skillInvocation.intent ? ` intent: ${skillInvocation.intent}` : ""}`
        };
        history.push(startMsg);
        if (sessionId) {
          await appendMessage(sessionId, startMsg, cwd);
        }

        const harness = createInFlightAbortHarness({
          captureEsc: false,
          onAbortNotice: msg => console.log(msg),
          onHardExit: () => process.exit(130),
        });
        const ac = harness.controller;

        const opts = {
          cwd,
          signal: ac.signal,
          onProgress: (e: { skill: string; phase: string; detail?: string }) => console.log(`[workflow:${e.skill}] ${e.phase}${e.detail ? ` — ${e.detail}` : ""}`),
          io: {
            output: (line: string) => {
              console.log(line);
            }
          },
          args: skillInvocation.skill.name === "deep-interview" ? (skillInvocation.intent ? skillInvocation.intent.split(/\s+/) : []) : undefined
        };

        let ok = false;
        let reason: string | undefined;
        try {
          let res: { ok: boolean; reason?: string };
          if (skillInvocation.skill.name === "deep-interview") {
            res = await runDeepInterviewEngine(opts);
          } else if (skillInvocation.skill.name === "ralplan") {
            res = await runRalplanEngine(opts);
          } else if (skillInvocation.skill.name === "team") {
            res = await runTeamEngine(opts);
          } else {
            res = await runUltragoalEngine(opts);
          }
          ok = res.ok;
          reason = res.reason;
        } catch (err: any) {
          ok = false;
          reason = err.message;
        } finally {
          harness.dispose();
        }

        const endMsg: Message = {
          role: "system",
          content: ok 
            ? `[workflow:${skillInvocation.skill.name}:finish]` 
            : `[workflow:${skillInvocation.skill.name}:abort]${reason ? ` reason: ${reason}` : ""}`
        };
        history.push(endMsg);
        if (sessionId) {
          await appendMessage(sessionId, endMsg, cwd);
        }
        return;
      }

      const useOneShotTui = shouldUseOneShotTui(flags.noTui);
      if (!useOneShotTui) {
        console.log(`▶ Running skill: ${skillInvocation.skill.name}${skillInvocation.intent ? ` — ${skillInvocation.intent}` : ""}`);
      }
      const task = buildSkillTask(skillInvocation.skill, skillInvocation.intent, skillInvocation.invokedAs);
      const { reply, rendered, usage } = await runTurn(task, useOneShotTui);
      if (!rendered) console.log(reply + usage);
      else if (usage) console.log(usage.trim());
      return;
    }
    try {
      const { reply, rendered, usage } = await runTurn(messageContent, shouldUseOneShotTui(flags.noTui));
      if (!rendered) console.log(reply + usage);
      else if (usage) console.log(usage.trim());
    } catch (err) {
      console.log(`! ${friendlyProviderError(err)}`);
    }
    return;
  }

  // INTERACTIVE mode
  const updatePromise = checkForUpdate({ timeoutMs: 2500 });
  const activeStartModel = sessionModel || defaultModel;
  const { provider: startProvider } = await describeModel(activeStartModel);
  const welcomeTheme = resolveTheme(process.env);
  console.log(renderWelcome({
    version: pkg.version,
    model: activeStartModel,
    provider: startProvider,
    cwd: cwd || process.cwd(),
    thinking: sessionThinking ?? "medium",
    sessionId,
    contextFiles: contextFiles.map(f => f.path),
    cols: terminalSize().cols,
    unicode: supportsUnicode(),
    color: welcomeTheme.color,
    accent: accentPaint(welcomeTheme),
    accentShadow: accentShadowPaint(welcomeTheme),
  }).join("\n"));

  const upd = await Promise.race([updatePromise, new Promise<null>(r => setTimeout(() => r(null), 1200))]);
  if (upd?.updateAvailable) console.log(renderUpdateBox(upd.current, upd.latest).join("\n"));
  if (!LaunchTui.usable(flags.noTui)) console.log("(plain output)");

  const useTui = LaunchTui.usable(flags.noTui);
  const runSkillInvocation = async (skill: SkillDoc, intent: string, invokedAs?: string): Promise<void> => {
    const isBundleWorkflow = ["deep-interview", "ralplan", "team", "ultragoal"].includes(skill.name);
    if (isBundleWorkflow) {
      const startMsg: Message = {
        role: "system",
        content: `[workflow:${skill.name}:start]${intent ? ` intent: ${intent}` : ""}`
      };
      history.push(startMsg);
      if (sessionId) {
        await appendMessage(sessionId, startMsg, cwd);
      }

      const harness = createInFlightAbortHarness({
        captureEsc: false,
        onAbortNotice: msg => console.log(msg),
        onHardExit: () => process.exit(130),
      });
      const ac = harness.controller;

      const opts = {
        cwd,
        signal: ac.signal,
        onProgress: (e: { skill: string; phase: string; detail?: string }) => console.log(`[workflow:${e.skill}] ${e.phase}${e.detail ? ` — ${e.detail}` : ""}`),
        io: {
          output: (line: string) => {
            console.log(line);
          },
          input: async () => {
            const wasPreviewArmed = previewArmed;
            if (wasPreviewArmed) {
              disarmPreview();
              previewArmed = false;
            }
            try {
              // EOF-safe prompt: a closed stdin yields "/exit" instead of a
              // never-settling question that would hang the workflow forever.
              return await promptInput("");
            } finally {
              if (wasPreviewArmed) {
                previewArmed = true;
                armPreview();
              }
            }
          }
        },
        args: skill.name === "deep-interview" ? (intent ? intent.split(/\s+/) : []) : undefined
      };

      let ok = false;
      let reason: string | undefined;
      try {
        let res: { ok: boolean; reason?: string };
        if (skill.name === "deep-interview") {
          res = await runDeepInterviewEngine(opts);
        } else if (skill.name === "ralplan") {
          res = await runRalplanEngine(opts);
        } else if (skill.name === "team") {
          res = await runTeamEngine(opts);
        } else {
          res = await runUltragoalEngine(opts);
        }
        ok = res.ok;
        reason = res.reason;
      } catch (err: any) {
        ok = false;
        reason = err.message;
      } finally {
        harness.dispose();
      }

      const endMsg: Message = {
        role: "system",
        content: ok 
          ? `[workflow:${skill.name}:finish]` 
          : `[workflow:${skill.name}:abort]${reason ? ` reason: ${reason}` : ""}`
      };
      history.push(endMsg);
      if (sessionId) {
        await appendMessage(sessionId, endMsg, cwd);
      }
    } else {
      // Drive the agent loop to EXECUTE the skill (don't just dump the doc). A concise
      // banner replaces the old full-doc print; the live TUI shows progress, and the
      // final reply is the skill's result.
      if (!useTui) console.log(`▶ Running skill: ${skill.name}${intent ? ` — ${intent}` : ""}`);
      const task = buildSkillTask(skill, intent, invokedAs);
      const { reply, rendered, usage } = await runTurn(task, useTui);
      if (!rendered) console.log(`jeo> ${renderMarkdownTables(reply)}${usage}`);
      else if (usage) console.log(usage.trim());
    }
  };

  // Tab autocomplete: alias names snapshotted once; live models come from the
  // background-warmed cache (logged-in/OAuth accounts). The completer is sync, so
  // it never blocks on the network — it reads whatever the cache currently holds.
  const aliasNames = Object.keys(await listAliases());
  void getLiveModels()
    .then(r => {
      liveModelsCache ??= r;
    })
    .catch(() => {});
  const mentionPaths = (prefix: string): string[] => {
    const norm = prefix.replace(/\\/g, "/");
    const wantsDirChildren = norm.endsWith("/");
    const dirPart = wantsDirChildren ? norm.slice(0, -1) : path.posix.dirname(norm) === "." ? "" : path.posix.dirname(norm);
    const namePart = wantsDirChildren ? "" : path.posix.basename(norm);
    const absDir = path.resolve(cwd, dirPart || ".");
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter(entry => !entry.name.startsWith("."))
      .filter(entry => !namePart || entry.name.toLowerCase().startsWith(namePart.toLowerCase()))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 50)
      .map(entry => {
        const rel = dirPart ? `${dirPart}/${entry.name}` : entry.name;
        return entry.isDirectory() ? `${rel}/` : rel;
      });
  };
  const completionContext = (): CompletionContext => {
    const base = staticCompletionContext();
    return {
      ...base,
      slashCommands: [...base.slashCommands, ...skillSlashDetails.map(d => d.command)],
      liveModels: liveModelsCache ? flattenModels(liveModelsCache).map(e => e.model) : [],
      aliases: aliasNames,
      skillNames: resolvedSkillNames,
      modelsForProvider: p => liveModelsCache?.find(r => r.provider === p)?.models ?? [],
      mentionPaths,
    };
  };
  let previewArmed = false;
  let pickerActive = false;
  const rl = createInterface({
    input: process.stdin,
    // Single-box input: gate readline's output while the boxed footer is armed so its own
    // `jeo>` prompt/echo is suppressed and ONLY our box shows. (Bun exposes no
    // `_writeToOutput` to patch, so gating the shared output stream is the portable fix.)
    // The gate also covers active select pickers: they disarm the preview, which
    // previously OPENED the gate and let readline echo typed filter characters
    // (CJK wide chars especially) straight onto the picker frame — the
    // "stacked input-box borders" corruption.
    output: gatedStdout(process.stdout, () => previewArmed || pickerActive),
    completer: (line: string) => readlineCompleter(line, completionContext()),
  });
  // Stdin EOF must END the REPL, not hang it: under Bun a pending `rl.question`
  // NEVER settles once the input stream closes (Ctrl-D, exhausted pipe) — the
  // while(true) prompt loop then waits forever (the "joc never exits" hang).
  // Bun's readline also DROPS piped lines that arrive between prompts (question()
  // only captures the line submitted while it is registered; orphan lines emit
  // 'line' instead), so queue those and serve them before prompting again.
  const pendingStdinLines: string[] = [];
  rl.on("line", l => { pendingStdinLines.push(l); });
  let stdinClosed = false;
  let notifyStdinClosed: (() => void) | undefined;
  // `on` + one-shot guard (not `once`): test harnesses stub readline with `on`/`question` only.
  rl.on("close", () => { if (stdinClosed) return; stdinClosed = true; notifyStdinClosed?.(); });
  /** `rl.question` that resolves "/exit" on stdin EOF instead of hanging forever. */
  const promptInput = async (prompt: string): Promise<string> => {
    const queued = pendingStdinLines.shift();
    if (queued !== undefined) return queued;
    if (stdinClosed) return "/exit";
    try {
      return await Promise.race([
        rl.question(prompt),
        new Promise<string>(resolve => { notifyStdinClosed = () => resolve(pendingStdinLines.shift() ?? "/exit"); }),
      ]);
    } finally {
      notifyStdinClosed = undefined;
    }
  };

  // Mouse-wheel scroll during a live turn (tmux or plain terminal) can inject
  // arrow/scroll escape sequences into stdin; readline buffers them into its
  // pending line and the NEXT prompt then shows/executes garbage. Drain any
  // pending tty input and clear readline's buffered line before each prompt.
  const drainPendingTtyInput = (): void => {
    if (!process.stdin.isTTY) return;
    try {
      while (process.stdin.read() !== null) { /* discard wheel/arrow noise typed mid-turn */ }
    } catch { /* stream not readable in this state — nothing buffered */ }
    const r = rl as unknown as { line?: string; cursor?: number };
    if (typeof r.line === "string" && r.line.length > 0 && /\x1b|\[[ABCD]/.test(r.line)) {
      r.line = "";
      r.cursor = 0;
    }
  };

  // Live slash preview pinned to a reserved bottom footer via a DEC scroll region
  // (DECSTBM). The region is armed ONLY while waiting for input, and disarmed for
  // turns/command output so the full-screen turn TUI renders normally. The footer
  // is drawn at absolute rows (per-row clear → no scroll, no duplication).
  // Opt out with JOC_NO_SLASH_PREVIEW=1; auto-off on short terminals.
  const currentAtLabel = (line: string): string | undefined => {
    const { tokens } = tokenize(line);
    const token = [...tokens].reverse().find(t => t.startsWith("@"));
    if (!token) return undefined;
    const norm = token.slice(1).replace(/\\/g, "/");
    if (!norm) return "@ .";
    if (norm.endsWith("/")) return `@ ${norm.slice(0, -1) || "."}`;
    const dir = path.posix.dirname(norm);
    return `@ ${dir === "." ? norm : dir}`;
  };
  // Boxed-input footer height — ADAPTIVE so short terminals/panes still get the single
  // boxed input instead of silently falling back to the raw `jeo>` prompt (previously
  // any terminal under 17 rows lost the box entirely and showed bare CLI input).
  const MAX_PREVIEW_ROWS = 12;
  const MIN_PREVIEW_ROWS = 6; // status bar (1) + input box (3 rows) + 2 preview rows
  const previewRowsFor = (rows: number): number => Math.max(MIN_PREVIEW_ROWS, Math.min(MAX_PREVIEW_ROWS, rows - 6));
  const previewEnabled =
    process.stdin.isTTY &&
    (process.env.JEO_NO_SLASH_PREVIEW ?? process.env.JOC_NO_SLASH_PREVIEW) !== "1" &&
    (process.stdout.rows ?? 24) >= MIN_PREVIEW_ROWS + 6; // box + ≥6 scrollable content rows
  // Footer height reserved by the CURRENTLY armed region; disarm/draw must use the
  // same value the arm computed, even if the terminal was resized in between.
  let footerRows = MAX_PREVIEW_ROWS;
  const out = process.stdout;
  // Arrow-key selection over the slash preview list.
  let navMatches: string[] = []; // command names matching the typed keyword (display order)
  let navIdx = -1; // highlighted row, -1 = none
  let typedLine = ""; // the user-typed line (restored after readline's history nav)
  let pendingSelection: string | undefined; // command chosen via arrows, applied on Enter
  let pendingImages: ImageAttachment[] = []; // clipboard images attached to the next message (ctrl+v)
  let pasteInFlight = false; // guard concurrent ctrl+v clipboard reads
  let idleDirtyCount: number | undefined; // git dirty count refreshed once per prompt
  let lastFooterKey = "";
  const logLines = (lines: string | string[]) => {
    const arr = Array.isArray(lines) ? lines : [lines];
    const cols = Math.max(20, (process.stdout.columns ?? 80) - 1);
    for (const line of arr) {
      console.log(truncateAnsi(line, cols));
    }
  };
  let previewPending = false;

  // Inline boxed-footer rendering with a FIXED reservation (the "@-mention typing
  // pushes the box down" fix). The footer reserves its full `footerRows` height
  // eagerly on arm (one-time scroll cost), and every redraw paints inside that
  // reservation with CUD (cursor-down) only — never `\n`. The old grow path emitted
  // `\n` whenever lines.length > footerRendered, and `\n` at the bottom margin
  // SCROLLS the terminal: every keystroke that wrapped the input box body or grew
  // the `Paths:` preview ate a row of prior output and misaligned the next repaint.
  // With a fixed reservation, footer height is constant for the lifetime of the
  // prompt, so the box can never grow, scroll, or break alignment.
  let footerRendered = 0; // rows of the reserved region (= footerRows once armed)
  // Caret cell of the boxed input (row relative to the reservation top, 1-based col),
  // recomputed by previewLines from readline's live rl.cursor. drawFooter parks the
  // REAL terminal cursor there, so the blinking caret sits right after the `>` prompt
  // and visibly follows arrow-key movement.
  let footerCursor = { row: 0, col: 1 };
  // Row (within the reservation) where the real cursor was last parked; the next
  // drawFooter/disarmPreview must hop back to the top from here before painting.
  let footerParkedRow = 0;
  const padToFooter = (lines: string[]): string[] => {
    if (lines.length >= footerRows) return lines.slice(0, footerRows);
    return [...lines, ...new Array(footerRows - lines.length).fill("")];
  };
  const armPreview = () => {
    if (!previewEnabled || previewArmed) return;
    footerRows = previewRowsFor(process.stdout.rows ?? 24);
    // Reserve `footerRows` bottom rows: write blank newlines (the terminal scrolls
    // ONCE here, not on every keystroke), then park the cursor at the top of the
    // reservation. Every subsequent drawFooter call stays inside this region.
    if (footerRows > 1) {
      out.write("\n".repeat(footerRows - 1) + cursorUp(footerRows - 1));
    }
    out.write(toColumn(1));
    footerRendered = footerRows;
    footerParkedRow = 0;
    previewArmed = true;
    lastFooterKey = "";
  };
  // Clear the reserved region and park the cursor at its top row so subsequent
  // command output starts where the box was (and inherits the existing scrollback).
  const disarmPreview = () => {
    if (!previewArmed) return;
    previewArmed = false;
    lastFooterKey = "";
    if (footerRendered > 0) {
      // Hop back to the reservation top from wherever the caret was parked.
      let s = footerParkedRow > 0 ? cursorUp(footerParkedRow) : "";
      footerParkedRow = 0;
      for (let i = 0; i < footerRendered; i++) {
        s += toColumn(1) + clearLine();
        if (i < footerRendered - 1) s += "\x1b[1B"; // CUD: no scroll at bottom margin
      }
      if (footerRendered > 1) s += cursorUp(footerRendered - 1);
      s += toColumn(1) + "\x1b[?25h";
      out.write(s);
      footerRendered = 0;
    } else {
      out.write("\x1b[?25h");
    }
  };
  // The gjc-layout status bar pinned directly ABOVE the input box: bg-gradient
  // identity block (model · thinking / branch / cwd) left, live ctx% right.
  const statusBarLine = (cols: number): string => {
    const activeModel = sessionModel || defaultModel;
    const meta = catalogMetadata(activeModel);
    const used = historyTokens(history);
    const theme = resolveTheme(process.env);
    return renderStatusBar({
      model: activeModel,
      thinking: sessionThinking,
      branch,
      dirtyCount: idleDirtyCount,
      cwd,
      ctxPct: meta?.contextTokens ? (used / meta.contextTokens) * 100 : undefined,
      ctxMaxTokens: meta?.contextTokens,
      cols,
      unicode: true,
      color: theme.color,
      colorLevel: detectColorLevel(process.env, true),
      gradient: themeGradient(theme, 2),
    });
  };
  const previewLines = (line: string, selected = -1): string[] => {
    const cols = Math.max(24, (process.stdout.columns ?? 80) - 1);
    // Caret offset comes from readline's live cursor when it matches the rendered
    // line (arrow keys/Home/End move it); otherwise (history nav mismatch) caret
    // sits at the end of the text.
    const rli = rl as unknown as { line?: string; cursor?: number };
    const caret = rli.line === line && typeof rli.cursor === "number" ? rli.cursor : line.length;
    const frame = renderInputFrame(line, {
      cols,
      color: true,
      unicode: true,
      accent: accentPaint(resolveTheme(process.env)),
      accentShadow: accentShadowPaint(resolveTheme(process.env)),
      cwdLabel: currentAtLabel(line),
      attachmentLabel: pendingImages.length
        ? `⧉ ${pendingImages.length} image${pendingImages.length > 1 ? "s" : ""} attached — sent with the next message`
        : undefined,
      maxBodyRows: Math.max(1, footerRows - 6),
      cursor: caret,
    });
    const input = frame.lines.map(l => truncateAnsi(l, cols));
    // Row 0 is the status bar, so the caret (and everything else) shifts down one row.
    footerCursor = {
      row: Math.max(0, Math.min(frame.cursorRow + 1, footerRows - 1)),
      col: Math.max(1, Math.min(frame.cursorCol, cols)),
    };
    const budget = Math.max(0, footerRows - 1 - input.length);
    const slash = budget > 0 ? formatSlashPreview(line, budget, selected, skillSlashDetails, resolvedSkills) : [];
    const args = !slash.length && budget > 0 ? formatCompletionPreview(line, completionContext(), budget) : [];
    const preview = (slash.length ? slash : args).map(l => chalk.gray(truncateAnsi(l, cols)));
    return [statusBarLine(cols), ...input, ...preview].slice(0, footerRows);
  };
  const drawFooter = (lines: string[]) => {
    if (!previewArmed || footerRendered === 0) return;
    // ALWAYS paint exactly footerRendered rows so the reservation is fully covered
    // and no row can spill past it — the bug fix that kept `@folder<more text>`
    // typing from scrolling the input box (and prior output) off the top.
    const padded = padToFooter(lines);
    // Pure caret moves (arrow keys) change no content — include the caret cell in
    // the repaint key so they still reposition the terminal cursor.
    const tRow = lines.length ? Math.min(footerCursor.row, footerRendered - 1) : 0;
    const tCol = lines.length ? footerCursor.col : 1;
    const key = `${padded.join("\n")}\u0000${tRow}:${tCol}`;
    if (key === lastFooterKey) return;
    lastFooterKey = key;
    // Hop back to the reservation top from the previously parked caret row, then
    // paint top→bottom using CUD only.
    let s = footerParkedRow > 0 ? cursorUp(footerParkedRow) : "";
    s += toColumn(1);
    for (let i = 0; i < footerRendered; i++) {
      s += toColumn(1) + clearLine();
      if (padded[i]) s += padded[i];
      if (i < footerRendered - 1) s += "\x1b[1B"; // CUD: never scroll
    }
    if (footerRendered > 1) s += cursorUp(footerRendered - 1);
    // Park the REAL cursor at the caret cell (right after the `>` prompt) so the
    // blinking terminal cursor marks the insertion point and follows arrow keys.
    s += toColumn(1);
    if (tRow > 0) s += `\x1b[${tRow}B`;
    s += toColumn(tCol) + "\x1b[?25h";
    footerParkedRow = tRow;
    out.write(s);
  };

  // ESC / Ctrl+C at the prompt: wipe the typed text (and detach any pending
  // clipboard images — their `[image #N]` tags live in that text) instead of
  // leaving stale input. Returns true when something was actually cleared.
  const clearTypedInput = (): boolean => {
    const rli = rl as unknown as { line: string; cursor: number; _refreshLine?: () => void };
    if ((rli.line?.length ?? 0) === 0 && pendingImages.length === 0) return false;
    rli.line = "";
    rli.cursor = 0;
    rli._refreshLine?.();
    pendingImages = [];
    typedLine = "";
    navMatches = [];
    navIdx = -1;
    pendingSelection = undefined;
    if (previewArmed) drawFooter(previewLines(""));
    return true;
  };
  // Ctrl+C at the prompt: the FIRST press clears the typed line (zsh/gjc-style)
  // — and pressing ^C again in quick succession (≤2s, nothing left to clear)
  // EXITS the process gracefully by resolving the pending prompt as /exit, so
  // the normal quit path (session save, resume pointer) runs. Mid-turn ^C
  // aborts stay with the separate raw-mode turn harness, not this listener.
  let lastSigintAt = 0;
  const SIGINT_EXIT_WINDOW_MS = 2000;
  rl.on("SIGINT", () => {
    if (pickerActive) return;
    const now = Date.now();
    const consecutive = now - lastSigintAt <= SIGINT_EXIT_WINDOW_MS;
    lastSigintAt = now;
    if (clearTypedInput()) {
      if (previewArmed) {
        const lines = previewLines("");
        lines.push(chalk.gray("  ^C cleared input — press ^C again to exit"));
        drawFooter(lines);
      }
      return;
    }
    if (consecutive) {
      // Second consecutive ^C with nothing to clear → graceful /exit: inject the
      // command through readline's own input path (rl.write submits the line and
      // resolves the pending rl.question), so the normal quit path — session save,
      // resume pointer — runs exactly as if the user typed /exit.
      try {
        rl.write("/exit\n");
      } catch {
        // Input path unavailable (stream closing) — exit directly but restore the
        // terminal first so the shell prompt isn't left on a hidden cursor.
        disarmPreview();
        out.write("\x1b[?25h\n");
        process.exit(0);
      }
      return;
    }
    if (previewArmed) {
      const lines = previewLines("");
      lines.push(chalk.gray("  ^C — press ^C again to exit · /exit to quit"));
      drawFooter(lines);
    }
  });

  const runSelectPicker = async <T>(
    render: (cols: number, rows: number) => string[],
    onKey: (ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => boolean | undefined,
  ): Promise<void> => {
    pickerActive = true; // closes the readline output gate for the picker's lifetime
    disarmPreview();
    // NOTE: deliberately NOT rl.pause() — pausing stops the underlying stdin stream,
    // which would also starve the picker's own "keypress" listener (picker hang).
    // Echo suppression is handled by the output gate above; raw mode (kept below)
    // prevents terminal-driver local echo.
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.setRawMode && !wasRaw) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    const cols = Math.max(40, terminalSize().cols - 2);
    const rows = Math.max(6, terminalSize().rows - 6);
    let rendered = 0;
    const repaint = () => {
      const lines = render(cols, rows).map(line => truncateAnsi(line, cols));
      const total = Math.max(rendered, lines.length);
      // First paint: drop down ONCE to start on a fresh row; subsequent paints:
      // cursor sits on the LAST rendered row, so cursorUp(rendered - 1) returns
      // to row 0 of the prior block (off-by-one fix — the old `cursorUp(rendered)`
      // landed ABOVE the block, so each repaint duplicated the trailing hint
      // line below the picker instead of overwriting it).
      let s = rendered > 0 ? (rendered > 1 ? cursorUp(rendered - 1) : "") + toColumn(1) : "\n";
      for (let i = 0; i < total; i++) {
        s += toColumn(1) + clearLine();
        if (i < lines.length) s += lines[i]!;
        // Rows the block already occupies move with CUD (no scroll at the bottom
        // margin → no anchor drift); only genuinely NEW rows use a real newline.
        if (i < total - 1) s += i < rendered - 1 ? "\x1b[1B" + toColumn(1) : "\n";
      }
      out.write(s + "\x1b[?25h");
      rendered = total;
    };
    const clear = () => {
      if (rendered <= 0) return;
      // Same off-by-one: from last row, cursorUp(rendered - 1) reaches row 0.
      let s = (rendered > 1 ? cursorUp(rendered - 1) : "") + toColumn(1);
      for (let i = 0; i < rendered; i++) {
        s += toColumn(1) + clearLine();
        // Every row here already exists — CUD only, never a scrolling newline.
        if (i < rendered - 1) s += "\x1b[1B" + toColumn(1);
      }
      // Park back at the first cleared row so post-picker output starts there.
      if (rendered > 1) s += cursorUp(rendered - 1);
      s += toColumn(1);
      out.write(s + "\x1b[?25h");
      rendered = 0;
    };
    repaint();
    try {
      await new Promise<void>(resolve => {
        const handler = (ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
          const done = onKey(ch, key);
          if (done) {
            process.stdin.off("keypress", handler);
            clear();
            resolve();
            return;
          }
          repaint();
        };
        process.stdin.on("keypress", handler);
      });
    } finally {
      if (process.stdin.setRawMode && !wasRaw) {
        process.stdin.setRawMode(false);
      }
      // Keys typed while the picker was open also landed in readline's hidden
      // line buffer; without this the NEXT prompt starts pre-filled with the
      // picker's filter text (invisible until submitted as garbage input).
      const rli = rl as unknown as { line?: string; cursor?: number };
      if (typeof rli.line === "string" && rli.line.length > 0) {
        rli.line = "";
        rli.cursor = 0;
      }
      pickerActive = false;
    }
  };

  // Antigravity with ANY Google OAuth (own login or the gemini-cli fallback) stays
  // SELECTABLE in pickers even when not call-ready: picking the model is how users
  // reach the flow, and the auth layer gives actionable login guidance on the first
  // call if the fallback token is rejected (403). Refusing selection was a dead end.
  const selectableThoughNotReady = (st?: { name: string; kind: string }): boolean =>
    !!st && st.name === "antigravity" && st.kind === "oauth";
  const notReadyWarning = (st: { name: string; label: string }): string =>
    `  ! ${st.name} is not call-ready yet (${st.label}) — run /provider login antigravity before the first turn.`;

  const pickLiveProviderModel = async (
    providerName: string,
    entries: PickEntry[],
    current?: string,
    disabledProviders: readonly ProviderName[] = [],
  ): Promise<PickEntry | undefined> => {
    if (!process.stdin.isTTY || entries.length === 0) return undefined;
    const list = liveModelPicker(entries, { current, disabledProviders, disabledHint: "needs API key/base URL" });
    let chosen: PickEntry | undefined;
    await runSelectPicker(
      (cols, rows) =>
        renderLiveModelPicker(list, {
          title: `Select ${providerName} model`,
          cols,
          rows: Math.max(4, Math.min(rows, 12)),
          unicode: true,
          color: true,
        }),
      (ch, key) => {
        if (key?.name === "up") {
          list.up();
          return false;
        }
        if (key?.name === "down") {
          list.down();
          return false;
        }
        if (key?.name === "pageup") {
          list.page(-1, 6);
          return false;
        }
        if (key?.name === "pagedown") {
          list.page(1, 6);
          return false;
        }
        if (key?.name === "backspace") {
          list.backspace();
          return false;
        }
        if (key?.name === "escape" || (key?.ctrl && key.name === "c")) {
          return true;
        }
        if (key?.name === "return" || key?.name === "enter") {
          chosen = list.selected()?.value;
          return true;
        }
        if (ch && ch >= " " && !key?.ctrl && !key?.meta) {
          list.typeChar(ch);
        }
        return false;
      },
    );
    return chosen;
  };

  const pickSkillFromList = async (skills: SkillDoc[]): Promise<SkillDoc | undefined> => {
    if (!process.stdin.isTTY || skills.length === 0) return undefined;
    const list = skillPicker(skills);
    let chosen: SkillDoc | undefined;
    await runSelectPicker(
      (cols, rows) =>
        renderSkillPicker(list, {
          cols,
          rows: Math.max(4, Math.min(rows, 12)),
          unicode: true,
          color: true,
        }),
      (ch, key) => {
        if (key?.name === "up") {
          list.up();
          return false;
        }
        if (key?.name === "down") {
          list.down();
          return false;
        }
        if (key?.name === "pageup") {
          list.page(-1, 6);
          return false;
        }
        if (key?.name === "pagedown") {
          list.page(1, 6);
          return false;
        }
        if (key?.name === "backspace") {
          list.backspace();
          return false;
        }
        if (key?.name === "escape" || (key?.ctrl && key.name === "c")) {
          return true;
        }
        if (key?.name === "return" || key?.name === "enter") {
          chosen = list.selected()?.value;
          return true;
        }
        if (ch && ch >= " " && !key?.ctrl && !key?.meta) {
          list.typeChar(ch);
        }
        return false;
      },
    );
    return chosen;
  };

  const pickCloudProvider = async (statuses: Awaited<ReturnType<typeof describeAllProviders>>): Promise<AuthProvider | undefined> => {
    const cloud = new Set(["anthropic", "openai", "gemini", "antigravity"]);
    const list = providerPicker(statuses.filter(s => cloud.has(s.name)), true);
    let chosen: ProviderName | undefined;
    await runSelectPicker(
      (cols, rows) =>
        renderProviderPicker(list, {
          title: "Select OAuth provider",
          cols,
          rows: Math.max(4, Math.min(rows, 8)),
          unicode: true,
          color: true,
        }),
      (ch, key) => {
        if (key?.name === "up") {
          list.up();
          return false;
        }
        if (key?.name === "down") {
          list.down();
          return false;
        }
        if (key?.name === "pageup") {
          list.page(-1, 4);
          return false;
        }
        if (key?.name === "pagedown") {
          list.page(1, 4);
          return false;
        }
        if (key?.name === "backspace") {
          list.backspace();
          return false;
        }
        if (key?.name === "escape" || (key?.ctrl && key.name === "c")) {
          return true;
        }
        if (key?.name === "return" || key?.name === "enter") {
          chosen = list.selected()?.value;
          return true;
        }
        if (ch && ch >= " " && !key?.ctrl && !key?.meta) {
          list.typeChar(ch);
        }
        return false;
      },
    );
    return chosen && cloud.has(chosen) ? chosen as AuthProvider : undefined;
  };

  if (previewEnabled) {
    process.once("exit", () => out.write("\x1b[?25h")); // safety net: never leave the cursor hidden
    process.stdin.on("keypress", (_ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
      // Ctrl+O: dump the FULL last assistant reply (untruncated, tables rendered) into
      // scrollback as a detail view, then restore the boxed footer. (Cmd+O is intercepted
      // by the OS/terminal and never reaches the app, so Ctrl+O is the portable binding.)
      if (key?.ctrl && key.name === "o") {
        if (!lastReply) return;
        const wasArmed = previewArmed;
        if (wasArmed) disarmPreview();
        const sep = "─".repeat(Math.min(48, Math.max(20, (process.stdout.columns ?? 80) - 1)));
        logLines([sep, "detail · full last response (ctrl+o)", sep, ...renderMarkdownTables(lastReply).split("\n"), sep]);
        if (wasArmed) { armPreview(); drawFooter(previewLines(typedLine, navIdx)); }
        return;
      }
      // Ctrl+V: attach a clipboard IMAGE to the next message. Terminal text paste
      // never arrives as a ctrl+v keypress (it streams as plain stdin data), so this
      // binding is image-only; when the clipboard holds no image it's a silent no-op.
      if (key?.ctrl && key.name === "v") {
        if (pasteInFlight) return;
        pasteInFlight = true;
        void (async () => {
          try {
            const img = await readClipboardImage();
            if (!img) return;
            pendingImages.push(img);
            const tag = `[image #${pendingImages.length}]`;
            const rli = rl as unknown as { line: string; cursor: number };
            const at = typeof rli.cursor === "number" ? rli.cursor : rli.line.length;
            const sep = rli.line.length > 0 && at > 0 && rli.line[at - 1] !== " " ? " " : "";
            rli.line = rli.line.slice(0, at) + sep + tag + " " + rli.line.slice(at);
            rli.cursor = at + sep.length + tag.length + 1;
            typedLine = rli.line;
            if (previewArmed) drawFooter(previewLines(typedLine, navIdx));
          } finally {
            pasteInFlight = false;
          }
        })();
        return;
      }
      if (pickerActive || previewPending) return;
      // ESC (or a meta-mapped Cmd+C) at the prompt: wipe the typed text. A bare
      // ESC decodes as `escape` (meta is set for a lone ESC byte — accept both)
      // only after readline's escape-sequence timeout, so arrow/wheel sequences
      // never trigger this.
      if (key && ((key.name === "escape" && !key.ctrl) || (key.meta && key.name === "c"))) {
        clearTypedInput();
        return;
      }
      // Ctrl+C is owned end-to-end by the rl SIGINT listener (clear or quit hint);
      // skipping the generic redraw here keeps that hint from being overwritten.
      if (key?.ctrl && key.name === "c") return;
      previewPending = true;
      setImmediate(() => {
        previewPending = false;
        if (!previewArmed) return;
        try {
          if (key && (key.name === "return" || key.name === "enter")) {
            drawFooter([]);
            return;
          }
          // Arrow up/down: move the highlight over the slash keyword preview list.
          // Once the user types a real argument (`/subagent `, `/provider login `, ...),
          // we stop intercepting arrows and just show the live completion preview.
          if (key && (key.name === "up" || key.name === "down") && navMatches.length > 0) {
            const rli = rl as unknown as { line: string; cursor: number; _refreshLine?: () => void };
            if (rli.line !== typedLine) {
              rli.line = typedLine;
              rli.cursor = typedLine.length;
              rli._refreshLine?.();
            }
            if (navIdx === -1) navIdx = key.name === "down" ? 0 : navMatches.length - 1;
            else navIdx = (navIdx + (key.name === "down" ? 1 : -1) + navMatches.length) % navMatches.length;
            pendingSelection = navMatches[navIdx];
            drawFooter(previewLines(typedLine, navIdx));
            return;
          }
          // Any other key edits the line: refresh the slash-keyword matches (if any),
          // reset the highlight, and show either the command preview or argument preview.
          typedLine = rl.line;
          navMatches = slashPreviewMatches(typedLine, skillSlashDetails, resolvedSkills);
          navIdx = -1;
          pendingSelection = undefined;
          drawFooter(previewLines(typedLine));
        } catch { /* ignore render races */ }
      });
    });
    // Idle-prompt resize: re-reserve the footer at the new terminal height so the
    // fixed reservation stays accurate (otherwise the next paint would target the
    // old row count and either over-shoot or under-paint the reserved region).
    process.stdout.on("resize", () => {
      if (!previewArmed) return;
      try {
        disarmPreview();
        armPreview();
        drawFooter(previewLines(typedLine, navIdx));
      } catch { /* ignore resize render races */ }
    });
  }

  while (true) {
      drainPendingTtyInput();
      // Refresh the status bar's dirty flag once per prompt (one git spawn, not per frame).
      idleDirtyCount = branch ? gitDirtyCount(cwd) : undefined;
      armPreview();
      // Render the boxed input immediately (placeholder) so the prompt is visible
      // even though readline's own "jeo>" echo is now suppressed in box mode.
      typedLine = "";
      navMatches = [];
      navIdx = -1;
      drawFooter(previewLines(""));
      // Box mode: NO raw `jeo>` prompt at all — the boxed footer IS the input UI
      // (gating already suppresses readline echo, the empty prompt guarantees no
      // raw CLI input line can ever flash). Legacy prompt only without the box.
      const raw = (await promptInput(previewEnabled ? "" : "\njoc> ")).trim();
      disarmPreview();
      // If an arrow-key selection was made over the slash/skill preview, run it.
      let input = pendingSelection && (isSlashAttempt(raw) || raw.startsWith("$")) && pendingSelection.startsWith(raw)
        ? pendingSelection
        : raw;
      // gjc-parity command aliases (full behavior reuse, no duplicated handlers).
      if (input === "/login" || input.startsWith("/login ")) input = `/provider login${input.slice("/login".length)}`;
      else if (input === "/settings") input = "/config";
      pendingSelection = undefined;
      navMatches = [];
      navIdx = -1;
      if (input === "/exit" || input === "/quit") break;
      if (input === "") {
        if (pendingImages.length === 0) continue;
        input = "Please look at the attached image(s)."; // image-only submit
      }
      if (input === "/" || input === "/?" || input === "/help") {
        logLines(formatSlashCommandList(input === "/help" ? "/" : input, skillSlashDetails));
        console.log("Tools: read / write / edit / bash / find / search. Sessions persist to .joc/sessions/.");
        const tip = getEvolutionTip(history.length, flags.maxSteps > 0 ? flags.maxSteps : initialStepLimit);
        console.log(`\n${chalk.cyan("Evolutionary Tip:")} ${tip}`);
        continue;
      }
      if (input === "/clear") {
        history.length = 1;
        console.log("(history cleared)");
        continue;
      }
      if (input === "/compact") {
        const turnConfig = await readGlobalConfig();
        const activeModel = sessionModel || turnConfig.defaultModel;
        const contextTokens = catalogMetadata(activeModel)?.contextTokens;
        const res = await maybeCompact(history, { model: sessionModel, force: true, contextTokens });
        if (res.error) {
          console.error(chalk.red(res.error));
        } else if (res.compacted && sessionId && res.replacesThrough !== undefined) {
          const summaryText = res.summary ?? `[Earlier conversation omitted: ${res.removed} messages — summary unavailable]`;
          await appendCompaction(sessionId, ++compactionSeq, summaryText, res.replacesThrough, cwd);
          console.log(`(compacted ${res.removed} older messages)`);
        } else {
          console.log("(nothing to compact)");
        }
        continue;
      }
      if (input === "/sessions") {
        const sessions = await listSessions(cwd);
        if (sessions.length === 0) console.log("(no saved sessions)");
        for (const s of sessions) {
          const marker = s.id === sessionId ? "*" : " ";
          const title = s.title ? `[${s.title}] ` : "";
          console.log(` ${marker}${s.id}  (${s.messageCount} msgs)  ${title}${s.preview}`);
        }
        continue;
      }
      // ---- gjc-parity session management ------------------------------------
      const startFreshSession = async (verb: string): Promise<void> => {
        history.length = 1;
        if (!flags.noSession) {
          sessionId = (await createSession(cwd)).id;
          console.log(`(${verb} — new session ${sessionId})`);
        } else {
          sessionId = undefined;
          console.log(`(${verb} — sessions disabled)`);
        }
      };
      if (input === "/new") {
        await startFreshSession("started fresh");
        continue;
      }
      if (input === "/drop") {
        if (sessionId) {
          const removed = await deleteSession(sessionId, cwd);
          console.log(removed ? `(deleted session ${sessionId})` : `(session ${sessionId} already gone)`);
        }
        await startFreshSession("dropped");
        continue;
      }
      if (input === "/session" || input.startsWith("/session ")) {
        const sub = input.substring(8).trim().toLowerCase();
        if (sub === "delete") {
          if (!sessionId) {
            console.log("(sessions are disabled — nothing to delete)");
            continue;
          }
          const removed = await deleteSession(sessionId, cwd);
          console.log(removed ? `(deleted session ${sessionId})` : `(session ${sessionId} already gone)`);
          await startFreshSession("dropped");
          continue;
        }
        if (sub && sub !== "info") {
          console.log("Usage: /session [info|delete]");
          continue;
        }
        if (!sessionId) {
          console.log("Session: disabled (--no-session)");
          continue;
        }
        const all = await listSessions(cwd);
        const current = all.find(s => s.id === sessionId);
        console.log("Session info:");
        console.log(`  id        ${sessionId}`);
        if (current?.title) console.log(`  title     ${current.title}`);
        console.log(`  file      ${sessionPath(sessionId, cwd)}`);
        console.log(`  started   ${current?.timestamp ?? "(this run)"}`);
        console.log(`  messages  ${current?.messageCount ?? Math.max(0, history.length - 1)} persisted · ${history.length - 1} in context`);
        console.log(`  workspace ${cwd}`);
        continue;
      }
      if (input === "/rename" || input.startsWith("/rename ")) {
        const title = input.substring(7).trim();
        if (!title) {
          console.log("Usage: /rename <title>");
          continue;
        }
        if (!sessionId) {
          console.log("(sessions are disabled — nothing to rename)");
          continue;
        }
        try {
          await renameSession(sessionId, title, cwd);
          console.log(`(session renamed to '${title}')`);
        } catch (err) {
          console.log(`! rename failed: ${(err as Error).message}`);
        }
        continue;
      }
      if (input === "/resume" || input.startsWith("/resume ")) {
        const id = input.substring(7).trim();
        if (!id) {
          const sessions = await listSessions(cwd);
          if (sessions.length === 0) {
            console.log("(no saved sessions)");
            continue;
          }
          console.log("Saved sessions — resume with /resume <id>:");
          for (const s of sessions.slice(0, 15)) {
            const marker = s.id === sessionId ? "*" : " ";
            console.log(` ${marker}${s.id}  (${s.messageCount} msgs)  ${s.title ? `[${s.title}] ` : ""}${s.preview}`);
          }
          continue;
        }
        try {
          const { messages } = await loadSession(id, cwd);
          history.length = 1;
          for (const m of messages) history.push(m);
          sessionId = id;
          console.log(`Resumed session ${id} (${messages.length} messages).`);
        } catch (err) {
          console.log(`! ${(err as Error).message}`);
        }
        continue;
      }
      if (input === "/retry") {
        if (!lastUserInput) {
          console.log("(nothing to retry yet — send a request first)");
          continue;
        }
        console.log(`(retrying: ${lastUserInput.slice(0, 80)}${lastUserInput.length > 80 ? "…" : ""})`);
        try {
          const { done, steps, reply, rendered, usage } = await runTurn(lastUserInput, useTui);
        lastReply = reply;
          if (!rendered) {
            console.log(`jeo> ${renderMarkdownTables(reply)}${usage}`);
            if (!done) console.log(`(agent did not converge in ${steps} steps)`);
          } else if (usage) {
            console.log(usage.trim());
          }
        } catch (err) {
          console.log(`! ${friendlyProviderError(err)}`);
        }
        continue;
      }
      if (input === "/history" || input.startsWith("/history ")) {
        // Re-print the worked history into scrollback (tmux-friendly review of
        // past prompts / tool steps / replies without terminal scrollback access).
        const arg = input.slice("/history".length).trim().toLowerCase();
        const maxTurns = arg === "all" ? undefined : Math.max(1, Number.parseInt(arg, 10) || 5);
        const sep = "─".repeat(Math.min(48, Math.max(20, (process.stdout.columns ?? 80) - 1)));
        logLines([sep, `history · last ${maxTurns ?? "all"} turn(s) (/history all for everything)`, sep,
          ...formatTranscript(history, { maxTurns, color: true, unicode: true }), sep]);
        continue;
      }
      if (input === "/export" || input.startsWith("/export ")) {
        if (!sessionId) {
          console.log("(sessions are disabled — nothing to export)");
          continue;
        }
        const tokens = input.substring(7).trim().split(/\s+/).filter(Boolean);
        const fmtToken = tokens.find(t => t.toLowerCase() === "json" || t.toLowerCase() === "markdown");
        const format = fmtToken?.toLowerCase() === "json" ? "json" as const : "markdown" as const;
        const pathToken = tokens.find(t => t !== fmtToken);
        const outPath = path.resolve(cwd, pathToken ?? `jeo-session-${sessionId.slice(0, 8)}.${format === "json" ? "json" : "md"}`);
        try {
          const text = await exportSession(sessionId, format, cwd);
          await fs.promises.writeFile(outPath, text, "utf-8");
          console.log(`${categoryBadge("file")} exported ${format} transcript → ${outPath}`);
        } catch (err) {
          console.log(`! export failed: ${(err as Error).message}`);
        }
        continue;
      }
      if (input === "/dump") {
        if (!sessionId) {
          console.log("(sessions are disabled — nothing to dump)");
          continue;
        }
        try {
          const text = await exportSession(sessionId, "markdown", cwd);
          const clip = process.platform === "darwin" ? "pbcopy" : Bun.which("wl-copy") ? "wl-copy" : Bun.which("xclip") ? "xclip" : "";
          if (clip && Bun.which(clip)) {
            const proc = Bun.spawn(clip === "xclip" ? [clip, "-selection", "clipboard"] : [clip], { stdin: "pipe" });
            proc.stdin.write(text);
            await proc.stdin.end();
            await proc.exited;
            console.log(`(transcript copied to clipboard — ${text.length} chars)`);
          } else {
            console.log(text);
            console.log("(no clipboard tool found — transcript printed above)");
          }
        } catch (err) {
          console.log(`! dump failed: ${(err as Error).message}`);
        }
        continue;
      }
      if (input === "/btw" || input.startsWith("/btw ")) {
        const q = input.substring(4).trim();
        if (!q) {
          console.log("Usage: /btw <question>   (ephemeral side question — history stays untouched)");
          continue;
        }
        try {
          const side: Message[] = [
            { role: "system", content: "You are jeo. Answer the user's side question concisely in plain text using the conversation context. Do not call tools; reply directly." },
            ...history.slice(1).filter(m => m.role === "user" || m.role === "assistant").slice(-20),
            { role: "user", content: q },
          ];
          const answer = await callLlm(side, { model: sessionModel, maxTokens: thinkingMaxTokens(sessionThinking) });
          console.log(`btw> ${answer.trim()}`);
        } catch (err) {
          console.log(`! ${friendlyProviderError(err)}`);
        }
        continue;
      }
      // ---- gjc-parity inspection commands ------------------------------------
      if (input === "/usage") {
        const total = sessionUsage.inputTokens + sessionUsage.outputTokens;
        console.log("Provider token usage (this REPL):");
        console.log(`  turns   ${sessionUsage.turns}`);
        console.log(`  input   ${sessionUsage.inputTokens}`);
        console.log(`  output  ${sessionUsage.outputTokens}`);
        console.log(`  total   ${total}${total === 0 ? "  (providers report usage per turn; run a request first)" : ""}`);
        continue;
      }
      if (input === "/context") {
        // Token estimate (~4 chars/token) over the in-memory history, by role.
        const est = (s: string) => Math.ceil(s.length / 4);
        const byRole: Record<string, { msgs: number; tokens: number }> = {};
        for (const m of history) {
          const slot = (byRole[m.role] ??= { msgs: 0, tokens: 0 });
          slot.msgs++;
          slot.tokens += est(m.content);
        }
        const total = Object.values(byRole).reduce((sum, r) => sum + r.tokens, 0);
        const { resolved } = await describeModel(sessionModel || (await readGlobalConfig()).defaultModel);
        const window = catalogMetadata(resolved)?.contextTokens;
        console.log("Context usage (estimated, ~4 chars/token):");
        for (const [role, r] of Object.entries(byRole)) {
          console.log(`  ${role.padEnd(9)} ${String(r.msgs).padStart(3)} msg${r.msgs === 1 ? " " : "s"}  ~${r.tokens} tokens`);
        }
        console.log(`  ${"total".padEnd(9)} ${String(history.length).padStart(3)} msgs  ~${total} tokens${window ? `  (${Math.round((total / window) * 100)}% of ${resolved}'s ${window}-token window)` : ""}`);
        console.log("  Free context with /compact or /clear.");
        continue;
      }
      if (input === "/tools") {
        console.log("Tools visible to the agent:");
        for (const line of TOOL_PROTOCOL.split("\n")) console.log(`  ${line}`);
        console.log(`  ${TASK_TOOL_PROTOCOL_LINE}`);
        console.log(`  ${TODO_TOOL_PROTOCOL_LINE}`);
        continue;
      }
      if (input === "/hotkeys") {
        console.log("Keyboard shortcuts:");
        console.log("  Tab        complete slash commands, models, roles, @paths");
        console.log("  ↑ / ↓      navigate the slash-command preview (Enter runs the highlighted one)");
        console.log("  Enter      submit input / confirm picker selection");
        console.log("  Esc        cancel an open picker");
        console.log("  Ctrl-C     cancel the in-flight turn (press again at the prompt to exit)");
        console.log("  Ctrl-D     exit the REPL");
        console.log("  Ctrl-O     dump the full last response (untruncated, tables rendered) into scrollback");
        console.log("  Ctrl-K / Ctrl-U / Ctrl-W   kill to end / start of line / previous word (emacs kill-ring)");
        console.log("  Ctrl-Y / Alt-Y             yank / yank-pop the killed text");
        console.log("  Ctrl-A / Ctrl-E            move to start / end of line");
        console.log("  /          open the slash-command palette");
        console.log("  @path      mention a file (Tab completes relative paths)");
        continue;
      }
      if (input === "/theme" || input.startsWith("/theme ")) {
        const want = input.substring(6).trim().toLowerCase();
        const themes = listThemes();
        if (!want) {
          const active = resolveTheme().name;
          console.log("TUI themes (set with /theme <name>, persists for this run via JOC_TUI_THEME):");
          for (const t of themes) console.log(`  ${t.name === active ? "*" : " "} ${t.name.padEnd(7)} ${t.description}`);
          continue;
        }
        if (!themes.some(t => t.name === want)) {
          console.log(`Unknown theme '${want}'. Known: ${themes.map(t => t.name).join(", ")}.`);
          continue;
        }
        process.env.JEO_TUI_THEME = want;
        console.log(`Theme set to ${want} (applies from the next turn).`);
        continue;
      }
      if (input === "/evolve") {
        console.log("=== Initiating Evolutionary Simulation ===");
        for (const stage of EVOLUTION_STAGES) {
          console.log(`\nStage: ${stage.name}`);
          await animateAsciiArt(stage, { delayMs: 40 });
        }
        console.log("\n=== Evolved to Singularity! ===");
        continue;
      }
      if (input.startsWith("/models") && (input === "/models" || input[7] === " ")) {
        const tokens = input.substring(7).trim().split(/\s+/).filter(Boolean);
        const lowerTokens = tokens.map(t => t.toLowerCase());
        const sub = lowerTokens[0] ?? "";
        const refresh = lowerTokens.includes("refresh");
        if (sub === "catalog") {
          const cfgNow = await readGlobalConfig();
          const def = sessionModel || cfgNow.defaultModel;
          const { resolved } = await describeModel(def);
          const query = tokens.slice(1).join(" ");
          const rows = query ? fuzzyMatchCatalog(query) : [...MODEL_CATALOG];
          console.log(`Canonical models${query ? ` matching '${query}'` : ""}:`);
          logLines(formatCanonicalCatalogTable(rows, { current: resolved }));
          console.log("\nProvider models:");
          logLines(formatCatalogTable(rows, { current: resolved }));
          continue;
        }
        if (sub === "caps") {
          const live = await getLiveModels(refresh);
          const def = sessionModel || (await readGlobalConfig()).defaultModel;
          const { resolved } = await describeModel(def);
          const enriched = sortByCapability(enrichAll(live));
          lastPickIndex = enriched.map((m, i): PickEntry => ({ index: i + 1, provider: m.provider, model: m.id }));
          const { known, unknown } = knownCount(enriched);
          console.log("Live models with capabilities (select with /model #N):");
          logLines(formatPickListWithCapabilities(lastPickIndex, { current: resolved }));
          console.log(`  (${known} with known capabilities, ${unknown} unknown)`);
          continue;
        }
        const cfgNow = await readGlobalConfig();
        const def = sessionModel || cfgNow.defaultModel;
        const { resolved, provider } = await describeModel(def);
        console.log(`Default model: ${formatModelLine({ label: def, resolved, provider })}`);
        console.log("Aliases:");
        logLines(formatAliasLines(await listAliases()));
        const live = await getLiveModels(refresh);
        lastPickIndex = flattenModels(live);
        console.log("Live models (logged-in providers) — select with /model #N:");
        logLines(formatPickListWithCapabilities(lastPickIndex, { current: resolved }));
        console.log("Refresh: /models refresh  ·  capabilities: /models caps  ·  one provider: /provider <name>");
        continue;
      }
      if (input.startsWith("/provider") && (input === "/provider" || input[9] === " ")) {
        const tokens = input.substring(9).trim().split(/\s+/).filter(Boolean);
        const name = (tokens[0] ?? "").toLowerCase();
        const explicitModel = tokens[1];
        // `/provider login|auth [name]` → run OAuth login from the REPL.
        if (name === "login" || name === "auth") {
          const cloud = ["anthropic", "openai", "gemini", "antigravity"] as const;
          let target = tokens.slice(1).map(t => t.toLowerCase()).find(t => (cloud as readonly string[]).includes(t));
          if (!target) {
            const statuses = await describeAllProviders();
            if (process.stdin.isTTY && process.stdout.isTTY) {
              target = await pickCloudProvider(statuses);
            } else {
              // No provider given → show current status and let the user pick.
              console.log("Log in to which provider?");
              cloud.forEach((p, i) => {
                const st = statuses.find(s => s.name === p);
                console.log(`  ${i + 1}) ${p.padEnd(10)} ${st?.ready ? `✓ ${st.label}` : "· not ready"}`);
              });
              const ans = (await promptInput("Choose [1-3] or name (blank to cancel): ")).trim().toLowerCase();
              const byNum: Record<string, string> = { "1": "anthropic", "2": "openai", "3": "gemini" };
              target = byNum[ans] ?? ((cloud as readonly string[]).includes(ans) ? ans : undefined);
            }
            if (!target) {
              console.log("(cancelled)");
              continue;
            }
          }
          console.log(`Starting OAuth login for ${target}…`);
          try {
            const { email } = await interactiveOAuthLogin(target as AuthProvider, rl);
            console.log(`[SUCCESS] OAuth login complete for ${target}${email ? ` (${email})` : ""}. Tokens saved to ~/.joc/config.json.`);
            const live = await refreshLiveModelsCache();
            const after = (await describeAllProviders()).find(s => s.name === target);
            if (after) console.log(`  status → ${after.name}: ${after.ready ? `✓ ${after.label}` : after.label}`);
            const forProvider = live.filter(r => r.provider === target);
            if (forProvider.some(r => r.ok && r.models.length > 0)) {
              lastPickIndex = flattenModels(forProvider);
              const viaCatalog = forProvider.some(r => r.fallback);
              console.log(`  ${viaCatalog ? "catalog" : "live"} ${target} models → /model #N or /provider ${target} #N${viaCatalog ? "  (live list endpoint rejected this token; showing known models)" : ""}`);
              logLines(formatPickListWithCapabilities(lastPickIndex, { cap: 12 }));
            } else {
              const failed = forProvider.find(r => !r.ok);
              if (failed?.error) console.log(`  live ${target} models unavailable: ${failed.error}`);
            }
          } catch (err) {
            console.log(`[FAILED] ${(err as Error).message} — or set ${target.toUpperCase()}_API_KEY.`);
          }
          continue;
        }
        const cfgNow = await readGlobalConfig();
        const statuses = await describeAllProviders(cfgNow);
        if (!name) {
          console.log("Providers (credential · base URL):");
          logLines(formatProviderPanel(statuses));
          console.log("Switch with: /provider <name> [model]  ·  arrows+Enter picker: /provider <name>  ·  list live models: /models");
          continue;
        }
        if (!isProviderName(name)) {
          console.log(`Unknown provider '${name}'. Known: ${statuses.map(s => s.name).join(", ")}.`);
          continue;
        }
        const st = statuses.find(s => s.name === name);
        if (st && !st.ready) {
          console.log(`! ${name} is not ready (${st.label}) — set ${st.envVar ?? "the provider key"} or configure a compatible base URL. Switching anyway.`);
        }
        const live = await getLiveModels();
        const forProvider = live.filter(r => r.provider === name);
        const providerPick = flattenModels(forProvider);
        const currentResolved = (await describeModel(sessionModel || cfgNow.defaultModel)).resolved;
        let pickedFromPicker = false;
        let target = explicitModel ?? PROVIDER_DEFAULT[name];
        if (!explicitModel && providerPick.length && process.stdin.isTTY && process.stdout.isTTY) {
          const picked = await pickLiveProviderModel(name, providerPick, currentResolved, st && !st.ready && !selectableThoughNotReady(st) ? [name] : []);
          if (!picked) {
            console.log("(cancelled)");
            continue;
          }
          pickedFromPicker = true;
          target = qualifyModelId(picked.model, picked.provider);
        } else if (explicitModel && providerPick.length) {
          const sel = resolveSelection(providerPick, explicitModel);
          if (sel.kind === "index" || sel.kind === "match") {
            target = qualifyModelId(sel.entry.model, sel.entry.provider);
            if (st && !st.ready) {
              if (selectableThoughNotReady(st)) {
                console.log(notReadyWarning(st));
              } else {
                console.log(`Cannot select ${sel.entry.model}: ${name} is not ready (${st.label}). Set ${st.envVar ?? "the provider key"} first.`);
                continue;
              }
            }
          } else if (sel.kind === "ambiguous") {
            console.log(`'${explicitModel}' matches ${sel.matches.length} ${name} models — be more specific:`);
            for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model} (${e.provider})`);
            continue;
          } else if (sel.kind === "out-of-range") {
            console.log(`#${explicitModel.slice(1)} is out of range for ${name} (1-${sel.max}).`);
            continue;
          }
        } else if (explicitModel?.startsWith("#")) {
          console.log(`No numbered ${name} model list is available yet.`);
          continue;
        }
        const { resolved, provider } = await describeModel(target);
        if (explicitModel && provider !== name) {
          console.log(`! '${target}' resolves to ${provider}, not ${name}. Pick a ${name} model from the live list below.`);
          if (providerPick.length) logLines(formatPickListWithCapabilities(providerPick, { cap: 20 }));
          continue;
        }
        sessionModel = target;
        // MRU persistence: a provider/model pick becomes the default for EVERY
        // future session and the head of the recents rotation.
        await saveConfigPatch(raw => rememberModelPatch(raw, target));
        console.log(`Model set to ${formatModelLine({ label: target, resolved, provider, ready: st?.ready })} — saved as default`);
        // Show the provider's live, credentialed catalog so the user can pick a concrete id.
        if (providerPick.length) {
          lastPickIndex = providerPick;
          if (!pickedFromPicker) {
            console.log(`Live ${name} models — select with /model #N, /provider ${name} #N, or rerun /provider ${name} and use arrows+Enter:`);
            logLines(formatPickListWithCapabilities(lastPickIndex, { current: resolved }));
          }
        }
        continue;
      }
      if (input.startsWith("/logout") && (input === "/logout" || input[7] === " ")) {
        const cloud = ["anthropic", "openai", "gemini", "antigravity"];
        const target = input.substring(7).trim().split(/\s+/).map(t => t.toLowerCase()).find(t => cloud.includes(t));
        if (!target) {
          console.log("Usage: /logout <anthropic|openai|gemini|antigravity>");
          continue;
        }
        const removed = await logoutOAuth(target as AuthProvider);
        console.log(removed ? `[SUCCESS] Removed OAuth token for ${target}.` : `No OAuth token stored for ${target}.`);
        await refreshLiveModelsCache();
        continue;
      }
      const agentsCommand =
        input === "/agents" || input.startsWith("/agents ") ? "/agents" :
        undefined;
      if (agentsCommand) {
        const tokens = input.substring(agentsCommand.length).trim().split(/\s+/).filter(Boolean);
        const roleArg = tokens[0];
        const modelArg = tokens[1];
        const cfgNow = await readGlobalConfig();
        if (!roleArg || roleArg === "/" || roleArg === "?" || roleArg.toLowerCase() === "help") {
          console.log("Subagent roles (used by 'jeo team'):");
          for (const line of formatAgentsPanel(SUBAGENT_ROLES, r => ({
            model: resolveSubagentModel(r.id, cfgNow),
            maxSteps: resolveSubagentMaxSteps(r.id, cfgNow),
          }))) console.log(line);
          console.log("Detail: /agents <role>  ·  set model: /agents <role> <model|#N>  ·  provider: /agents <role> provider <name> [model]  ·  steps: /agents <role> maxSteps <N>");
          console.log("Tip: set a role while choosing models with /model subagent <role> [model|#N]");
          console.log("Available: executor, planner, architect, critic");
          console.log("Subcommands: <role> <model|#N>, <role> provider <name> [model], <role> maxSteps <N>, <role> reset");
          continue;
        }
        const role = getSubagentRole(roleArg);
        if (!role) {
          console.log(`Unknown role '${roleArg}'. Known: ${SUBAGENT_ROLES.map(r => r.id).join(", ")}.`);
          continue;
        }
        if (modelArg?.toLowerCase() === "reset") {
          await saveConfigPatch(raw => ({ subagents: clearSubagentSetting(raw, role.id) }));
          console.log(`${role.title} settings reset to defaults → ~/.joc/config.json`);
          continue;
        }
        if (modelArg?.toLowerCase() === "maxsteps" || modelArg?.toLowerCase() === "steps") {
          const maxSteps = parseMaxSteps(tokens[2]);
          if (!maxSteps) {
            console.log(`Usage: /agents ${role.id} maxSteps <positive-number>`);
            continue;
          }
          await saveConfigPatch(raw => ({ subagents: withSubagentSetting(raw, role.id, { maxSteps }) }));
          console.log(`${role.title} maxSteps set to ${maxSteps} → ~/.joc/config.json`);
          continue;
        }
        if (modelArg?.toLowerCase() === "provider") {
          const want = (tokens[2] ?? "").toLowerCase();
          if (!isProviderName(want)) {
            console.log(`Usage: /agents ${role.id} provider <anthropic|openai|gemini|antigravity|ollama> [model|#N]`);
            continue;
          }
          const st = (await describeAllProviders()).find(s => s.name === want);
          if (st && !st.ready) {
            if (selectableThoughNotReady(st)) {
              console.log(notReadyWarning(st));
            } else {
              console.log(`Cannot pin ${role.title} to ${want}: not ready (${st.label}). Set ${st.envVar ?? "the provider key"} first.`);
              continue;
            }
          }
          const live = await getLiveModels();
          const forProvider = flattenModels(live.filter(r => r.provider === want));
          const explicit = tokens[3];
          let chosenModel: string;
          if (explicit && forProvider.length) {
            const sel = resolveSelection(forProvider, explicit);
            if (sel.kind === "index" || sel.kind === "match") chosenModel = qualifyModelId(sel.entry.model, want);
            else if (sel.kind === "ambiguous") {
              console.log(`'${explicit}' matches ${sel.matches.length} ${want} models — be more specific:`);
              for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model}`);
              continue;
            } else if (sel.kind === "out-of-range") {
              console.log(`#${explicit.slice(1)} is out of range for ${want} (1-${sel.max}).`);
              continue;
            } else {
              chosenModel = qualifyModelId(explicit, want);
            }
          } else if (explicit) {
            chosenModel = qualifyModelId(explicit, want);
          } else if (forProvider.length) {
            // No model given → the provider's first live model, provider-qualified.
            chosenModel = qualifyModelId(forProvider[0]!.model, want);
          } else {
            chosenModel = PROVIDER_DEFAULT[want];
          }
          await saveConfigPatch(raw => ({ subagents: withSubagentSetting(raw, role.id, { model: chosenModel }) }));
          console.log(`${role.title} pinned to ${want} via model ${chosenModel} — saved to ~/.joc/config.json`);
          if (forProvider.length) {
            lastPickIndex = forProvider;
            console.log(`Live ${want} models — refine with /agents ${role.id} #N:`);
            for (const line of formatPickListWithCapabilities(lastPickIndex, { current: chosenModel, cap: 12 })) console.log(line);
          }
          continue;
        }
        if (modelArg) {
          let chosenModel = modelArg;
          let entries = lastPickIndex;
          if (modelArg.startsWith("#") && entries.length === 0) {
            const live = await getLiveModels();
            entries = flattenModels(live);
          }
          if (entries.length) {
            const sel = resolveSelection(entries, modelArg);
            if (sel.kind === "index" || sel.kind === "match") {
              chosenModel = qualifyModelId(sel.entry.model, sel.entry.provider);
              const bad = (await describeAllProviders()).find(s => s.name === sel.entry.provider && !s.ready);
              if (bad) {
                if (selectableThoughNotReady(bad)) {
                  console.log(notReadyWarning(bad));
                } else {
                  console.log(`Cannot pin ${sel.entry.model}: ${sel.entry.provider} is not ready (${bad.label}). Set ${bad.envVar ?? "the provider key"} first.`);
                  continue;
                }
              }
            } else if (sel.kind === "ambiguous") {
              console.log(`'${modelArg}' matches ${sel.matches.length} live models — be more specific:`);
              for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model} (${e.provider})`);
              continue;
            } else if (sel.kind === "out-of-range") {
              console.log(`#${modelArg.slice(1)} is out of range (1-${sel.max}). Run /models first.`);
              continue;
            }
          } else if (modelArg.startsWith("#")) {
            console.log("Run /models first to build the numbered live model list.");
            continue;
          }
          // Persist a per-role model override to ~/.joc/config.json (consumed by 'jeo team').
          await saveConfigPatch(raw => ({ subagents: withSubagentSetting(raw, role.id, { model: chosenModel }) }));
          const { provider } = await describeModel(chosenModel);
          console.log(`${role.title} model set to ${chosenModel} (${provider}) — saved to ~/.joc/config.json`);
          const live = await getLiveModels();
          if (!liveModelKnown(live, chosenModel)) {
            console.log(`  (note: '${chosenModel}' is not in any live model list — verify it is valid for ${provider})`);
          }
          continue;
        }
        for (const line of formatAgentDetail(role, {
          model: resolveSubagentModel(role.id, cfgNow),
          maxSteps: resolveSubagentMaxSteps(role.id, cfgNow),
        })) console.log(line);
        const live = await getLiveModels();
        const agentPick = flattenModels(live);
        if (agentPick.length) {
          lastPickIndex = agentPick;
          console.log(`Live models for ${role.title} — pin with /agents ${role.id} #N:`);
          for (const line of formatPickListWithCapabilities(lastPickIndex, { current: resolveSubagentModel(role.id, cfgNow), cap: 20 })) console.log(line);
        }
        continue;
      }
      if (input === "/config") {
        const cfgNow = await readGlobalConfig();
        const label = sessionModel || cfgNow.defaultModel;
        const { resolved, provider } = await describeModel(label);
        console.log("Effective runtime config:");
        for (const line of formatConfigPanel({
          model: label,
          resolved,
          provider,
          thinkingLevel: sessionThinking ?? cfgNow.thinkingLevel ?? "medium",
          ollamaBaseUrl: cfgNow.ollamaBaseUrl,
          openaiBaseUrl: cfgNow.openaiBaseUrl,
          requestMaxRetries: cfgNow.retry?.requestMaxRetries,
          sessionId,
        })) console.log(line);
        continue;
      }
      if (input.startsWith("/roles") && (input === "/roles" || input[6] === " ")) {
        const tokens = input.substring(6).trim().split(/\s+/).filter(Boolean);
        const cfgNow = await readGlobalConfig();
        const TIERS = ["smol", "slow", "plan"] as const;
        if (tokens.length >= 2 && (TIERS as readonly string[]).includes(tokens[0])) {
          const tier = tokens[0] as (typeof TIERS)[number];
          let chosenModel = tokens[1]!;
          let entries = lastPickIndex;
          if (chosenModel.startsWith("#") && entries.length === 0) {
            const live = await getLiveModels();
            entries = flattenModels(live);
          }
          if (entries.length) {
            const sel = resolveSelection(entries, chosenModel);
            if (sel.kind === "index" || sel.kind === "match") {
              chosenModel = qualifyModelId(sel.entry.model, sel.entry.provider);
              const bad = (await describeAllProviders()).find(s => s.name === sel.entry.provider && !s.ready);
              if (bad) {
                console.log(`Cannot set role ${tier} to ${sel.entry.model}: ${sel.entry.provider} is not ready (${bad.label}). Set ${bad.envVar ?? "the provider key"} first.`);
                continue;
              }
            } else if (sel.kind === "ambiguous") {
              console.log(`'${chosenModel}' matches ${sel.matches.length} live models — be more specific:`);
              for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model} (${e.provider})`);
              continue;
            } else if (sel.kind === "out-of-range") {
              console.log(`#${chosenModel.slice(1)} is out of range (1-${sel.max}). Run /models first.`);
              continue;
            }
          } else if (chosenModel.startsWith("#")) {
            console.log("Run /models first to build the numbered live model list.");
            continue;
          }
          await saveConfigPatch(raw => ({ roles: { ...(raw.roles ?? {}), [tier]: chosenModel } }));
          console.log(`Role '${tier}' model set to ${chosenModel} → ~/.joc/config.json`);
          continue;
        }
        console.log("Model role tiers (fall back to the default model):");
        for (const tier of TIERS) {
          const { provider } = await describeModel(resolveRoleModel(tier, cfgNow));
          console.log(`  ${tier.padEnd(5)} ${resolveRoleModel(tier, cfgNow)} (${provider})`);
        }
        console.log("Set a tier: /roles <smol|slow|plan> <model>");
        const live = await getLiveModels();
        const rolePick = flattenModels(live);
        if (rolePick.length) {
          lastPickIndex = rolePick;
          console.log("Live models for role tiers — set with /roles <tier> #N:");
          for (const line of formatPickListWithCapabilities(lastPickIndex, { cap: 15 })) console.log(line);
        }
        continue;
      }
      if (input.startsWith("/thinking") && (input === "/thinking" || input[9] === " ")) {
        const arg = input.substring(9).trim().toLowerCase();
        if (!arg) {
          console.log(`Thinking level: ${sessionThinking ?? "medium"} (~${thinkingMaxTokens(sessionThinking)} max tokens/step)`);
          continue;
        }
        if (arg === "minimal" || arg === "low" || arg === "medium" || arg === "high" || arg === "xhigh") {
          sessionThinking = arg;
          console.log(`Thinking set to ${arg} (~${thinkingMaxTokens(arg)} max tokens/step)`);
        } else {
          console.log(`Invalid level '${arg}'. Use: minimal | low | medium | high | xhigh.`);
        }
        continue;
      }
      if (input.startsWith("/model") && (input === "/model" || input[6] === " ")) {
        let arg = input.substring(6).trim();
        // `/model save [id]` → persist the (session or given) model as the config default.
        if (arg === "save" || arg.startsWith("save ")) {
          let toSave = arg.slice(4).trim();
          // Resolve `#N`/fuzzy through the same pick-list logic as `/model #N`, so we never
          // persist a literal token like "#2" as defaultModel (which then fails to route).
          if (toSave && lastPickIndex.length) {
            const sel = resolveSelection(lastPickIndex, toSave);
            if (sel.kind === "index" || sel.kind === "match") toSave = qualifyModelId(sel.entry.model, sel.entry.provider);
            else if (sel.kind === "ambiguous") {
              console.log(`'${toSave}' matches ${sel.matches.length} models — be more specific:`);
              for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model} (${e.provider})`);
              continue;
            } else if (sel.kind === "out-of-range") {
              console.log(`#${toSave.slice(1)} is out of range (1-${sel.max}). Run /models first.`);
              continue;
            }
            // kind "none" → treat `toSave` as a literal model id/alias.
          } else if (toSave.startsWith("#")) {
            console.log("Run /models (or /provider <name>) first to build the numbered list.");
            continue;
          }
          // Fall back to the FRESH on-disk default (not the stale session-start snapshot) so a
          // bare `/model save` after a prior `/model save <id>` never reverts the saved default.
          const finalSave = toSave || sessionModel || (await readGlobalConfig()).defaultModel;
          await saveConfigPatch(raw => rememberModelPatch(raw, finalSave));
          const { resolved, provider } = await describeModel(finalSave);
          console.log(`Default model saved: ${formatModelLine({ label: finalSave, resolved, provider })} → ~/.joc/config.json`);
          continue;
        }
        const statuses = await describeAllProviders();
        const disabledModelProviders = statuses.filter(s => !s.ready && !selectableThoughNotReady(s)).map(s => s.name);
        const roleMatch = /^(subagent|role)\s+(\S+)(?:\s+(.+))?$/i.exec(arg);
        if (roleMatch) {
          const role = getSubagentRole(roleMatch[2] ?? "");
          if (!role) {
            console.log("Usage: /model subagent <executor|planner|architect|critic> [model|#N]");
            continue;
          }
          let roleModelArg = (roleMatch[3] ?? "").trim();
          if (!roleModelArg && process.stdin.isTTY && process.stdout.isTTY) {
            const live = await getLiveModels();
            lastPickIndex = flattenModels(live);
            if (lastPickIndex.length) {
              const currentResolved = (await describeModel(resolveSubagentModel(role.id, await readGlobalConfig()))).resolved;
              const picked = await pickLiveProviderModel(role.id, lastPickIndex, currentResolved, disabledModelProviders);
              if (!picked) {
                console.log("(cancelled)");
                continue;
              }
              roleModelArg = qualifyModelId(picked.model, picked.provider);
            }
          }
          if (roleModelArg && lastPickIndex.length) {
            const sel = resolveSelection(lastPickIndex, roleModelArg);
            if (sel.kind === "index" || sel.kind === "match") {
              if (disabledModelProviders.includes(sel.entry.provider)) {
                const bad = statuses.find(s => s.name === sel.entry.provider);
                console.log(`Cannot select ${sel.entry.model}: ${sel.entry.provider} is not ready (${bad?.label ?? "not ready"}). Set ${bad?.envVar ?? "the provider key"} first.`);
                continue;
              }
              roleModelArg = qualifyModelId(sel.entry.model, sel.entry.provider);
            } else if (sel.kind === "ambiguous") {
              console.log(`'${roleModelArg}' matches ${sel.matches.length} models — be more specific:`);
              for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model} (${e.provider})`);
              continue;
            } else if (sel.kind === "out-of-range") {
              console.log(`#${roleModelArg.slice(1)} is out of range (1-${sel.max}). Run /models first.`);
              continue;
            }
          } else if (roleModelArg.startsWith("#")) {
            console.log("Run /models (or /provider <name>) first to build the numbered list.");
            continue;
          }
          if (roleModelArg) {
            await saveConfigPatch(raw => ({ subagents: withSubagentSetting(raw, role.id, { model: roleModelArg }) }));
            const { provider } = await describeModel(roleModelArg);
            console.log(`${role.title} model set to ${roleModelArg} (${provider}) — saved to ~/.joc/config.json`);
          } else {
            const current = resolveSubagentModel(role.id, await readGlobalConfig());
            const { resolved, provider } = await describeModel(current);
            console.log(`${role.title} model: ${formatModelLine({ label: current, resolved, provider })}`);
            const live = await getLiveModels();
            lastPickIndex = flattenModels(live);
            if (lastPickIndex.length) {
              console.log(`Live models for ${role.title} — set with /model subagent ${role.id} #N:`);
              for (const line of formatPickListWithCapabilities(lastPickIndex, { current: resolved, cap: 20 })) console.log(line);
            }
          }
          continue;
        }
        if (!arg && process.stdin.isTTY && process.stdout.isTTY) {
          const live = await getLiveModels();
          lastPickIndex = flattenModels(live);
          if (lastPickIndex.length) {
            const currentResolved = (await describeModel(sessionModel || defaultModel)).resolved;
            const picked = await pickLiveProviderModel("live", lastPickIndex, currentResolved, disabledModelProviders);
            if (!picked) {
              console.log("(cancelled)");
              continue;
            }
            arg = qualifyModelId(picked.model, picked.provider);
          }
        }
        // Selection from the last numbered pick list (`#N`) or a fuzzy substring.
        if (arg && lastPickIndex.length) {
          const sel = resolveSelection(lastPickIndex, arg);
          if (sel.kind === "index" || sel.kind === "match") {
            if (disabledModelProviders.includes(sel.entry.provider)) {
              const bad = statuses.find(s => s.name === sel.entry.provider);
              console.log(`Cannot select ${sel.entry.model}: ${sel.entry.provider} is not ready (${bad?.label ?? "not ready"}). Set ${bad?.envVar ?? "the provider key"} first.`);
              continue;
            }
            arg = qualifyModelId(sel.entry.model, sel.entry.provider);
          } else if (sel.kind === "ambiguous") {
            console.log(`'${arg}' matches ${sel.matches.length} models — be more specific:`);
            for (const e of sel.matches.slice(0, 12)) console.log(`  #${e.index}  ${e.model} (${e.provider})`);
            continue;
          } else if (sel.kind === "out-of-range") {
            console.log(`#${arg.slice(1)} is out of range (1-${sel.max}). Run /models first.`);
            continue;
          }
          // kind "none" → fall through and treat `arg` as a literal model id/alias.
        } else if (arg.startsWith("#")) {
          console.log("Run /models (or /provider <name>) first to build the numbered list.");
          continue;
        }
        const label = arg || (sessionModel || defaultModel);
        if (arg) {
          sessionModel = arg;
          // MRU persistence: picking a model IS saving it — the newest pick wins
          // as the global default; recents keep the rotation for every session.
          await saveConfigPatch(raw => rememberModelPatch(raw, arg));
        }
        const { resolved, provider } = await describeModel(label);
        const st = statuses.find(s => s.name === provider);
        console.log(`${arg ? "Model set to" : "Current model"}: ${formatModelLine({ label, resolved, provider, ready: st?.ready })}${arg ? " — saved as default" : ""}`);
        if (st && !st.ready) console.log(`  ! ${provider} is not ready (${st.label}) — set ${st.envVar ?? "the provider key"} or run 'jeo setup'.`);
        // ChatGPT OAuth only serves the Codex models; warn before the turn fails if the user
        // pins a non-Codex id with no local base URL to fall back to (gjc-parity readiness guard).
        if (arg && provider === "openai" && st?.kind === "oauth" && !CODEX_MODELS.includes(resolved)) {
          const hasLocalBase = !!((await readGlobalConfig()).openaiBaseUrl || process.env.OPENAI_BASE_URL);
          if (!hasLocalBase) {
            console.log(`  ! ChatGPT OAuth serves only Codex models (${CODEX_MODELS.join(", ")}); '${resolved}' will be rejected at runtime — pick one of those, or set OPENAI_API_KEY / OPENAI_BASE_URL.`);
          }
        }
        if (arg && liveModelsCache && resolved === label && !liveModelKnown(liveModelsCache, resolved)) {
          console.log(`  (note: '${resolved}' is not in the live ${provider} catalog — run /models to see valid ids)`);
        }
        const meta = catalogMetadata(resolved);
        if (meta) console.log(`  ${formatCapabilityLine(meta)}`);
        if (!arg) {
          const recents = recentModelsForDisplay(await readGlobalConfig());
          if (recents.length > 1) {
            console.log("Recent models (newest first):");
            recents.slice(0, 5).forEach((m, i) => console.log(`  ${i + 1}. ${m}${i === 0 ? "  ◀ default" : ""}`));
          }
          const live = await getLiveModels();
          lastPickIndex = flattenModels(live);
          console.log("Live models (logged-in providers) — set with /model #N:");
          for (const line of formatPickListWithCapabilities(lastPickIndex, { current: resolved, cap: 20 })) console.log(line);
        }
        console.log("  (model picks persist automatically — newest selection is the default everywhere)");
        continue;
      }
      if (input.startsWith("/view") && (input === "/view" || input[5] === " ")) {
        const tokens = input.substring(5).trim().split(/\s+/).filter(Boolean);
        const file = tokens[0];
        if (!file) {
          console.log("Usage: /view <file> [start-end]   (e.g. /view src/cli.ts 1-40)");
          continue;
        }
        let content: string;
        try {
          content = await fs.promises.readFile(path.resolve(cwd, file), "utf-8");
        } catch (err) {
          console.log(`! cannot read ${file}: ${(err as Error).message}`);
          continue;
        }
        const range = tokens[1] ? parseLineRange(tokens[1]) : undefined;
        if (tokens[1] && !range) {
          console.log(`Invalid range '${tokens[1]}'. Use start-end | start- | start.`);
          continue;
        }
        const lang = detectLanguage(file);
        const { lines, startLine } = sliceLines(content, range ?? undefined);
        const { cols } = await import("../tui/terminal").then(m => m.size());
        console.log(`${categoryBadge("file")} ${chalk.bold(`${file}`)}${chalk.gray(`  (${languageLabel(lang)}, lines ${startLine}-${startLine + lines.length - 1})`)}`);
        for (const line of formatCodeBlock(lines.join("\n"), { startLine, lang, cols: Math.max(40, cols - 1), maxLines: 200 })) {
          console.log(line);
        }
        continue;
      }
      if (input.startsWith("/diff") && (input === "/diff" || input[5] === " ")) {
        const target = input.substring(5).trim();
        const proc = Bun.spawnSync(["git", "diff", ...(target ? ["--", target] : [])], { cwd, stdout: "pipe", stderr: "pipe" });
        if (proc.exitCode !== 0 && !proc.stdout.length) {
          console.log(`! git diff failed: ${proc.stderr.toString().trim() || "not a git repo?"}`);
          continue;
        }
        const text = proc.stdout.toString();
        if (!text.trim()) {
          console.log("(no unstaged changes)");
          continue;
        }
        const { cols } = await import("../tui/terminal").then(m => m.size());
        console.log(`${categoryBadge("diff")} git diff${target ? ` -- ${target}` : ""}`);
        for (const line of formatDiff(text, { cols: Math.max(40, cols - 1), maxLines: 400 })) console.log(line);
        continue;
      }
      if (input.startsWith("/find") && (input === "/find" || input[5] === " ")) {
        const glob = input.substring(5).trim();
        if (!glob) {
          console.log("Usage: /find <glob>   (e.g. /find src/**/*.ts)");
          continue;
        }
        console.log(`${categoryBadge("search")} find files matching '${glob}':`);
        const res = await findTool(glob, cwd);
        console.log(res.success ? (res.output || "(no matches)") : `! ${res.error}`);
        continue;
      }
      if (input.startsWith("/search") && (input === "/search" || input[7] === " ")) {
        const tokens = input.substring(7).trim().split(/\s+/).filter(Boolean);
        const pattern = tokens[0];
        const glob = tokens[1] ?? "*";
        if (!pattern) {
          console.log("Usage: /search <pattern> [glob]   (e.g. /search resolveProvider src/**/*.ts)");
          continue;
        }
        console.log(`${categoryBadge("search")} search pattern '${pattern}' in '${glob}':`);
        const res = await searchTool(pattern, glob, cwd);
        console.log(res.success ? (res.output || "(no matches)") : `! ${res.error}`);
        continue;
      }
      const skillEntrypoint = input.startsWith("/skill:") ? "/skill:" : input.startsWith("/skill") && (input === "/skill" || input[6] === " ") ? "/skill" : "";
      if (skillEntrypoint) {
        if (flags.noSkills) {
          console.log("Skills are disabled.");
          continue;
        }
        const rest = skillEntrypoint === "/skill:" ? input.substring(7).trim() : input.substring(6).trim();
        let skills = await loadSkills(cwd);
        if (flags.skills) {
          const patterns = flags.skills.split(",").map(p => p.trim()).filter(Boolean);
          skills = skills.filter(s => patterns.some(p => matchSkillGlob(p, s.name)));
        }
        if (!rest) {
          if (process.stdin.isTTY && process.stdout.isTTY) {
            const picked = await pickSkillFromList(skills);
            if (!picked) {
              console.log("(cancelled)");
              continue;
            }
            await runSkillInvocation(picked, "");
            continue;
          }
          console.log("Skills (bundled + configured docs) — run with /skill <name> [intent] or a skill slash alias:");
          for (const s of skills) {
            const aliases = skillSlashAliases(s);
            console.log(`  ${s.name.padEnd(16)} ${s.summary}${aliases.length ? `  (${aliases.join(", ")})` : ""}`);
          }
          continue;
        }
        const [nm, ...intentParts] = rest.split(/\s+/);
        const skill = getSkillFrom(skills, nm);
        if (!skill) {
          console.log(`Unknown skill: ${nm}. Available: ${skills.map(s => s.name).join(", ")}`);
          continue;
        }
        const intent = intentParts.join(" ").trim();
        try {
          await runSkillInvocation(skill, intent);
        } catch (err) {
          console.log(`! ${(err as Error).message}`);
        }
        continue;
      }
      const aliasInvocation = parseSkillInvocation(input, resolvedSkills);
      if (aliasInvocation?.invokedAs) {
        try {
          await runSkillInvocation(aliasInvocation.skill, aliasInvocation.intent, aliasInvocation.invokedAs);
        } catch (err) {
          console.log(`! ${(err as Error).message}`);
        }
        continue;
      }
      // Unhandled slash attempt → suggest, don't send the typo to the model.
      if (isSlashAttempt(input)) {
        const m = matchSlash(input, [...completionContext().slashCommands]);
        if (m.length) {
          for (const line of formatSlashCommandList(input, skillSlashDetails)) console.log(line);
        } else {
          console.log(`Unknown command '${input}'. Try /help.`);
        }
        continue;
      }

      lastUserInput = input;
      // Hand pending clipboard images to this turn and clear them — a failed turn
      // does not resurrect attachments (the [image #N] tags stay in the text).
      const turnImages = pendingImages.length ? [...pendingImages] : undefined;
      pendingImages = [];
      try {
        const { done, steps, reply, rendered, usage } = await runTurn(input, useTui, turnImages);
        lastReply = reply;
        if (!rendered) {
          console.log(`jeo> ${renderMarkdownTables(reply)}${usage}`);
          if (!done) console.log(`(agent did not converge in ${steps} steps)`);
        } else if (usage) {
          console.log(usage.trim());
        }
      } catch (err) {
        console.log(`! ${friendlyProviderError(err)}`);
      }
    }
  disarmPreview(); // clear footer + restore full-screen scrolling before leaving the REPL
  // gjc-parity resume pointer (logs/gjc-tui-study analysis Gap C): leave the exact
  // resume command in scrollback on exit, mirroring the --list handler's convention.
  if (sessionId && !flags.noSession) console.log(formatResumeHint(sessionId));
  rl.close();
}
