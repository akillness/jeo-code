import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { runAgentLoop, DEFAULT_TOOLS, TOOL_PROTOCOL, WORKING_DISCIPLINE, OUTPUT_DISCIPLINE, VERIFICATION_DIRECTIVE, type AgentLoopEvents } from "../agent/engine";
import { computerSupervisor } from "../agent/computer-supervisor";
import { executeComputerAction } from "./computer";

import { createOpikTracer, wrapEvents } from "../agent/opik-tracer";
import { initialDynamicStepLimit } from "../agent/step-budget";
import { memoryPromptSection, spawnDetachedDistill, recordFailedAttempt } from "../agent/memory";
import { createTaskTool, taskToolProtocolLine, type TaskSubEvent } from "../agent/task-tool";
import { createSubagentTool, SUBAGENT_TOOL_PROTOCOL_LINE } from "../agent/subagent-tool";
import { SubagentRegistry } from "../agent/subagent-registry";
import { stopSessionNotifyEndpoint, startSessionNotifyEndpoint, type SessionNotifyEndpoint } from "../agent/notify/session-endpoint";
import { parseInThreadConfigCommand } from "../agent/notify/config-commands";

import { createTodoTool, TODO_TOOL_PROTOCOL_LINE } from "../agent/todo-tool";
import { createJobTool, JOB_TOOL_PROTOCOL_LINE } from "../agent/job-tool";
import { JobRegistry } from "../agent/job-registry";
import { createIrcTool, IRC_TOOL_PROTOCOL_LINE } from "../agent/irc-tool";
import { createGoalTool, GOAL_TOOL_PROTOCOL_LINE } from "../agent/goal-tool";
import { createApproveTool, APPROVE_TOOL_PROTOCOL_LINE } from "../agent/approve-tool";
import { LaunchTui } from "../tui/app";
import { runDeepInterviewEngine, type DeepInterviewEngineOptions } from "./deep-interview";
import { runRalplanEngine, type RalplanEngineOptions } from "./ralplan";
import { runTeamEngine, type TeamEngineOptions } from "./team";
import { runUltragoalEngine, type UltragoalEngineOptions } from "./ultragoal";
import { skillsPromptSection, loadSkills, buildSkillTask, workflowSkillsForPrompt, parseSkillInvocation, parseSkillChain, skillSlashAliases, looksLikeSkillEcho, skillInvocationCard, type SkillDoc, type SkillInvocation } from "../skills/catalog";
import { formatForgeBox, scaleForgeWidth } from "../tui/components/forge";
import { interactiveOAuthLogin } from "./auth";
import { logoutOAuth, OAUTH_PROVIDERS, API_KEY_ONLY_PROVIDERS, setApiKey } from "../auth";
import type { AuthProvider } from "../auth";
import { matchSlash, isSlashAttempt, suggestSlashCommands, formatSlashCommandList, formatSlashPreview, slashPreviewMatches, activeTriggerToken, allTriggerTokens, tabCompleteSelection, type SlashCommandInfo } from "../tui/components/slash";
import { staticCompletionContext, readlineCompleter, formatCompletionPreview, formatMidTurnHint, tokenize, type CompletionContext } from "../tui/components/autocomplete";
import { normalizeBaseUrl } from "./setup-helpers";
import { EVOLUTION_STAGES, animateAsciiArt } from "../tui/components/ascii-art";
import { getEvolutionTip } from "../tui/components/evolution";
import { renderWelcome, playWelcomeSweep } from "../tui/components/welcome";
import { checkForUpdate, readUpdateCache, writeUpdateCache } from "../util/update-check";
import { jeoEnv } from "../util/env";
import { renderUpdateBox } from "../tui/components/update-box";
import { consumeLaunchWhatsNew } from "../util/whats-new";
import { maybeBell } from "../util/notify";
import { supportsUnicode } from "../tui/components/capability";
import pkg from "../../package.json";
import chalk from "chalk";
import { callLlm, type Message } from "../agent/loop";
import { friendlyProviderError } from "../util/provider-error";
import { readGlobalConfig, saveConfigPatch, resolveWikiRoot } from "../agent/state";
import { rememberModelPatch, recentModelsForDisplay } from "../agent/model-recency";
import { describeModel, describeAllProviders, describeProvider, resolveProvider, thinkingMaxTokens, resolveMaxOutputTokens, thinkingToReasoningEffort, discoverModels, flattenModels, resolveSelection, catalogMetadata, catalogByProvider, resolveRoleModel, CODEX_MODELS, qualifyModelId, modelServableWithConfig, isLocalProviderReachable } from "../ai";
import type { ProviderModelsResult, PickEntry, ProviderName, ModelRole, ThinkLevel } from "../ai";
import { readGoalState, writeGoalState, clearGoalState, verifyGoal, applyEvidenceGate } from "../agent/goal-verifier";
import { routePrompt, deriveCacheSessionKey, warnOnce, tierModelPool, selectFromPool, PROMPT_TIERS, withRoutingTierSetting, inferTierForModel, type PromptTier, type RouteDecision } from "../agent/prompt-router";
import { RouteHistory } from "../agent/route-history";

import { isRateLimitError, isUsageLimitError, isConnectionError } from "../util/retry";


import { listAliases } from "../ai/model-registry";
import { openaiCompatDef, SUBSCRIPTION_PROVIDER_NAMES } from "../ai/providers/openai-compatible-catalog";

import { allSubagentRoles, getSubagentRole, resolveSubagentModel, resolveSubagentMaxSteps, resolveSubagentThinking, parseMaxSteps, withSubagentSetting, clearSubagentSetting, applyTargetChoices } from "../agent/subagents";
import { SelectList, renderSelectList, type SelectItem } from "../tui/components/select-list";

import {
  formatModelLine,
  formatProviderPanel,
  formatAgentsPanel,
  formatAgentDetail,
  formatConfigPanel,
  formatPickListWithCapabilities,
  formatCapabilityLine,
} from "../tui/components/config-panel";
import { liveModelPicker, renderLiveModelPicker, buildThinkingLevelChoices, type ModelAssignmentBadge } from "../tui/components/live-model-picker";

import { loginPicker, renderLoginPicker, onboardingPicker, renderOnboardingPicker, apiKeyPicker, renderApiKeyPicker, subscriptionLoginPicker, type OnboardingAction } from "../tui/components/provider-picker";
import { sanitizeForTerminal } from "../tui/components/code-view";

import { categoryBadge } from "../tui/components/category-index";
import { renderInputFrame, type HighlightRange } from "../tui/components/input-box";

import { renderStatusBar } from "../tui/components/status";
import { detectColorLevel, ColorLevel, visibleWidth } from "../tui/components/color";
import { readClipboardImage } from "../util/clipboard-image";
import { attachImagePaths, insertImageTag } from "../util/file-attachment";

import { copyTextToClipboard, readClipboardText } from "../tui/clipboard";
import { loadInputHistory, appendInputHistory } from "../agent/input-history";
import type { ImageAttachment } from "../ai/types";
import { renderMarkdownTables } from "../tui/components/markdown-table";
 
import { stripMarkdown } from "../tui/components/markdown-text";
import { summarizeForgeInvocation } from "../tui/components/forge";
import { formatDuration, formatUsage } from "../tui/components/duration";

import { bashTool } from "../agent/tools";

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
  updateSessionModel,
  updateSessionDraft,
  appendCompaction,
  resolveSessionRef,
} from "../agent/session";
import { clearLine, cursorUp, toColumn, truncate as truncateAnsi, size as terminalSize, resetMouseTracking, clearScreen, clearVisible, clearToEnd, enableModifyOtherKeys, disableModifyOtherKeys, enableKittyKeyboard, disableKittyKeyboard, setCursorColor, resetCursorColor, isTTY, watchResize } from "../tui/terminal";




import {
  type LaunchFlags,
  parseFlags,
  matchSkillGlob,
  filterToolMap,
  buildToolProtocol,
  TOOL_DESCRIPTIONS,
  fastThinkingLevelForModel,
  isProviderName,
  isThinkingLevel,
} from "./launch/flags";
import {
  tmuxSessionName,
  gitDirtyCount,
  allocateTmuxSession,
  shouldEnableCurrentTmuxMouse,
  tmuxLaunchCommand,
  tmuxProfileCommands,
  currentTmuxClipboardCommands,
  resolveWorktree,
  shellQuote,
  reapStaleTmuxSessions,
  callerTmuxTerminalSize,
  tmuxNewSessionSizeArgs,
  type TmuxTerminalSize,
  type TmuxCreateResult,
  type TmuxProfileCommand,
} from "./launch/tmux";
import {
  type InFlightAbortHarness,
  type PromptInputQueue,
  PASTE_START,
  PASTE_END,
  isStandaloneBackspace,
  CURSOR_COMBO_REWRITES,
  matchCursorCombo,
  matchMouseReport,
  matchTerminalReport,
  stripMouseReports,
  rewriteCursorCombos,
  stripPasteEscapes,
  MULTILINE_SENTINEL,
  isGenuineMultilineDraft,
  shouldBoxVerticalNav,
  boxVerticalNavAction,
  queuePromptInputChunk,
  captureLivePromptInputChunk,
  draftFromUnsentLine,
  restoreQueuedLinesToPrefill,
  createInFlightAbortHarness,
  classifyMidTurnLine,
  decideCtrlC,
  filterPromptInputChunk,
  pasteIdleDecision,
  PASTE_MERGE_IDLE_MS,
  chunkHasCtrlC,
  normalizeKeypress,
} from "./launch/input";
import {
  gatedStdout,
  formatTaskSubEvent,
  logTaskSubEvent,
  createStreamEvents,
  shouldUseOneShotTui,
} from "./launch/stream";
import {
  WORKFLOW_NAMES,
  isWorkflowSkill,
  runWorkflowEngine,
} from "./launch/workflow";
import {
  mentionPaths as mentionPathsIn,
  currentAtLabel as currentAtLabelFn,
} from "./launch/mentions";
import {
  hotkeysLines,
  contextUsageLines,
  historyViewLines,
} from "./launch/slash-views";
import { formatTranscript } from "../tui/components/transcript";


import {
  handleUsage,
  handleTools,
  handleHotkeys,
  handleContext,
  type SlashContext,
} from "./launch/slash-handlers";
import {
  handleViewSlash,
  handleDiffSlash,
  handleFindSlash,
  handleSearchSlash,
} from "./launch/code-slash";
import { handleUndoSlash } from "./launch/git-slash";
import { runSessionSlash } from "./launch/session-slash";
import { runModelSlash } from "./launch/model-slash";
import { runRouteSlash } from "./launch/route-slash";
import { runComputerSlash } from "./launch/computer-slash";

import { runAgentsSlash, runRolesSlash, runFastSlash, runThinkingSlash } from "./launch/agents-slash";
import { wikiRootPromptLine, decideWikiSlash } from "./launch/wiki-slash";
import { decideThemeSlash, buildConfigPanelLines, runEvolveSimulation } from "./launch/system-slash";



export {
  type LaunchFlags,
  parseFlags,
  matchSkillGlob,
  filterToolMap,
  buildToolProtocol,
  TOOL_DESCRIPTIONS,
  fastThinkingLevelForModel,
  isProviderName,
  isThinkingLevel,
  tmuxSessionName,
  gitDirtyCount,
  allocateTmuxSession,
  shouldEnableCurrentTmuxMouse,
  tmuxLaunchCommand,
  tmuxProfileCommands,
  currentTmuxClipboardCommands,
  resolveWorktree,
  shellQuote,
  reapStaleTmuxSessions,
  callerTmuxTerminalSize,
  tmuxNewSessionSizeArgs,
  type TmuxTerminalSize,
  type TmuxCreateResult,
  type TmuxProfileCommand,
  type InFlightAbortHarness,
  type PromptInputQueue,
  PASTE_START,
  PASTE_END,
  isStandaloneBackspace,
  CURSOR_COMBO_REWRITES,
  matchCursorCombo,
  matchMouseReport,
  matchTerminalReport,
  stripMouseReports,
  rewriteCursorCombos,
  MULTILINE_SENTINEL,
  isGenuineMultilineDraft,
  shouldBoxVerticalNav,
  boxVerticalNavAction,
  queuePromptInputChunk,
  captureLivePromptInputChunk,
  draftFromUnsentLine,
  restoreQueuedLinesToPrefill,
  createInFlightAbortHarness,
  classifyMidTurnLine,

  gatedStdout,
  formatTaskSubEvent,
  logTaskSubEvent,
  createStreamEvents,
  shouldUseOneShotTui,
  WORKFLOW_NAMES,
  isWorkflowSkill,
  runWorkflowEngine,
  mentionPathsIn as mentionPaths,
  currentAtLabelFn as currentAtLabel,
};
export function normalizeSlashAlias(input: string): string {
  // gjc-parity: bare `/login` opens the provider onboarding selector (same as bare
  // `/provider`); `/login <provider|args>` is the direct OAuth-login alias.
  if (input === "/login") return "/provider";
  if (input.startsWith("/login ")) return `/provider login${input.slice("/login".length)}`;
  if (input === "/settings") return "/config";
  if (input === "/subagent" || input.startsWith("/subagent ")) return `/agents${input.slice("/subagent".length)}`;
  if (input === "/subagents" || input.startsWith("/subagents ")) return `/agents${input.slice("/subagents".length)}`;
  if (input === "/resume" || input.startsWith("/resume ")) return `/session resume${input.slice("/resume".length)}`;
  // gjc-parity: /new, /drop, /rename, /sessions are top-level palette aliases for
  // their /session <sub> implementations (same pattern as /resume above).
  if (input === "/new") return "/session new";
  if (input === "/drop") return "/session drop";
  if (input === "/rename" || input.startsWith("/rename ")) return `/session rename${input.slice("/rename".length)}`;
  if (input === "/sessions") return "/session list";
  return input;
}

// Per-provider starting model for `--provider <name>` / role pinning. Catalog
// OpenAI-compatible providers supply their own default; built-ins use this map.
// Sentinel returned by an aborted `rl.question()` (remote-inject or stdin-close
// won the race first) — a unique object identity so it can never collide with
// real user input, however unlikely a matching string would be.
const REMOTE_ABORT_SENTINEL = Symbol("remote-abort");
const STATIC_PROVIDER_DEFAULT: Partial<Record<ProviderName, string>> = { anthropic: "sonnet", openai: "gpt-5.5", gemini: "flash", antigravity: "antigravity/gemini-3-pro-high", ollama: "fast", lmstudio: "lmstudio/local-model", xai: "grok-4.3", kimi: "kimi-k2-0711-preview" };
function providerDefaultModel(p: ProviderName): string {
  return openaiCompatDef(p)?.defaultModel ?? STATIC_PROVIDER_DEFAULT[p] ?? "";
}

/**
 * Pick-list entries for ONE provider, with static fallbacks so the list is never
 * empty.
 *
 * Live discovery yields ids only for a logged-in, reachable provider, and
 * `catalogOr` backfills the static catalog for OAuth sources and for API-key
 * providers whose models-list endpoint is absent (HTTP 404, e.g. Tencent MaaS).
 * A not-yet-configured provider still has an empty live list, so prefer live ids;
 * else the provider's capability catalog; else its single known default model (all
 * 24 OpenAI-compat providers carry one) so the user always sees at least one id.
 */
export function providerPickEntries(live: ProviderModelsResult[], want: ProviderName): PickEntry[] {
  const fromLive = flattenModels(live.filter(r => r.provider === want));
  if (fromLive.length) return fromLive;
  const catalog = catalogByProvider(want);
  if (catalog.length) {
    return catalog.map((m, i) => ({ index: i + 1, provider: want, model: qualifyModelId(m.providerModel, want) }));
  }
  // Offline fallback for catalog-less (OpenAI-compatible) providers: the def's
  // defaultModel first, then its knownModels list, so the per-role provider picker
  // shows several pickable ids instead of one. De-duped + provider-qualified.
  const def = openaiCompatDef(want);
  if (def) {
    const ids = [def.defaultModel, ...(def.knownModels ?? [])].map(m => qualifyModelId(m, want));
    const seen = new Set<string>();
    const entries: PickEntry[] = [];
    for (const model of ids) {
      if (seen.has(model)) continue;
      seen.add(model);
      entries.push({ index: entries.length + 1, provider: want, model });
    }
    if (entries.length) return entries;
  }
  const fallback = providerDefaultModel(want);
  return fallback ? [{ index: 1, provider: want, model: qualifyModelId(fallback, want) }] : [];
}

export function formatResumeHint(sessionId: string): string {
  return `Resume with: jeo launch --resume ${sessionId}`;
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
      if (jeoEnv("TMUX_LAUNCHED") !== "1") console.log(`Using worktree: ${wt}`);
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
    (flags.modelRole ? resolveRoleModel(flags.modelRole, cfg) : flags.provider ? providerDefaultModel(flags.provider) : undefined);
  if (flags.provider && initialSessionModel) {
    const { provider } = await describeModel(initialSessionModel);
    if (provider !== flags.provider) {
      console.log(`error: selected model '${initialSessionModel}' resolves to ${provider}, not requested provider ${flags.provider}.`);
      return;
    }
  }

  if (flags.tmux) {
    if (!process.env.TMUX && jeoEnv("TMUX_LAUNCHED") !== "1") {
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
        const cmd = tmuxLaunchCommand(process.argv[1], process.execPath, cwd);

        const innerCmd = `exec env JEO_TMUX_LAUNCHED=1 ${[...cmd, "launch", ...innerArgs].map(shellQuote).join(" ")}`;

        // Create a fresh, independent session (race-safe: the create is the guard).
        // Size the DETACHED session to the caller terminal (gjc launch-tmux parity
        // #1376): without -x/-y tmux creates it 80x24 and the inner jeo's first
        // frames render mis-wrapped into the pane scrollback before attach resizes.
        const termSize = callerTmuxTerminalSize();
        const alloc = allocateTmuxSession(sessionBase, name => {
          const created = Bun.spawnSync([tmuxBin, "new-session", "-d", ...tmuxNewSessionSizeArgs(termSize), "-s", name, "-c", cwd, innerCmd]);
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
        // gjc-parity session profile (mouse / clipboard / copy-mode style / @jeo-*
        // markers): wheel-up enters copy-mode over the REAL pane history, so the
        // mid-turn scrollback (ledger lines flushed above the live frame) is
        // reachable with the mouse wheel. Session-scoped (`-t =name`, never -g).
        // Best-effort per command: an old tmux missing an option is fine.
        for (const profileCmd of tmuxProfileCommands(sessionName, process.env, { branch: branch || undefined, project: cwd })) {
          try { Bun.spawnSync([tmuxBin, ...profileCmd.args]); } catch { /* best-effort */ }
        }
        // Reap orphaned jeo sessions: each detached, long-idle `jeo launch` REPL
        // pins tens of MB forever, so over days they pile up and aggregate RSS
        // climbs (the "jeo/bun 프로세스가 쌓여 메모리가 점점 커진다" report). Sweep the
        // jeo-owned, unattached, long-idle ones — never the one just created.
        // Best-effort; opt out with JEO_TMUX_REAP=0.
        try {
          const reaped = reapStaleTmuxSessions(tmuxBin, [sessionName]);
          if (reaped.length > 0) {
            console.log(
              `Reaped ${reaped.length} idle jeo tmux session${reaped.length === 1 ? "" : "s"}: ${reaped.join(", ")}`,
            );
          }
        } catch { /* best-effort */ }
        console.log(
          sessionName === sessionBase
            ? `Starting new tmux session: ${sessionName}`
            : `Starting new independent tmux session: ${sessionName} (another live jeo session already owns ${sessionBase}; reattach later with: tmux attach -t ${sessionName})`,
        );

        // Re-assert the caller dimensions right before attach (best-effort): profile
        // commands or a slow first frame can land while the window is still detached.
        if (termSize) {
          try {
            Bun.spawnSync([tmuxBin, "resize-window", "-t", `=${sessionName}`, "-x", String(termSize.columns), "-y", String(termSize.rows)]);
          } catch { /* best-effort — old tmux without resize-window is fine */ }
        }

        const attach = Bun.spawn([tmuxBin, "attach-session", "-t", `=${sessionName}`], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        // A nonzero attach exit (e.g. "open terminal failed: not a terminal" when
        // stdout isn't a real TTY, a too-small client, or a transient server error)
        // otherwise vanished: jeo returned 0 and the freshly created session was left
        // orphaned with no hint. Surface it. Only advise reattach when the session is
        // STILL live — if the inner jeo already exited (bad args, instant crash) the
        // session is gone and "reattach" would be misleading.
        const attachCode = await attach.exited;
        if (attachCode !== 0) {
          const alive = Bun.spawnSync([tmuxBin, "has-session", "-t", `=${sessionName}`], {
            stdout: "ignore",
            stderr: "ignore",
          }).exitCode === 0;
          console.error(
            alive
              ? `Error: tmux attach failed (exit ${attachCode}). The session is still running; reattach with: tmux attach -t ${sessionName}`
              : `Error: tmux session ${sessionName} ended before it could be attached (attach exit ${attachCode}).`,
          );
          process.exitCode = attachCode;
        }
        return;

      } else {
        console.warn("warning: tmux is not available on PATH. Launching directly...");
      }
    } else if (shouldEnableCurrentTmuxMouse(process.env)) {
      // `jeo --tmux` INSIDE an existing tmux session: no new session is created, but
      // wheel scrolling still needs tmux mouse mode — without it tmux ignores the
      // wheel entirely, so the live-turn scrollback contract (ledger lines flushed
      // above the inline frame) is unreachable ("scroll doesn't work"). Session-
      // scoped (never -g), best-effort; JEO_TMUX_MOUSE=0 opts out.
      const tmuxBin = Bun.which("tmux");
      if (tmuxBin) {
        try { Bun.spawnSync([tmuxBin, "set-option", "mouse", "on"]); } catch { /* best-effort */ }
        // Enabling the mouse re-routes a drag into copy-mode; set-clipboard +
        // copy-command make that drag-select actually land on the system clipboard.
        for (const c of currentTmuxClipboardCommands(process.env)) {
          try { Bun.spawnSync([tmuxBin, ...c.args]); } catch { /* best-effort */ }
        }
      }
    }
  }


  // --list: print persisted sessions and exit.
  if (flags.list) {
    const sessions = await listSessions(cwd);
    if (sessions.length === 0) {
      console.log("No saved sessions in .jeo/sessions/.");
      return;
    }
    console.log("Saved sessions (newest first):");
    for (const s of sessions) {
      console.log(`  ${s.id}  ${s.timestamp}  (${s.messageCount} msgs)${s.model ? `  [${s.model}]` : ""}  ${s.preview}`);
    }
    console.log("\nResume with: jeo launch --resume <id>");
    return;
  }

  // pi-style: load project context (JEO.md / AGENTS.md / .jeo/context.md / CLAUDE.md) into the prompt.
  const contextFiles = await loadProjectContext(cwd);

  const KNOWN_TOOLS = new Set(["read", "write", "edit", "bash", "find", "search", "ls", "task", "todo", "subagent", "job", "irc", "goal", "approve", "ast_grep", "ast_edit", "computer", "lsp", "lsp_rename", "debug", "browser"]);
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
  // Skills are invoked ONLY via the `$` entrypoint — never as `/` commands. A skill's declared
  // aliases (frontmatter `aliases:`/`slash:`) are additionally `$`-invocable (`/obsidian-capture`
  // → `$obsidian-capture`), so they extend `$` autocomplete (see resolvedSkillTokens) rather than
  // the slash palette. The slash menu stays builtins-only, hence skillSlashDetails is empty.
  const skillSlashDetails: SlashCommandInfo[] = [];
  // Declared-alias tokens (the alias text without its leading `/`), surfaced in `$` autocomplete
  // next to skill names so installing a skill grows the `$` menu, not the `/` menu.
  const resolvedSkillTokens = [...new Set([
    ...resolvedSkillNames,
    ...resolvedSkills.flatMap(s => skillSlashAliases(s).map(a => a.replace(/^\//, ""))),
  ])];

  const protocol = buildToolProtocol(allowedTools);
  const preamble = flags.systemPrompt ?? "You are the jeo, an interactive coding agent.\nAccomplish the user's request by calling tools and verifying your work.";
  // Prior-session learnings (B6 경험 증류) — "" when absent or JEO_NO_MEMORY=1.
  // The one-shot task text (flags.message) seeds relevance search so the most
  // pertinent concepts win the injection budget; interactive boots with no query
  // (high-confidence core concepts are always prioritized regardless).
  const memoryBlock = await memoryPromptSection(cwd, flags.message || undefined);

  // Global llm-wiki vault root (config `wikiRoot` / env JEO_WIKI_ROOT). When specified
  // it is applied two ways: exported to JEO_WIKI_ROOT so hooks, subagents and the
  // ~/.agents/rules wiki rule resolve the same path, and stated in the system prompt so
  // every session — regardless of project/cwd — references the one shared global wiki.
  // Global llm-wiki vault root, mutable so a mid-session `/wiki <path>` re-applies it.
  let sessionWikiRoot = resolveWikiRoot(cfg);
  if (sessionWikiRoot && !process.env.JEO_WIKI_ROOT) process.env.JEO_WIKI_ROOT = sessionWikiRoot;
  const baseSystemPromptNoMemory =
    preamble + "\n\n" + protocol + "\n\n" +
    WORKING_DISCIPLINE + "\n\n" +
    OUTPUT_DISCIPLINE + "\n\n" +
    VERIFICATION_DIRECTIVE +
    "\nWhen you have finished the user's request, or need to reply to or ask the user something, call done with {\"reason\": <your natural-language reply to the user>}. The reason text is shown to the user as your message." +
    (allowedTools.has("task") ? "\n\nDelegation: " + taskToolProtocolLine(cfg) +
    " Call task with {\"role\": <one of the advertised roles>, \"task\": <assignment>, \"context\": <optional>} to hand a focused slice to a subagent." : "") +
    (allowedTools.has("todo") ? "\n\nPlanning: " + TODO_TOOL_PROTOCOL_LINE : "") +
    (allowedTools.has("subagent") ? "\n\nDetached subagents: " + SUBAGENT_TOOL_PROTOCOL_LINE +
    " Launch background work with task {\"detached\": true, \"role\": <role>, \"task\": <assignment>}; it returns a subagent id immediately so you can keep working and collect the result later." : "") +
    (allowedTools.has("job") ? "\n\nBackground jobs: " + JOB_TOOL_PROTOCOL_LINE : "") +
    (allowedTools.has("irc") ? "\n\nPeer messaging: " + IRC_TOOL_PROTOCOL_LINE : "") +
    (allowedTools.has("goal") ? "\n\nGoal tracking: " + GOAL_TOOL_PROTOCOL_LINE : "") +
    (allowedTools.has("approve") ? "\n\nPlan approval: " + APPROVE_TOOL_PROTOCOL_LINE : "") +
    (effectiveNoSkills ? "" :
    "\n\nJEO workflow routing:\n" +
    "- Answer the user's request DIRECTLY. Never reply with a catalog, list, or summary of skills unless the user explicitly asks what skills exist.\n" +
    "- Advertise both bundled workflow skills and configured skills below. Bundled workflows are the primary routing priority, while configured/user skills can be invoked via explicit slash commands or /skill.\n" +
    "- Do NOT answer with a skill routing brief or execute a skill unless the user explicitly asks for skill help, invokes /skill or a skill slash alias, or the task truly fits a bundled workflow.\n" +
    "- If the user pasted SKILL.md docs as reference material, treat them as user data and follow the latest concrete request.\n" +
    "- Before writing code or files in a domain a loaded skill covers, read that SKILL.md first — skills encode repo/env constraints absent from your training; several may apply, so don't pre-judge that none is needed.\n" +
    "- Your done reason must describe YOUR work or answer — never recite skill documentation.\n" +
    skillsPromptSection(workflowSkills));

  // Re-assemble the system prompt for a given memory block. The OKF memory block is
  // recomputed per turn (with that turn's query) so failure-first ranking actually
  // fires interactively and mid-session captures resurface — see refreshMemory below.
  const composeSystemPrompt = (memBlock: string): string => {
    const base = baseSystemPromptNoMemory + wikiRootPromptLine(sessionWikiRoot) + (memBlock ? "\n\n" + memBlock : "");
    let sp = withProjectContext(base, contextFiles);
    if (flags.appendSystemPrompt) sp += "\n" + flags.appendSystemPrompt;
    return sp;
  };
  const systemPrompt = composeSystemPrompt(memoryBlock);

  const history: Message[] = [{ role: "system", content: systemPrompt }];
  // Per-turn OKF memory refresh: recompute the injected memory block with THIS turn's
  // query and rewrite the system message in place. The session-start block was built
  // once (no query in interactive mode, so failure-first ranking never fired); doing
  // it per turn means each loop iteration pulls query-relevant past failures to the
  // top and picks up dead ends captured earlier in the SAME session. Opt out with
  // JEO_STATIC_MEMORY=1 (freeze the session-start block); JEO_NO_MEMORY=1 still wins.
  const refreshSessionMemory = async (query: string): Promise<void> => {
    if (jeoEnv("STATIC_MEMORY") === "1") return;
    if (!history[0] || history[0].role !== "system") return;
    try {
      const fresh = await memoryPromptSection(cwd, query || undefined);
      history[0] = { ...history[0], content: composeSystemPrompt(fresh) };
    } catch { /* keep the prior system prompt on any failure */ }
  };
  let sessionModel: string | undefined = initialSessionModel;
  // Session thinking-level override (`/thinking`); falls back to the config level.
  let sessionThinking: "low" | "medium" | "high" | "xhigh" | undefined = flags.thinking ?? cfg.thinkingLevel;
  // PromptRouter session override: undefined = follow config.routing.enabled, true/false = /route on|off wins this session.
  let sessionRouteOverride: boolean | undefined;
  // Last routing decision (or the reason none applied) — /route why reads this.
  let lastRouteDecision: RouteDecision | { note: string } | null = null;
  // Bounded FIFO of this session's routing decisions — /route history reads this.
  // Same lifecycle scope as `lastRouteDecision`: one instance per REPL session,
  // never persisted to config.
  const routeHistory = new RouteHistory();
  // Computer-use session override: undefined = follow config.computer.enabled, true/false = /computer on|off wins this session.
  let sessionComputerOverride: boolean | undefined;

  // Cache of live, credential-validated models per provider (refreshed by live pickers).
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
  // Unsent draft restored from a NON-interactive resume path (`--resume <id>`,
  // `--continue`/`-c`) — the interactive-picker and mid-loop `/session resume`
  // paths feed `queuedPromptInput.partial` directly (declared much later); this
  // one exists because `queuedPromptInput` isn't in scope yet at startup. Read
  // once by `queuedPromptInput`'s own initializer below, then not touched again.
  let startupDraft: string | undefined;
  // Full untruncated output of the most recent tool call — the clipped forge
  // card's `⟦Ctrl+O for more⟧` hint resolves here.
  let lastToolDetail: { tool: string; output: string } | null = null;
  // Accumulated reasoning/thinking for the in-flight turn (the model's thought before its
  // answer). Captured from the reasoning stream and persisted on the assistant message so
  // it survives /resume + export (gjc "think → answer" record). Reset at each turn start.
  let lastTurnReasoning = "";
  // Native reasoning artifacts for the FINAL (done) step — the engine attaches intermediate
  // steps' artifacts to their own pushed messages, but the done turn is built here. Reset on
  // each step boundary so only the last step's artifacts ride the final reply (no duplication).
  let lastTurnArtifacts: import("../ai/types").ReasoningArtifact[] = [];
  /** Wrap turn events so EVERY sink (TUI or plain stream) records the last full
   *  tool output for the Ctrl+O detail view. */
  const withToolDetailCapture = (base: ReturnType<LaunchTui["events"]>): ReturnType<LaunchTui["events"]> => ({
    ...base,
    onToolResult: (tool, success, output) => {
      lastToolDetail = { tool, output };
      base.onToolResult?.(tool, success, output);
    },
    onStep: (step: number) => {
      // New step: drop the prior step's final-reply artifacts so only the LAST step's ride
      // the done reply (intermediate steps are persisted by the engine on their own turns).
      lastTurnArtifacts = [];
      base.onStep?.(step);
    },
    onReasoningStream: (textSoFar: string) => {
      // textSoFar is the cumulative thought for the current step; keep the latest
      // non-empty value (the thought immediately preceding the turn's answer).
      if (textSoFar.trim()) lastTurnReasoning = textSoFar;
      base.onReasoningStream?.(textSoFar);
    },
    onReasoningArtifactStream: (artifact) => {
      lastTurnArtifacts.push(artifact);
      base.onReasoningArtifactStream?.(artifact);
    },
  });
  /** Compose a session-persistence flush into onStep so each completed step is
   *  written as it lands (durability across mid-turn interruption) without
   *  disturbing the original onStep sink. */
  const withStepPersistence = (
    base: AgentLoopEvents,
    persist: () => Promise<void>,
  ): AgentLoopEvents => ({
    ...base,
    onStep: async (step: number) => {
      await base.onStep?.(step);
      await persist();
    },
  });
  /** The Ctrl+O detail block (shared by the prompt-time keypress handler and the
   *  mid-turn TUI binding): full last reply + full last tool output. */
  const composeDetailLines = (): string[] => {
    if (!lastReply && !lastToolDetail) return [];
    const sep = "─".repeat(Math.min(48, Math.max(20, (process.stdout.columns ?? 80) - 1)));
    const toolDetail = lastToolDetail
      ? [sep, `detail · full last tool output (${lastToolDetail.tool})`, sep, ...lastToolDetail.output.split("\n").slice(0, 2000).map(sanitizeForTerminal)]
      : [];
    const replyDetail = lastReply
      ? [sep, "detail · full last response (ctrl+o)", sep, ...renderMarkdownTables(lastReply).split("\n")]
      : [];
    return [...replyDetail, ...toolDetail, sep];
  };

  // pi-style session persistence: resume an existing session or create a new one.
  let sessionId: string | undefined;
  // True once a resume actually restored PRIOR messages (not just an empty
  // placeholder). Consumed by the "INTERACTIVE mode" welcome-banner block below to
  // skip the fresh-start clearScreen()+banner render — found live: printing the
  // resumed transcript ledger here, then unconditionally wiping the screen and
  // drawing the generic welcome box a few hundred lines later, buried the actual
  // restored work under a "fresh start" banner instead of leaving it on screen.
  let resumedWithHistory = false;

  let compactionSeq = 0;
  if (!flags.noSession) {
    if (flags.resumeInteractive) {

      // Bare `--resume`/`-r` (no value) at cold startup (gjc-parity): the interactive
      // session picker — added right before the REPL loop starts, below — takes over
      // and replaces this session before the user ever sees it, but ONLY in a TTY.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        // No TTY means no picker is possible — fall back to the same silent-latest
        // behavior as `--continue` rather than silently doing nothing. Resolve the
        // TRUE latest session BEFORE creating any placeholder session below — creating
        // one first would make IT the newest-mtime file, permanently masking the real
        // prior session and turning this fallback into dead code (found live: a bare
        // `--resume` outside a TTY always "resumed" a fresh empty session instead of
        // the actual prior one).
        const id = await latestSessionId(cwd);
        if (id) {
          try {
            const { header, messages } = await loadSession(id, cwd);
            for (const m of messages) history.push(m);
            sessionId = id;
            if (!initialSessionModel && header.model) sessionModel = header.model;
            const modelNote = sessionModel ? ` · model ${sessionModel}` : "";
            console.log(`Resumed session ${id} (${messages.length} messages).${modelNote}`);
            // Reproduce the prior screen exactly (gjc/gajae-code parity): a bare
            // `--resume` picker with no TTY falls back to the latest session, so
            // this is the ONLY chance to show the prior work before the REPL
            // starts — replay it as a scrollback ledger, same formatter `/session
            // resume` uses mid-session, so a resumed screen always reads like the
            // exact prior conversation instead of a bare message count.
            if (messages.length > 0) {
              resumedWithHistory = true;
              const sep = "─".repeat(Math.min(48, Math.max(20, (process.stdout.columns ?? 80) - 1)));
              console.log([sep, ...formatTranscript(history, { maxTurns: 6, color: true, unicode: true }), sep].join("\n"));
            }


          } catch (err) {
            console.log(`Could not resume ${id}: ${(err as Error).message}. Starting fresh.`);
          }
        }
        // No prior session to resume (fresh cwd), or the resume attempt above failed —
        // safe-default fresh session, same as every other "nothing to resume" path.
        if (!sessionId) {
          sessionId = (await createSession(cwd, undefined, sessionModel)).id;
        }
      } else {
        // TTY: start with a fresh session as the safe default; the interactive picker
        // below (right before the REPL loop) takes over and replaces it before the
        // user ever sees this one, so creating it first here is harmless.
        sessionId = (await createSession(cwd, undefined, sessionModel)).id;
      }

    } else if (flags.resume) {
      let id: string | undefined;
      let skipResume = false;
      if (flags.resumeId) {
        // gjc-parity: resolve as a full id OR a short id prefix.
        const resolved = await resolveSessionRef(flags.resumeId, cwd);
        if (resolved.kind === "ok") {
          id = resolved.id;
        } else if (resolved.kind === "ambiguous") {
          console.log(`Ambiguous session id '${flags.resumeId}' — matches: ${resolved.matches.slice(0, 5).join(", ")}${resolved.matches.length > 5 ? " …" : ""}. Use more characters or run with --resume (no value) to pick interactively.`);
          skipResume = true;
        } else {
          console.log(`Session '${flags.resumeId}' not found. Starting a new one.`);
          skipResume = true;
        }
      } else {
        id = await latestSessionId(cwd);
      }
      if (skipResume) {
        sessionId = (await createSession(cwd, undefined, sessionModel)).id;
      } else if (!id) {
        console.log("No session to resume. Starting a new one.");
        sessionId = (await createSession(cwd, undefined, sessionModel)).id;
      } else {
        try {
          const { header, messages } = await loadSession(id, cwd);
          for (const m of messages) history.push(m);
          sessionId = id;
          // Restore the model this session was last using unless the CLI explicitly
          // pinned one (flags.model/role/provider → initialSessionModel wins).
          if (!initialSessionModel && header.model) sessionModel = header.model;
          // Restore the unsent input-box draft (gajae-code parity) — see
          // startupDraft's own doc comment for why this path can't feed
          // queuedPromptInput.partial directly yet.
          if (header.draft) startupDraft = header.draft;
          const modelNote = sessionModel ? ` · model ${sessionModel}` : "";
          console.log(`Resumed session ${id} (${messages.length} messages).${modelNote}`);
          // Reproduce the prior screen exactly (gjc/gajae-code parity): same
          // scrollback-ledger replay `/session resume` uses mid-session, so
          // `--resume`/`-c`/`--resume <id>` restores the prior work onto the
          // screen instead of just a bare message count.
          if (messages.length > 0) {
            resumedWithHistory = true;
            const sep = "─".repeat(Math.min(48, Math.max(20, (process.stdout.columns ?? 80) - 1)));
            console.log([sep, ...formatTranscript(history, { maxTurns: 6, color: true, unicode: true }), sep].join("\n"));
          }


        } catch (err) {
          console.log(`Could not resume ${id}: ${(err as Error).message}. Starting fresh.`);
          sessionId = (await createSession(cwd, undefined, sessionModel)).id;
        }
      }
    } else {
      sessionId = (await createSession(cwd, undefined, sessionModel)).id;
    }
  }

  // Remote subagent visibility/control AND main-session mirroring over Telegram
  // (gjc per-session-thread parity, see `src/agent/notify/`): best-effort, a
  // cheap no-op unless `notifications.enabled`. Created ONCE for the whole REPL
  // lifetime (not per-turn) so a Telegram forum topic, once created, persists
  // across turns AND across `--resume` (keyed by jeo's real `sessionId`, not a
  // random one — see `SessionNotifyEndpoint`'s header doc).
  const sessionNotifyEndpoint = await startSessionNotifyEndpoint(cwd, sessionId);
  if (sessionNotifyEndpoint) {
    sessionNotifyEndpoint.sendIdentity({ repo: cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd, branch, cwd });
  }

  // Persist the active per-session model into the session header so `/resume` restores
  // it (each session can carry its own model independent of the global default).
  // Best-effort: a header-rewrite failure must never abort the turn.
  const persistSessionModel = async (): Promise<void> => {
    if (flags.noSession || !sessionId || !sessionModel) return;
    try {
      await updateSessionModel(sessionId, sessionModel, cwd);
    } catch { /* best-effort */ }
  };

  // Persist (or clear) the unsent input-box draft into the session header so a
  // later `/resume` restores it into the prompt (gajae-code parity: an
  // in-progress prompt survives a quit + resume instead of being silently
  // lost). Best-effort, same contract as persistSessionModel above — a
  // header-rewrite failure must never abort the exit path that calls this.
  const persistSessionDraft = async (draft: string): Promise<void> => {
    if (flags.noSession || !sessionId) return;
    try {
      await updateSessionDraft(sessionId, draft, cwd);
    } catch { /* best-effort */ }
  };

  // `step N/M` display seed: the explicit --max-steps cap, else the dynamic budget's
  // rolling base — the engine's onBudget event keeps the denominator honest as it grows.
  const initialStepLimit = flags.maxSteps > 0 ? flags.maxSteps : initialDynamicStepLimit();
  // Plain (non-TTY / --no-tui) progress sink — the cmd-mode equivalent of the live TUI.
  const streamEvents = createStreamEvents(initialStepLimit);
  let queueBusyInput: ((chunk: string) => boolean) | undefined;
  let queueBusyPasteActive: (() => boolean) | undefined;
  // Live snapshot of the busy-turn prompt draft — feeds the TUI's normal input
  // box during a running turn so typed text stays in the same query surface
  // instead of a separate queued row.
  let queueBusySnapshot: (() => { text: string }) | undefined;
  // Clears the live next-prompt draft — used after a mid-turn Enter is lifted into
  // the steering inbox so the consumed line does not also become the next prompt.
  let queueBusyClear: (() => void) | undefined;
  // Routes a command-shaped (/… or $…) mid-turn draft into the idle loop's
  // pending-line queue so it runs as a real COMMAND at the turn boundary,
  // instead of being steered into the model as literal text.
  let queueBusyCommand: ((line: string) => void) | undefined;
  let interactiveTurnActive = false;
  // Set by `promptInput` while a question is in flight; cleared in its
  // `finally`. `handleRemoteUserMessage` calls this to inject a Telegram
  // free-text reply as the next submitted line WITHOUT waiting for a local
  // Enter — returns `false` (caller then falls back to queuing) if no
  // question is currently pending or wiring already fired.
  let pendingRemoteInject: ((text: string) => boolean) | undefined;
  // Set at the start of each `runTurn` to THIS turn's steerInbox/flushSteerCard;
  // cleared at turn end. `handleRemoteUserMessage` steers the running turn
  // through this when set, mirroring the local mid-turn-Enter path exactly
  // (same steerInbox, same scrollback card) instead of a parallel mechanism.
  let currentTurnSteer: { push: (line: string) => void; flushCard: (line: string) => void } | undefined;
  // Session-local notify settings (gjc `/verbose`/`/lean`/`/redact` in-thread
  // command parity): mutable for the REPL's lifetime, defaulted from config,
  // never persisted — a config_command from Telegram changes THIS session
  // only, exactly like gjc's own session-local semantics.
  let notifyVerbosity: "lean" | "verbose" = cfg.notifications?.verbosity ?? "lean";
  let notifyRedact = cfg.notifications?.redact ?? false;


  // Run one conversational turn: compact, persist user msg, run the loop, persist + return the reply.
  // When `useTui`, a live TUI renders the turn and prints the final reply itself (rendered=true).
  const runTurn = async (
    userInput: string,
    useTui: boolean,
    images?: ImageAttachment[],
    // What to show as the user card in the live frame: undefined → the prompt
    // itself (normal turns); null → suppress it entirely (skill runs, where the
    // injected SKILL.md is NOT user-authored and the [skill] card already names it,
    // gjc-style); a string → show that compact label instead of the raw input.
    opts?: { userCard?: string | null },
  ): Promise<{ done: boolean; steps: number; reply: string; rendered: boolean; usage: string }> => {
    const turnConfig = await readGlobalConfig();
    // Fall back to the model resolved at THIS session's start (frozen snapshot), NOT
    // the live global default. A concurrent `jeo` session running `/model` persists the
    // global default (rememberModelPatch), so re-reading turnConfig.defaultModel here let
    // that write silently switch THIS running session's model mid-run. Per-session model
    // selection must stay session-local: running sessions never influence each other.
    const routingEnabled = sessionRouteOverride ?? !!turnConfig.routing?.enabled;
    let routeCredentialNotice: string | undefined;
    let routeVetoNote: string | undefined;
    const equivalentRouteFallback = async (decision: RouteDecision, reason: string, exclude: readonly string[] = []): Promise<string | null> => {
      const excluded = new Set([decision.model, ...exclude]);
      const poolCandidates = (): string[] =>
        tierModelPool(decision.tier, turnConfig)
          .filter(model => !excluded.has(model))
          .filter(model => !images?.length || catalogMetadata(model)?.images !== false);
      let candidates = poolCandidates();
      // The static MODEL_CATALOG only lists a couple of OpenAI-compatible clouds by
      // name (tencent, xai) — every other API-key provider (groq, deepseek, mistral,
      // openrouter, …) only enters `tierModelPool` once its `/models` endpoint has
      // been discovered THIS session (`recordLiveProviderModels`, driven by
      // `getLiveModels`). Interactive sessions warm that cache in the background at
      // startup, but a ONE-SHOT invocation (`jeo -p`/piped input) never calls
      // `getLiveModels()` at all — so a credentialed-but-undiscovered API provider
      // had ZERO fallback candidates even though the user's key works. Warming here
      // is cheap: `getLiveModels()` caches its result (`liveModelsCache`), so this
      // only pays real discovery latency once per cold session, exactly when the
      // primary model already failed and a fallback is genuinely needed.
      if (candidates.length === 0) {
        await getLiveModels().catch(() => []);
        candidates = poolCandidates();
      }
      if (candidates.length === 0) return null;
      const selected = selectFromPool(candidates, sessionId ? `${sessionId}:fallback:${decision.model}:${reason}` : undefined);
      const start = Math.max(0, candidates.indexOf(selected));
      const ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
      for (const candidate of ordered) {
        const { resolved, provider } = await describeModel(candidate, turnConfig);
        const status = await describeProvider(provider, turnConfig);
        if (!status.ready || !modelServableWithConfig(provider, resolved, turnConfig)) continue;
        if (provider === "ollama" || provider === "lmstudio") {
          const localBaseUrl = provider === "ollama"
            ? (turnConfig.ollamaBaseUrl ?? "http://localhost:11434")
            : (turnConfig.lmstudioBaseUrl ?? "http://localhost:1234/v1");
          if (!await isLocalProviderReachable(provider, localBaseUrl)) continue;
        }
        return candidate;
      }
      return null;
    };
    const fallbackDecision = async (decision: RouteDecision, reason: string, noticeKey: string, notice: string): Promise<RouteDecision | null> => {
      const fallback = await equivalentRouteFallback(decision, reason);
      if (!fallback) {
        routeVetoNote = `routed model '${decision.model}' ${reason} — fell back to '${sessionModel || defaultModel}'`;
        routeCredentialNotice = warnOnce(noticeKey, notice);
        return null;
      }
      routeVetoNote = `routed model '${decision.model}' ${reason} — switched to equivalent '${fallback}'`;
      routeCredentialNotice = warnOnce(noticeKey, `${notice} Switching to equivalent '${fallback}' for this turn.`);
      return { ...decision, model: fallback, warning: decision.warning ? `${decision.warning}; ${routeVetoNote}` : routeVetoNote };
    };
    // `sessionRouteOverride === true` means the user explicitly ran `/route on` —
    // that explicit request wins over a prior model pin (`sessionModel`, from
    // `--model`/`/model`) so routing actually evaluates every prompt as asked,
    // instead of being silently blocked by a pin the user may have forgotten about.
    // Routing enabled only via config (`routing.enabled: true`, no explicit /route
    // toggle this session) still respects an existing pin, as before.
    const routeOverridesPin = sessionRouteOverride === true;
    let routed = routingEnabled && (routeOverridesPin || !sessionModel)
      ? await routePrompt(userInput, turnConfig, { hasImages: !!images?.length, sessionId }).catch(() => null)
      : null;

    // Fail-open credential gate: `routePrompt` only resolves a tier's model from
    // config (routing.tiers/roles.smol/roles.slow/defaultModel) — it deliberately
    // stays pure/config-only (see its narrowed `Pick<Config,...>` param) and never
    // checks whether that model's provider actually has a usable credential. A user
    // can configure `roles.smol`/`roles.slow`/`routing.tiers.*.model` to a provider
    // they never logged into (or whose OAuth token expired since setup), and without
    // this gate that misconfiguration would silently turn a WORKING session
    // (defaultModel) into a FAILING turn ("No credential for provider …") the
    // instant routing engages — even though the turn would have succeeded unrouted.
    // Uses the SAME `describeProvider` readiness check `/roles`'s live-picker path
    // and `jeo doctor` already use — routing must never make a turn worse than
    // routing being off, matching the "fail-open everywhere" contract documented at
    // the top of prompt-router.ts. Nulling `routed` here (rather than patching its
    // `.model`) lets the EXISTING `activeModel`/`lastRouteDecision` fallback lines
    // below handle the rest unchanged.
    if (routed) {
      // describeModel expands aliases (e.g. a hand-written `roles.high: "gpt"`)
      // exactly like the real call path, so the servability check below judges
      // the id the provider will actually see — never a raw alias string.
      const { resolved: routedResolved, provider: routedProvider } = await describeModel(routed.model, turnConfig);
      const status = await describeProvider(routedProvider, turnConfig);
      if (!status.ready) {
        routed = await fallbackDecision(
          routed,
          `(${routedProvider}) has no usable credential this turn`,
          `prompt-router:provider-not-ready:${routedProvider}`,
          `[route] routed to '${routed.model}' (${routedProvider}) but that provider has no usable credential. Run 'jeo auth login ${routedProvider}' or reconfigure routing.tiers/roles for a provider you're logged into.`,
        );
      } else if (!modelServableWithConfig(routedProvider, routedResolved, turnConfig)) {
        // Provider readiness is necessary but not sufficient: an OAuth login only
        // serves specific models (auth matrix on modelServableWithConfig). Only
        // user-pinned routing.tiers/roles models can hit this branch —
        // auto-selected models already passed the same predicate.
        routed = await fallbackDecision(
          routed,
          `(${routedProvider}) is not servable by the stored ${routedProvider} credential this turn`,
          `prompt-router:model-not-servable:${routed.model}`,
          `[route] routed to '${routed.model}' but the stored ${routedProvider} OAuth login cannot serve that model. Set ${routedProvider.toUpperCase()}_API_KEY or reconfigure routing.tiers/roles to a model your login serves.`,
        );
      } else if (routedProvider === "ollama" || routedProvider === "lmstudio") {
        // Live reachability gate for LOCAL providers only: `describeProvider` reports
        // ollama/lmstudio as `ready: true` unconditionally (keyless just means "no
        // credential needed", not "the server is actually up"), so a routing.tiers/
        // roles pin to a downed local server previously sailed past every readiness
        // check above and only failed mid-turn with a raw, provider-less connection
        // error ("Unable to connect. Is the computer able to access the url?" —
        // Bun's fetch/undici error for a refused connection AND an unresolvable
        // host alike). A short-timeout live probe here keeps routing's fail-open
        // contract intact for the one credential class it couldn't previously see
        // through. Cloud providers never reach this branch — their credential/
        // servability checks above are sufficient and adding a live probe there
        // would just add latency for a class of failure `withRetry` already
        // recovers from at call time.
        const localBaseUrl = routedProvider === "ollama"
          ? (turnConfig.ollamaBaseUrl ?? "http://localhost:11434")
          : (turnConfig.lmstudioBaseUrl ?? "http://localhost:1234/v1");
        const reachable = await isLocalProviderReachable(routedProvider, localBaseUrl);
        if (!reachable) {
          routed = await fallbackDecision(
            routed,
            `(${routedProvider}) is unreachable at ${localBaseUrl} this turn`,
            `prompt-router:provider-unreachable:${routedProvider}`,
            `[route] routed to '${routed.model}' (${routedProvider}) but ${localBaseUrl} is unreachable. Start the ${routedProvider} server, or reconfigure routing.tiers/roles for a provider that is running.`,
          );
        }
      }
    }
    lastRouteDecision = routed ?? (routeVetoNote ? { note: routeVetoNote } : routingEnabled && (routeOverridesPin || !sessionModel) ? { note: "routing produced no decision (fail-open)" } : { note: "routing not active this turn" });
    // Only a REAL decision (not a `{note}` placeholder) is worth recording —
    // `/route history` exists to show what actually routed, not every turn's
    // gating outcome.
    if (routed) routeHistory.add(routed);
    // Explicit /model always wins UNLESS an explicit `/route on` this session opted
    // back into per-prompt routing (`routeOverridesPin`); otherwise `routed` is only
    // ever computed when `!sessionModel`.

    let activeModel = routed?.model ?? (sessionModel || defaultModel);
    let activeThinking = routed?.thinking ?? sessionThinking;
    // Provider-side prompt caches are keyed PER MODEL — reusing the bare `sessionId`
    // across a mid-session model switch (routePrompt changing activeModel turn to
    // turn) sends the same cache-correlation key to a different model/provider,
    // guaranteeing a cache miss on every switch and silently undermining routing's
    // own cost/latency goal (design doc §7 risk #4). Scope the key to the resolved
    // model so each model keeps its own stable cache lineage within the session.
    // `sessionId` is undefined only under `--no-session` — in that case there is no
    // provider-side cache lineage to protect anyway, so forward `undefined` unchanged
    // (matches the prior behavior of `sessionKey: sessionId` for that mode).
    let turnSessionKey = sessionId ? deriveCacheSessionKey(sessionId, activeModel) : undefined;
    let contextTokens = catalogMetadata(activeModel)?.contextTokens;

    // Resolve provider + dirty count up front — both are cheap and feed the live
    // frame's footer. `turnConfig` is reused so describeModel does NOT re-read the
    // config file. (gjc parity P1.B5: dirty count per-turn, not per-render.)
    const { provider: activeProvider } = await describeModel(activeModel, turnConfig);
    const turnDirtyCount = branch ? gitDirtyCount(cwd) : undefined;
    const tui = useTui ? new LaunchTui({ model: activeModel, provider: activeProvider, sessionId, maxSteps: initialStepLimit, cwd, branch, dirtyCount: turnDirtyCount, thinking: activeThinking, routedTier: routed?.tier }) : null;
    if (routeCredentialNotice) {
      if (tui) tui.events().onNotice?.(routeCredentialNotice);
      else console.log(routeCredentialNotice);
    } else if (routed?.warning) {
      if (tui) tui.events().onNotice?.(routed.warning);
      else console.log(routed.warning);
    }
    if (routed && (routed.source === "llm" || routed.tier !== "standard")) {
      const routeNotice = `[route] ${routed.tier} → ${routed.model} (${routed.source}: ${routed.signals.join(", ") || "none"}, confidence ${routed.confidence.toFixed(2)})`;
      if (tui) tui.events().onNotice?.(routeNotice);
      else console.log(routeNotice);
    }
    tui?.setTurnTitle(userInput); // gjc-parity turn title → HUD + tmux pane title (no LLM call)
    // `beforeLen` marks where this turn's appended messages start; it is re-read
    // AFTER compaction (which mutates history) and consumed by the post-turn
    // persistence block below.
    let beforeLen = history.length;
    lastTurnReasoning = ""; // fresh turn: capture this turn's thinking from scratch
    lastTurnArtifacts = [];
    // Incremental session persistence (durability across mid-turn interruption):
    // persistTurnTail() flushes history messages added since the last flush — called
    // right after the user prompt, on every onStep boundary, and once post-turn — so
    // Ctrl+C / crash / ESC can't lose the prompt + finished steps before /resume.
    let persistedLen = beforeLen;
    const persistTurnTail = async (): Promise<void> => {
      if (!sessionId || history.length <= persistedLen) return;
      const tail = history.slice(persistedLen);
      persistedLen = history.length;
      try { await appendMessages(sessionId, tail, cwd); } catch { /* best-effort */ }
    };
    let result;
    try {
      // Paint the live frame + spinner the INSTANT the turn is accepted, BEFORE the
      // potentially slow / LLM-driven compaction below. Otherwise the gap between the
      // submitted prompt and the first feedback reads as a dead "no response" window
      // (the reported symptom). All remaining preflight runs UNDER the spinner now.
      if (tui) {
        interactiveTurnActive = true;
        tui.start();
      }
      // Refresh injected OKF memory with THIS turn's query before the model call so
      // failure-first ranking fires and same-session dead ends resurface.
      await refreshSessionMemory(userInput);
      // Esc-cancellable turn-boundary compaction preflight: a slow/hung summarization
      // LLM call must not be un-cancellable just because it runs before the main
      // per-turn abort harness (created below) exists yet. A short-lived harness scoped
      // to just this call gives Esc/Ctrl+C the same abort path without wiring the full
      // mid-turn steering machinery this early (which needs turn-scoped vars not
      // constructed until after compaction/history mutation settles).
      const compactHarness = createInFlightAbortHarness({
        captureEsc: !!tui,
        onAbortNotice: msg => {
          if (tui) tui.events().onNotice?.(msg);
          else console.log(msg);
        },
        onHardExit: () => {
          if (tui) tui.finish("Cancelled.", { ok: false });
          process.exit(130);
        },
      });
      let compRes: Awaited<ReturnType<typeof maybeCompact>>;
      try {
        compRes = await maybeCompact(history, {
          model: activeModel,
          contextTokens,
          signal: compactHarness.controller.signal,
        });
      } finally {
        compactHarness.dispose();
      }
      if (compRes.error) {
        throw new Error(compRes.error);
      }
      if (compRes.compacted && sessionId && compRes.replacesThrough !== undefined) {
        const touchedNote = compRes.touchedFiles?.length ? ` Files touched: ${compRes.touchedFiles.join(", ")}.` : "";
        const summaryText = compRes.summary ?? `[Earlier conversation omitted: ${compRes.removed} messages — summary unavailable.${touchedNote}]`;
        await appendCompaction(sessionId, ++compactionSeq, summaryText, compRes.replacesThrough, cwd);
        tui?.events().onNotice?.(`(compacted ${compRes.removed} older message${compRes.removed === 1 ? "" : "s"})`);
      }
      beforeLen = history.length;
      persistedLen = beforeLen; // re-baseline after compaction mutated history
      if (images?.length && catalogMetadata(activeModel)?.images === false) {
        const warn = `! ${activeModel} does not advertise image input — sending the attachment anyway.`;
        if (tui) tui.events().onNotice?.(warn);
        else console.log(warn);
      }
      history.push(images?.length ? { role: "user", content: userInput, images } : { role: "user", content: userInput });
      // Persist the user prompt immediately so an interrupted turn keeps it on disk.
      await persistTurnTail(); // persist the user prompt immediately
      // Keep the submitted query in scrollback: the prompt that STARTS a turn shows
      // only as the transient HUD turn-title otherwise, which vanishes when the live
      // frame clears at turn-end — so the conversation transcript lost every user
      // prompt. Flush a `user` card (same surface as a mid-turn steer) so it persists.
      // Flush a `user` card (same surface as a mid-turn steer) so the prompt persists
      // in scrollback. opts.userCard overrides it: null suppresses the card entirely
      // (skill runs), a string shows a compact label instead of the raw input.
      const cardText = opts?.userCard === undefined ? userInput : opts.userCard;
      // Images render alongside the card only for the real prompt (undefined
      // userCard) — a skill run's compact/suppressed card never carried the
      // user's own attachments in the first place (buildSkillTask calls above
      // never pass `images`), so there is nothing to show either way.
      if (tui && cardText && cardText.trim()) tui.flushUserCard(cardText, opts?.userCard === undefined ? images : undefined);
      tui?.setContextUsage(historyTokens(history), contextTokens);

      // Per-turn steering inbox (gjc parity): additional queries typed mid-turn land
      // here and the engine drains them at each step boundary; createTaskTool forwards
      // the same drain so a single running subagent receives them live. Unconsumed
      // messages are folded into the next prompt in the finally block (race safety).
      const steerInbox: string[] = [];
      const steeringEnabled = !!tui && jeoEnv("NO_STEER") !== "1";
      const drainSteer = () => steerInbox.splice(0, steerInbox.length);
      const harness = createInFlightAbortHarness({
        captureEsc: !!tui,
        onNoise: () => tui?.repaint(),
        pasteActive: () => queueBusyPasteActive?.() ?? false,
        // Ctrl+O mid-turn: flush the detail view into the TUI panel. Always
        // useful — even before the first reply/tool detail exists, the panel
        // shows the turn's timestamped recent-activity tail, so Ctrl+O answers
        // "what has been happening" instead of silently doing nothing.
        onDetailKey: () => {
          if (!tui) return;
          const lines = [...composeDetailLines()];
          const activity = tui.recentActivity(20);
          if (activity.length) {
            const sep = "─".repeat(40);
            lines.push(`activity · last ${activity.length} event(s) this turn`, sep, ...activity, sep);
          }
          if (lines.length === 0) return;
          tui.showDetail(lines);
        },
        onScrollKey: (dir, page) => tui?.scrollDetail(dir, page),
        onBufferedInput: chunk => {
          if (!tui) return;
          // gjc-style mid-turn steering: a typed Enter (outside a bracketed paste)
          // lifts the current draft into the steering inbox so the RUNNING turn picks
          // it up at the next step, instead of only becoming the next prompt.
          // JEO_NO_STEER=1 restores the legacy draft-only behavior.
          const typedEnter =
            steeringEnabled &&
            !(queueBusyPasteActive?.() ?? false) &&
            /[\r\n]/.test(chunk) &&
            !chunk.includes(PASTE_START) &&
            !chunk.includes(PASTE_END);
          const captured = queueBusyInput?.(chunk) ?? false;
          if (typedEnter) {
            const line = (queueBusySnapshot?.().text ?? "").trim();
            if (line) {
              // A mid-turn /command or $skill is NOT a query for the model — steering it
              // would send the literal "/model" / "$skill" text to the LLM. Recognize it
              // and run it as a real COMMAND: queue it for the idle dispatcher and stop the
              // turn so it runs at once (below). Plain queries still steer into the running
              // turn. JEO_NO_STEER=1 disables both (legacy draft-only).
              queueBusyClear?.();
              tui.setLivePromptInput("");
              tui.setLivePromptHint([]);
              tui.setLivePromptHighlight(undefined);
              if (classifyMidTurnLine(line) === "command") {
                // Run it as a real COMMAND: queue it for immediate dispatch by the prompt
                // loop and abort the turn (the same controller Esc uses). The abort ends a
                // streaming turn at once and cancels any further steps; a running tool still
                // finishes first (jeo's abort is step-level, like Esc). The queued command is
                // then auto-dispatched — no second Enter. JEO_NO_MIDTURN_DISPATCH=1 keeps the
                // legacy behavior (queue to prefill, no interrupt, press Enter to run).
                queueBusyCommand?.(line);
                if (jeoEnv("NO_MIDTURN_DISPATCH") === "1") {
                  tui.events().onNotice?.(`⌘ queued ${line} — press Enter after this turn to run`);
                } else {
                  tui.events().onNotice?.(`⌘ ${line} — interrupting the turn to run it`);
                  harness.controller.abort();
                }
              } else {
                steerInbox.push(line);
                // Surface the steered query as a `user` card in scrollback so it reads
                // as an accepted input that started work — not just a transient notice.
                tui.flushSteerCard(line);
              }
              return;
            }
          }
          // Mid-turn typing is echoed LIVE into the input box so the field never looks
          // frozen/disabled while a turn runs — the typed text IS captured, so it must be
          // visible. This updates the in-frame input box via the differential renderer
          // only; it never leaks into scrollback/history (native readline echo stays
          // suppressed for the whole turn). On Enter the draft is lifted into the steering
          // inbox and surfaces as a `user` card (above). JEO_NO_LIVE_DRAFT=1 opts out.
          if (captured && jeoEnv("NO_LIVE_DRAFT") !== "1") {
            const draft = queueBusySnapshot?.().text ?? "";
            tui.setLivePromptInput(draft);
            // Mid-turn command preview: as you type a /command or $skill DURING a turn,
            // show its matches above the input box so command input visibly reacts
            // (idle-prompt parity). Cleared the moment the draft stops being command-shaped.
            tui.setLivePromptHint(
              /^\s*[/$]/.test(draft) ? formatMidTurnHint(draft.trimStart(), completionContext(), 5) : [],
            );
            tui.setLivePromptHighlight(triggerHighlight(expandSentinel(draft)));
          }
        },
        onAbortNotice: msg => {
          if (tui) tui.events().onNotice?.(msg);
          else console.log(msg);
        },
        onHardExit: () => {
          if (tui) tui.finish("Cancelled.", { ok: false });
          process.exit(130);
        },
      });
      const ac = harness.controller;
      // #9: per-turn registry for DETACHED subagents (task{detached:true}); the
      // `subagent` tool controls them and cancelAll() in finally prevents orphans.
      const subagentRegistry = new SubagentRegistry();
      const jobRegistry = new JobRegistry();
      sessionNotifyEndpoint?.attachRegistry(subagentRegistry);
      currentTurnSteer = { push: line => steerInbox.push(line), flushCard: line => tui?.flushSteerCard(line) };
      if (sessionNotifyEndpoint && !notifyRedact) {
        const preview = userInput.length > 200 ? `${userInput.slice(0, 200)}…` : userInput;
        sessionNotifyEndpoint.sendContextUpdate("turn_start", preview, { model: activeModel });
      } else if (sessionNotifyEndpoint) {
        sessionNotifyEndpoint.sendContextUpdate("turn_start", "[redacted]", { model: activeModel });
      }
      try {
        // Per-turn todo snapshot: drives the done-time reconciliation gate (the
        // Todos checklist used to end a finished turn stuck at "✓0 ◐1 ·4 / 5"
        // because nothing ever forced the model to update item statuses).
        let turnTodos: { title: string; status: string }[] = [];
        const onBeforeDone = async (
          reason: string,
          evidence: { sawMutation: boolean; sawVerification: boolean; verificationStale: boolean },
        ): Promise<string | null> => {
          const unfinished = turnTodos.filter(t => t.status !== "done");
          if (turnTodos.length > 0 && unfinished.length > 0) {
            return (
              `Your todo list still shows ${unfinished.length} unfinished item(s): ${unfinished.map(t => `"${t.title}"`).join(", ")}. ` +
              `Reconcile the plan first — call the todo tool resending the FULL list with every actually-completed item marked "done" ` +
              `(drop items that no longer apply), then call done again.`
            );
          }

          const goalState = await readGoalState(cwd);
          if (goalState && goalState.condition) {
            const reBlockCount = goalState.verdicts.filter(v => v.verdict === "NOT_MET" || v.verdict === "IMPOSSIBLE").length;
            const MAX_RE_BLOCKS = 2;

            if (reBlockCount >= MAX_RE_BLOCKS) {
              if (tui) tui.events().onNotice?.(`[Goal Verifier] Re-block cap of ${MAX_RE_BLOCKS} reached. Auto-allowing done.`);
              else console.log(`[Goal Verifier] Re-block cap of ${MAX_RE_BLOCKS} reached. Auto-allowing done.`);
              return null;
            }

            if (tui) tui.events().onNotice?.("[Goal Verifier] Running goal verification...");
            const llmVerdict = await verifyGoal(goalState.condition, history, activeModel);
            // Deterministic downgrade: a fresh MET from the transcript-only LLM
            // judge still needs mutation/verification evidence to back it up —
            // see applyEvidenceGate's own docs (goal-verifier.ts). NOT_MET/
            // IMPOSSIBLE pass through unchanged; this only ever tightens MET.
            const verdict = applyEvidenceGate(llmVerdict, evidence);

            goalState.verdicts.push({
              at: Date.now(),
              verdict: verdict.verdict,
              gap: verdict.reason,
            });
            await writeGoalState(goalState, cwd);

            if (verdict.verdict === "NOT_MET" || verdict.verdict === "IMPOSSIBLE") {
              const prefix = verdict.verdict === "IMPOSSIBLE" ? "[IMPOSSIBLE] " : "";
              return (
                `Goal verifier check failed: The goal "${goalState.condition}" is not yet met.\n` +
                `Reason: ${prefix}${verdict.reason}\n` +
                `Please address the remaining gaps and call done again.`
              );
            }
          }

          return null;
        };
        const fullTools = {
          ...DEFAULT_TOOLS,
          task: createTaskTool({
            config: { ...turnConfig, defaultModel: activeModel },
            signal: ac.signal,
            steer: drainSteer,
            registry: subagentRegistry,
            sessionEndpoint: sessionNotifyEndpoint,
            onEvent: useTui
              ? (e => tui?.onSubagentEvent(e))
              : (e => logTaskSubEvent(e)),
          }),
          todo: createTodoTool({ onChange: items => { turnTodos = items; tui?.setTodos(items); } }),
          subagent: createSubagentTool(subagentRegistry),
          job: createJobTool(jobRegistry),
          irc: createIrcTool(subagentRegistry),
          goal: createGoalTool(),
          approve: createApproveTool(),
          // `/computer on|off` session override wins over `config.computer.enabled`
          // (see `sessionComputerOverride`/`computer-slash.ts`); undefined = fall
          // through to DEFAULT_TOOLS' own config-only gate inside executeComputerAction.
          computer: (a: Record<string, any>) => {
            computerSupervisor.setKillSwitchLive(true);
            computerSupervisor.heartbeat();
            return executeComputerAction(a as any, { enabledOverride: sessionComputerOverride });
          },

        };
        const tools = filterToolMap(fullTools, Array.from(allowedTools));
        // Opik observability (opt-in via JEO_OPIK): one trace per turn, spans per
        // step/tool, token usage, and completed/verified/efficiency eval scores.
        // No-op (zero network) when disabled or unconfigured; never breaks a turn.
        const opik = createOpikTracer({
          name: userInput.trim().slice(0, 80) || "jeo turn",
          input: userInput,
          metadata: { model: activeModel, cwd },
          tags: ["jeo", "launch"],
        });
        opik.startTurn();
        // Hoisted above `runLoopWithModel` (moved from after its first call) so the
        // rate-limit fast-fallback predicate below can see the CURRENT attempted-model
        // set on every call, including the very first one. `attemptedRouteModels` is
        // mutated in place (`.add`) as the fallback loop below tries more models — this
        // closure always reads its live contents, never a stale snapshot.
        const attemptedRouteModels = new Set<string>([activeModel]);
        // A NON-routed turn (routing disabled, or the user pinned a model via /model)
        // still needs the equivalent-pool fallback on a usage-limit/rate-limit/credential
        // failure — the exact "5-hour usage window exhausted, model just stops working"
        // case this loop exists to fix. Synthesize a same-size-class RouteDecision
        // (inferTierForModel) so `equivalentRouteFallback` has a tier/pool to search even
        // with routing off; a real `routed` decision (routing enabled) is used unchanged.
        let fallbackBaseDecision: RouteDecision = routed ?? {
          model: activeModel,
          thinking: activeThinking,
          tier: inferTierForModel(activeModel),
          confidence: 1,
          source: "heuristic",
          signals: [],
        };
        // Cheap SYNC check (no network/credential probing — that full validation is
        // `equivalentRouteFallback`'s job when a switch actually happens) for "does an
        // untried, same-tier candidate exist RIGHT NOW". Feeds
        // AgentLoopOptions.rateLimitFallbackAvailable so the engine can bail a 429 retry
        // ladder on the first failed attempt instead of riding ~90s of backoff on a
        // model that has an equivalent sitting right there. Mirrors
        // `equivalentRouteFallback`'s own `poolCandidates` filters (tier pool minus
        // already-tried models minus image-incapable models when this turn has images)
        // so "available" here never promises more than the real fallback can deliver.
        const rateLimitFallbackAvailable = (): boolean =>
          tierModelPool(fallbackBaseDecision.tier, turnConfig)
            .filter(model => !attemptedRouteModels.has(model))
            .some(model => !images?.length || catalogMetadata(model)?.images !== false);
        const runLoopWithModel = (model: string, thinking: ThinkLevel | undefined, cacheKey: string | undefined, maxSteps = flags.maxSteps, budget?: { maxExtensions: number }) => runAgentLoop(history, {
          cwd,
          tools,
          maxSteps,
          ...(budget ? { budget } : {}),
          model,
          maxTokens: resolveMaxOutputTokens(model, thinking),
          reasoningEffort: thinking ? thinkingToReasoningEffort(thinking) : undefined,
          signal: ac.signal,
          sessionKey: cacheKey,
          steer: drainSteer,
          rateLimitFallbackAvailable,
          events: wrapEvents(withStepPersistence({ ...withToolDetailCapture(tui ? tui.events() : streamEvents), onBeforeDone }, persistTurnTail), opik),
        });
        const routeFailureReason = (doneReason: unknown): string | null => {
          const message = String(doneReason ?? "");
          if (!message) return "stopped without a final answer";
          const asError = new Error(message);
          if (isRateLimitError(asError)) return "hit a rate limit";
          if (isUsageLimitError(asError)) return "hit a usage/quota limit";
          // Auth/credential failures (401/403 rejection, missing/expired credential) are
          // an operational fault of THIS provider, not the prompt or the model's
          // capability — the equivalent-pool fallback exists precisely to route around a
          // provider whose credential just broke (expired OAuth token, revoked key, no
          // key configured) mid-session, instead of failing the whole turn.
          if (/rejected the credential|no credential for provider|no usable credential|\b401\b|\b403\b/i.test(message)) {
            return "is unauthenticated for this session";
          }
          // Pre-response connection failures (refused/unresolvable host, local
          // ollama/lmstudio server down, unreachable custom base URL) — see
          // isConnectionError's docs. Distinct from a mid-stream drop (transient,
          // already retried by the engine) or a genuine timeout (handled below).
          if (isConnectionError(asError) || /could not connect|is unreachable at/i.test(message)) {
            return "is unreachable";
          }
          // A silent/no-response provider (the call ran the full wall-clock timeout
          // with no usable output) is exactly the "no response" exception the
          // equivalent-pool fallback exists to route around.
          if (/did not complete the request within the call timeout|the operation timed out|exceeded the overall deadline/i.test(message)) {
            return "did not respond in time";
          }
          // Billing/payment failures (HTTP 402 — quota exhausted with postpaid billing
          // off, insufficient credit, free-trial exhausted) are a provider-account
          // fault, not a prompt/model problem: the SAME account's other models are
          // often unaffected (observed: Tencent's kimi-k2.5/deepseek-v3.2 402 while
          // deepseek-v4-flash/glm-5.2 on the SAME key kept working). Reroute exactly
          // like a rate/usage limit instead of leaving a configured-but-billing-blocked
          // model dead for the rest of the session.
          if (/\b402\b|payment required|insufficient credit|billing (?:is )?not enabled|free trial quota/i.test(message)) {
            return "requires billing/payment on this provider account";
          }
          // A persistent 5xx that SURVIVED the model-manager's own retry budget
          // (withRetry already backed off 500/502/503/504/529 internally — see
          // defaultRetryable's RETRYABLE_STATUS) means the provider's server itself
          // is down/overloaded beyond what backoff can recover from THIS session.
          // Equally a provider-side fault as the classes above, not a prompt issue.
          if (/\b(?:500|502|503|504|529)\b/.test(message)) {
            return "hit a persistent server-side error";
          }

          if (/does not recognize the requested model|model .*?(?:not found|not available|unavailable|unsupported|retired|gated)|\b(?:400|404)\b/i.test(message)) {
            return "is unavailable";
          }
          // Treat plain empty completions and protocol dead-ends as continuity failures:
          // the routed model did not produce an answer the agent can commit. Do NOT
          // reroute deterministic policy/budget errors — switching models must not be
          // a safety bypass or a substitute for raising output/context budgets.
          if (/returned no content/i.test(message)) {
            if (/max[_ -]?(?:output[_ -]?)?tokens|finish_reason=length|done_reason=length|stop_reason=max_tokens|content_filter|refusal|safety|prohibited_content|blocklist|recitation|spii|reasoning_extraction/i.test(message)) {
              return null;
            }
            return "returned no content";
          }
          if (/no valid tool call|without signaling done|consecutive failing tool calls|consecutive failing tool steps|repeating the same tool call|cycling through the same/i.test(message)) {
            return "did not produce a usable agent response";
          }
          return null;
        };
        result = await runLoopWithModel(activeModel, activeThinking, turnSessionKey);
        const routeFallbackMaxRaw = Number(jeoEnv("ROUTE_FALLBACK_MAX_ATTEMPTS") ?? NaN);
        const routeFallbackMax = Number.isFinite(routeFallbackMaxRaw) && routeFallbackMaxRaw >= 0
          ? Math.floor(routeFallbackMaxRaw)
          : 3;
        for (let routeFallbackAttempt = 0; routeFallbackAttempt < routeFallbackMax; routeFallbackAttempt++) {
          const routedFailureReason = !result.done ? routeFailureReason(result.doneReason) : null;
          if (!routedFailureReason) break;
          const fallback = await equivalentRouteFallback(fallbackBaseDecision, routedFailureReason, [...attemptedRouteModels]);
          if (!fallback) break;
          const previousModel = activeModel;
          attemptedRouteModels.add(fallback);
          activeModel = fallback;
          activeThinking = fallbackBaseDecision.thinking ?? sessionThinking;
          turnSessionKey = sessionId ? deriveCacheSessionKey(sessionId, activeModel) : undefined;
          contextTokens = catalogMetadata(activeModel)?.contextTokens;
          fallbackBaseDecision = { ...fallbackBaseDecision, model: activeModel };
          lastRouteDecision = { ...fallbackBaseDecision, warning: `model '${previousModel}' ${routedFailureReason}; switched to equivalent '${activeModel}'` };
          // Post-call fallback: the pre-call `routed` pick (already recorded above,
          // if any) got superseded mid-turn — record the decision that ACTUALLY
          // served the turn so `/route history`/`why` reflect reality, not a
          // since-abandoned pre-call guess.
          routeHistory.add(lastRouteDecision);
          const notice = `[route] model '${previousModel}' ${routedFailureReason}; switching to equivalent '${activeModel}' for this turn.`;
          if (tui) {
            const { provider: fallbackProvider } = await describeModel(activeModel, turnConfig);
            tui.events().onModelSwitch?.(activeModel, fallbackProvider);
            tui.events().onNotice?.(notice);
          } else {
            console.log(notice);
          }
          result = await runLoopWithModel(activeModel, activeThinking, turnSessionKey);
        }

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
            model: activeModel,
            maxTokens: resolveMaxOutputTokens(activeModel, activeThinking),
            reasoningEffort: activeThinking ? thinkingToReasoningEffort(activeThinking) : undefined,
            signal: ac.signal,
            sessionKey: turnSessionKey,
            steer: drainSteer,
            events: wrapEvents(withToolDetailCapture(tui ? tui.events() : streamEvents), opik),
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
        // Close the Opik trace once per turn (done or budget-stop). Errors swallowed.
        await opik.endTurn({ done: result.done, steps: result.steps, output: result.doneReason });
      } finally {
        harness.dispose();
        subagentRegistry.cancelAll(); // #9: no detached run leaks past the turn
        sessionNotifyEndpoint?.detachRegistry(); // this turn's registry is gone — subagent frames stop applying to it
        currentTurnSteer = undefined; // a remote message after this point queues instead of steering a dead turn
        await stopSessionNotifyEndpoint(subagentRegistry); // tear down the FALLBACK lazy endpoint, if one was started (no-op when sessionNotifyEndpoint owns the registry)
        jobRegistry.cancelAll(); // background jobs are turn-scoped too — no orphaned processes

        // Steering typed but never drained (e.g. entered just after the final step)
        // must not be lost — fold it into the next prompt draft so it runs next.
        const leftover = steerInbox.splice(0, steerInbox.length).map(s => s.trim()).filter(Boolean);
        if (leftover.length) {
          const merged = [queuedPromptInput.partial, ...leftover].filter(Boolean).join(" ");
          queuedPromptInput.partial = merged;
        }
      }
    } catch (err) {
      if (tui) {
        tui.finish(`! ${friendlyProviderError(err)}`, { ok: false });
        interactiveTurnActive = false;
      }
      throw err;
    }
    // A completed turn with an empty done-reason must NOT masquerade as a step-limit
    // failure ("reached the 3-step limit" after the model called done at step 3).
    const reply = result.doneReason
      || (result.done
        ? `(done in ${result.steps} step${result.steps === 1 ? "" : "s"} — the model returned no summary)`
        : `(reached the ${result.steps}-step limit without signaling done)`);
    if (sessionNotifyEndpoint) {
      const usageStr = result.usage ? formatUsage(result.usage) : undefined;
      if (notifyRedact) {
        sessionNotifyEndpoint.sendContextUpdate("turn_end", "[redacted]", { model: activeModel, usage: usageStr });
        sessionNotifyEndpoint.sendTurnStream("[redacted]");
      } else {
        const preview = reply.length > 200 ? `${reply.slice(0, 200)}…` : reply;
        sessionNotifyEndpoint.sendContextUpdate("turn_end", preview, { model: activeModel, usage: usageStr });
        // `notifyVerbosity` currently gates ONLY whether tool/step detail would be
        // mirrored (a future extension point) — the finalized reply text itself is
        // always sent in full at both verbosity levels, matching gjc's own
        // lean-vs-verbose semantics (lean omits tool noise, never the answer).
        sessionNotifyEndpoint.sendTurnStream(reply);
      }
    }
    // Persist any messages this turn produced that onStep hasn't flushed yet (the
    // final step's tool-call/result + any retry-loop messages), then the reply.
    // Incremental onStep flushes already wrote the prompt and completed steps, so
    // this only covers the tail — net content is the full turn either way.
    try {
      await persistTurnTail();
      const assistantMsg: Message = { role: "assistant", content: reply };
      if (lastTurnReasoning.trim()) assistantMsg.reasoning = lastTurnReasoning;
      if (lastTurnArtifacts.length) assistantMsg.reasoningArtifacts = lastTurnArtifacts;
      history.push(assistantMsg);
      if (sessionId) await appendMessage(sessionId, assistantMsg, cwd);
      if (tui) tui.finish(reply);
    } finally {
      if (tui) interactiveTurnActive = false;
    }
    if (result.usage) {
      sessionUsage.inputTokens += result.usage.inputTokens;
      sessionUsage.outputTokens += result.usage.outputTokens;
    }
    sessionUsage.turns++;

    // Mid-session failure capture: a guard-detected stall (the model repeated /
    // cycled / consecutively failed without recovering) is a dead end the rest of
    // THIS session should avoid. Record it into OKF now (deterministic, no LLM) so
    // the next turn's memory refresh resurfaces it. Best-effort; never blocks the turn.
    if (result.stopClass) {
      const task = userInput.replace(/\s+/g, " ").trim();
      const excerpt = task.length > 70 ? task.slice(0, 70) + "…" : task;
      const why = result.stopClass === "consecutive_failure"
        ? "consecutive failing tool calls"
        : result.stopClass === "cycle"
          ? "cycling through the same tool calls"
          : "repeating the same tool call";
      const tags = Array.from(new Set(
        task.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [],
      )).slice(0, 8);
      void recordFailedAttempt(cwd, {
        title: `Stalled on: ${excerpt}`,
        description: `A prior turn stalled (${why}) on this task — change approach before retrying.`,
        body: `Task: ${task.slice(0, 240)}\n\nThe agent gave up after ${why} (${result.steps} steps) and could not recover. ` +
          `Do NOT repeat the same line of attack; try a different decomposition, tool, or verification path.`,
        tags,
      }).catch(() => {});
    }
    const usage = result.usage ? `  (${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens)` : "";

    if (turnConfig.gitAutoCommit) {
      try {
        const statusRes = Bun.spawnSync(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "ignore" });
        if (statusRes.exitCode === 0 && statusRes.stdout.toString().trim().length > 0) {
          Bun.spawnSync(["git", "add", "."], { cwd });
          const diffRes = Bun.spawnSync(["git", "diff", "--cached", "--name-status"], { cwd, stdout: "pipe", stderr: "ignore" });
          const changedFiles = diffRes.stdout.toString().trim().split("\n").map(line => line.split("\t")[1]).filter(Boolean);
          const fileSummary = changedFiles.length > 0 ? ` (modified: ${changedFiles.slice(0, 3).join(", ")}${changedFiles.length > 3 ? ", ..." : ""})` : "";
          const commitMsg = `[jeo] auto-commit${fileSummary}\n\nPrompt: ${userInput.slice(0, 100)}${userInput.length > 100 ? "..." : ""}`;
          const commitRes = Bun.spawnSync(["git", "commit", "-m", commitMsg], { cwd });
          if (commitRes.exitCode === 0) {
            if (tui) tui.events().onNotice?.(`(auto-committed changes to git)`);
            else console.log(`(auto-committed changes to git)`);
          } else {
            if (tui) tui.events().onNotice?.(`(auto-commit failed: git commit returned non-zero)`);
            else console.error(`(auto-commit failed: git commit returned non-zero)`);
          }
        }
      } catch (e) {
        if (tui) tui.events().onNotice?.(`(auto-commit failed: ${e instanceof Error ? e.message : String(e)})`);
        else console.error(`(auto-commit failed: ${e instanceof Error ? e.message : String(e)})`);
      }
    }

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
    // One-shot piped/`-p` input that is a control slash command must be handled
    // HERE — never forwarded to the model. `echo "/clear" | jeo` (and Ctrl-D after
    // a piped command) previously sent the literal "/clear" to the LLM as a prompt:
    // a slow, flaky, and semantically wrong round-trip. These no-arg session/system
    // commands have a meaningful one-shot effect (or are simple no-ops) and exit.
    {
      const cmd = messageContent.trim();
      if (cmd === "/exit" || cmd === "/quit") {
        return;
      }
      if (cmd === "/clear" || cmd === "/session new" || cmd === "/session drop" || cmd === "/session delete") {
        // Reset history to just the system prompt and overwrite the session file so
        // the persisted transcript matches (a fresh session for /session new and /session drop).
        history.length = 1;
        if (sessionId && !flags.noSession) {
          try {
            sessionId = (await createSession(cwd, undefined, sessionModel)).id;
          } catch { /* best-effort: in-memory clear already done */ }
        }
        console.log("(history cleared)");
        return;
      }
      if (cmd === "/" || cmd === "/?" || cmd === "/help") {
        for (const line of formatSlashCommandList("/", skillSlashDetails)) console.log(line);
        console.log("Tools: read / write / edit / bash / find / search. Sessions persist to .jeo/sessions/.");
        return;
      }
      if (cmd === "/usage") {
        const cfg = await readGlobalConfig();
        const ctx: SlashContext = { history, sessionModel, sessionId, cwd, config: cfg };
        const result = handleUsage(ctx, sessionUsage);
        if (result && "lines" in result) for (const line of result.lines) console.log(line);
        return;
      }
      if (cmd === "/context") {
        const cfg = await readGlobalConfig();
        const ctx: SlashContext = { history, sessionModel, sessionId, cwd, config: cfg };
        const result = await handleContext(ctx);
        if (result && "lines" in result) for (const line of result.lines) console.log(line);
        return;
      }
      if (cmd === "/tools") {
        const cfg = await readGlobalConfig();
        const ctx: SlashContext = { history, sessionModel, sessionId, cwd, config: cfg };
        const result = await handleTools(ctx);
        if (result && "lines" in result) for (const line of result.lines) console.log(line);
        return;
      }
      if (cmd === "/hotkeys") {
        const cfg = await readGlobalConfig();
        const ctx: SlashContext = { history, sessionModel, sessionId, cwd, config: cfg };
        const result = handleHotkeys(ctx);
        if (result && "lines" in result) for (const line of result.lines) console.log(line);
        return;
      }
      if (cmd === "/theme" || cmd.startsWith("/theme ")) {
        const decision = decideThemeSlash(cmd, listThemes(), resolveTheme().name);
        for (const line of decision.lines) console.log(line);
        if (decision.kind === "set") {
          process.env.JEO_TUI_THEME = decision.themeName!;
          await saveConfigPatch(raw => ({ theme: decision.themeName }));
          // No refreshUiTheme() here — one-shot mode returns immediately after this
          // block, so there is no live TUI paint state to re-resolve (and
          // refreshUiTheme is declared later in this closure, out of scope here).
        }
        return;
      }
      if (cmd === "/wiki" || cmd.startsWith("/wiki ")) {
        const decision = decideWikiSlash(
          cmd,
          resolveWikiRoot(await readGlobalConfig()),
          !!jeoEnv("WIKI_ROOT"),
        );
        for (const line of decision.lines) console.log(line);
        if (decision.kind === "clear") {
          await saveConfigPatch(() => ({ wikiRoot: undefined }));
          delete process.env.JEO_WIKI_ROOT;
          sessionWikiRoot = undefined;
          await refreshSessionMemory("");
        } else if (decision.kind === "set") {
          await saveConfigPatch(() => ({ wikiRoot: decision.persistArg }));
          process.env.JEO_WIKI_ROOT = decision.root;
          sessionWikiRoot = decision.root;
          await refreshSessionMemory("");
        }
        return;
      }
      if (cmd === "/config" || cmd === "/settings") {
        for (const line of await buildConfigPanelLines({ sessionModel, sessionThinking, sessionId })) console.log(line);
        return;
      }
      if (cmd === "/evolve") {
        await runEvolveSimulation(animateAsciiArt);
        return;
      }
    }
    // One skill run (bundle workflow → engine; regular skill → agent turn). Shared by the
    // single-invocation path and the `$a $b …` chain path so every `$` skill actually runs.
    const runOneSkillShot = async (inv: SkillInvocation): Promise<void> => {
      const isBundleWorkflow = isWorkflowSkill(inv.skill.name);
      if (isBundleWorkflow) {
        const startMsg: Message = {
          role: "system",
          content: `[workflow:${inv.skill.name}:start]${inv.intent ? ` intent: ${inv.intent}` : ""}`
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
          args: inv.skill.name === "deep-interview" ? (inv.intent ? inv.intent.split(/\s+/) : []) : undefined
        };

        let ok = false;
        let reason: string | undefined;
        try {
          const res: { ok: boolean; reason?: string } = await runWorkflowEngine(inv.skill.name, opts);
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
            ? `[workflow:${inv.skill.name}:finish]`
            : `[workflow:${inv.skill.name}:abort]${reason ? ` reason: ${reason}` : ""}`
        };
        if (sessionId) {
          await appendMessage(sessionId, endMsg, cwd);
        }
        return;
      }

      const useOneShotTui = shouldUseOneShotTui(flags.noTui);
      if (!useOneShotTui) {
        console.log(`▶ Running skill: ${inv.skill.name}${inv.intent ? ` — ${inv.intent}` : ""}`);
      }
      const task = buildSkillTask(inv.skill, inv.intent, inv.invokedAs);
      const { reply, rendered, usage } = await runTurn(task, useOneShotTui, undefined, { userCard: null });
      if (!rendered) console.log(stripMarkdown(renderMarkdownTables(reply)) + usage);
      else if (usage) console.log(usage.trim());
    };

    // `$a $b … [intent]` — run every resolved skill in order; a lone `$skill` is a chain of 1.
    const skillChain = parseSkillChain(messageContent, resolvedSkills);
    if (skillChain && skillChain.invocations.length) {
      if (skillChain.unresolved.length) {
        console.log(`(skipping unknown skill${skillChain.unresolved.length > 1 ? "s" : ""}: ${skillChain.unresolved.map(u => `$${u}`).join(", ")})`);
      }
      if (skillChain.invocations.length > 1) {
        console.log(`▶ Chaining ${skillChain.invocations.length} skills: ${skillChain.invocations.map(i => `$${i.skill.name}`).join(" → ")}`);
      }
      for (const inv of skillChain.invocations) {
        await runOneSkillShot(inv);
      }
      return;
    }
    // A `$skill` invocation resolves to a single skill (by name, declared alias, or unique prefix).
    const skillInvocation = parseSkillInvocation(messageContent, resolvedSkills);
    if (skillInvocation) {
      await runOneSkillShot(skillInvocation);
      return;
    }
    try {
      const { reply, rendered, usage } = await runTurn(messageContent, shouldUseOneShotTui(flags.noTui));
      if (!rendered) console.log(stripMarkdown(renderMarkdownTables(reply)) + usage);
      else if (usage) console.log(usage.trim());
    } catch (err) {
      console.log(`! ${friendlyProviderError(err)}`);
    }
    return;
  }

  // INTERACTIVE mode
  const updatePromise = checkForUpdate({ timeoutMs: 2500 });
  // Refresh the on-disk update cache for the NEXT launch regardless of whether
  // this launch's bounded wait below catches the result. Screen-safe: writes
  // only, never renders (rendering after the prompt is armed would corrupt the
  // boxed input footer).
  void updatePromise.then(u => { if (u) void writeUpdateCache(u.latest); }).catch(() => {});
  // Terminal hygiene BEFORE anything renders: a previous program (or stale tmux
  // pane) can leave xterm mouse-tracking ON, so the terminal reports clicks and
  // motion as escape sequences from the very first prompt — the "starts out
  // mouse-clicked" corruption. jeo never enables these modes; resetting them is
  // a no-op on a clean terminal.
  if (process.stdout.isTTY) process.stdout.write(resetMouseTracking());
  const activeStartModel = sessionModel || defaultModel;
  const { provider: startProvider } = await describeModel(activeStartModel);
  const welcomeTheme = resolveTheme(process.env);
  const welcomeData = {
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
  };
  // welcomeData.cols is a launch-time snapshot; re-measure on every banner re-render
  // (/clear, /resume) so the box fits the resized terminal instead of the old width.
  const freshWelcomeLines = (): string[] =>
    renderWelcome({ ...welcomeData, cols: terminalSize().cols });
  // gjc-style fresh-start clear so the banner opens atop a clean screen. TTY only,
  // never mid-turn (scrollback flood). ponytail: add an opt-out env if anyone misses their scrollback.
  // SKIPPED on a resume that actually restored prior messages: the transcript ledger
  // was already printed above (during session persistence, right after "Resumed
  // session ... (N messages)"), so clearing here would wipe it and the generic
  // "fresh start" banner below would bury the just-restored work — live-verified via
  // a real pty run of `--resume <id>`, which showed exactly that: the resumed
  // conversation flashed on screen then vanished under the welcome box a moment later.
  if (!resumedWithHistory) {
    if (process.stdout.isTTY) process.stdout.write(clearScreen());
    // Launch sweep: the forge mark's gradient loops seamlessly (default 2 full
    // cycles, JEO_WELCOME_ANIM_CYCLES overrides), ending on the static banner.
    // Truecolor TTYs only; JEO_NO_WELCOME_ANIM=1 opts out.
    const sweepable =
      !!process.stdout.isTTY &&
      welcomeTheme.color &&
      detectColorLevel(process.env, true) === ColorLevel.TrueColor &&
      jeoEnv("NO_WELCOME_ANIM") !== "1";
    const sweepCycles = Math.min(10, Math.max(1, Number(jeoEnv("WELCOME_ANIM_CYCLES")) || 2));
    if (sweepable) await playWelcomeSweep(welcomeData, { cycles: sweepCycles });
    else console.log(renderWelcome(welcomeData).join("\n"));
  }



  // Surface the "New version" banner reliably: render ONCE from the on-disk cache
  // instantly (no network wait, works offline — the common path after the first
  // successful check), and ALSO from a bounded live check so a first run / version
  // bump still shows it this launch. Both must run BEFORE the prompt is armed.
  let updateBannerShown = false;
  const showUpdateBanner = (u: { current: string; latest: string; updateAvailable: boolean } | null): void => {
    if (updateBannerShown || !u?.updateAvailable) return;
    updateBannerShown = true;
    console.log(renderUpdateBox(u.current, u.latest).join("\n"));
  };
  showUpdateBanner(await readUpdateCache(pkg.version));
  showUpdateBanner(await Promise.race([updatePromise, new Promise<null>(r => setTimeout(() => r(null), 1200))]));
  // First launch after a version bump: surface the bundled release notes ONCE
  // (offline, from the new package's CHANGELOG.md) and record the seen version
  // so it never repeats. Screen-safe: prints BEFORE the prompt is armed.
  try {
    const whatsNew = await consumeLaunchWhatsNew({
      cols: Math.min(100, Math.max(40, (process.stdout.columns ?? 80) - 2)),
      unicode: supportsUnicode(),
      color: welcomeTheme.color,
    });
    if (whatsNew && whatsNew.length) console.log(whatsNew.join("\n"));
  } catch { /* release notes are a courtesy; never block launch */ }
  if (!LaunchTui.usable(flags.noTui)) console.log("(plain output)");

  const useTui = LaunchTui.usable(flags.noTui);
  const runSkillInvocation = async (skill: SkillDoc, intent: string, invokedAs?: string): Promise<void> => {
    // gjc-style invocation card: surface WHAT is being injected before the work
    // starts — skill name, resolved SKILL.md path, and the prompt size.
    {
      const card = formatForgeBox(
        { title: "[skill]", lines: skillInvocationCard(skill, intent) },
        { width: scaleForgeWidth(Math.min(100, Math.max(40, (process.stdout.columns ?? 80) - 2))), unicode: supportsUnicode(), paint: accentPaint(uiTheme), paintShadow: accentShadowPaint(uiTheme), color: uiTheme.color },
      );
      logLines(card);
    }
    const isBundleWorkflow = isWorkflowSkill(skill.name);
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
                armPreview();
                drawFooter(previewLines(typedLine, navIdx));
              }
            }
          }
        },
        args: skill.name === "deep-interview" ? (intent ? intent.split(/\s+/) : []) : undefined
      };

      let ok = false;
      let reason: string | undefined;
      try {
        const res: { ok: boolean; reason?: string } = await runWorkflowEngine(skill.name, opts);
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
      const { reply, rendered, usage } = await runTurn(task, useTui, undefined, { userCard: null });
      if (!rendered) console.log(`jeo> ${stripMarkdown(renderMarkdownTables(reply))}${usage}`);
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
  const mentionPaths = (prefix: string): string[] => mentionPathsIn(cwd, prefix);
  const completionContext = (): CompletionContext => {
    const base = staticCompletionContext();
    return {
      ...base,
      slashCommands: [...base.slashCommands, ...skillSlashDetails.map(d => d.command)],
      liveModels: liveModelsCache ? flattenModels(liveModelsCache).map(e => e.model) : [],
      aliases: aliasNames,
      skillNames: resolvedSkillTokens,
      modelsForProvider: p => liveModelsCache?.find(r => r.provider === p)?.models ?? [],
      mentionPaths,
    };
  };
  let previewArmed = false;
  // True while a prompt line is being awaited. Folded into the readline output
  // gate so native echo is suppressed for the WHOLE await window — including the
  // brief gap between turn-end and armPreview() — so no keystroke can leak into
  // scrollback before the boxed footer takes over.
  let promptActive = false;
  let pickerActive = false;
  // ── Multi-line input ───────────────────────────────────────────────────────────
  // Reliable multi-line input: a bracketed paste arrives as ONE buffer (fills the box,
  // submits intact) and Shift+Enter can insert a newline. We route the prompt's stdin
  // through a filter that rewrites line breaks to a private-use SENTINEL char BEFORE
  // readline sees them — readline inserts it as an ordinary character (no per-line
  // submit/race), the box renders it as a real line break, and it is expanded back to
  // "\n" on submit. On for any interactive TTY; JEO_NO_MULTILINE=1 reads stdin directly.
  const SENTINEL = MULTILINE_SENTINEL;
  // Multi-line input filter is ON for any interactive TTY: reliable multi-line paste
  // (fills the box, submits intact into the user card) is the default. The lone-"\n"
  // break rule is ALSO default-on (JEO_MULTILINE=0 opts out): every real terminal
  // sends `\r` for Enter in raw mode, so a bare `\n` can only come from Ctrl+J,
  // Ctrl+Enter (Windows Terminal / conhost), or a ghostty `shift+enter=text:\n`
  // keybind — all of which MEAN "insert a line break". This is what makes a break
  // key available on Windows terminals that support neither the kitty keyboard
  // protocol nor xterm modifyOtherKeys. JEO_NO_MULTILINE=1 fully disables the
  // filter (reads stdin directly).
  const multilineInput = !!process.stdin.isTTY && jeoEnv("NO_MULTILINE") !== "1";
  const loneLfShiftEnter = jeoEnv("MULTILINE") !== "0";
  const expandSentinel = (s: string): string => (multilineInput ? s.split(SENTINEL).join("\n") : s);
  // Prompt-scoped process listeners (stdin data/keypress, stdout resize). Registered
  // once per launch but previously anonymous and never removed — benign for a single
  // CLI run, but repeated launch() (test harness) accumulated them past Node's
  // 10-listener default → MaxListenersExceededWarning + a real leak. Track each remover
  // and drain it on every exit path so the process listener set returns to baseline.
  const promptListenerCleanups: Array<() => void> = [];
  const drainPromptListeners = () => {
    for (const off of promptListenerCleanups.splice(0)) { try { off(); } catch { /* best effort */ } }
  };
  let keyFilter: PassThrough | undefined;
  // Holder for the active readline so the input filter can see the current line
  // buffer (used by the empty-line backspace guard below). Set after rl is created.
  let activeRl: { line?: string; cursor?: number } | undefined;

  if (multilineInput) {
    const kf = new PassThrough();
    (kf as unknown as { isTTY: boolean }).isTTY = true;
    (kf as unknown as { setRawMode: (m: boolean) => unknown }).setRawMode = (m: boolean) => {
      try { (process.stdin as { setRawMode?(r: boolean): void }).setRawMode?.(m); } catch { /* terminal gone */ }
      return kf;
    };
    Object.defineProperty(kf, "isRaw", { get: () => (process.stdin as { isRaw?: boolean }).isRaw });
    // Forward stdin → filter, rewriting line breaks into a newline SENTINEL BEFORE
    // readline sees them, so multi-line input arrives as ONE buffer (no per-line submit
    // and no racy paste-merge). Stateful across chunks:
    //   • Inside a bracketed paste (200~..201~): every line break → sentinel, so the
    //     whole paste inserts as one multi-line buffer that the user reviews + submits
    //     with Enter (fixes "paste only kept line 1").
    //   • Outside a paste: Shift+Enter encodings → sentinel — a lone "\n" (ghostty
    //     `keybind = shift+enter=text:\n`, passes tmux unchanged even with extended-keys
    //     off) and the xterm "\x1b[27;2;13~" / kitty "\x1b[13;2u" sequences. Enter ("\r")
    //     passes through and submits.
    // Stateful across chunks (a bracketed paste can span several). The byte-rewrite logic
    // lives in `filterPromptInputChunk` (pure + exported) so the full keystroke wiring is
    // testable without a live readline/PTY; this handler is the thin live adapter.
    const kfState = { inPaste: false };
    const kfDataHandler = (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      const result = filterPromptInputChunk(
        data,
        activeRl ? (activeRl as unknown as { line: string; cursor: number }) : null,
        {
          loneLfShiftEnter,
          slashMatchCount: navMatches.length,
          historyPanelOpen: promptHistoryLines != null,
          columns: process.stdout.columns ?? 80,
        },
        kfState,
      );
      if (result.drop) return;
      kf.write(result.out);
    };
    process.stdin.on("data", kfDataHandler);
    promptListenerCleanups.push(() => process.stdin.off("data", kfDataHandler));
    keyFilter = kf;
    // readline now decodes keypresses on `keyFilter`; keep process.stdin emitting
    // 'keypress' too so the footer-redraw / paste-marker / picker listeners (registered
    // on process.stdin below) still fire.
    emitKeypressEvents(process.stdin);
    // Ask the terminal to make Shift+Enter DISTINGUISHABLE from plain Enter — without
    // this, `SHIFT_ENTER_SEQS`/the lone-LF opt-in never see anything to match, because
    // most terminals send NOTHING (or a byte identical to Enter) for Shift+Enter unless
    // one of these protocols is explicitly requested. Both are safe to send unconditionally:
    // a terminal that doesn't implement either silently ignores the unrecognized private-mode
    // sequence. Restored on exit so a shell/editor started afterward isn't left with an
    // unexpected keyboard-encoding mode.
    process.stdout.write(enableModifyOtherKeys() + enableKittyKeyboard());
    process.once("exit", () => {
      try { process.stdout.write(disableKittyKeyboard() + disableModifyOtherKeys()); } catch { /* terminal gone */ }
    });
  }

  const rl = createInterface({
    input: keyFilter ?? process.stdin,
    // Single-box input: gate readline's output while the boxed footer is armed so its own
    // `jeo>` prompt/echo is suppressed and ONLY our box shows. (Bun exposes no
    // `_writeToOutput` to patch, so gating the shared output stream is the portable fix.)
    // The gate also covers active select pickers: they disarm the preview, which
    // previously OPENED the gate and let readline echo typed filter characters
    // (CJK wide chars especially) straight onto the picker frame — the
    // "stacked input-box borders" corruption.
    output: gatedStdout(process.stdout, () => previewArmed || promptActive || pickerActive || interactiveTurnActive),
    completer: (line: string) => readlineCompleter(line, completionContext()),
  });
  activeRl = rl; // wire the input filter's empty-line backspace guard to the live buffer
  // Cross-launch input history: hydrate readline's ↑/↓ ring with prompts from
  // previous sessions in this workspace, so a fresh launch can recall "이전에
  // 사용한 쿼리" — not just lines typed in the current run. readline keeps history
  // newest-first, which is exactly the order loadInputHistory returns.
  if (process.stdin.isTTY) {
    const rliHist = rl as unknown as { history?: string[] };
    if (Array.isArray(rliHist.history)) {
      for (const entry of loadInputHistory(cwd)) {
        if (!rliHist.history.includes(entry)) rliHist.history.push(entry);
      }
    }
  }
  const promptStdin = process.stdin as typeof process.stdin & { isRaw?: boolean; setRawMode?(raw: boolean): void };
  const promptWasRaw = !!promptStdin.isRaw;
  let promptRawChanged = false;
  const restorePromptRawMode = () => {
    if (!promptRawChanged) return;
    try { promptStdin.setRawMode?.(false); } catch { /* terminal gone */ }
    promptRawChanged = false;
  };
  if (promptStdin.isTTY && promptStdin.setRawMode && !promptWasRaw) {
    promptStdin.setRawMode(true);
    promptRawChanged = true;
  }
  process.once("exit", restorePromptRawMode);
  // Stdin EOF must END the REPL, not hang it: under Bun a pending `rl.question`
  // NEVER settles once the input stream closes (Ctrl-D, exhausted pipe) — the
  // while(true) prompt loop then waits forever (the "jeo never exits" hang).
  // Bun's readline also DROPS piped lines that arrive between prompts (question()
  // only captures the line submitted while it is registered; orphan lines emit
  // 'line' instead), so queue those and serve them before prompting again.
  const pendingStdinLines: string[] = [];
  // Commands submitted mid-turn (/… or $…) land here; the prompt loop dispatches them
  // IMMEDIATELY on its next iteration, bypassing the "new input first" prefill contract
  // (the user explicitly invoked them — no second Enter).
  const pendingMidTurnCommands: string[] = [];
  const queuedPromptInput: PromptInputQueue = { pendingLines: pendingStdinLines, partial: startupDraft ?? "", pastedLines: [], inPaste: false };
  queueBusyInput = (chunk: string) => captureLivePromptInputChunk(queuedPromptInput, chunk);
  queueBusyPasteActive = () => queuedPromptInput.inPaste;
  queueBusySnapshot = () => ({
    text: queuedPromptInput.partial,
  });
  queueBusyClear = () => { queuedPromptInput.partial = ""; };
  queueBusyCommand = (line: string) => {
    // NO_MIDTURN_DISPATCH=1 keeps the legacy prefill path (tee up, press Enter); the
    // default routes to the immediate-dispatch queue served at the top of the loop.
    (jeoEnv("NO_MIDTURN_DISPATCH") === "1" ? pendingStdinLines : pendingMidTurnCommands).push(line);
  };
  // Bracketed-paste line routing at the PROMPT: readline strips the 2004 markers
  // and replays pasted lines as synthetic keypresses, emitting paste-start /
  // paste-end around them. Lines submitted INSIDE that window are intentional
  // batch commands → pastedLines (one command per prompt, in order). Lines
  // outside it keep the existing contracts (typed-line prefill fold on a TTY,
  // in-order auto-serve for piped stdin).
  let promptPasteActive = false;
  // PASTE-MERGE: a multi-line bracketed paste must arrive as ONE message, not split into
  // one command per line. Lines that fire WHILE a paste is open are buffered here instead
  // of run individually; promptInput joins them with the trailing residual on resolve.
  // `endWaiters` wake that merge the moment the 201~ paste-end marker arrives. `lastActivityAt`
  // tracks the last buffered line so the dropped-marker fallback is IDLE-based (never cuts a
  // large paste still streaming in — see pasteIdleDecision).
  const pasteMerge: { buf: string[]; endWaiters: Array<() => void>; lastActivityAt: number } = { buf: [], endWaiters: [], lastActivityAt: 0 };
  let pasteLineFired = false; // the line that resolved rl.question came from inside a paste
  if (process.stdin.isTTY) {
    const pasteKeypressHandler = (_ch: string, key: { name?: string } | undefined) => {
      if (key?.name === "paste-start") { promptPasteActive = true; pasteMerge.buf = []; pasteMerge.lastActivityAt = Date.now(); }
      else if (key?.name === "paste-end") {
        promptPasteActive = false;
        for (const w of pasteMerge.endWaiters.splice(0)) w();
      }
    };
    process.stdin.on("keypress", pasteKeypressHandler);
    promptListenerCleanups.push(() => process.stdin.off("keypress", pasteKeypressHandler));
    // Enable bracketed paste for the REPL lifetime (restored on exit below):
    // terminals only wrap pastes in the 200~/201~ markers once the app opts in.
    process.stdout.write("\x1b[?2004h");
    process.once("exit", () => { try { process.stdout.write("\x1b[?2004l"); } catch { /* terminal gone */ } });
  }
  rl.on("line", l => {
    if (promptPasteActive) {
      // Inside a bracketed paste: buffer the line, never run it on its own.
      pasteMerge.buf.push(l);
      pasteMerge.lastActivityAt = Date.now();
      pasteLineFired = true;
      return;
    }
    // A select picker (/model, /agents, …) reads keypresses directly while NO
    // rl.question is active, so its filter-text + selecting Enter fire an ORPHAN
    // `line` event here. Queuing that would auto-serve the leftover filter as the
    // next prompt (the "/model · /agents leaves typed text behind" bug). Drop it:
    // the picker owns those keystrokes and clears the readline buffer on exit.
    if (!interactiveTurnActive && !pickerActive) pendingStdinLines.push(l);
  });
  let stdinClosed = false;
  let notifyStdinClosed: (() => void) | undefined;
  let gracefulReadlineClose = false;
  let hardExitOnLoopEnd = false;
  // `on` + one-shot guard (not `once`): test harnesses stub readline with `on`/`question` only.
  rl.on("close", () => {
    if (stdinClosed) return;
    // Bun/readline can turn Ctrl+C into a bare close event without SIGINT/key
    // delivery. In an interactive terminal, an unexpected close is therefore a
    // hard break, not a graceful `/exit`. Some Bun/tmux paths leave stdin.isTTY
    // false while stdout is still a TTY, so accept either side as interactive.
    if ((process.stdin.isTTY || process.stdout.isTTY || previewEnabled) && !gracefulReadlineClose) {
      // Best-effort, fire-and-forget: persist whatever's still typed but unsent
      // (Ctrl+D / EOF / disconnected terminal — no explicit discard gesture, unlike
      // Ctrl+C's own "clear the box" contract, which stays untouched here) so
      // `/resume` can restore it (see persistSessionDraft above). Must not block
      // process.exit() below.
      const draft = draftFromUnsentLine((rl as unknown as { line?: string }).line);
      if (draft) void persistSessionDraft(draft);
      hardExitOnLoopEnd = true;
      forceExitFromCtrlC();
    }
    stdinClosed = true;
    notifyStdinClosed?.();
  });
  /** `rl.question` that resolves "/exit" on stdin EOF instead of hanging forever. */
  let promptServedFromPaste = false;
  const promptInput = async (prompt: string): Promise<string> => {
    promptServedFromPaste = false;
    // Pasted batch commands first — they execute one per prompt, in order.
    const pasted = queuedPromptInput.pastedLines.shift();
    if (pasted !== undefined) {
      promptServedFromPaste = true;
      return pasted;
    }
    const queued = pendingStdinLines.shift();
    if (queued !== undefined) return queued;
    if (stdinClosed) {
      if (hardExitOnLoopEnd || process.stdin.isTTY || process.stdout.isTTY) forceExitFromCtrlC();
      return "/exit";
    }
    promptActive = true;
    pasteLineFired = false;
    // Remote (Telegram) free-text injection while idle at THIS prompt: a fresh
    // AbortController per call lets `handleRemoteUserMessage` cancel the
    // in-flight `rl.question()` cleanly (verified empirically: AbortSignal
    // rejects with AbortError, no zombie resolution stealing the NEXT prompt's
    // keystroke — unlike an abandoned, never-aborted `rl.question()` promise).
    // Injection is gated on `rl.line === ""` by the caller (never hijacks a
    // user actively typing) — `pendingRemoteInject` (module-scope-ish, set here
    // and cleared in `finally`) is what a remote message actually calls: it
    // aborts the stale question AND resolves this race with the injected text
    // in one atomic step, so there is exactly one winner and no zombie.
    const questionAbort = new AbortController();
    let remoteInjectResolve: ((text: string) => void) | undefined;
    pendingRemoteInject = (text: string) => {
      if (!remoteInjectResolve) return false; // already fired or the race already settled
      questionAbort.abort();
      remoteInjectResolve(text);
      remoteInjectResolve = undefined;
      return true;
    };
    try {
      const value = await Promise.race<string | typeof REMOTE_ABORT_SENTINEL>([
        rl.question(prompt, { signal: questionAbort.signal }).catch(err => {
          if (err instanceof Error && err.name === "AbortError") return REMOTE_ABORT_SENTINEL;
          throw err;
        }),
        new Promise<string>(resolve => {
          notifyStdinClosed = () => {
            if (hardExitOnLoopEnd || process.stdin.isTTY || process.stdout.isTTY) forceExitFromCtrlC();
            resolve(pendingStdinLines.shift() ?? "/exit");
          };
        }),
        new Promise<string>(resolve => {
          remoteInjectResolve = resolve;
        }),
      ]);
      // The aborted `rl.question()` lost the race (a remote message or stdin-close
      // won it first) — its sentinel must never be treated as real submitted input.
      if (value === REMOTE_ABORT_SENTINEL) return promptInput(prompt);
      // PASTE-MERGE: if the resolving line came from inside a bracketed paste, the rest of
      // the paste (buffered in pasteMerge.buf) plus the trailing residual still in the line
      // buffer belong to the SAME message. Wait for paste-end, then join them with newlines
      // and return ONE multi-line input instead of running line 1 and queuing the rest.
      if (pasteLineFired) {
        if (promptPasteActive) {
          await new Promise<void>(resolve => {
            if (!promptPasteActive) { resolve(); return; }
            let done = false;
            const finish = () => { if (done) return; done = true; resolve(); };
            // Woken immediately by the 201~ paste-end marker (endWaiters).
            pasteMerge.endWaiters.push(finish);
            // Fallback for a DROPPED end-marker: idle-based, so a large paste still
            // streaming in keeps resetting the clock and is never truncated. Only a
            // genuinely quiet stream (no new line for PASTE_MERGE_IDLE_MS) flushes.
            const tick = () => {
              if (done) return;
              if (!promptPasteActive) { finish(); return; }
              const { fire, waitMs } = pasteIdleDecision(Date.now() - pasteMerge.lastActivityAt);
              if (fire) { finish(); return; }
              setTimeout(tick, waitMs);
            };
            setTimeout(tick, PASTE_MERGE_IDLE_MS);
          });
        }

        const residual = (rl as unknown as { line?: string }).line ?? "";
        // Clear the residual so it does NOT prefill (and re-submit) the next prompt.
        try { rl.write(null, { ctrl: true, name: "u" }); } catch { /* best-effort */ }
        try { (rl as unknown as { line: string; cursor: number }).line = ""; (rl as unknown as { cursor: number }).cursor = 0; } catch { /* best-effort */ }
        const parts = [...pasteMerge.buf];
        if (residual !== "") parts.push(residual);
        pasteMerge.buf = [];
        pasteLineFired = false;
        return expandSentinel(parts.join("\n"));
      }
      return expandSentinel(value);
    } finally {
      promptActive = false;
      notifyStdinClosed = undefined;
      pendingRemoteInject = undefined;
    }
  };

  // Mouse-wheel scroll during a live turn (tmux or plain terminal) can inject
  // arrow/scroll escape sequences into stdin; readline buffers them into its
  // pending line and the NEXT prompt then shows/executes garbage. Drain tty input
  // before each prompt, but preserve printable text typed while a live turn was
  // still running so fast follow-up prompts (including Korean/CJK text) are not
  // silently eaten.
  const drainPendingTtyInput = (): void => {
    if (!process.stdin.isTTY) return;
    try {
      let chunk: unknown;
      while ((chunk = process.stdin.read()) !== null) {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
        queuePromptInputChunk(queuedPromptInput, text);
      }
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
  // Opt out with JEO_NO_SLASH_PREVIEW=1; auto-off on short terminals.
  const currentAtLabel = (line: string): string | undefined => currentAtLabelFn(line);
  // Boxed-input footer height — ADAPTIVE so short terminals/panes still get the single
  // boxed input instead of silently falling back to the raw `jeo>` prompt (previously
  // any terminal under 17 rows lost the box entirely and showed bare CLI input).
  const MAX_PREVIEW_ROWS = 12;
  const MIN_PREVIEW_ROWS = 7; // status bar (1) + spacer (1) + input box (3 rows) + 2 preview rows
  const previewRowsFor = (rows: number): number => Math.max(MIN_PREVIEW_ROWS, Math.min(MAX_PREVIEW_ROWS, rows - 6));
  // Enable the boxed input footer for ANY interactive TTY. It paints inside a
  // reserved bottom region (never scrollback) and only commits the line on
  // Enter, so typed characters never leak into the conversation history while
  // typing. previewRowsFor() clamps the reservation height for short terminals,
  // so even small panes get the box instead of the raw `jeo>` echo fallback
  // (which echoes every keystroke straight into scrollback). The raw fallback is
  // now reserved for non-TTY/piped input, where live history echo is moot.
  const previewEnabled =
    process.stdin.isTTY &&
    jeoEnv("NO_SLASH_PREVIEW") !== "1";
  // Footer height reserved by the CURRENTLY armed region; disarm/draw must use the
  // same value the arm computed, even if the terminal was resized in between.
  // `footerRows` is the MAX reservation height (the budget previewLines/historyPreview
  // may fill). The PHYSICAL reservation (`footerRendered`) is now dynamic: compact at
  // idle (no dropdown) so a finished/idle prompt leaves NO reserved blank rows, and
  // grown on demand when a slash/arg preview needs more. `footerWantRows` is the height
  // the latest previewLines/historyPreview wants; drawFooter re-pins to it in place.
  let footerRows = MAX_PREVIEW_ROWS;
  // Compact idle reservation: status bar (1) + spacer (1) + input box (3 rows).
  const COMPACT_FOOTER_ROWS = 5;
  let footerWantRows = COMPACT_FOOTER_ROWS;
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
  // Idle-prompt Ctrl+O detail panel: a REVERSIBLE, scrollable overlay drawn inside
  // the footer reservation. Toggle open/closed with Ctrl+O; ↑↓/PgUp/PgDn scroll so
  // long/CJK content is fully reachable (no "… N more" clip). null = closed.
  let promptHistoryLines: string[] | null = null;
  let promptHistoryScroll = 0;
  let promptHistoryMaxScroll = 0;
  let promptHistoryPage = 1;

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
  // The footer's last painted lines (padded to the reservation height). The resize
  // relayout uses these to find the frame's physical top at the live width — a full-width
  // line painted at an older, wider geometry reflows onto extra rows after a width shrink.
  let lastDrawnLines: string[] = [];
  const padToFooter = (lines: string[]): string[] => {
    if (lines.length >= footerRendered) return lines.slice(0, footerRendered);
    return [...lines, ...new Array(footerRendered - lines.length).fill("")];
  };
  const armPreview = () => {
    if (!previewEnabled || previewArmed) return;
    footerRows = previewRowsFor(process.stdout.rows ?? 24);
    // Reserve a COMPACT region (idle prompt height) right after the current output —
    // not the full `footerRows` budget — so a finished/idle prompt leaves no blank rows
    // below it. drawFooter grows the reservation in place when a dropdown needs more.
    const initial = Math.max(1, Math.min(footerRows, COMPACT_FOOTER_ROWS));
    if (initial > 1) {
      out.write("\n".repeat(initial - 1) + cursorUp(initial - 1));
    }
    out.write(toColumn(1));
    footerRendered = initial;
    footerWantRows = initial;
    footerParkedRow = 0;
    previewArmed = true;
    lastFooterKey = "";
  };
  // Re-pin the reservation to `n` rows IN PLACE (right after the existing output, never
  // bottom-pinned): clear the old region from its top, then reserve `n` rows there. Used
  // by drawFooter to grow for a dropdown and shrink back to the compact idle height, so
  // the prompt never carries a trailing/floating blank block.
  const setFooterRows = (n: number) => {
    n = Math.max(1, Math.min(n, footerRows));

    if (!previewArmed || n === footerRendered) return;

    let s = footerParkedRow > 0 ? cursorUp(footerParkedRow) : "";
    s += toColumn(1) + clearToEnd(); // wipe old region; cursor now at its top (after output)
    if (n > 1) s += "\n".repeat(n - 1) + cursorUp(n - 1);
    s += toColumn(1);

    out.write(s);

    footerRendered = n;
    footerParkedRow = 0;
    lastFooterKey = ""; // force a full repaint into the resized region
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
      lastDrawnLines = [];
    } else {
      out.write("\x1b[?25h");
    }
  };
  // KEYSTROKE-HOT theme handle: `previewLines`/`statusBarLine` run on EVERY
  // keypress, and an uncached `resolveTheme` walks config-file I/O and (on
  // macOS without a configured theme) an execSync `defaults read` appearance
  // probe ≈ 12ms/call — ×3 calls/key was the visible typing delay. Resolve
  // once, refresh ONLY when `/theme` changes the env.
  let uiTheme = resolveTheme(process.env);
  let uiAccent = accentPaint(uiTheme);
  let uiAccentShadow = accentShadowPaint(uiTheme);
  // Input-box border colors. Each opened session gets a DISTINCT hue (so several jeo
  // sessions are tellable apart at a glance), and cmd-mode (`!`) overrides it with a
  // caution amber so entering the shell escape is unmistakable.
  const SESSION_BOX_ACCENTS = ["#48dbfb", "#39ff14", "#a29bfe", "#1dd1a1", "#ff9ff3", "#54a0ff", "#ff6b81", "#c8d6e5"];
  const CMD_MODE_BOX_ACCENT = "#ffb300";
  const hexPaint = (hex: string) => (s: string) => chalk.hex(hex)(s);
  const hexShadowPaint = (hex: string) => (s: string) => chalk.dim(chalk.hex(hex)(s));
  // Per-process random start so different jeo processes differ at a glance; advanced on
  // each newly opened session (advanceSessionBoxColor) so consecutive sessions never match.
  let sessionBoxColorIdx = Math.floor(Math.random() * SESSION_BOX_ACCENTS.length);
  const advanceSessionBoxColor = (): void => {
    sessionBoxColorIdx = (sessionBoxColorIdx + 1) % SESSION_BOX_ACCENTS.length;
  };
  // Resolve the box painters for the current draft: cmd-mode amber when it starts with
  // `!`, else the per-session hue, else the theme accent (colorless theme / no session).
  const boxAccents = (line: string): { accent: (s: string) => string; shadow: (s: string) => string } => {
    if (!uiTheme.color) return { accent: uiAccent, shadow: uiAccentShadow };
    if (line.startsWith("!")) return { accent: hexPaint(CMD_MODE_BOX_ACCENT), shadow: hexShadowPaint(CMD_MODE_BOX_ACCENT) };
    if (sessionId) { const hex = SESSION_BOX_ACCENTS[sessionBoxColorIdx]!; return { accent: hexPaint(hex), shadow: hexShadowPaint(hex) }; }
    return { accent: uiAccent, shadow: uiAccentShadow };
  };
  // Recolor the active `/command` or `$skill` trigger token INSIDE the input box so a
  // real invocation is visibly recognized as it is typed: neon green once the token
  // resolves to ≥1 command/skill, caution pink while it matches none (a likely typo
  // that would be sent as plain text). Offsets are code-point indices into the SAME
  // string the box renders, so multi-byte preceding text stays aligned with the box's
  // Array.from() char model. Returns undefined for colorless themes / no active trigger.
  const TRIGGER_HL_VALID = "#39ff14";
  const TRIGGER_HL_UNKNOWN = "#ff6b81";
  const triggerHighlight = (
    rendered: string,
  ): HighlightRange[] => {
    if (!uiTheme.color) return [];
    // Highlight EVERY `/command`·`$skill` invocation in the line at once and
    // independent of caret position, so multiple triggers all stay lit and a
    // token keeps its color even when the caret jumps elsewhere to edit.
    const out: HighlightRange[] = [];
    for (const trigger of allTriggerTokens(rendered)) {
      const start = Array.from(rendered.slice(0, trigger.start)).length;
      const end = start + Array.from(trigger.token).length;
      // "Open" = the word still being typed: it reaches the end of the line with
      // no space after it. An open token counts as valid-so-far on any match
      // (incl. fuzzy prefix); every committed token must be an EXACT known
      // command/skill to stay green, else it shows caution pink (likely typo).
      const isOpen = trigger.start + trigger.token.length === rendered.length;
      const matches = slashPreviewMatches(trigger.token, skillSlashDetails, resolvedSkills);
      const valid = isOpen ? matches.length > 0 : matches.includes(trigger.token);
      const hex = valid ? TRIGGER_HL_VALID : TRIGGER_HL_UNKNOWN;
      out.push({ start, end, paint: (s: string) => chalk.hex(hex)(s) });
    }
    return out;
  };
  // Match the REAL terminal cursor's color to the theme accent (OSC 12) so the caret
  // is never a same-toned block over the input box's typed text — the default terminal
  // cursor color (usually solid white) otherwise reads as a stray light patch on every
  // non-mono theme, especially the darker ones, making it hard to spot where typing
  // lands. Colorless (`mono`) intentionally skips this and any terminal that ignores
  // OSC 12 (rare) is unaffected either way. Reset on process exit (see below).
  const applyCursorColor = (): void => {
    if (isTTY() && uiTheme.color) {
      try { process.stdout.write(setCursorColor(uiTheme.accent)); } catch { /* terminal gone */ }
    }
  };
  const refreshUiTheme = (): void => {
    uiTheme = resolveTheme(process.env);
    uiAccent = accentPaint(uiTheme);
    uiAccentShadow = accentShadowPaint(uiTheme);
    applyCursorColor();
  };
  applyCursorColor();
  process.once("exit", () => {
    try { process.stdout.write(resetCursorColor()); } catch { /* terminal gone */ }
  });

  // The gjc-layout status bar pinned directly ABOVE the input box: bg-gradient
  // identity block (model · thinking / branch / cwd) left, live ctx% right.
  const statusBarLine = (cols: number): string => {
    const activeModel = sessionModel || defaultModel;
    const meta = catalogMetadata(activeModel);
    const used = historyTokens(history);
    const theme = uiTheme;
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
    const { accent: boxAccent, shadow: boxShadow } = boxAccents(line);
    const rendered = expandSentinel(line);
    const frame = renderInputFrame(rendered, {
      // Full terminal width (cols is already columns - 1, leaving the last column free
      // so a full-width row never wraps). Matches the live-turn box, user/forge cards,
      // and the welcome banner — all share this cols-1 width so nothing jumps on the
      // idle↔live transition. The status bar below stays full-width too.
      cols: cols,
      color: true,
      unicode: true,
      accent: boxAccent,
      accentShadow: boxShadow,
      cwdLabel: currentAtLabel(line),
      attachmentLabel: pendingImages.length
        ? `⧉ ${pendingImages.length} image${pendingImages.length > 1 ? "s" : ""} attached — sent with the next message`
        : undefined,
      maxBodyRows: Math.max(1, footerRows - 7),
      cursor: caret,
      highlight: triggerHighlight(rendered),
    });
    const input = frame.lines.map(l => truncateAnsi(l, cols));
    // jeo-ref layout: a blank spacer row between the status bar (row 0) and the
    // input box, so the box breathes instead of gluing to the bar — the caret
    // (and everything below) therefore shifts down TWO rows.
    footerCursor = {
      row: Math.max(0, Math.min(frame.cursorRow + 2, footerRows - 1)),
      col: Math.max(1, Math.min(frame.cursorCol, cols)),
    };
    const budget = Math.max(0, footerRows - 2 - input.length);
    const slash = budget > 0 ? formatSlashPreview(line, budget, selected, skillSlashDetails, resolvedSkills) : [];
    const args = !slash.length && budget > 0 ? formatCompletionPreview(line, completionContext(), budget) : [];
    const preview = (slash.length ? slash : args).map(l => chalk.gray(truncateAnsi(l, cols)));
    const result = [statusBarLine(cols), "", ...input, ...preview].slice(0, footerRows);
    // Want only the input box + status bar at idle (no dropdown) → compact reservation;
    // grow to fit the dropdown when a preview is present.
    footerWantRows = preview.length > 0 ? result.length : Math.min(footerRows, 2 + input.length);
    return result;
  };
  // Render the reversible Ctrl+O detail panel into the footer reservation: a status
  // bar, a title (with scroll hint when needed), then a windowed slice of the detail
  // with ↑/↓ counters. Recomputes the scroll bound/page size each paint so scroll
  // keys can clamp correctly. Mirrors the mid-turn LaunchTui panel.
  const historyPreviewLines = (detail: string[]): string[] => {
    const cols = Math.max(24, (process.stdout.columns ?? 80) - 1);
    const physical = detail.flatMap(line => line.split("\n")).map(line => truncateAnsi(line, cols));
    const bodyLimit = Math.max(1, footerRows - 2); // status bar + title rows
    const scrollable = physical.length > bodyLimit;
    const cap = scrollable ? Math.max(1, bodyLimit - 2) : bodyLimit;
    promptHistoryPage = cap;
    promptHistoryMaxScroll = Math.max(0, physical.length - cap);
    if (promptHistoryScroll > promptHistoryMaxScroll) promptHistoryScroll = promptHistoryMaxScroll;
    const hint = scrollable ? "· ↑↓/PgUp/PgDn scroll · Ctrl+O closes" : "· Ctrl+O closes";
    const title = `${uiAccent("history")} ${chalk.dim(hint)}`;
    let body: string[];
    if (!scrollable) {
      body = physical;
    } else {
      const start = promptHistoryScroll;
      const above = start;
      const reserveTop = above > 0 ? 1 : 0;
      let innerLimit = Math.max(1, bodyLimit - reserveTop - 1);
      let win = physical.slice(start, start + innerLimit);
      let below = physical.length - (start + win.length);
      if (below === 0) {
        innerLimit = Math.max(1, bodyLimit - reserveTop);
        win = physical.slice(start, start + innerLimit);
        below = physical.length - (start + win.length);
      }
      body = [];
      if (above > 0) body.push(chalk.dim(`↑ ${above} more above`));
      body.push(...win);
      if (below > 0) body.push(chalk.dim(`↓ ${below} more below`));
    }
    footerCursor = { row: Math.min(1, footerRows - 1), col: 1 };
    const result = [statusBarLine(cols), title, ...body].slice(0, footerRows);
    footerWantRows = result.length; // the Ctrl+O panel sizes the reservation to its content
    return result;
  };
  const drawFooter = (lines: string[]) => {
    if (!previewArmed || footerRendered === 0) return;
    // Re-pin the reservation to the height the latest preview/panel wants (compact at
    // idle, grown for a dropdown) BEFORE painting, so no reserved blank trails the prompt.
    setFooterRows(footerWantRows);

    // ALWAYS paint exactly footerRendered rows so the reservation is fully covered
    // and no row can spill past it — the bug fix that kept `@folder<more text>`
    // typing from scrolling the input box (and prior output) off the top.
    const padded = padToFooter(lines);
    // Remember the exact painted frame so resize/disarm can clear its real physical
    // footprint at the (possibly changed) live width instead of trusting logical rows.
    lastDrawnLines = padded;
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

  // Ctrl-L "redraw / re-anchor" recovery. The boxed footer paints IN PLACE relative to
  // the last parked cursor row; if the terminal scrolled for any reason the app did not
  // drive (a stray async stdout write, a tmux pane reflow, a wheel-scroll past the margin),
  // that anchor goes stale and subsequent repaints land on the wrong rows — the box looks
  // frozen and typed text never appears, even though readline IS still capturing every key
  // ("화면이 밀려서 입력이 안 보이는" 상태). This wipes the VISIBLE screen (scrollback kept),
  // re-reserves the footer at the top, and repaints from readline's live buffer, so the box
  // and caret snap back and whatever was already typed shows immediately.
  const redrawPromptFooter = () => {
    if (!previewArmed) return;
    try {
      const rows = process.stdout.rows ?? 24;
      footerRendered = 0;
      footerParkedRow = 0;
      lastFooterKey = "";
      lastDrawnLines = [];
      out.write(clearVisible());
      footerRows = previewRowsFor(rows);
      const initial = Math.max(1, Math.min(footerRows, COMPACT_FOOTER_ROWS));
      if (initial > 1) out.write("\n".repeat(initial - 1) + cursorUp(initial - 1));
      out.write(toColumn(1));
      footerRendered = initial;
      footerWantRows = initial;
      drawFooter(promptHistoryLines ? historyPreviewLines(promptHistoryLines) : previewLines(typedLine, navIdx));
    } catch { /* ignore redraw races */ }
  };

  // ESC — and a FIRST Ctrl+C while the box is non-empty — wipe the typed text (and
  // detach any pending clipboard images, whose `[image #N]` tags live in that text)
  // instead of leaving stale input. A Ctrl+C on the already-empty box hard-exits
  // (see handleCtrlC below).
  /** True when the prompt box holds anything a clear/Ctrl+C would discard: typed
   *  text, a pending clipboard image, or a queued pasted batch. Single source of the
   *  "is there input?" predicate shared by clearTypedInput and the Ctrl+C decision. */
  const promptHasContent = (): boolean => {
    const line = (rl as unknown as { line?: string }).line;
    return (line?.length ?? 0) > 0 || pendingImages.length > 0 || queuedPromptInput.pastedLines.length > 0;
  };
  const clearTypedInput = (): boolean => {
    const rli = rl as unknown as { line: string; cursor: number; _refreshLine?: () => void };
    const hadPastedQueue = queuedPromptInput.pastedLines.length > 0;

    if (!promptHasContent()) return false;

    // ESC is the escape hatch for an accidental giant paste: drop the queued batch.
    if (hadPastedQueue) {
      const dropped = queuedPromptInput.pastedLines.splice(0).length;
      console.log(chalk.dim(`(discarded ${dropped} queued pasted command${dropped > 1 ? "s" : ""})`));
    }
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
  // A Ctrl+C on an EMPTY prompt is a hard terminal break (exit code 130), not a line
  // editor shortcut. `/exit` remains the graceful session-save path; ^C is the
  // emergency "get me back to my shell now" path. A first Ctrl+C with text in the box
  // CLEARS it instead (handleCtrlC); the next Ctrl+C on the now-empty box exits.
  const forceExitFromCtrlC = () => {
    try {
      disarmPreview();
      out.write("\x1b[?25h\n");
      restorePromptRawMode();
    } catch {
      // Best-effort terminal restore; process exit is the contract.
    }
    // Fire-and-forget — see the identical rationale at the main hard-exit path.
    void sessionNotifyEndpoint?.stop();
    process.exit(130);
  };
  // Prompt Ctrl+C: a single press clears a non-empty box; on an empty box it exits.
  // `lastCtrlCAt` collapses the duplicate deliveries of one physical press (keypress
  // + SIGINT + raw byte) so a single Ctrl+C can't clear AND then immediately exit.
  let lastCtrlCAt = 0;
  const handleCtrlC = () => {
    const now = Date.now();
    const action = decideCtrlC(promptHasContent(), now - lastCtrlCAt);
    if (action === "ignore") return; // duplicate delivery of the same press
    lastCtrlCAt = now;
    if (action === "clear") clearTypedInput(); // had input → wipe it, stay at the prompt
    else forceExitFromCtrlC(); // empty → hard exit (130)
  };
  const handleCtrlCByte = (chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    // chunkHasCtrlC also matches the kitty CSI-u (`CSI 99;5u`) and xterm
    // modifyOtherKeys (`CSI 27;5;99~`) encodings jeo's protocol push provokes.
    if (chunkHasCtrlC(text)) handleCtrlC();
  };
  // Bun/readline can deliver Ctrl+C as readline SIGINT, process SIGINT, or (tmux)
  // a raw \u0003 byte before readline resolves the question; funnel all three through
  // handleCtrlC (clear-or-exit + de-duplication) so the behavior is identical.
  process.on("SIGINT", handleCtrlC);
  process.stdin.on("data", handleCtrlCByte);
  rl.on("SIGINT", handleCtrlC);

  const runSelectPicker = async <T>(
    render: (cols: number, rows: number) => string[],
    onKey: (ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean } | undefined) => boolean | undefined,
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
    let rendered = 0;
    const repaint = () => {
      // Re-measure on EVERY paint so the picker tracks live terminal resizes. The old code
      // captured cols/rows ONCE at open, so a picker left open across a resize never reflowed
      // and stayed pinned to its opening geometry — it never recovered after a shrink→grow.
      const cols = Math.max(40, terminalSize().cols - 2);
      const rows = Math.max(6, terminalSize().rows - 6);
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
    // Reflow the picker on terminal resize. The terminal has already reflowed the old
    // block's rows, so `rendered` no longer maps 1:1 to physical rows: drop the stale
    // accounting, wipe the visible screen (scrollback kept), and repaint at the freshly
    // measured geometry. Debounced so a drag-resize coalesces into a single clean repaint.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onPickerResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        try { rendered = 0; out.write(clearVisible()); repaint(); } catch { /* resize render race */ }
      }, 16);
    };
    process.stdout.on("resize", onPickerResize);
    // Poll-based safety net (same rationale as the idle footer's watchResize): a
    // picker left open across a missed 'resize' event would otherwise stay pinned
    // to its opening geometry until a keypress happened to trigger a repaint.
    const stopPickerResizeWatch = watchResize(() => onPickerResize());
    try {

      await new Promise<void>(resolve => {
        const handler = (ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string } | undefined) => {
          // Same normalization as the footer handler: kitty CSI-u Esc/Ctrl+C must
          // close a picker exactly like their legacy encodings.
          const done = onKey(ch, normalizeKeypress(key));
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
      process.stdout.off("resize", onPickerResize);
      stopPickerResizeWatch();
      if (resizeTimer) clearTimeout(resizeTimer);

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



  const MODEL_BADGE_ROLE_ORDER = ["planner", "architect", "executor", "critic"] as const;

  const roleBadgeColor = (roleId: string): ModelAssignmentBadge["color"] =>
    roleId === "executor" || roleId === "architect" || roleId === "planner" || roleId === "critic" ? roleId : "critic";



  const modelPickerAssignments = async (): Promise<ModelAssignmentBadge[]> => {
    const cfg = await readGlobalConfig();
    const defaultModelForBadges = sessionModel || cfg.defaultModel;
    const cfgForBadges = { ...cfg, defaultModel: defaultModelForBadges };
    const roles = allSubagentRoles(cfgForBadges);
    const byId = new Map(roles.map(role => [role.id, role]));
    const orderedRoleIds = [
      ...MODEL_BADGE_ROLE_ORDER,
      ...roles.map(role => role.id).filter(id => !MODEL_BADGE_ROLE_ORDER.includes(id as (typeof MODEL_BADGE_ROLE_ORDER)[number])),
    ];
    const assignments: ModelAssignmentBadge[] = [
      {
        role: "default",
        label: "DEFAULT",
        model: defaultModelForBadges,
        thinking: sessionThinking ?? cfg.thinkingLevel ?? "medium",
        color: "default",
      },
    ];
    for (const tier of PROMPT_TIERS) {
      const configured = cfg.routing?.tiers?.[tier];
      if (!configured?.model) continue;
      assignments.push({
        role: `routing:${tier}`,
        label: `ROUTE:${tier}`,
        model: configured.model,
        thinking: configured.thinking ?? "auto",
        color: "default",
      });
    }
    for (const roleId of orderedRoleIds) {
      const role = byId.get(roleId);
      if (!role) continue;
      assignments.push({
        role: role.id,
        label: role.title.toUpperCase(),
        model: resolveSubagentModel(role.id, cfgForBadges),
        thinking: resolveSubagentThinking(role.id, cfgForBadges) ?? "inherit",
        color: roleBadgeColor(role.id),
      });
    }
    return assignments;
  };

  const pickLiveProviderModel = async (
    providerName: string,
    entries: PickEntry[],
    current?: string,
    disabledProviders: readonly ProviderName[] = [],
  ): Promise<PickEntry | undefined> => {
    if (!process.stdin.isTTY || entries.length === 0) return undefined;
    const list = liveModelPicker(entries, { current, assignments: await modelPickerAssignments(), disabledProviders, disabledHint: "needs API key/base URL" });
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
        if (key?.name === "tab") {
          // gajae-code parity: cycle the provider tab (shift+tab steps back).
          list.cycleTab(key.shift ? -1 : 1);
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

  /** Generic arrows+Enter option picker (apply-target / role / action menus).
   *  Returns the chosen value, or undefined on ESC / non-TTY. */
  const pickFromOptions = async (
    title: string,
    options: SelectItem<string>[],
  ): Promise<string | undefined> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || options.length === 0) return undefined;
    const list = new SelectList(options);
    let chosen: string | undefined;
    await runSelectPicker(
      (cols, rows) => renderSelectList(list, { title, cols, rows: Math.max(4, Math.min(rows, 14)), unicode: true, color: true }),
      (ch, key) => {
        if (key?.name === "up") { list.up(); return false; }
        if (key?.name === "down") { list.down(); return false; }
        if (key?.name === "escape" || (key?.ctrl && key.name === "c")) return true;
        if (key?.name === "return" || key?.name === "enter") {
          chosen = list.selected()?.value;
          return true;
        }
        if (key?.name === "backspace") { list.backspace(); return false; }
        if (ch && ch >= " " && !key?.ctrl && !key?.meta) list.typeChar(ch);
        return false;
      },
    );
    return chosen;
  };

  const pickThinkingLevel = async (
    title: string,
    current: ThinkLevel | undefined,
    inheritLabel?: string,
    supportedLevels?: readonly ThinkLevel[],
  ): Promise<ThinkLevel | "inherit" | undefined> => {
    const levels = buildThinkingLevelChoices(current, {
      inheritLabel,
      levels: supportedLevels,
      tokenHint: lvl => `~${Math.round(thinkingMaxTokens(lvl as ThinkLevel) / 1000)}k tokens`,
    });
    const picked = await pickFromOptions(title, levels);
    return picked === "inherit" || isThinkingLevel(picked) ? picked : undefined;
  };

  const setRoleThinking = async (roleId: string, rawLevel: string | undefined): Promise<boolean> => {
    const cfgForRole = await readGlobalConfig();
    const role = getSubagentRole(roleId, cfgForRole);
    if (!role) return false;
    const level = (rawLevel ?? "").toLowerCase();
    if (level === "inherit") {
      await saveConfigPatch(raw => ({ subagents: withSubagentSetting(raw, role.id, { thinking: undefined }) }));
      console.log(`${role.title} thinking now inherits the default → ~/.jeo/config.json`);
      return true;
    }
    if (!isThinkingLevel(level)) {
      console.log(`Usage: /model subagent ${role.id} thinking <inherit|low|medium|high|xhigh>`);
      return true;
    }
    await saveConfigPatch(raw => ({ subagents: withSubagentSetting(raw, role.id, { thinking: level }) }));
    console.log(`${role.title} thinking set to ${level} (~${thinkingMaxTokens(level)} max tokens/step) → ~/.jeo/config.json`);
    return true;
  };
  const displayModelName = (model: string): string => {
    const leaf = (model.split("/").pop() || model).trim();
    return leaf.replace(/^gpt/i, "GPT");
  };

  // gajae-code `/model` parity: after a model is picked, the interactive flow
  // runs TWO menus — gjc's `#renderActionMenu` ("Set as DEFAULT / EXECUTOR / …",
  // i.e. WHICH target uses this model) followed by its `#renderThinkingMenu`
  // ("Reasoning for <target>", the per-target reasoning budget). DEFAULT updates
  // the active session model; a subagent role writes ~/.jeo/config.json without
  // switching the chat model.
  const applyPickedModelWithTarget = async (target: string): Promise<boolean> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const cfgForPick = await readGlobalConfig();
    const targetId = await pickFromOptions(
      `Model Name: ${displayModelName(target)}\n\nAction for: ${target}`,
      applyTargetChoices(cfgForPick).map(c => ({ value: c.value, label: c.label, hint: c.hint })),
    );
    if (!targetId) {
      console.log("(cancelled)");
      return true;
    }

    if (targetId === "default") {
      const currentDefaultThinking = (sessionThinking ?? cfgForPick.thinkingLevel ?? "medium") as ThinkLevel;
      const level = await pickThinkingLevel(`Reasoning for default: ${target}`, currentDefaultThinking);
      if (level === undefined) {
        console.log("(cancelled)");
        return true;
      }
      const { resolved, provider } = await describeModel(target);
      const st = (await describeAllProviders(cfgForPick)).find(s => s.name === provider);
      sessionModel = target;
      await persistSessionModel();
      const defaultThinking = isThinkingLevel(level) ? level : undefined;
      if (defaultThinking) {
        sessionThinking = defaultThinking;
      }
      await saveConfigPatch(raw => ({
        ...rememberModelPatch(raw, target),
        ...(defaultThinking ? { thinkingLevel: defaultThinking } : {}),
      }));
      console.log(`Model set to ${formatModelLine({ label: target, resolved, provider, ready: st?.ready })}${defaultThinking ? ` · thinking ${defaultThinking}` : ""} — saved as default.`);
      return true;
    }

    if (targetId.startsWith("routing:")) {
      const tier = targetId.slice("routing:".length) as PromptTier;
      if (!PROMPT_TIERS.includes(tier)) return false;
      const meta = catalogMetadata(target);
      const supportedThinking = meta?.thinking ?? [];
      const currentRouteThinking = cfgForPick.routing?.tiers?.[tier]?.thinking;
      let thinking: ThinkLevel | undefined;
      if (supportedThinking.length > 0) {
        const level = await pickThinkingLevel(
          `Reasoning for route ${tier}: ${target}`,
          currentRouteThinking,
          undefined,
          supportedThinking,
        );
        if (level === undefined) {
          console.log("(cancelled)");
          return true;
        }
        thinking = isThinkingLevel(level) ? level : undefined;
      }
      await saveConfigPatch(raw => ({
        routing: withRoutingTierSetting(raw, tier, { model: target, thinking }),
      }));
      const { provider } = await describeModel(target);
      const thinkingLabel = supportedThinking.length > 0 ? ` · thinking ${thinking}` : " · no thinking override (model does not advertise thinking)";
      console.log(`Prompt route ${tier} set to ${target} (${provider})${thinkingLabel} — routing enabled in ~/.jeo/config.json. Clear any session model pin with /model auto to let routing evaluate prompts.`);
      return true;
    }

    const role = getSubagentRole(targetId, cfgForPick);
    if (!role) return false;
    const currentRoleThinking = resolveSubagentThinking(role.id, cfgForPick) as ThinkLevel | undefined;
    const level = await pickThinkingLevel(
      `Reasoning for ${role.title}: ${target}`,
      currentRoleThinking,
      `inherit (default ${cfgForPick.thinkingLevel ?? "medium"})`,
    );
    if (level === undefined) {
      console.log("(cancelled)");
      return true;
    }
    const thinking = level === "inherit" ? undefined : (isThinkingLevel(level) ? level : undefined);
    await saveConfigPatch(raw => ({ subagents: withSubagentSetting(raw, role.id, { model: target, thinking }) }));
    const { provider } = await describeModel(target);
    console.log(`${role.title} model set to ${target} (${provider})${level === "inherit" ? " · thinking inherits default" : ` · thinking ${level}`} — saved to ~/.jeo/config.json.`);
    return true;
  };


  const pickCloudProvider = async (statuses: Awaited<ReturnType<typeof describeAllProviders>>): Promise<AuthProvider | undefined> => {
    const cloud = new Set<string>(OAUTH_PROVIDERS); // OAuth-login providers (anthropic/openai/gemini/antigravity)
    const subs = new Set<string>(SUBSCRIPTION_PROVIDER_NAMES); // subscription/plan products (token-keyed)
    const list = subscriptionLoginPicker(
      statuses.filter(s => cloud.has(s.name)),
      statuses.filter(s => subs.has(s.name)),
      true,
    );
    let chosen: ProviderName | undefined;
    await runSelectPicker(
      (cols, rows) =>
        renderLoginPicker(list, {
          title: "Login with OAuth / subscription  ↑↓ move · Enter select · Esc cancel",
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
    return chosen && (cloud.has(chosen) || subs.has(chosen)) ? chosen as AuthProvider : undefined;
  };

  // Bare `/provider` opens gjc's interactive onboarding selector: choose between
  // OAuth/subscription login and registering an API-compatible endpoint. Returns the
  // picked action, or undefined when cancelled (Esc/Ctrl+C). TTY only — callers fall
  // back to the printed usage in non-interactive mode.
  const pickOnboardingAction = async (): Promise<OnboardingAction | undefined> => {
    const list = onboardingPicker(true);
    let chosen: OnboardingAction | undefined;
    await runSelectPicker(
      (cols, rows) =>
        renderOnboardingPicker(list, {
          cols,
          rows: Math.max(4, Math.min(rows, 6)),
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

  // API-key onboarding: pick one of the bundled API-key-only providers (groq, deepseek,
  // mistral, …) to store a key for. Returns the picked provider, or undefined on cancel.
  // TTY only — the caller prints scriptable guidance otherwise.
  const pickApiKeyProvider = async (statuses: Awaited<ReturnType<typeof describeAllProviders>>): Promise<AuthProvider | undefined> => {
    const subs = new Set<string>(SUBSCRIPTION_PROVIDER_NAMES); // surfaced under OAuth/subscription login instead
    // kimi is dual-credential (moonshot API key OR Kimi Code OAuth) — keep it key-settable.
    const keyed = new Set<string>([...API_KEY_ONLY_PROVIDERS, "kimi"]);
    const list = apiKeyPicker(statuses.filter(s => keyed.has(s.name) && !subs.has(s.name)), true);
    let chosen: ProviderName | undefined;
    await runSelectPicker(
      (cols, rows) =>
        renderApiKeyPicker(list, {
          title: "Select a provider to key  \u2191\u2193 move \u00b7 Enter select \u00b7 Esc cancel",
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
    return chosen && keyed.has(chosen) ? chosen as AuthProvider : undefined;
  };


  if (previewEnabled) {
    process.once("exit", () => out.write("\x1b[?25h")); // safety net: never leave the cursor hidden
    const footerKeypressHandler = (_ch: string, rawKey: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string } | undefined) => {
      // Kitty CSI-u / xterm modifyOtherKeys events arrive with `name: undefined`
      // (Node's keypress table predates those protocols) — normalize them back to
      // the `{ name, ctrl, meta }` shape every check below matches on. Without this
      // Esc and Ctrl+C are DEAD at the idle prompt on kitty-protocol terminals.
      const key = normalizeKeypress(rawKey);
      if (key?.ctrl && key.name === "c") {
        handleCtrlC();
        return;
      }
      // ESC (or a meta-mapped Cmd+C) at the prompt: wipe the typed text. Checked HERE,
      // before the `!previewArmed || pickerActive` gate below — mirroring Ctrl+C right
      // above, which already bypasses that gate. Without this, a transient window where
      // `previewArmed` is momentarily false (the same class of race Ctrl+C was already
      // immune to) silently swallowed the ESC keypress: the box stayed unaffected and
      // `clearTypedInput()` never ran (the "esc 입력 후 안 먹힘" bug — Esc after typing
      // intermittently did nothing). `clearTypedInput()` itself already no-ops safely
      // when there is nothing to clear or no armed box to redraw into, so running it
      // unconditionally here is safe even mid-picker or pre-arm.
      if (key && ((key.name === "escape" && !key.ctrl) || (key.meta && key.name === "c"))) {
        clearTypedInput();
        return;
      }

      if (!previewArmed || pickerActive) return;
      // Drag-and-drop file attach: a terminal delivers a dropped file as its PATH typed
      // into the box, wrapped in a bracketed paste. On paste-end, swap any readable image
      // path LIVE for the same `[image #N]` tag Ctrl+V uses, so the box shows the tag
      // instead of a long raw filesystem path. Non-image / unreadable paths and ordinary
      // text pastes match nothing and are a no-op. Submit-time attach (below) still covers
      // terminals that deliver a drop WITHOUT bracketing it.
      if (key?.name === "paste-end" && !pasteInFlight && !pasteLineFired) {
        pasteInFlight = true;
        // Defer one tick: the dropped bytes reach readline through the keyFilter
        // PassThrough, so rl.line is only settled after the current stream turn.
        setImmediate(() => {
          void (async () => {
            try {
              const rli = rl as unknown as { line: string; cursor: number; _refreshLine?: () => void };
              const before = rli.line;
              const dropped = await attachImagePaths(before, pendingImages.length + 1);
              if (dropped.images.length === 0 || dropped.text === before) return;
              pendingImages.push(...dropped.images);
              rli.line = dropped.text;
              rli.cursor = dropped.cursor; // park right after the swapped-in tag (whitespace normalized)
              typedLine = dropped.text;
              // Keep readline's internal screen model in step with the swapped-in tag so
              // the caret is not offset on the next keystroke (mirrors the Ctrl+V path).
              rli._refreshLine?.();
              if (previewArmed) drawFooter(previewLines(typedLine, navIdx));
            } finally {
              pasteInFlight = false;
            }
          })();
        });
        return;
      }
      // Ctrl+L: redraw / re-anchor the prompt. The recovery for a footer whose in-place
      // anchor drifted after the screen scrolled (typed text stops showing in the box).
      if (key?.ctrl && key.name === "l") {
        redrawPromptFooter();
        return;
      }
      // Ctrl+O: toggle a reversible, scrollable detail panel inside the footer
      // (expand on the first press, FOLD on the next). ↑↓/PgUp/PgDn scroll it while
      // open — long/CJK content is fully reachable, nothing is clipped. The live-turn
      // path uses LaunchTui.showDetail(). (Cmd+O is intercepted by the terminal.)
      if (key?.ctrl && key.name === "o") {
        if (promptHistoryLines) {
          promptHistoryLines = null; // fold
          drawFooter(previewLines(typedLine, navIdx));
          return;
        }
        const detail = composeDetailLines();
        if (detail.length === 0) return;
        promptHistoryLines = detail;
        promptHistoryScroll = 0;
        drawFooter(historyPreviewLines(detail));
        return;
      }
      // While the detail panel is open, arrows / PgUp / PgDn scroll it instead of
      // navigating slash/history; every other key (below) closes it.
      if (promptHistoryLines && key && (key.name === "up" || key.name === "down" || key.name === "pageup" || key.name === "pagedown")) {
        const page = key.name === "pageup" || key.name === "pagedown";
        const dir = key.name === "up" || key.name === "pageup" ? -1 : 1;
        const step = page ? Math.max(1, promptHistoryPage - 1) : 1;
        const next = Math.min(promptHistoryMaxScroll, Math.max(0, promptHistoryScroll + dir * step));
        if (next !== promptHistoryScroll) {
          promptHistoryScroll = next;
          drawFooter(historyPreviewLines(promptHistoryLines));
        }
        return;
      }
      if (promptHistoryLines) {
        // Any other key dismisses the panel, then falls through to normal handling.
        promptHistoryLines = null;
        drawFooter(previewLines(typedLine, navIdx));
      }
      // Ctrl+V: attach a clipboard IMAGE to the next message; when the clipboard
      // holds no image, fall back to pasting its TEXT at the caret. Terminal-level
      // paste (Cmd+V / Ctrl+Shift+V) still streams through stdin as before — this
      // binding covers the terminals/users where that path doesn't fire (the
      // "복사붙여넣기가 잘 동작안하는 경우"): previously a text-only clipboard made
      // Ctrl+V a SILENT no-op.
      if (key?.ctrl && key.name === "v") {
        if (pasteInFlight) return;
        pasteInFlight = true;
        void (async () => {
          try {
            const rli = rl as unknown as { line: string; cursor: number; _refreshLine?: () => void };
            const img = await readClipboardImage();
            if (img) {
              pendingImages.push(img);
              const at = typeof rli.cursor === "number" ? rli.cursor : rli.line.length;
              // Insert the [image #N] tag at the caret with normalized single-space
              // padding (shared with the drag-drop path) so the caret lands right after
              // the tag instead of being pushed several columns by stray spaces.
              const ins = insertImageTag(rli.line, at, pendingImages.length);
              rli.line = ins.text;
              rli.cursor = ins.cursor;
            } else {
              const clip = await readClipboardText();
              if (!clip) return;
              // Same sanitation as a bracketed paste: strip ANSI escapes/C0 noise,
              // fold line breaks to the multi-line sentinel (or spaces when the
              // filter is off) so a multi-line clipboard cannot self-submit.
              const cleaned = stripPasteEscapes(clip.replace(/\r\n/g, "\n").replace(/\r/g, "\n"))
                .split("\n").join(multilineInput ? SENTINEL : " ");
              if (!cleaned) return;
              const at = typeof rli.cursor === "number" ? rli.cursor : rli.line.length;
              rli.line = rli.line.slice(0, at) + cleaned + rli.line.slice(at);
              rli.cursor = at + cleaned.length;
            }
            typedLine = rli.line;
            // Sync readline's internal screen model to the injected text (same as the
            // slash/tab completion accept paths): without it readline's stale row/cursor
            // model offsets the real caret several columns on the next keystroke — the
            // "caret pushed past the tag after attaching an image" shift.
            rli._refreshLine?.();
            if (previewArmed) drawFooter(previewLines(typedLine, navIdx));
          } finally {
            pasteInFlight = false;
          }
        })();
        return;
      }
      if (previewPending) return;

      // Ctrl+C is handled above (clear-or-exit); keep this guard for defensive ordering only.
      if (key?.ctrl && key.name === "c") return;

      previewPending = true;
      setImmediate(() => {
        previewPending = false;
        if (!previewArmed) return;
        try {
          if (key && (key.name === "return" || key.name === "enter")) {
            // Redraw the REAL box (not drawFooter([]), which erases it): this runs in a
            // setImmediate and can fire AFTER the loop already re-armed + repainted the box
            // for the next prompt (slash command / turn). An empty draw there wiped the fresh
            // box and parked the cursor at the reservation top — the "input box vanishes and
            // the caret leaves the prompt after a command" bug. Drawing previewLines keeps the
            // box present and the caret in it whether this fires before submit or after re-arm.
            drawFooter(previewLines(typedLine, navIdx));
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
          // Tab: complete the line to the highlighted popup row (or the TOP match
          // when nothing is highlighted) — `/mod`+Tab → `/model `, `$sp`+Tab →
          // `$spec-kit `. Runs AFTER readline's own completer fired; overwriting
          // rl.line here makes the popup's choice the deterministic final state
          // (the completer's candidate dump is gated while the preview is armed).
          if (key && key.name === "tab" && navMatches.length > 0) {
            const completed = tabCompleteSelection(typedLine, navMatches, navIdx);

            if (completed) {
              const rli = rl as unknown as { line: string; cursor: number; _refreshLine?: () => void };
              rli.line = completed;
              rli.cursor = completed.length;
              rli._refreshLine?.();
              typedLine = completed;
              navMatches = slashPreviewMatches(typedLine, skillSlashDetails, resolvedSkills);
              navIdx = -1;
              pendingSelection = undefined;
              drawFooter(previewLines(typedLine));
              return;
            }
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
    };
    process.stdin.on("keypress", footerKeypressHandler);
    promptListenerCleanups.push(() => process.stdin.off("keypress", footerKeypressHandler));
    // Idle-prompt resize: re-reserve the footer at the new terminal height so the
    // fixed reservation stays accurate (otherwise the next paint would target the
    // old row count and either over-shoot or under-paint the reserved region).
    // gjc-style responsiveness: re-reserve the footer IMMEDIATELY on the first resize
    // event (leading edge → no lag), then cap re-reservations to ~30fps during a
    // drag-resize, with a trailing settle so the FINAL height is always reserved exactly.
    // Skip same-geometry events; each re-reserve disarms→arms so it must not run per-event.
    const RESIZE_THROTTLE_MS = 33;
    let idleResizeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastIdleAt = 0;
    let lastIdleCols = process.stdout.columns ?? 80;
    let lastIdleRows = process.stdout.rows ?? 24;
    const reReserveFooter = () => {
      if (!previewArmed) return;
      const cols = process.stdout.columns ?? 80;
      const rows = process.stdout.rows ?? 24;
      if (cols === lastIdleCols && rows === lastIdleRows) return;
      lastIdleCols = cols;
      lastIdleRows = rows;
      try {
        // Fresh launch / post-`/clear`: the only thing on screen above the footer is the
        // welcome banner, which the terminal reflows into a fragmented mess on a width
        // change (every full-width box row wraps, floating its right border onto its own
        // line). Redraw it cleanly at the NEW width instead — full clear + reprint banner
        // + fresh footer reservation. Scoped to history.length <= 1, so once real work has
        // scrolled the banner into deep scrollback the caret-anchored relayout below runs.
        if (history.length <= 1 && process.stdout.isTTY) {
          footerRendered = 0;
          footerParkedRow = 0;
          lastFooterKey = "";
          lastDrawnLines = [];
          out.write(clearScreen());
          out.write(renderWelcome({ ...welcomeData, cols }).join("\n") + "\n");
          footerRows = previewRowsFor(rows);
          const initial = Math.max(1, Math.min(footerRows, COMPACT_FOOTER_ROWS));
          if (initial > 1) out.write("\n".repeat(initial - 1) + cursorUp(initial - 1));
          out.write(toColumn(1));
          footerRendered = initial;
          footerWantRows = initial;
          drawFooter(promptHistoryLines ? historyPreviewLines(promptHistoryLines) : previewLines(typedLine, navIdx));
          return;
        }
        // Resolution-safe relayout, anchored to the CURSOR (not the screen bottom). The
        // previous frame was painted at the OLD width; on resize the terminal reflows its
        // full-width rows AND repositions the frame — a width shrink wraps lines and floats
        // the frame UP by its blank tail, while a height grow leaves the frame high while
        // adding rows at the bottom. In every case the terminal keeps the REAL cursor on
        // the input caret's cell, so the caret is the one stable anchor. The old logical
        // disarm→arm cycle ignored this, clearing the wrong rows and scrolling the stray
        // frame into scrollback (the stacked status-bar corruption).
        //
        // Hop UP from the caret to the frame's physical top — `footerParkedRow` logical
        // rows of content sit above the caret; recompute their PHYSICAL height at the new
        // width (wrapped lines count for more) — then clear-to-end-of-display in one op.
        // This wipes the whole stray frame regardless of which way it drifted, and is
        // banner-safe: the hop stops exactly at the frame top (just below the static
        // content). ED is safe here — this path emits no bottom-margin scroll, so (unlike
        // the mid-turn ledger flush) tmux never copies the erased rows into history.
        const c = Math.max(1, cols);
        let abovePhysical = 0;
        for (let i = 0; i < footerParkedRow && i < lastDrawnLines.length; i++) {
          abovePhysical += Math.max(1, Math.ceil(Math.max(1, visibleWidth(lastDrawnLines[i]!)) / c));
        }
        // The caret may sit on a LOWER physical sub-row of its own (now-wrapped) line: a
        // long input wraps and the terminal keeps the cursor on its cell, so add the
        // caret's sub-row offset (caret column / width) or the hop stops below the top.
        const caretSubRow = Math.floor(Math.max(0, footerCursor.col - 1) / c);
        const hopUp = abovePhysical + caretSubRow;
        let s = (hopUp > 0 ? cursorUp(hopUp) : "") + toColumn(1) + clearToEnd();
        // Re-pin a COMPACT reservation right where the frame top was (just below the
        // static content) — NOT bottom-pinned. ED already blanked from the frame top
        // down, so reserve the idle height here; drawFooter grows it for a dropdown.
        // Bottom-pinning left a tall blank gap above the bar when the content was short.
        footerRows = previewRowsFor(rows);
        const initial = Math.max(1, Math.min(footerRows, COMPACT_FOOTER_ROWS));
        if (initial > 1) s += "\n".repeat(initial - 1) + cursorUp(initial - 1);
        s += toColumn(1);
        out.write(s);
        footerRendered = initial;
        footerWantRows = initial;
        footerParkedRow = 0;
        lastFooterKey = "";
        drawFooter(promptHistoryLines ? historyPreviewLines(promptHistoryLines) : previewLines(typedLine, navIdx));
      } catch { /* ignore resize render races */ }
    };
    const idleResizeHandler = () => {
      if (!previewArmed) return;
      const now = Date.now();
      if (now - lastIdleAt >= RESIZE_THROTTLE_MS) {
        lastIdleAt = now;
        reReserveFooter();
        return;
      }
      if (idleResizeTimer) clearTimeout(idleResizeTimer);
      idleResizeTimer = setTimeout(() => {
        idleResizeTimer = undefined;
        lastIdleAt = Date.now();
        reReserveFooter();
      }, RESIZE_THROTTLE_MS);
    };
    process.stdout.on("resize", idleResizeHandler);
    // Poll-based safety net: the idle footer sits between turns for most of a
    // session's wall-clock time, so a missed 'resize' event here (tmux pane switch
    // while this pane isn't foreground, a SIGCONT race, etc. — see terminal.ts's
    // watchResize doc) is the single biggest source of "screen stays at its
    // starting size" reports. Cheap 300ms poll; idleResizeHandler already dedupes
    // via lastIdleAt/reReserveFooter so this composes safely with the real event.
    const stopIdleResizeWatch = watchResize(() => idleResizeHandler());
    promptListenerCleanups.push(() => {
      process.stdout.off("resize", idleResizeHandler);
      if (idleResizeTimer) clearTimeout(idleResizeTimer);
      stopIdleResizeWatch();
    });
  }



  // Bare `--resume`/`-r` (no value) at cold startup (gjc-parity): show the SAME
  // interactive session picker `/session resume` (no arg) uses, in place of the
  // fresh session created above. TTY-only — non-TTY already fell back to
  // silent-latest resume in the startup block above.
  if (flags.resumeInteractive && !flags.noSession && process.stdin.isTTY && process.stdout.isTTY) {
    const pickResult = await runSessionSlash("/session resume", {
      cwd, history, noSession: flags.noSession, sessionId, sessionModel, rl,
      advanceSessionBoxColor, disarmPreview, clearScreen, freshWelcomeLines, logLines, runSelectPicker,
    });
    sessionId = pickResult.sessionId;
    if (pickResult.sessionModel !== undefined) sessionModel = pickResult.sessionModel;
    if (pickResult.lastUserInput !== undefined) lastUserInput = pickResult.lastUserInput;
    if (pickResult.lastReply !== undefined) lastReply = pickResult.lastReply;
    // Restore the unsent input-box draft left over at last save (gajae-code
    // parity) — feeds the SAME "new input first" prefill path queued mid-turn
    // lines already use, so it's visible in the box, Enter to run, Esc/Ctrl+U
    // to discard, on the very first prompt of this resumed session.
    if (pickResult.draft) queuedPromptInput.partial = pickResult.draft;
  }

  // Remote (Telegram) free-text reply / config command routing — wired here,
  // right before the REPL loop starts, since it needs `pendingImages`,
  // `rl`/`promptInput`'s `pendingRemoteInject`, and `pendingStdinLines`, all
  // established by now. See the Tier 2 contract's "Session-side routing".
  if (sessionNotifyEndpoint) {
    sessionNotifyEndpoint.onUserMessage = (msg): void => {
      void (async () => {
        // Resolve any attached photo/document paths (already downloaded to
        // local temp files by the daemon) into real ImageAttachments via the
        // SAME path `attachImagePaths` uses for local drag-drop — one image
        // ingestion mechanism, not a parallel one. Bare paths never contain
        // whitespace here (daemon-generated temp names), so simple whitespace
        // joining is a safe token boundary for the path-token scanner.
        const withPaths = msg.imagePaths?.length ? `${msg.text} ${msg.imagePaths.join(" ")}`.trim() : msg.text;
        const attached = await attachImagePaths(withPaths, pendingImages.length + 1);
        const cleanedText = attached.images.length ? attached.text : msg.text;
        if (attached.images.length) pendingImages.push(...attached.images);

        if (interactiveTurnActive && currentTurnSteer) {
          // Busy: steer the running turn exactly like a local mid-turn Enter.
          currentTurnSteer.push(cleanedText);
          currentTurnSteer.flushCard(cleanedText);
          return;
        }
        // Idle: never hijack text the user is actively typing locally — only
        // abort+inject when the readline buffer is confirmed empty (verified
        // empirically: aborting mid-partial-type corrupts the buffer).
        const rli = rl as unknown as { line?: string };
        if (rli.line === "" && pendingRemoteInject?.(cleanedText)) return;
        // No question pending, or the user is mid-type: queue for the NEXT
        // prompt cycle instead (same queue `pendingMidTurnCommands`/paste-merge
        // already feed — consumed at the top of the next `promptInput` call).
        pendingStdinLines.push(cleanedText);
      })();
    };
    sessionNotifyEndpoint.onConfigCommand = (cmd): void => {
      if (cmd.verbosity !== undefined) notifyVerbosity = cmd.verbosity;
      if (cmd.redact !== undefined) notifyRedact = cmd.redact;
    };
  }

  while (true) {
      drainPendingTtyInput();
      // "New input first": queued FULL lines from the previous turn are folded
      // into the editable prefill (visible in the input box, Enter to run,
      // Esc/Ctrl+U to discard) instead of auto-executing ahead of fresh input —
      // the "continues the previous work first" bug. Piped stdin keeps the
      // legacy in-order auto-serve (scripted runs depend on it).
      if (process.stdin.isTTY) {
        const folded = restoreQueuedLinesToPrefill(queuedPromptInput);
        if (folded > 0) {
          console.log(chalk.dim(`(restored ${folded} queued input line${folded > 1 ? "s" : ""} into the prompt — Enter to run, Esc to discard)`));
        }
      }
      const prefilledLine = queuedPromptInput.partial;
      queuedPromptInput.partial = "";
      // Resolve the visible input text FIRST (cheap, no I/O): the queued prefill, else
      // any partial the user typed while the previous live turn/subagent was running
      // (that text survives in readline's own buffer — adopt it so the box never hides
      // editable input). A pasted batch's TRAILING partial is recovered the same way.
      const rli = rl as unknown as { line?: string; cursor?: number; _refreshLine?: () => void };
      const residualPartial = !prefilledLine && typeof rli.line === "string" && rli.line.length > 0 && !/\x1b/.test(rli.line)
        ? rli.line
        : "";
      typedLine = prefilledLine || residualPartial;
      navMatches = [];
      navIdx = -1;
      // Reserve + paint the boxed input IMMEDIATELY — WITH its real text — so the
      // prompt is visible the instant the turn ends, BEFORE the git spawn below.
      // Otherwise the dirty-flag spawn (slow on a large / just-edited repo) runs in a
      // window where the box is gone and keystrokes echo nowhere (the "no response
      // after the result" gap). readline's own echo stays gated while armed.
      armPreview();
      promptHistoryLines = null; // each fresh prompt starts with the Ctrl+O panel closed
      if (prefilledLine) {
        rli.line = prefilledLine;
        rli.cursor = prefilledLine.length;
        rli._refreshLine?.();
      }
      drawFooter(previewLines(typedLine));
      // Refresh the status bar's dirty flag once per prompt (one git spawn, not per
      // frame); the second drawFooter repaints only if the count actually changed.
      idleDirtyCount = branch ? gitDirtyCount(cwd) : undefined;
      drawFooter(previewLines(typedLine));
      // Box mode: NO raw `jeo>` prompt at all — the boxed footer IS the input UI
      // (gating already suppresses readline echo, the empty prompt guarantees no
      // raw CLI input line can ever flash). Legacy prompt only without the box.
      const rawText = pendingMidTurnCommands.length
        ? (disarmPreview(), pendingMidTurnCommands.shift()!)
        : await promptInput(previewEnabled ? "" : "\njeo> ");
      if (rawText.includes("\u0003")) forceExitFromCtrlC();
      const raw = rawText.trim();
      disarmPreview();
      // Persist the submitted line so ↑ recalls it on a future launch (best-effort).
      if (raw && process.stdin.isTTY) appendInputHistory(cwd, raw);
      // Pasted batch command: echo what is about to run (with the remaining queue
      // depth) so a multi-line paste reads as a visible, ordered script.
      if (promptServedFromPaste && raw) {
        const remaining = queuedPromptInput.pastedLines.length;
        console.log(`${categoryBadge("progress")} ▶ pasted command: ${raw}${remaining > 0 ? chalk.dim(`  (+${remaining} queued)`) : ""}`);
      }
      // If an arrow-key selection was made over the slash/skill preview, apply it
      // to the ACTIVE trigger token (which may sit anywhere in the line —
      // mention-style): only the token is replaced, surrounding text survives.
      // A leading-token selection therefore still replaces the whole line and
      // runs as a command, exactly as before.
      const trigger = activeTriggerToken(raw);
      let input = pendingSelection && trigger && pendingSelection.startsWith(trigger.token)
        ? raw.slice(0, trigger.start) + pendingSelection
        : raw;
      // gjc-parity command aliases (full behavior reuse, no duplicated handlers):
      // /login→/provider login, /settings→/config, /subagent(s)→/agents.
      input = normalizeSlashAlias(input);
      pendingSelection = undefined;
      navMatches = [];
      navIdx = -1;
      // File attachment: a dragged-and-dropped image file arrives as its path in
      // the typed text. Read any image path(s), attach them, and swap the path for
      // an [image #N] tag (continuing the clipboard-image numbering) — the same
      // scheme Ctrl+V uses. Skipped for slash commands and `!` shell escapes.
      if (input && !input.startsWith("/") && !input.startsWith("!")) {
        const dropped = await attachImagePaths(input, pendingImages.length + 1);
        if (dropped.images.length > 0) {
          pendingImages.push(...dropped.images);
          input = dropped.text;
          console.log(chalk.dim(`(attached ${dropped.images.length} image file${dropped.images.length > 1 ? "s" : ""} from path)`));
        }
      }
      if (input === "/exit" || input === "/quit") break;
      if (input === "") {
        if (pendingImages.length === 0) continue;
        input = "Please look at the attached image(s)."; // image-only submit
      }
      // gjc-parity shell escape: `!<cmd>` runs the command directly in cmd-mode and
      // prints its output WITHOUT engaging the agent (history untouched), like a REPL
      // shell escape. The user is explicitly driving their own shell, so the deep-interview
      // mutation guard (which gates the AGENT's tools) does not apply here.
      if (input.startsWith("!")) {
        const cmd = input.slice(1).trim();
        if (!cmd) {
          console.log("Usage: !<shell command>   (run a command in cmd-mode; the agent and history are untouched)");
          continue;
        }
        try {
          const res = await bashTool(cmd, cwd);
          if (res.output) console.log(res.output);
          if (!res.success && res.error) console.log(chalk.red(res.error));
        } catch (err) {
          console.log(chalk.red(`! command failed: ${(err as Error).message}`));
        }
        continue;
      }
      if (input === "/" || input === "/?" || input === "/help") {
        logLines(formatSlashCommandList(input === "/help" ? "/" : input, skillSlashDetails));
        console.log("Tools: read / write / edit / bash / find / search. Sessions persist to .jeo/sessions/.");
        console.log("Shell: !<command>   runs a command in cmd-mode directly (agent/history untouched).");
        const tip = getEvolutionTip(history.length, flags.maxSteps > 0 ? flags.maxSteps : initialStepLimit);
        console.log(`\n${chalk.cyan("Evolutionary Tip:")} ${tip}`);
        continue;
      }
      if (input === "/clear") {
        history.length = 1;
        // Back to the initial screen: wipe the conversation, clear the terminal +
        // scrollback, and re-render the welcome banner so /clear looks like a fresh launch.
        if (process.stdout.isTTY) {
          disarmPreview();
          process.stdout.write(clearScreen()); // clear screen + scrollback + cursor home
          console.log(freshWelcomeLines().join("\n"));
        }
        console.log("(history cleared — back to the start screen)");
        continue;
      }
      if (input === "/compact") {
        // Session-start default snapshot (not the live global default) — keeps a
        // concurrent session's `/model` write from changing this session's context budget.
        const activeModel = sessionModel || defaultModel;
        const contextTokens = catalogMetadata(activeModel)?.contextTokens;
        const res = await maybeCompact(history, { model: activeModel, force: true, contextTokens });
        if (res.error) {
          console.error(chalk.red(res.error));
        } else if (res.compacted) {
          if (sessionId && res.replacesThrough !== undefined) {
            const touchedNote = res.touchedFiles?.length ? ` Files touched: ${res.touchedFiles.join(", ")}.` : "";
            const summaryText = res.summary ?? `[Earlier conversation omitted: ${res.removed} messages — summary unavailable.${touchedNote}]`;
            await appendCompaction(sessionId, ++compactionSeq, summaryText, res.replacesThrough, cwd);
          }
          console.log(`(compacted ${res.removed} older messages${res.touchedFiles?.length ? `; kept ${res.touchedFiles.length} file refs` : ""})`);
        } else {
          console.log("(nothing to compact)");
        }
        continue;
      }
      if (input === "/session" || input.startsWith("/session ")) {
        const result = await runSessionSlash(input, {
          cwd, history, noSession: flags.noSession, sessionId, sessionModel, rl,
          advanceSessionBoxColor, disarmPreview, clearScreen, freshWelcomeLines, logLines, runSelectPicker,
        });
        sessionId = result.sessionId;
        if (result.sessionModel !== undefined) sessionModel = result.sessionModel;
        if (result.lastUserInput !== undefined) lastUserInput = result.lastUserInput;
        if (result.lastReply !== undefined) lastReply = result.lastReply;
        // Restore the unsent input-box draft (see the resumeInteractive call
        // site above for the full rationale) — `continue` below immediately
        // re-enters the loop top, which consumes `queuedPromptInput.partial`
        // as this next prompt's prefill.
        if (result.draft) queuedPromptInput.partial = result.draft;
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
        logLines(historyViewLines(history, input.slice("/history".length), process.stdout.columns));
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
          // Copy via BOTH OSC 52 (reaches the outer terminal over SSH/tmux) and a
          // local clipboard tool (pbcopy / wl-copy / xclip / xsel / clip) — the union
          // makes `cmd+v` find the transcript regardless of where the terminal runs.
          const copied = await copyTextToClipboard(text);
          if (copied.osc52 || copied.local) {
            const via = [copied.local ? "system tool" : "", copied.osc52 ? "OSC52" : ""].filter(Boolean).join(" + ");
            console.log(`(transcript copied to clipboard via ${via} — ${text.length} chars)`);
            // OSC52 is the only path that reaches the OUTER terminal over SSH/tmux. If it was
            // skipped for size, a remote paste won't find the text — say so (and how to lift it).
            if (copied.osc52SkippedTooLarge) {
              console.log("(note: too large for the OSC52 remote-clipboard path — copied via the local tool only; over SSH/tmux this won't reach your machine. Set JEO_OSC52_MAX higher if your terminal accepts larger writes.)");
            }
          } else {
            console.log(text);
            console.log(copied.osc52SkippedTooLarge
              ? "(transcript too large for OSC52 and no local clipboard tool — printed above)"
              : "(no clipboard path available — transcript printed above)");
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
          // Side questions are quick lookups: STREAM the reply (immediate feedback
          // instead of a silent 10-30s wait that reads as "broken") and cap the
          // reasoning budget at LOW — an xhigh session level made slow models burn
          // a huge thinking budget before the first byte.
          process.stdout.write("btw> ");
          let streamed = "";
          const answer = await callLlm(side, {
            model: sessionModel || defaultModel,
            maxTokens: thinkingMaxTokens("low"),
            onToken: delta => {
              streamed += delta;
              process.stdout.write(delta);
            },
          });
          if (!streamed.trim() && answer.trim()) process.stdout.write(answer.trim());
          process.stdout.write("\n");
        } catch (err) {
          console.log(`\n! ${friendlyProviderError(err)}`);
        }
        continue;
      }
      if (input === "/undo") {
        logLines(handleUndoSlash(cwd));

        continue;
      }

      if (input === "/goal" || input.startsWith("/goal ")) {
        const arg = input.substring(5).trim();
        if (!arg) {
          const current = await readGoalState(cwd);
          if (current) {
            console.log(`Current goal: "${current.condition}" (set at ${new Date(current.setAt).toLocaleTimeString()})`);
          } else {
            console.log("Usage: /goal <condition>   (set a natural language stop condition for the session)");
            console.log("       /goal clear         (clear the current goal)");
          }
          continue;
        }
        if (arg === "clear" || arg === "none") {
          await clearGoalState(cwd);
          console.log("Goal cleared.");
          continue;
        }
        const state = {
          condition: arg,
          setAt: Date.now(),
          verdicts: [],
        };
        await writeGoalState(state, cwd);
        console.log(`Goal set to: "${arg}"`);
        continue;
      }
      // ---- gjc-parity inspection commands ------------------------------------
      if (input === "/usage") {
        const cfg = await readGlobalConfig();
        const ctx: SlashContext = { history, sessionModel, sessionId, cwd, config: cfg };
        const result = handleUsage(ctx, sessionUsage);
        if (result && "lines" in result) for (const line of result.lines) console.log(line);
        continue;
      }
      if (input === "/context") {
        const cfg = await readGlobalConfig();
        const ctx: SlashContext = { history, sessionModel, sessionId, cwd, config: cfg };
        const result = await handleContext(ctx);
        if (result && "lines" in result) for (const line of result.lines) console.log(line);
        continue;
      }
      if (input === "/tools") {
        const cfg = await readGlobalConfig();
        const ctx: SlashContext = { history, sessionModel, sessionId, cwd, config: cfg };
        const result = await handleTools(ctx);
        if (result && "lines" in result) for (const line of result.lines) console.log(line);
        continue;
      }
      if (input === "/hotkeys") {
        const cfg = await readGlobalConfig();
        const ctx: SlashContext = { history, sessionModel, sessionId, cwd, config: cfg };
        const result = handleHotkeys(ctx);
        if (result && "lines" in result) for (const line of result.lines) console.log(line);
        continue;
      }
      if (input === "/theme" || input.startsWith("/theme ")) {
        const decision = decideThemeSlash(input, listThemes(), resolveTheme().name);
        for (const line of decision.lines) console.log(line);
        if (decision.kind === "set") {
          process.env.JEO_TUI_THEME = decision.themeName!;
          await saveConfigPatch(raw => ({ theme: decision.themeName }));
          refreshUiTheme(); // re-resolve the keystroke-hot theme handle immediately
        }
        continue;
      }
      if (input === "/wiki" || input.startsWith("/wiki ")) {
        const decision = decideWikiSlash(
          input,
          resolveWikiRoot(await readGlobalConfig()),
          !!jeoEnv("WIKI_ROOT"),
        );
        for (const line of decision.lines) console.log(line);
        if (decision.kind === "clear") {
          await saveConfigPatch(() => ({ wikiRoot: undefined }));
          delete process.env.JEO_WIKI_ROOT;
          sessionWikiRoot = undefined;
          await refreshSessionMemory("");
        } else if (decision.kind === "set") {
          await saveConfigPatch(() => ({ wikiRoot: decision.persistArg }));
          process.env.JEO_WIKI_ROOT = decision.root;
          sessionWikiRoot = decision.root;
          await refreshSessionMemory("");
        }
        continue;
      }
      if (input === "/wiki" || input.startsWith("/wiki ")) {
        const decision = decideWikiSlash(
          input,
          resolveWikiRoot(await readGlobalConfig()),
          !!jeoEnv("WIKI_ROOT"),
        );
        for (const line of decision.lines) console.log(line);
        if (decision.kind === "clear") {
          await saveConfigPatch(() => ({ wikiRoot: undefined }));
          delete process.env.JEO_WIKI_ROOT;
          sessionWikiRoot = undefined;
          await refreshSessionMemory("");
        } else if (decision.kind === "set") {
          await saveConfigPatch(() => ({ wikiRoot: decision.persistArg }));
          process.env.JEO_WIKI_ROOT = decision.root;
          sessionWikiRoot = decision.root;
          await refreshSessionMemory("");
        }
        continue;
      }
      if (input === "/evolve") {
        await runEvolveSimulation(animateAsciiArt);
        continue;
      }
      if (input.startsWith("/provider") && (input === "/provider" || input[9] === " ")) {
        const tokens = input.substring(9).trim().split(/\s+/).filter(Boolean);
        let name = (tokens[0] ?? "").toLowerCase();
        // gjc-parity (semantic): /provider is ONBOARDING ONLY — set up OAuth credentials
        // or an API-compatible endpoint. Switching the active provider/model lives in /model.
        const providerOnboardingUsage = (): string[] => [
          "Provider onboarding — set up credentials or an API-compatible endpoint:",
          "  OAuth / subscription : /provider login [anthropic|openai|gemini|antigravity|<subscription>]   (alias: /login)",
          "                         subscriptions (token): alibaba-coding-plan, qwen-portal, xiaomi-token-plan-*, minimax-code*",
          "  API key (cloud)      : /provider key [provider] [key]   (groq, deepseek, mistral, openrouter, …)",
          "  API-compatible       : /provider add --base-url <url> [--model <model>] [--compat openai]   (reads OPENAI_API_KEY)",
          "                         show current / clear: /provider add   ·   /provider add clear",
          "  Logout               : /logout <provider>",
          "  Headless OAuth        : paste the redirect URL or code when the login prompt asks.",
          "Switch the active model or provider with /model.",
        ];
        // Bare `/provider` in an interactive TTY → gjc's interactive onboarding selector
        // (OAuth login vs API-compatible endpoint). The choice routes into the same
        // `login`/`add` branches below; cancel falls through to the printed readiness +
        // usage. Non-TTY / `help` keep the static panel (scriptable, unchanged).
        if (!name && process.stdin.isTTY && process.stdout.isTTY) {
          const action = await pickOnboardingAction();
          if (action === "oauth-login") name = "login";
          else if (action === "api-key") name = "key";
          else if (action === "api-add") {
            console.log("Add an API-compatible endpoint:");
            console.log("  /provider add --base-url <url> [--model <model>] [--compat openai]");
            console.log("  reads OPENAI_API_KEY · show current / clear: /provider add   ·   /provider add clear");
            continue;
          }
          // action === undefined (cancelled) → fall through to the readiness panel.
        }
        // `/provider key [name] [key]` → store an API key for an API-key-only provider
        // (groq/deepseek/mistral/…). Interactive: pick the provider, then paste the key.
        if (name === "key") {
          // kimi is dual-credential (moonshot API key OR Kimi Code OAuth) — keep it key-settable.
          const keyed = new Set<string>([...API_KEY_ONLY_PROVIDERS, "kimi"]);
          let target = tokens.slice(1).map(t => t.toLowerCase()).find(t => keyed.has(t)) as AuthProvider | undefined;
          // A trailing token after the provider name is treated as the key itself.
          const inlineKey = target ? tokens.slice(1).filter(t => t.toLowerCase() !== target).pop() : undefined;
          if (!target) {
            const statuses = await describeAllProviders();
            if (process.stdin.isTTY && process.stdout.isTTY) {
              target = await pickApiKeyProvider(statuses);
            } else {
              console.log("Set an API key for which provider?");
              console.log(`  ${API_KEY_ONLY_PROVIDERS.filter(p => !(SUBSCRIPTION_PROVIDER_NAMES as readonly string[]).includes(p)).join(", ")}`);
              console.log("  Subscription / plan products use /provider login (token).");
              console.log("  Usage: /provider key <provider> <api-key>   (or set <PROVIDER>_API_KEY)");
            }
            if (!target) {
              console.log("(cancelled)");
              continue;
            }
          }
          const envVar = `${target.toUpperCase().replace(/-/g, "_")}_API_KEY`;
          let apiKey = inlineKey;
          if (!apiKey) {
            apiKey = (await promptInput(`Paste ${target} API key (blank to cancel): `)).trim();
          }
          if (!apiKey) {
            console.log("(cancelled — no key entered)");
            continue;
          }
          await setApiKey(target, apiKey);
          console.log(`[SUCCESS] Stored ${target} API key in ~/.jeo/config.json (also reads ${envVar}).`);
          const live = await refreshLiveModelsCache();
          const after = (await describeAllProviders()).find(s => s.name === target);
          if (after) console.log(`  status → ${after.name}: ${after.ready ? `✓ ${after.label}` : after.label}`);
          const forProvider = live.filter(r => r.provider === target);
          if (forProvider.some(r => r.ok && r.models.length > 0)) {
            lastPickIndex = flattenModels(forProvider);
            const viaCatalog = forProvider.some(r => r.fallback);
            console.log(`  ${viaCatalog ? "catalog" : "live"} ${target} models → /model #N${viaCatalog ? "  (live list endpoint unavailable; showing known models)" : ""}`);
            logLines(formatPickListWithCapabilities(lastPickIndex, { cap: 12 }));
          } else {
            const failed = forProvider.find(r => !r.ok);
            if (failed?.error) console.log(`  live ${target} models unavailable: ${failed.error}`);
          }
          continue;
        }
        // `/provider login|auth [name]` → run OAuth login from the REPL.
        if (name === "login" || name === "auth") {
          const cloud = ["anthropic", "openai", "gemini", "antigravity"] as const;
          const subs = new Set<string>(SUBSCRIPTION_PROVIDER_NAMES); // token-keyed subscription/plan products
          let target = tokens.slice(1).map(t => t.toLowerCase()).find(t => (cloud as readonly string[]).includes(t) || subs.has(t));
          if (!target) {
            const statuses = await describeAllProviders();
            if (process.stdin.isTTY && process.stdout.isTTY) {
              target = await pickCloudProvider(statuses);
            } else {
              console.log("Log in to which provider?");
              console.log("  OAuth:");
              cloud.forEach((p, i) => {
                const st = statuses.find(s => s.name === p);
                const badge = st?.loggedIn
                  ? `\u2713 logged in${st.oauthEmail ? ` (${st.oauthEmail})` : ""}`
                  : "\u00b7 not logged in";
                console.log(`  ${i + 1}) ${p.padEnd(10)} ${badge}`);
              });
              console.log("  Subscription / plan (token):");
              for (const p of SUBSCRIPTION_PROVIDER_NAMES) {
                const st = statuses.find(s => s.name === p);
                const badge = st?.kind === "api_key" ? "\u2713 active" : "\u00b7 no token";
                console.log(`     ${p.padEnd(22)} ${badge} (set ${st?.envVar ?? `${p.toUpperCase().replace(/-/g, "_")}_API_KEY`})`);
              }
              const ans = (await promptInput(`Choose [1-${cloud.length}] or name (blank to cancel): `)).trim().toLowerCase();
              const byNum: Record<string, string> = Object.fromEntries(cloud.map((p, i) => [String(i + 1), p]));
              target = byNum[ans] ?? ((cloud as readonly string[]).includes(ans) || subs.has(ans) ? ans : undefined);
            }
            if (!target) {
              console.log("(cancelled)");
              continue;
            }
          }
          // Subscription/plan providers authenticate by token (not OAuth): prompt for the key
          // and store it like `/provider key`, then refresh + list models.
          if (subs.has(target)) {
            const sub = target as AuthProvider;
            const envVar = `${sub.toUpperCase().replace(/-/g, "_")}_API_KEY`;
            let token = tokens.slice(1).filter(t => t.toLowerCase() !== sub).pop();
            if (!token) {
              if (process.stdin.isTTY && process.stdout.isTTY) {
                token = (await promptInput(`Paste ${sub} subscription token (blank to cancel): `)).trim();
              } else {
                console.log(`Set the ${sub} subscription token with: /provider login ${sub} <token>   (or set ${envVar}).`);
              }
            }
            if (!token) {
              console.log("(cancelled — no token entered)");
              continue;
            }
            await setApiKey(sub, token);
            console.log(`[SUCCESS] Stored ${sub} subscription token in ~/.jeo/config.json (also reads ${envVar}).`);
            const live = await refreshLiveModelsCache();
            const after = (await describeAllProviders()).find(s => s.name === sub);
            if (after) console.log(`  status → ${after.name}: ${after.ready ? `✓ ${after.label}` : after.label}`);
            const forProvider = live.filter(r => r.provider === sub);
            if (forProvider.some(r => r.ok && r.models.length > 0)) {
              lastPickIndex = flattenModels(forProvider);
              const viaCatalog = forProvider.some(r => r.fallback);
              console.log(`  ${viaCatalog ? "catalog" : "live"} ${sub} models → /model #N${viaCatalog ? "  (live list endpoint unavailable; showing known models)" : ""}`);
              logLines(formatPickListWithCapabilities(lastPickIndex, { cap: 12 }));
            } else {
              const failed = forProvider.find(r => !r.ok);
              if (failed?.error) console.log(`  live ${sub} models unavailable: ${failed.error}`);
            }
            continue;
          }
          console.log(`Starting OAuth login for ${target}…`);
          try {
            const { email } = await interactiveOAuthLogin(target as AuthProvider, rl);
            console.log(`[SUCCESS] OAuth login complete for ${target}${email ? ` (${email})` : ""}. Tokens saved to ~/.jeo/config.json.`);
            const live = await refreshLiveModelsCache();
            const after = (await describeAllProviders()).find(s => s.name === target);
            if (after) console.log(`  status → ${after.name}: ${after.ready ? `✓ ${after.label}` : after.label}`);
            const forProvider = live.filter(r => r.provider === target);
            if (forProvider.some(r => r.ok && r.models.length > 0)) {
              lastPickIndex = flattenModels(forProvider);
              const viaCatalog = forProvider.some(r => r.fallback);
              console.log(`  ${viaCatalog ? "catalog" : "live"} ${target} models → /model #N${viaCatalog ? "  (live list endpoint rejected this token; showing known models)" : ""}`);
              logLines(formatPickListWithCapabilities(lastPickIndex, { cap: 12 }));
            } else {
              const failed = forProvider.find(r => !r.ok);
              if (failed?.error) console.log(`  live ${target} models unavailable: ${failed.error}`);
            }
          } catch (err) {
            console.log(`[FAILED] ${(err as Error).message} — or set ${target.toUpperCase()}_API_KEY.`);
          } finally {
            // The OAuth manual-code prompt opens an rl.question that is aborted the
            // instant the browser callback (or a failure) settles the flow. Bun leaves
            // that abandoned question's buffer behind, so the next prompt would adopt
            // it as residual prefill and resurrect the submitted "/provider login" in
            // the input box. Reset the readline line buffer so the prompt starts empty.
            const rli = rl as unknown as { line?: string; cursor?: number };
            rli.line = "";
            rli.cursor = 0;
          }
          continue;
        }
        // `/provider add --base-url <url> [--model <m>] [--compat openai]` → register an
        // OpenAI-compatible endpoint (sets openaiBaseUrl). gjc flag style; bare positional
        // URL/model still accepted for leniency. `/provider add clear` removes it.
        if (name === "add") {
          const rest = tokens.slice(1);
          if ((rest[0] ?? "").toLowerCase() === "clear") {
            await saveConfigPatch(() => ({ openaiBaseUrl: undefined }));
            await refreshLiveModelsCache();
            console.log("OpenAI-compatible base URL cleared — saved to ~/.jeo/config.json.");
            continue;
          }
          let baseUrl: string | undefined;
          let modelArg: string | undefined;
          let compat: string | undefined;
          for (let i = 0; i < rest.length; i++) {
            const t = rest[i]!;
            if (t === "--base-url" || t === "--url") baseUrl = rest[++i];
            else if (t === "--model") modelArg = rest[++i];
            else if (t === "--compat") compat = (rest[++i] ?? "").toLowerCase();
            else if (t === "--api-key-env" || t === "--provider") { i++; /* gjc-only: jeo has no named-provider registry — ignored */ }
            else if (!t.startsWith("--") && baseUrl === undefined) baseUrl = t; // positional url
            else if (!t.startsWith("--") && modelArg === undefined) modelArg = t; // positional model
          }
          if (compat && compat !== "openai") {
            console.log(`Only --compat openai is supported (got '${compat}') — jeo registers a single OpenAI-compatible endpoint.`);
            continue;
          }
          if (!baseUrl) {
            const cur = (await readGlobalConfig()).openaiBaseUrl;
            console.log(cur ? `OpenAI-compatible base URL: ${cur}` : "No OpenAI-compatible base URL set.");
            console.log("Set one with: /provider add --base-url <url> [--model <model>]   ·   clear with: /provider add clear");
            continue;
          }
          const url = normalizeBaseUrl(baseUrl, "");
          if (!url) {
            console.log("Provide a base URL, e.g. /provider add --base-url http://localhost:1234/v1");
            continue;
          }
          await saveConfigPatch(() => ({ openaiBaseUrl: url }));
          if (modelArg) {
            const qualified = qualifyModelId(modelArg, "openai");
            sessionModel = qualified;
            await saveConfigPatch(raw => rememberModelPatch(raw, qualified));
            await persistSessionModel();
            console.log(`OpenAI-compatible endpoint set: ${url} · default model ${qualified} — saved to ~/.jeo/config.json.`);
          } else {
            console.log(`OpenAI-compatible endpoint set: ${url} — saved to ~/.jeo/config.json.`);
          }
          const live = await refreshLiveModelsCache();
          const forProvider = live.filter(r => r.provider === "openai");
          const pick = flattenModels(forProvider);
          if (pick.length) {
            lastPickIndex = pick;
            console.log("Discovered models at this endpoint — select with /model #N:");
            logLines(formatPickListWithCapabilities(pick, { cap: 12 }));
          } else {
            const failed = forProvider.find(r => !r.ok);
            console.log(failed?.error ? `  could not list models: ${failed.error}` : "  no models discovered yet — the endpoint may need a key (set OPENAI_API_KEY).");
          }
          continue;
        }
        // Bare `/provider` (or `help`): show readiness + the onboarding usage. No switching.
        if (!name || name === "help") {
          const cfgNow = await readGlobalConfig();
          const statuses = await describeAllProviders(cfgNow);
          console.log("Providers (credential · base URL):");
          logLines(formatProviderPanel(statuses));
          for (const line of providerOnboardingUsage()) console.log(line);
          continue;
        }
        // Anything else (a provider name) used to switch the active provider — that moved
        // to /model (gjc semantics: /provider onboards, /model selects).
        console.log(`'/provider ${name}' no longer switches providers — provider/model selection moved to /model.`);
        console.log("Run /model to pick any provider's model (or /model <id|#N>). /provider now only onboards — see /provider help.");
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
      if (input === "/agents" || input.startsWith("/agents ")) {
        const agentsResult = await runAgentsSlash(input, {
          sessionModel, sessionThinking, lastPickIndex,
          getLiveModels, pickLiveProviderModel, setRoleThinking, pickFromOptions, pickThinkingLevel,
        });
        if (agentsResult.sessionThinking !== undefined) sessionThinking = agentsResult.sessionThinking;
        if (agentsResult.lastPickIndex !== undefined) lastPickIndex = agentsResult.lastPickIndex;
        continue;
      }
      if (input === "/config") {
        for (const line of await buildConfigPanelLines({ sessionModel, sessionThinking, sessionId })) console.log(line);
        continue;
      }
      if (input.startsWith("/roles") && (input === "/roles" || input[6] === " ")) {
        const rolesResult = await runRolesSlash(input, {
          sessionModel, sessionThinking, lastPickIndex,
          getLiveModels, pickLiveProviderModel, setRoleThinking, pickFromOptions, pickThinkingLevel,
        });
        if (rolesResult.sessionThinking !== undefined) sessionThinking = rolesResult.sessionThinking;
        if (rolesResult.lastPickIndex !== undefined) lastPickIndex = rolesResult.lastPickIndex;
        continue;
      }
      if (input.startsWith("/fast") && (input === "/fast" || input[5] === " ")) {
        const fastResult = await runFastSlash(input, {
          sessionModel, sessionThinking, lastPickIndex,
          getLiveModels, pickLiveProviderModel, setRoleThinking, pickFromOptions, pickThinkingLevel,
        });
        if (fastResult.sessionThinking !== undefined) sessionThinking = fastResult.sessionThinking;
        if (fastResult.lastPickIndex !== undefined) lastPickIndex = fastResult.lastPickIndex;
        continue;
      }
      if (input.startsWith("/thinking") && (input === "/thinking" || input[9] === " ")) {
        const thinkingResult = await runThinkingSlash(input, {
          sessionModel, sessionThinking, lastPickIndex,
          getLiveModels, pickLiveProviderModel, setRoleThinking, pickFromOptions, pickThinkingLevel,
        });
        if (thinkingResult.sessionThinking !== undefined) sessionThinking = thinkingResult.sessionThinking;
        if (thinkingResult.lastPickIndex !== undefined) lastPickIndex = thinkingResult.lastPickIndex;
        continue;
      }
      if (input.startsWith("/model") && (input === "/model" || input[6] === " ")) {
        const modelResult = await runModelSlash(input, {
          sessionModel, sessionThinking, defaultModel, lastPickIndex, liveModelsCache,
          isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
          getLiveModels, applyPickedModelWithTarget, persistSessionModel, pickLiveProviderModel,
        });
        // `null` (from `/model auto`/`/model clear`) means "release the pin", NOT
        // "unchanged" — `sessionModel` must become `undefined` so `runTurn`'s
        // `!sessionModel` routing gate re-opens for the rest of this session.
        if (modelResult.sessionModel !== undefined) sessionModel = modelResult.sessionModel === null ? undefined : modelResult.sessionModel;
        if (modelResult.sessionThinking !== undefined) sessionThinking = modelResult.sessionThinking;
        if (modelResult.lastPickIndex !== undefined) lastPickIndex = modelResult.lastPickIndex;
        continue;
      }
      if (input.startsWith("/route") && (input === "/route" || input[6] === " ")) {
        const cfgNow = await readGlobalConfig();
        const routeResult = runRouteSlash(input, {
          sessionRouteOverride,
          routingConfigEnabled: !!cfgNow.routing?.enabled,
          lastRouteDecision,
          pinnedModel: sessionModel,
          routeHistory: routeHistory.getAll(),
        });
        if (routeResult.sessionRouteOverride !== undefined) sessionRouteOverride = routeResult.sessionRouteOverride;
        for (const line of routeResult.lines) console.log(line);
        continue;
      }
      if (input.startsWith("/computer") && (input === "/computer" || input[9] === " ")) {
        const cfgNow = await readGlobalConfig();
        const computerResult = runComputerSlash(input, {
          sessionComputerOverride,
          computerConfigEnabled: !!cfgNow.computer?.enabled,
        });
        if (computerResult.sessionComputerOverride !== undefined) sessionComputerOverride = computerResult.sessionComputerOverride;
        for (const line of computerResult.lines) console.log(line);
        continue;
      }

      if (input.startsWith("/view") && (input === "/view" || input[5] === " ")) {
        for (const line of await handleViewSlash(input, cwd)) console.log(line);
        continue;
      }
      if (input.startsWith("/diff") && (input === "/diff" || input[5] === " ")) {
        for (const line of await handleDiffSlash(input, cwd, uiTheme)) console.log(line);
        continue;
      }
      if (input.startsWith("/find") && (input === "/find" || input[5] === " ")) {
        for (const line of await handleFindSlash(input, cwd)) console.log(line);
        continue;
      }
      if (input.startsWith("/search") && (input === "/search" || input[7] === " ")) {
        for (const line of await handleSearchSlash(input, cwd)) console.log(line);
        continue;
      }


      const skillEntrypoint = input.startsWith("/skill:") ? "/skill:" : input.startsWith("/skill") && (input === "/skill" || input[6] === " ") ? "/skill" : "";
      if (skillEntrypoint) {
        if (flags.noSkills) {
          console.log("Skills are disabled.");
          continue;
        }
        // `/` never LOADS or RUNS a skill file — skills are invoked ONLY via `$<name>`.
        // `/skill[:...]` is a read-only listing that points the user at the `$` entrypoint.
        let skills = await loadSkills(cwd);
        if (flags.skills) {
          const patterns = flags.skills.split(",").map(p => p.trim()).filter(Boolean);
          skills = skills.filter(s => patterns.some(p => matchSkillGlob(p, s.name)));
        }
        console.log("Skills are invoked with $<name> [intent] (e.g. $team build auth). Available:");
        for (const s of skills) {
          console.log(`  $${s.name.padEnd(16)} ${s.summary}`);
        }
        continue;
      }
      // `$a $b ... [intent]` — run EVERY resolved skill in the leading run, in order, each
      // with the shared trailing intent. A lone `$skill` is just a chain of length 1.
      const dollarChain = input.startsWith("$") ? parseSkillChain(input, resolvedSkills) : null;
      if (dollarChain && dollarChain.invocations.length) {
        if (dollarChain.unresolved.length) {
          console.log(`(skipping unknown skill${dollarChain.unresolved.length > 1 ? "s" : ""}: ${dollarChain.unresolved.map(u => `$${u}`).join(", ")})`);
        }
        if (dollarChain.invocations.length > 1) {
          console.log(`▶ Chaining ${dollarChain.invocations.length} skills: ${dollarChain.invocations.map(i => `$${i.skill.name}`).join(" → ")}`);
        }
        for (const inv of dollarChain.invocations) {
          try {
            await runSkillInvocation(inv.skill, inv.intent, inv.invokedAs);
          } catch (err) {
            console.log(`! ${(err as Error).message}`);
          }
        }
        continue;
      }

      // Unresolved `$skill` → suggest precisely, never silently send the typo to the model.
      // `$exact`/`$prefix`/chains already ran above; a leftover `$word` is a missed skill
      // attempt, EXCEPT `$UPPERCASE` env-var-style tokens (e.g. `$HOME`) which pass through.
      if (input.startsWith("$")) {
        const unresolved = (dollarChain?.unresolved.length
          ? dollarChain.unresolved
          : [(input.split(/\s+/, 1)[0] ?? "").slice(1)]
        ).filter(t => t && !/^[A-Z_][A-Z0-9_]*$/.test(t));
        if (unresolved.length > 1) {
          console.log(`No skills: ${unresolved.map(u => `$${u}`).join(", ")}.  (Type $ to autocomplete.)`);
          continue;
        }
        if (unresolved.length === 1) {
          const token = unresolved[0]!;
          const lc = token.toLowerCase();
          const prefix = resolvedSkills.filter(s => s.name.toLowerCase().startsWith(lc));
          if (prefix.length) {
            console.log(`Ambiguous skill '$${token}'. Did you mean: ${prefix.slice(0, 6).map(s => `$${s.name}`).join(", ")}?`);
          } else {
            const names = resolvedSkills.map(s => `$${s.name}`);
            const shown = names.slice(0, 12).join(", ");
            const more = names.length > 12 ? ` … +${names.length - 12} more` : "";
            console.log(`No skill '$${token}'. ${names.length ? `Available: ${shown}${more}` : "No skills are loaded."}  (Type $ to autocomplete.)`);
          }
          continue;
        }
      }

      // Unhandled slash attempt → suggest, don't send the typo to the model.
      if (isSlashAttempt(input)) {
        const m = matchSlash(input, [...completionContext().slashCommands]);
        if (m.length) {
          for (const line of formatSlashCommandList(input, skillSlashDetails)) console.log(line);
        } else {
          const cmds = [...completionContext().slashCommands];
          const near = suggestSlashCommands(input, cmds);
          console.log(near.length ? `Unknown command '${input}'. Did you mean ${near.join(", ")}?` : `Unknown command '${input}'. Try /help.`);
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
        // A cancelled turn (ESC / Ctrl-C) must also cancel the pasted batch —
        // continuing to auto-run the rest of a paste after an abort is hostile.
        if (reply === "Cancelled." && queuedPromptInput.pastedLines.length > 0) {
          const dropped = queuedPromptInput.pastedLines.splice(0).length;
          console.log(chalk.dim(`(cancelled — dropped ${dropped} queued pasted command${dropped > 1 ? "s" : ""})`));
        }
        if (!rendered) {
          console.log(`jeo> ${renderMarkdownTables(reply)}${usage}`);
          if (!done) console.log(`(agent did not converge in ${steps} steps)`);
        } else if (usage) {
          console.log(usage.trim());
        }
        // gajae-code 0.7.8 parity: ping the terminal bell when a turn finishes so a
        // backgrounded session notifies the user. Off unless config.notify.bell (or
        // JEO_NOTIFY_BELL=1) is set; never fires for a cancelled turn.
        if (reply !== "Cancelled.") maybeBell("complete", cfg.notify, (s) => out.write(s), process.env as Record<string, string | undefined>);
      } catch (err) {
        console.log(`! ${friendlyProviderError(err)}`);
      }
    }
  disarmPreview(); // clear footer + restore full-screen scrolling before leaving the REPL
  if (hardExitOnLoopEnd) {
    try {
      disarmPreview();
      out.write("\x1b[?25h\n");
    } catch { /* best effort */ }
    // Fire-and-forget: process.exit() below does not wait for this, but the OS
    // tears down the socket on process death regardless, and a leaked discovery
    // file is self-healing (the daemon's scanSessions() reaps dead-pid entries
    // on its next 3s poll — see notify-telegram-daemon.test.ts).
    void sessionNotifyEndpoint?.stop();
    process.removeListener("SIGINT", handleCtrlC);
    process.stdin.off("data", handleCtrlCByte);
    drainPromptListeners();
    restorePromptRawMode();
    process.exit(130);
  }
  // hermes-style experience distill (plan/gjc-inheritance.md B6) — now handed to a
  // DETACHED child (round-16): /exit and ^C^C return the shell IMMEDIATELY instead
  // of blocking up to 20s on a final LLM call. The child writes MEMORY.md atomically.
  if (sessionUsage.turns > 0) {
    const spawned = await spawnDetachedDistill(history, cwd, sessionModel || defaultModel);
    if (spawned) console.log(chalk.gray("(session memory distilling in background)"));
  }
  // gjc-parity resume pointer (logs/gjc-tui-study analysis Gap C): leave the exact
  // resume command in scrollback on exit, mirroring the --list handler's convention.
  if (sessionId && !flags.noSession) console.log(formatResumeHint(sessionId));
  await sessionNotifyEndpoint?.stop();
  process.removeListener("SIGINT", handleCtrlC);
  process.stdin.off("data", handleCtrlCByte);
  drainPromptListeners();
  restorePromptRawMode();
  gracefulReadlineClose = true;
  rl.close();
}
