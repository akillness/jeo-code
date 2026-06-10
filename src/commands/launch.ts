import { createInterface } from "node:readline/promises";
import { runAgentLoop, executorSystemPrompt, DEFAULT_TOOLS, TOOL_PROTOCOL, type AgentLoopEvents } from "../agent/engine";
import { createTaskTool, TASK_TOOL_PROTOCOL_LINE, type TaskSubEvent } from "../agent/task-tool";
import { createTodoTool, TODO_TOOL_PROTOCOL_LINE } from "../agent/todo-tool";
import { LaunchTui } from "../tui/app";
import { skillsPromptSection, loadSkills, formatSkill, buildSkillTask, getSkillFrom, skillSlashAliases, workflowSkillsForPrompt, parseSkillInvocation, looksLikeSkillEcho, type SkillDoc } from "../skills/catalog";
import { interactiveOAuthLogin } from "./auth";
import { logoutOAuth } from "../auth";
import type { AuthProvider } from "../auth";
import { matchSlash, isSlashAttempt, formatSlashCommandList, formatSlashPreview, slashPreviewMatches, type SlashCommandInfo } from "../tui/components/slash";
import { staticCompletionContext, readlineCompleter, formatCompletionPreview, tokenize, type CompletionContext } from "../tui/components/autocomplete";
import { EVOLUTION_STAGES, renderAsciiArt, animateAsciiArt } from "../tui/components/ascii-art";
import { getEvolutionTip } from "../tui/components/evolution";
import chalk from "chalk";
import { callLlm, type Message } from "../agent/loop";
import { friendlyProviderError } from "../util/provider-error";
import { readGlobalConfig, saveConfigPatch } from "../agent/state";
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
import { renderInputBox } from "../tui/components/input-box";
import { summarizeForgeInvocation } from "../tui/components/forge";
import { findTool, searchTool } from "../agent/tools";
import { loadProjectContext, withProjectContext } from "../agent/context-files";
import { maybeCompact } from "../agent/compaction";
import * as path from "node:path";
import * as fs from "node:fs";
import { listThemes, resolveTheme } from "../tui/components/themes";
import {
  createSession,
  appendMessage,
  loadSession,
  listSessions,
  latestSessionId,
  exportSession,
  renameSession,
  deleteSession,
  sessionPath,
} from "../agent/session";
import { clearLine, cursorUp, toColumn, truncate as truncateAnsi, size as terminalSize } from "../tui/terminal";

export interface LaunchFlags {
  list: boolean;
  resume: boolean;
  resumeId?: string;
  noSession: boolean;
  noTui: boolean;
  maxSteps: number;
  message: string;
  tmux: boolean;
  worktree?: string;
  model?: string;
  provider?: ProviderName;
  modelRole?: ModelRole;
  thinking?: ThinkLevel;
  errors: string[];
}

const PROVIDER_DEFAULT: Record<ProviderName, string> = { anthropic: "sonnet", openai: "gpt-5.5", gemini: "flash", ollama: "fast" };

function takeValue(args: string[], index: number, inlinePrefix: string): { value?: string; nextIndex: number } {
  const current = args[index]!;
  if (current.startsWith(inlinePrefix)) return { value: current.slice(inlinePrefix.length), nextIndex: index };
  const next = args[index + 1];
  if (next && !next.startsWith("-")) return { value: next, nextIndex: index + 1 };
  return { nextIndex: index };
}

function isProviderName(input: string | undefined): input is ProviderName {
  return input === "anthropic" || input === "openai" || input === "gemini" || input === "ollama";
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
  if (flags.maxSteps !== 25) parts.push(`steps-${flags.maxSteps}`);
  if (parts.length === 0) return "";
  const joined = parts.join("-");
  const suffix = joined.length <= 72 ? joined : `${joined.slice(0, 65)}-${hashString(joined)}`;
  return `-${suffix}`;
}

/**
 * Base tmux session name for `joc --tmux`. Keyed on the working DIRECTORY (not just the
 * git branch) so two different projects/worktrees on the same branch (e.g. `main`)
 * never share a base. {@link uniqueTmuxSessionName} then makes each concurrent invocation
 * fully independent, so a second `joc --tmux` never attaches to (and mirrors) the first.
 */
export function tmuxSessionName(cwd: string, branch: string, flags: LaunchFlags): string {
  const dirTag = `${tmuxSafeNamePart(path.basename(cwd) || "root", 16)}-${hashString(cwd)}`;
  const base = branch ? `joc-${branch}-${dirTag}` : `joc-${dirTag}`;
  return base + tmuxRuntimeSuffix(flags);
}

/**
 * Allocate + create an INDEPENDENT tmux session from a base name. Each separate,
 * concurrent `joc --tmux` invocation gets its OWN session instead of attaching to (and
 * mirroring) one another process already created: try `base`, then `base-2`, `base-3`, …
 * The create itself is the guard, so this is race-safe — two processes starting at the
 * same instant can't both win `base`. `tryCreate` must attempt to create the named session
 * and return `"ok"` (created — it's ours), `"taken"` (name already live / lost the race →
 * try the next suffix), or `"error:<msg>"` (a real failure → abort). Sessions die with
 * their joc process, so a sequential re-run reuses the clean base; only live overlap is
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
 * A `process.stdout` view whose visible-output methods become no-ops while `gated()` is
 * true. Used as readline's `output` so that, while the boxed slash-preview footer is armed,
 * readline's OWN prompt/echo is suppressed and only our box is visible — no duplicated raw
 * `joc>` line. The previous approach monkeypatched `rl._writeToOutput`, a Node internal Bun
 * does not expose (so on Bun both inputs showed at once). Gating the shared `output` stream
 * works on both runtimes. Our footer is written straight to `process.stdout`, never through
 * this proxy, so it always renders. Geometry/everything else is forwarded unchanged.
 */
const GATED_OUTPUT_METHODS = new Set(["write", "cursorTo", "moveCursor", "clearLine", "clearScreenDown"]);
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
  // is classifiable at a glance (parity with the live TUI and `joc team`).
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

export function parseDirectSubagentInput(input: string): { roleId: string; task: string } | null {
  const trimmed = input.trim();
  const command =
    trimmed === "/subagent" || trimmed.startsWith("/subagent ") ? "/subagent" :
    trimmed === "/agents" || trimmed.startsWith("/agents ") ? "/agents" :
    trimmed === "/subagents" || trimmed.startsWith("/subagents ") ? "/subagents" :
    "";
  if (!command) return null;
  const tokens = trimmed.slice(command.length).trim().split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();
  if (first === "run" || first === "exec" || first === "start") {
    let i = 1;
    let roleId = "executor";
    if (getSubagentRole(tokens[i])) {
      roleId = tokens[i]!.toLowerCase();
      i++;
    }
    return { roleId, task: tokens.slice(i).join(" ").trim() };
  }
  const sep = tokens.indexOf("--");
  if (sep >= 0) {
    const roleId = sep > 0 ? tokens[0]!.toLowerCase() : "executor";
    return { roleId, task: tokens.slice(sep + 1).join(" ").trim() };
  }
  return null;
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
): AgentLoopEvents {
  let step = 0;
  let pending = "";
  return {
    onStep: (n: number) => { step = n; },
    onAssistant: (_raw: string, invocation: { tool?: string; arguments?: unknown } | null) => {
      const tool = typeof invocation?.tool === "string" ? invocation.tool.trim() : "";
      if (!tool || tool === "done") return;
      pending = summarizeForgeInvocation(tool, invocation?.arguments).title;
      log(`${categoryBadge("progress")} ${chalk.cyan(`[step ${step}/${maxSteps}]`)} ${pending}`);
    },
    onToolResult: (tool: string, ok: boolean, output?: string) => {
      const label = pending || tool;
      const mark = ok ? chalk.green("✓") : chalk.red("✗");
      log(`  ${categoryBadge(ok ? "done" : "error")} ${mark} ${label}${streamResultSuffix(tool, ok, output)}`);
      pending = "";
    },
    onNotice: (msg: string) => log(`  ${categoryBadge("progress")} ${chalk.yellow(msg)}`),
  };
}

export function shouldUseOneShotTui(noTui: boolean): boolean {
  return LaunchTui.usable(noTui);
}

export function parseFlags(args: string[]): LaunchFlags {
  const flags: LaunchFlags = { list: false, resume: false, noSession: false, noTui: false, maxSteps: 25, message: "", tmux: false, errors: [] };
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
    } else if (a === "--resume") {
      flags.resume = true;
      const next = args[i + 1];
      if (next && UUID_REGEX.test(next)) {
        flags.resumeId = next;
        i++;
      }
    } else if (a.startsWith("--resume=")) {
      flags.resume = true;
      const val = a.slice(9);
      if (UUID_REGEX.test(val)) {
        flags.resumeId = val;
      } else {
        rest.push(val);
      }
    } else {
      rest.push(a);
    }
  }
  flags.message = rest.join(" ").trim();
  return flags;
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
  const branch = (path.basename(abs).replace(/[^a-zA-Z0-9_-]/g, "-") || "joc-wt");
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
  const flags = parseFlags(args);
  if (flags.errors.length) {
    for (const err of flags.errors) console.log(`error: ${err}`);
    return;
  }

  if (flags.worktree) {
    const wt = resolveWorktree(cwd, flags.worktree);
    if (wt !== cwd) {
      process.chdir(wt);
      cwd = wt;
      if (process.env.JOC_TMUX_LAUNCHED !== "1") console.log(`Using worktree: ${wt}`);
    }
  }
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
    if (!process.env.TMUX && process.env.JOC_TMUX_LAUNCHED !== "1") {
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
        const entrypoint = process.argv[1] || "joc";
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
          if (/duplicate session/i.test(err)) return "taken"; // another joc grabbed this name
          return `error:${err || `tmux new-session exited ${created.exitCode}`}`;
        });
        if ("error" in alloc) {
          console.error(`Error: Failed to create tmux session: ${alloc.error}`);
          process.exit(1);
        }
        const sessionName = alloc.name;
        console.log(
          sessionName === sessionBase
            ? `Starting new tmux session: ${sessionName}`
            : `Starting new independent tmux session: ${sessionName} (another live joc session already owns ${sessionBase}; reattach later with: tmux attach -t ${sessionName})`,
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
    console.log("\nResume with: joc launch --resume <id>");
    return;
  }

  // pi-style: load project context (JEO.md / AGENTS.md / .joc/context.md / CLAUDE.md) into the prompt.
  const contextFiles = await loadProjectContext(cwd);
  const resolvedSkills = await loadSkills(cwd); // bundled + user/project SKILL.md docs
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
  const baseSystemPrompt =
    executorSystemPrompt("joc, an interactive coding agent") +
    "\nWhen you have finished the user's request, or need to reply to or ask the user something, call done with {\"reason\": <your natural-language reply to the user>}. The reason text is shown to the user as your message." +
    "\n\nDelegation: " + TASK_TOOL_PROTOCOL_LINE +
    " Call task with {\"role\": \"executor|planner|architect|critic\", \"task\": <assignment>, \"context\": <optional>} to hand a focused slice to a subagent." +
    "\n\nPlanning: " + TODO_TOOL_PROTOCOL_LINE +
    "\n\nJOC workflow routing:\n" +
    "- Answer the user's request DIRECTLY. Never reply with a catalog, list, or summary of skills unless the user explicitly asks what skills exist.\n" +
    "- Advertise only the bundled workflow surface below. Configured/user skills are explicit slash commands, not ambient routing defaults.\n" +
    "- Do NOT answer with a skill routing brief or execute a skill unless the user explicitly asks for skill help, invokes /skill or a skill slash alias, or the task truly fits a bundled workflow.\n" +
    "- If the user pasted SKILL.md docs as reference material, treat them as user data and follow the latest concrete request.\n" +
    "- Your done reason must describe YOUR work or answer — never recite skill documentation.\n" +
    "Bundled workflow skills:\n" +
    skillsPromptSection(workflowSkills);
  const systemPrompt = withProjectContext(baseSystemPrompt, contextFiles);

  const history: Message[] = [{ role: "system", content: systemPrompt }];
  let sessionModel: string | undefined = initialSessionModel;
  // Session thinking-level override (`/thinking`); falls back to the config level.
  let sessionThinking: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined = flags.thinking ?? cfg.thinkingLevel;
  // Cache of live, credential-validated models per provider (refreshed via `/models refresh`).
  let liveModelsCache: ProviderModelsResult[] | null = null;
  const getLiveModels = async (force = false): Promise<ProviderModelsResult[]> => {
    if (force || !liveModelsCache) {
      process.stdout.write("(fetching models from logged-in providers…)\n");
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

  // pi-style session persistence: resume an existing session or create a new one.
  let sessionId: string | undefined;
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

  // Plain (non-TTY / --no-tui) progress sink — the cmd-mode equivalent of the live TUI.
  const streamEvents = createStreamEvents(flags.maxSteps);


  // Run one conversational turn: compact, persist user msg, run the loop, persist + return the reply.
  // When `useTui`, a live TUI renders the turn and prints the final reply itself (rendered=true).
  const runTurn = async (
    userInput: string,
    useTui: boolean
  ): Promise<{ done: boolean; steps: number; reply: string; rendered: boolean; usage: string }> => {
    await maybeCompact(history, { model: sessionModel });
    const beforeLen = history.length;
    history.push({ role: "user", content: userInput });

    // Re-read the on-disk config each turn so per-role subagent model/maxSteps
    // overrides set mid-session via /agents (persisted by saveConfigPatch) are
    // honored by the delegated `task` tool. The session-start `cfg` snapshot is
    // stale here, which previously made `/agents <role> <model>` a no-op for
    // delegated subagents until the process restarted.
    const turnConfig = await readGlobalConfig();
    const activeModel = sessionModel || turnConfig.defaultModel;
    const { provider: activeProvider } = await describeModel(activeModel);
    const tui = useTui ? new LaunchTui({ model: activeModel, provider: activeProvider, sessionId, maxSteps: flags.maxSteps }) : null;
    if (tui) tui.start();
    let result;
    const ac = new AbortController();
    const tools = {
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
    const onSigint = () => ac.abort();
    process.once("SIGINT", onSigint);
    try {
      result = await runAgentLoop(history, {
        cwd,
        tools,
        maxSteps: flags.maxSteps,
        model: sessionModel,
        maxTokens: sessionThinking ? thinkingMaxTokens(sessionThinking) : undefined,
        signal: ac.signal,
        events: tui ? tui.events() : streamEvents,
      });
      // Echo guard: a turn that "answers" by reciting skill-document content gets ONE
      // corrective retry — this is the "reply is just skill docs" bug. The retry keeps
      // the same history (so the model sees its own echo + the correction) on a small
      // step budget; its usage is folded into the turn total.
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
          maxSteps: Math.min(6, flags.maxSteps),
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
    } catch (err) {
      if (tui) tui.finish(`! ${friendlyProviderError(err)}`);
      throw err;
    } finally {
      process.removeListener("SIGINT", onSigint);
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
      for (const m of history.slice(beforeLen)) await appendMessage(sessionId, m, cwd);
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

  const runDirectSubagent = async (roleId: string, taskText: string, useTuiForRun: boolean): Promise<void> => {
    if (!taskText) {
      console.log("Usage: /subagent run [executor|planner|architect|critic] <task>  (or /subagent <role> -- <task>)");
      return;
    }
    const role = getSubagentRole(roleId);
    if (!role) {
      console.log(`Unknown subagent role '${roleId}'. Known: ${SUBAGENT_ROLES.map(r => r.id).join(", ")}.`);
      return;
    }
    const cfgNow = await readGlobalConfig();
    const activeModel = sessionModel || cfgNow.defaultModel;
    // The model the subagent will ACTUALLY run on: per-role override → session/default.
    const roleModel = resolveSubagentModel(role.id, { ...cfgNow, defaultModel: activeModel });
    const { provider } = await describeModel(roleModel);
    const maxSteps = resolveSubagentMaxSteps(role.id, cfgNow);
    const tui = useTuiForRun ? new LaunchTui({ model: roleModel, provider, sessionId, maxSteps }) : null;
    if (tui) tui.start();
    else console.log(`${categoryBadge("subagent")} Subagent: ${role.title} · model ${roleModel} (${provider}) · ≤${maxSteps} steps`);
    const ac = new AbortController();
    const onSigint = () => ac.abort();
    process.once("SIGINT", onSigint);
    try {
      const tool = createTaskTool({
        config: { ...cfgNow, defaultModel: activeModel },
        signal: ac.signal,
        onEvent: tui ? (e => tui.onSubagentEvent(e)) : (e => logTaskSubEvent(e)),
      });
      const res = await tool({ role: role.id, task: taskText }, cwd);
      const text = res.success ? res.output : `! ${res.error || res.output || "subagent failed"}`;
      if (tui) tui.finish(text);
      else console.log(text);
    } catch (err) {
      const text = `! ${friendlyProviderError(err)}`;
      if (tui) tui.finish(text);
      else console.log(text);
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  };

  const joinedArgs = flags.message;
  const isOneShot = joinedArgs.length > 0 || !process.stdin.isTTY;

  if (isOneShot) {
    let messageContent = joinedArgs;
    if (!process.stdin.isTTY && joinedArgs.length === 0) {
      messageContent = (await Bun.stdin.text()).trim();
    }
    if (!messageContent) {
      console.log("No input provided.");
      return;
    }
    const directSubagent = parseDirectSubagentInput(messageContent);
    if (directSubagent) {
      await runDirectSubagent(directSubagent.roleId, directSubagent.task, shouldUseOneShotTui(flags.noTui));
      return;
    }
    const skillInvocation = parseSkillInvocation(messageContent, resolvedSkills);
    if (skillInvocation) {
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
  const welcomeStage = EVOLUTION_STAGES[0];
  await animateAsciiArt(welcomeStage);
  console.log(`\n=== joc launch — interactive coding agent (Evolution Stage: ${welcomeStage.name}) ===`);
  const activeStartModel = sessionModel || defaultModel;
  const { provider: startProvider } = await describeModel(activeStartModel);
  console.log(`Model: ${activeStartModel} (${startProvider})  ·  thinking: ${sessionThinking ?? "medium"}`);
  if (sessionId) console.log(`Session: ${sessionId}`);
  if (contextFiles.length > 0) console.log(`Project context: ${contextFiles.map(f => f.path).join(", ")}`);
  console.log("Type your request. Slash: /help /model /models /provider /agents /subagent run /roles /thinking /skill /view /diff /find /search /sessions /exit  (type / for the full ↑/↓ palette)" + (LaunchTui.usable(flags.noTui) ? "" : "  (plain output)"));

  const useTui = LaunchTui.usable(flags.noTui);
  const runSkillInvocation = async (skill: SkillDoc, intent: string, invokedAs?: string): Promise<void> => {
    // Drive the agent loop to EXECUTE the skill (don't just dump the doc). A concise
    // banner replaces the old full-doc print; the live TUI shows progress, and the
    // final reply is the skill's result.
    if (!useTui) console.log(`▶ Running skill: ${skill.name}${intent ? ` — ${intent}` : ""}`);
    const task = buildSkillTask(skill, intent, invokedAs);
    const { reply, rendered, usage } = await runTurn(task, useTui);
    if (!rendered) console.log(`joc> ${reply}${usage}`);
    else if (usage) console.log(usage.trim());
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
  const rl = createInterface({
    input: process.stdin,
    // Single-box input: gate readline's output while the boxed footer is armed so its own
    // `joc>` prompt/echo is suppressed and ONLY our box shows. (Bun exposes no
    // `_writeToOutput` to patch, so gating the shared output stream is the portable fix.)
    output: gatedStdout(process.stdout, () => previewArmed),
    completer: (line: string) => readlineCompleter(line, completionContext()),
  });

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
  // boxed input instead of silently falling back to the raw `joc>` prompt (previously
  // any terminal under 17 rows lost the box entirely and showed bare CLI input).
  const MAX_PREVIEW_ROWS = 12;
  const MIN_PREVIEW_ROWS = 5; // input box (3 rows) + 2 preview rows
  const previewRowsFor = (rows: number): number => Math.max(MIN_PREVIEW_ROWS, Math.min(MAX_PREVIEW_ROWS, rows - 6));
  const previewEnabled =
    process.stdin.isTTY &&
    process.env.JOC_NO_SLASH_PREVIEW !== "1" &&
    (process.stdout.rows ?? 24) >= MIN_PREVIEW_ROWS + 6; // box + ≥6 scrollable content rows
  // Footer height reserved by the CURRENTLY armed region; disarm/draw must use the
  // same value the arm computed, even if the terminal was resized in between.
  let footerRows = MAX_PREVIEW_ROWS;
  const out = process.stdout;
  let pickerActive = false;
  // Arrow-key selection over the slash preview list.
  let navMatches: string[] = []; // command names matching the typed keyword (display order)
  let navIdx = -1; // highlighted row, -1 = none
  let typedLine = ""; // the user-typed line (restored after readline's history nav)
  let pendingSelection: string | undefined; // command chosen via arrows, applied on Enter
  let lastFooterKey = "";
  const logLines = (lines: string | string[]) => {
    const arr = Array.isArray(lines) ? lines : [lines];
    const cols = Math.max(20, (process.stdout.columns ?? 80) - 1);
    for (const line of arr) {
      console.log(truncateAnsi(line, cols));
    }
  };
  let previewPending = false;

  // Inline boxed-footer rendering (same repaint pattern as runSelectPicker): the
  // footer is drawn at the cursor as ordinary lines and repainted in place with
  // relative cursor moves. The previous implementation reserved the bottom rows
  // via a DEC scroll region (DECSTBM) and cleared them on every redraw — which
  // ERASED any command output that had scrolled into those rows (long `/help`,
  // `/theme`, `/hotkeys` listings lost their tails). Inline repaint never touches
  // scrollback, so command output is always preserved.
  let footerRendered = 0; // rows the footer currently occupies (cursor parks on the last one)
  const armPreview = () => {
    if (!previewEnabled || previewArmed) return;
    footerRows = previewRowsFor(process.stdout.rows ?? 24);
    previewArmed = true;
  };
  // Clear the footer rows and park the cursor back at the footer's first row so
  // subsequent command output starts exactly where the box was.
  const disarmPreview = () => {
    if (!previewArmed) return;
    previewArmed = false;
    lastFooterKey = "";
    if (footerRendered > 0) {
      let s = footerRendered > 1 ? cursorUp(footerRendered - 1) : "";
      for (let i = 0; i < footerRendered; i++) {
        s += toColumn(1) + clearLine();
        if (i < footerRendered - 1) s += "\x1b[1B"; // cursor-down: no scroll at the bottom margin
      }
      if (footerRendered > 1) s += cursorUp(footerRendered - 1);
      s += toColumn(1) + "\x1b[?25h";
      out.write(s);
      footerRendered = 0;
    } else {
      out.write("\x1b[?25h");
    }
  };
  const previewLines = (line: string, selected = -1): string[] => {
    const cols = Math.max(24, (process.stdout.columns ?? 80) - 1);
    const input = renderInputBox(line, {
      cols,
      color: true,
      unicode: true,
      cwdLabel: currentAtLabel(line),
      maxBodyRows: Math.max(1, footerRows - 5),
    }).map(l => truncateAnsi(l, cols));
    const budget = Math.max(0, footerRows - input.length);
    const slash = budget > 0 ? formatSlashPreview(line, budget, selected, skillSlashDetails) : [];
    const args = !slash.length && budget > 0 ? formatCompletionPreview(line, completionContext(), budget) : [];
    const preview = (slash.length ? slash : args).map(l => chalk.gray(truncateAnsi(l, cols)));
    return [...input, ...preview].slice(0, footerRows);
  };
  const drawFooter = (lines: string[]) => {
    if (!previewArmed) return;
    const key = lines.join("\n");
    if (key === lastFooterKey) return;
    lastFooterKey = key;
    const total = Math.max(footerRendered, lines.length);
    if (total === 0) return;
    let s = footerRendered > 1 ? cursorUp(footerRendered - 1) : "";
    for (let i = 0; i < total; i++) {
      s += toColumn(1) + clearLine();
      if (i < lines.length) s += lines[i]!;
      // Move down: over rows the footer already occupies use CUD (no scroll at the
      // bottom margin → no anchor drift); for newly appended rows use a real
      // newline (scrolls uniformly, keeping the drawn block contiguous).
      if (i < total - 1) s += i < footerRendered - 1 ? "\x1b[1B" + toColumn(1) : "\n";
    }
    // Park the cursor on the footer's last VISIBLE row (or its first row when empty).
    const parkRow = Math.max(lines.length - 1, 0);
    if (total - 1 > parkRow) s += cursorUp(total - 1 - parkRow);
    s += "\x1b[?25h";
    out.write(s);
    footerRendered = lines.length;
  };

  const runSelectPicker = async <T>(
    render: (cols: number, rows: number) => string[],
    onKey: (ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => boolean | undefined,
  ): Promise<void> => {
    pickerActive = true;
    disarmPreview();
    const cols = Math.max(40, terminalSize().cols - 2);
    const rows = Math.max(6, terminalSize().rows - 6);
    let rendered = 0;
    const repaint = () => {
      const lines = render(cols, rows).map(line => truncateAnsi(line, cols));
      let s = rendered > 0 ? cursorUp(rendered) : "\n";
      const total = Math.max(rendered, lines.length);
      for (let i = 0; i < total; i++) {
        s += toColumn(1) + clearLine();
        if (i < lines.length) s += lines[i]!;
        if (i < total - 1) s += "\n";
      }
      out.write(s + "\x1b[?25h");
      rendered = total;
    };
    const clear = () => {
      if (rendered <= 0) return;
      let s = cursorUp(rendered);
      for (let i = 0; i < rendered; i++) {
        s += toColumn(1) + clearLine();
        if (i < rendered - 1) s += "\n";
      }
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
      pickerActive = false;
    }
  };

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
    const cloud = new Set(["anthropic", "openai", "gemini"]);
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
    process.stdin.on("keypress", (_ch: string, key: { name?: string } | undefined) => {
      if (pickerActive || previewPending) return;
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
          navMatches = slashPreviewMatches(typedLine, skillSlashDetails);
          navIdx = -1;
          pendingSelection = undefined;
          drawFooter(previewLines(typedLine));
        } catch { /* ignore render races */ }
      });
    });
    // Idle-prompt resize: recompute the footer height budget and repaint the
    // inline box at the new width (no scroll region to re-sync anymore).
    process.stdout.on("resize", () => {
      if (!previewArmed) return;
      try {
        footerRows = previewRowsFor(process.stdout.rows ?? 24);
        lastFooterKey = "";
        drawFooter(previewLines(typedLine, navIdx));
      } catch { /* ignore resize render races */ }
    });
  }

  try {
    while (true) {
      armPreview();
      // Render the boxed input immediately (placeholder) so the prompt is visible
      // even though readline's own "joc>" echo is now suppressed in box mode.
      typedLine = "";
      navMatches = [];
      navIdx = -1;
      drawFooter(previewLines(""));
      // Box mode: NO raw `joc>` prompt at all — the boxed footer IS the input UI
      // (gating already suppresses readline echo, the empty prompt guarantees no
      // raw CLI input line can ever flash). Legacy prompt only without the box.
      const raw = (await rl.question(previewEnabled ? "" : "\njoc> ")).trim();
      disarmPreview();
      // If an arrow-key selection was made over the slash preview, run that command.
      let input = pendingSelection && isSlashAttempt(raw) && pendingSelection.startsWith(raw)
        ? pendingSelection
        : raw;
      // gjc-parity command aliases (full behavior reuse, no duplicated handlers).
      if (input === "/login" || input.startsWith("/login ")) input = `/provider login${input.slice("/login".length)}`;
      else if (input === "/settings") input = "/config";
      pendingSelection = undefined;
      navMatches = [];
      navIdx = -1;
      if (input === "/exit" || input === "/quit") break;
      if (input === "") continue;
      if (input === "/" || input === "/?" || input === "/help") {
        logLines(formatSlashCommandList(input === "/help" ? "/" : input, skillSlashDetails));
        console.log("Tools: read / write / edit / bash / find / search. Sessions persist to .joc/sessions/.");
        const tip = getEvolutionTip(history.length, flags.maxSteps);
        console.log(`\n${chalk.cyan("Evolutionary Tip:")} ${tip}`);
        continue;
      }
      if (input === "/clear") {
        history.length = 1;
        console.log("(history cleared)");
        continue;
      }
      if (input === "/compact") {
        const res = await maybeCompact(history, { model: sessionModel, force: true });
        console.log(res.compacted ? `(compacted ${res.removed} older messages)` : "(nothing to compact)");
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
          if (!rendered) {
            console.log(`joc> ${reply}${usage}`);
            if (!done) console.log(`(agent did not converge in ${steps} steps)`);
          } else if (usage) {
            console.log(usage.trim());
          }
        } catch (err) {
          console.log(`! ${friendlyProviderError(err)}`);
        }
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
        const outPath = path.resolve(cwd, pathToken ?? `joc-session-${sessionId.slice(0, 8)}.${format === "json" ? "json" : "md"}`);
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
            { role: "system", content: "You are joc. Answer the user's side question concisely in plain text using the conversation context. Do not call tools; reply directly." },
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
        process.env.JOC_TUI_THEME = want;
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
          const cloud = ["anthropic", "openai", "gemini"] as const;
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
              const ans = (await rl.question("Choose [1-3] or name (blank to cancel): ")).trim().toLowerCase();
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
          const picked = await pickLiveProviderModel(name, providerPick, currentResolved, st && !st.ready ? [name] : []);
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
              console.log(`Cannot select ${sel.entry.model}: ${name} is not ready (${st.label}). Set ${st.envVar ?? "the provider key"} first.`);
              continue;
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
        console.log(`Model set to ${formatModelLine({ label: target, resolved, provider, ready: st?.ready })}`);
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
        const cloud = ["anthropic", "openai", "gemini"];
        const target = input.substring(7).trim().split(/\s+/).map(t => t.toLowerCase()).find(t => cloud.includes(t));
        if (!target) {
          console.log("Usage: /logout <anthropic|openai|gemini>");
          continue;
        }
        const removed = await logoutOAuth(target as AuthProvider);
        console.log(removed ? `[SUCCESS] Removed OAuth token for ${target}.` : `No OAuth token stored for ${target}.`);
        await refreshLiveModelsCache();
        continue;
      }
      const agentsCommand =
        input === "/agents" || input.startsWith("/agents ") ? "/agents" :
        input === "/subagents" || input.startsWith("/subagents ") ? "/subagents" :
        input === "/subagent" || input.startsWith("/subagent ") ? "/subagent" :
        undefined;
      if (agentsCommand) {
        const tokens = input.substring(agentsCommand.length).trim().split(/\s+/).filter(Boolean);
        const directSubagent = parseDirectSubagentInput(input);
        if (directSubagent) {
          await runDirectSubagent(directSubagent.roleId, directSubagent.task, useTui);
          continue;
        }
        const roleArg = tokens[0];
        const modelArg = tokens[1];
        const cfgNow = await readGlobalConfig();
        if (!roleArg || roleArg === "/" || roleArg === "?" || roleArg.toLowerCase() === "help") {
          console.log("Subagent roles (used by 'joc team'):");
          for (const line of formatAgentsPanel(SUBAGENT_ROLES, r => ({
            model: resolveSubagentModel(r.id, cfgNow),
            maxSteps: resolveSubagentMaxSteps(r.id, cfgNow),
          }))) console.log(line);
          console.log("Detail: /agents <role>  ·  set model: /agents <role> <model|#N>  ·  provider: /agents <role> provider <name> [model]  ·  steps: /agents <role> maxSteps <N>");
          console.log("Run now: /subagent run [role] <task>  ·  /subagent <role> -- <task>");
          console.log("Available: executor, planner, architect, critic");
          console.log("Subcommands: run, <role> <model|#N>, <role> provider <name> [model], <role> maxSteps <N>, <role> reset");
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
            console.log(`Usage: /agents ${role.id} provider <anthropic|openai|gemini|ollama> [model|#N]`);
            continue;
          }
          const st = (await describeAllProviders()).find(s => s.name === want);
          if (st && !st.ready) {
            console.log(`Cannot pin ${role.title} to ${want}: not ready (${st.label}). Set ${st.envVar ?? "the provider key"} first.`);
            continue;
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
                console.log(`Cannot pin ${sel.entry.model}: ${sel.entry.provider} is not ready (${bad.label}). Set ${bad.envVar ?? "the provider key"} first.`);
                continue;
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
          // Persist a per-role model override to ~/.joc/config.json (consumed by 'joc team').
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
          await saveConfigPatch(() => ({ defaultModel: finalSave }));
          const { resolved, provider } = await describeModel(finalSave);
          console.log(`Default model saved: ${formatModelLine({ label: finalSave, resolved, provider })} → ~/.joc/config.json`);
          continue;
        }
        const statuses = await describeAllProviders();
        const disabledModelProviders = statuses.filter(s => !s.ready).map(s => s.name);
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
        if (arg) sessionModel = arg;
        const { resolved, provider } = await describeModel(label);
        const st = statuses.find(s => s.name === provider);
        console.log(`${arg ? "Model set to" : "Current model"}: ${formatModelLine({ label, resolved, provider, ready: st?.ready })}`);
        if (st && !st.ready) console.log(`  ! ${provider} is not ready (${st.label}) — set ${st.envVar ?? "the provider key"} or run 'joc setup'.`);
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
          const live = await getLiveModels();
          lastPickIndex = flattenModels(live);
          console.log("Live models (logged-in providers) — set with /model #N:");
          for (const line of formatPickListWithCapabilities(lastPickIndex, { current: resolved, cap: 20 })) console.log(line);
        }
        console.log("  (persist as default: /model save)");
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
        const rest = skillEntrypoint === "/skill:" ? input.substring(7).trim() : input.substring(6).trim();
        const skills = await loadSkills(cwd);
        if (!rest) {
          if (process.stdin.isTTY && process.stdout.isTTY) {
            const picked = await pickSkillFromList(skills);
            if (!picked) {
              console.log("(cancelled)");
              continue;
            }
            try {
              await runSkillInvocation(picked, "");
            } catch (err) {
              console.log(`! ${(err as Error).message}`);
            }
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
      try {
        const { done, steps, reply, rendered, usage } = await runTurn(input, useTui);
        if (!rendered) {
          console.log(`joc> ${reply}${usage}`);
          if (!done) console.log(`(agent did not converge in ${steps} steps)`);
        } else if (usage) {
          console.log(usage.trim());
        }
      } catch (err) {
        console.log(`! ${friendlyProviderError(err)}`);
      }
    }
  } finally {
    disarmPreview(); // clear footer + restore full-screen scrolling before leaving the REPL
    rl.close();
  }
}
