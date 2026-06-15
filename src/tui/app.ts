/**
 * LaunchTui — the interactive coding-agent TUI (plan/01-tui.md §M2).
 *
 * Owns a differential Renderer + components and maps the agent engine's
 * `AgentLoopEvents` to a live, in-place frame: a tool-call list + an animated
 * status footer. On turn end the live region collapses to static final output
 * (tool summary + the assistant's reply), which stays in scrollback.
 *
 * Pure UI: it never imports the engine; the caller passes `tui.events()` into
 * `runAgentLoop` and calls `tui.start()` / `tui.finish(reply)` around the turn.
 */
import { Renderer } from "./renderer";
import { readWorkflowStateStrict } from "../agent/state";
import { size, isTTY, hideCursor, showCursor, enterAltScreen, leaveAltScreen } from "./terminal";
import { Spinner } from "./components/spinner";
import { ToolList } from "./components/tool-list";
import { StreamRegion } from "./components/stream";
import { renderFooter, type FooterData } from "./components/footer";
import { renderDnaClaw, dnaClawHeight, dnaClawFrameCount, dnaClawBeat, DNA_FLOW_PALETTE } from "./components/ascii-art";
import { evolutionTrack, createStageProgress, type StageProgress, transitionMessage } from "./components/evolution";
import type { TaskSubEvent } from "../agent/task-tool";
import { supportsUnicode } from "./components/capability";
import { centerBlock, padLineTo, boxBlock, BOX_ASCII, BOX_UNICODE } from "./components/layout";
import { SECTION_GAP, stackSections } from "./components/section";
import { resolveTheme, themeGradient, accentPaint, accentShadowPaint, diffPaint, mutedPaint, cardFillPaint } from "./components/themes";
import { detectColorLevel, animatedGradientText, ColorLevel } from "./components/color";
import { formatForgeBox, summarizeForgeInvocation, summarizeForgeResult, fitForgeBoxes, webSearchCardLines, type ForgeSummary } from "./components/forge";
import { renderJeoStatus, renderStatusBar, renderStatusBox } from "./components/status";
import { costForUsage, formatCost } from "../ai/pricing";
import { renderMarkdownTables } from "./components/markdown-table";
 
import { stripMarkdown, renderMarkdownAnsi } from "./components/markdown-text";
import { visibleWidth, wrapTextWithAnsi, truncateToWidth, sanitizeForFrame } from "./components/width";
import { categoryBadge } from "./components/category-index";
import { formatStepTimeline, stepsFromTools, formatStepHeader, formatStepTimelineCompact, type StepState } from "./components/step-timeline";
import { formatHintBar } from "./components/hints";
import { formatDuration, formatUsage } from "./components/duration";
import { renderHud, derivePhase, type JeoPhase } from "./components/hud";
import { formatTodoWriteCard } from "./components/todo-card";
import { renderInputBox } from "./components/input-box";
import { jeoEnv } from "../util/env";
import chalk from "chalk";

export interface LaunchTuiOptions {
  model: string;
  /** Resolved provider name for the footer (anthropic / openai / gemini / ollama). */
  provider?: string;
  sessionId?: string;
  write?: (s: string) => void;
  /** Step budget for this turn; drives the footer's `step N/M` denominator. */
  maxSteps?: number;
  /** Whether to treat the output as a TTY (drives alt-screen use). Defaults to isTTY(). */
  tty?: boolean;
  cwd?: string;
  branch?: string;
  /** Uncommitted-change count for the `⑂ branch ?N` dirty flag; omit/0 = clean. */
  dirtyCount?: number;
  /** Thinking-level label ("high", …) for the gjc-style model status bar. */
  thinking?: string;
}

export interface AgentEventsLike {
  onStep?(step: number): void;
  onAssistant?(raw: string, invocation: { tool: string; arguments?: unknown } | null): void;
  onToolResult?(tool: string, success: boolean, output: string): void;
  onToolProgress?(tool: string, partial: string): void;
  onNotice?(message: string): void;
  onUsage?(usage: { inputTokens: number; outputTokens: number }): void;
  onModelStream?(textSoFar: string): void;
  onReasoningStream?(textSoFar: string): void;
  onBudget?(limit: number, reason: string): void;

}

/** Pull the (possibly partial) `reasoning` string value out of a streaming JSON tool
 *  call so the live view can show the model's plan as it forms. Returns "" until a
 *  `"reasoning": "…` field starts. Tolerates the unterminated tail mid-stream. */
function extractStreamingReasoning(buf: string): string {
  // `reasoning` is a documented LEADING field, so only scan the head of the (growing)
  // buffer — avoids an O(n²) full rescan per delta when reasoning is absent on a large
  // streamed write/edit payload.
  const head = buf.length > 512 ? buf.slice(0, 512) : buf;
  const m = head.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return "";
  try { return JSON.parse('"' + m[1] + '"'); }
  catch { return m[1].replace(/\\\\/g, "\\").replace(/\\n/g, " ").replace(/\\"/g, '"'); }
}

/** Uniform live-activity fallback for models that stream no `reasoning` field: derive
 *  what the model is doing from the forming JSON (`"tool":"x"` → "calling x…") or, for
 *  prose-replying models, show the reply head — so the live status field behaves identically
 *  across providers/models instead of staying silent for some of them. */
function extractStreamingActivity(buf: string): string {
  const head = buf.length > 512 ? buf.slice(0, 512) : buf;
  const tool = head.match(/"tool"\s*:\s*"([^"]+)"/)?.[1];
  if (tool) return tool === "done" ? "writing the reply…" : `calling ${tool}…`;
  const t = head.trim();
  if (!t) return "";
  if (t.startsWith("{") || t.startsWith("```")) return "forming the next tool call…";
  return t.replace(/\s+/g, " ").slice(0, 140);
}

const DEFAULT_MAX_STEPS = 100;
// Tools light enough that they never get a forge card (gjc parity): completion is a
// single ✓/✗ ledger line; only failures surface a result card with the error body.
const LIGHT_TOOLS = new Set(["read", "find", "search", "ls", "todo"]);
function todoListChanged(
  oldItems: { title: string; status: string }[],
  newItems: { title: string; status: string }[]
): boolean {
  if (oldItems.length !== newItems.length) return true;
  for (let i = 0; i < oldItems.length; i++) {
    if (oldItems[i].title !== newItems[i].title || oldItems[i].status !== newItems[i].status) {
      return true;
    }
  }
  return false;
}


// Armed once per process: if we exit mid-turn (e.g. an uncaught crash), restore the
// terminal — leave the alt screen when the CURRENT turn mode is alt-screen, close any
// open synchronized update, and always bring the cursor back — so the TTY is never
// left hidden-cursor, sync-frozen, or stuck on a blank alt screen. The mode flag is
// mutable and refreshed on every start() so a later turn in a different mode (e.g. a
// test flipping JEO_TUI_ALT_SCREEN) is restored correctly.
let exitSafetyArmed = false;
let exitSafetyAltScreen = false;
function armExitSafety(altScreen: boolean): void {
  exitSafetyAltScreen = altScreen;
  if (exitSafetyArmed) return;
  exitSafetyArmed = true;
  process.once("exit", () => {
    try { process.stdout.write((exitSafetyAltScreen ? leaveAltScreen() : "\x1b[?2026l") + showCursor()); } catch { /* terminal gone */ }
  });
}

export class LaunchTui {
  private readonly renderer: Renderer;
  private readonly write: (s: string) => void;
  private readonly spinner: Spinner;
  private readonly tools = new ToolList();
  private readonly stream = new StreamRegion();
  private readonly forgeSummaries: ForgeSummary[] = [];
  private readonly footer: FooterData;
  private startedAt = 0;
  private currentStepStartedAt = 0;
  private tickCount = 0;
  private mutationGuarded = false;
  private finished = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pendingIndex: number | null = null;
  private pendingTitle: string | null = null;
  private pendingForge: ForgeSummary | null = null;
  // True between a step start and the model's reply — i.e. we're waiting on the model.
  // Surfaced in the status line ("calling model…") so the wait isn't an opaque pause.
  private thinking = false;
  private hudPhase: JeoPhase = "thinking";
  private runningTool = false;
  // Latest transient provider notice (rate-limit auto-retry countdown); pinned into the
  // [STEP] status row while waiting so backoff is visible at a glance. Cleared on the
  // next step / model reply.
  private retryNotice: string | null = null;
  private workflowStatus: { skill: string; phase: string; detail?: string } | null = null;
  // Cumulative token usage for the live turn (engine onUsage event).
  private turnUsage: { inputTokens: number; outputTokens: number } | null = null;
  // True while a delegated subagent turn is in flight — drives the `(sub)` status marker.
  private subagentActive = false;
  // Latest nested subagent activity (role + glyph + detail) — surfaced LIVE in the
  // status row while a `task` runs, so a delegated turn never reads as an opaque
  // "calling model" stall (the perceived-hang usability gap). Cleared on done.
  private subagentLive: string | null = null;
  // Bounded activity-history ring: one plain-text entry per ledger append, with a
  // turn-relative timestamp. Powers Ctrl+O's "recent activity" tail so the detail
  // view ALWAYS answers "what has been happening", even before the first reply.
  private readonly activityLog: { at: number; line: string }[] = [];
  private static readonly ACTIVITY_LOG_CAP = 200;
  // Live next-prompt draft. Printable keystrokes typed while a turn owns stdin
  // edit this same query surface; it is rendered as the normal input box during
  // the turn and becomes the editable prompt prefill when the turn finishes.
  private livePromptInput = "";
  // Auto-derived turn title (no LLM call): seeded from the first user message, refined
  // once to the first tool's verb+target. Shown in the HUD and synced to the tmux pane
  // title under --tmux so multiple sessions are distinguishable at a glance (gjc parity).
  private turnTitle: string | null = null;
  private turnTitleRefined = false;
  // Live "reasoning" text streamed from the model's response this step (the optional
  // `"reasoning"` field of the forming tool-call JSON). Shown dim under the HUD while
  // the model responds, then flushed once into scrollback as a `jeo · …` ledger line.
  private streamingReasoning = "";
  /** Native model thinking text (separate reasoning channel), shown DIMMED while it
   *  streams and cleared on commit — ephemeral, never flushed (the durable record is the
   *  action/reply the thinking produced). */
  private streamingThought = "";
  /** Uniform live-activity text for the live status field (reasoning OR derived fallback). */
  private streamingActivity = "";
  /** Last stream-driven draw (ms epoch) — throttles per-delta repaints to ≤10/s. */
  private lastStreamDraw = 0;
  private flushedReasoning = "";
  // Live streaming output of the currently-running tool (bash stdout via onToolProgress).
  // Shown as a DIMMED bounded block while the tool runs; cleared when the formatted
  // result card lands (onToolResult) — the gjc-style "shaded until complete" effect.
  private liveToolOutput = "";
  // Ctrl+O history/detail panel. When set, the live inline frame shows this
  // block above the heartbeat; pressing Ctrl+O again clears it and restores the
  // normal activity view. Kept as data, not scrollback text, so it can actually close.
  private historyLines: string[] | null = null;
  // Kind of the last ledger entry — drives the gjc-reference vertical rhythm: a
  // blank line separates DIFFERENT ledger groups (card ↔ ✓-tool lines ↔ reasoning
  // ↔ notices), while same-kind lines (consecutive ✓ reads) stay adjacent.
  private lastLedgerKind: string | null = null;
  // True while the live turn renders in the alternate screen buffer (TTY only);
  // drives leaving it on finish so terminal scroll never fights the repaint.
  private usedAltScreen = false;
  // Agent-declared task plan (the `todo` tool), rendered as a live checklist.
  private todos: { title: string; status: "pending" | "in_progress" | "done" }[] = [];
  // Cache the rendered art + track per stage so the 120ms spinner tick reuses
  // them instead of re-rendering/re-coloring the block every frame.
  private cachedStageIndex = -1;
  private cachedCols = -1;
  // Effective animation frame the cached art was rendered at. Keying the cache on
  // this (not the raw `isThinking` flag) lets frameless stages render ONCE instead
  // of re-rendering the gradient block every 120ms tick.
  private cachedFrame = -1;
  private cachedArt: string[] = [];
  private cachedTrack = "";
  // Monotonic stage progress so evolution only ever moves forward this turn.
  private readonly progress: StageProgress = createStageProgress();
  // Terminal unicode capability, detected once (drives spinner/track glyph set).
  private readonly unicode: boolean = supportsUnicode();
  // Active color theme (JEO_TUI_THEME), default cosmic; `mono` disables color.
  private readonly theme = resolveTheme(process.env);
  // Whether the live turn may use the alternate screen buffer (real TTY only).
  private readonly tty: boolean;
  // gjc-style inline rendering (default on a TTY): the live frame repaints in place in
  // the MAIN buffer and every completed ledger line is flushed into normal scrollback
  // first, so tmux / terminal mouse-wheel can scroll back through earlier progress
  // mid-turn. JEO_TUI_ALT_SCREEN=1 opts back into the legacy alternate-screen turn
  // (scroll-isolated, but no mid-turn scrollback).
  private readonly inline: boolean;
  // Thinking-level label for the gjc-style model status bar.
  private readonly thinkingLevel?: string;

  constructor(opts: LaunchTuiOptions) {
    this.write = opts.write ?? ((s: string) => process.stdout.write(s));
    this.tty = opts.tty ?? isTTY();
    this.inline = this.tty && jeoEnv("TUI_ALT_SCREEN") !== "1";
    // Row reservation is only needed (and only safe) for the inline main-buffer frame;
    // the alt screen starts at the top with a full-height frame.
    this.renderer = new Renderer(this.write, undefined, { reserve: this.inline });
    this.spinner = new Spinner(undefined, { unicode: this.unicode });
    this.thinkingLevel = opts.thinking;
    this.footer = {
      model: opts.model,
      provider: opts.provider,
      sessionId: opts.sessionId,
      maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
      unicode: this.unicode,
      cwd: opts.cwd,
      branch: opts.branch,
      dirtyCount: opts.dirtyCount,
    };
  }

  /** Whether a TUI should be used at all (TTY required). */
  static usable(noTui: boolean): boolean {
    return isTTY() && !noTui;
  }

  /** Update the agent-declared task plan (driven by the `todo` tool). */
  setTodos(items: { title: string; status: "pending" | "in_progress" | "done" }[]): void {
    const hasInProgress = items.some(item => item.status === "in_progress");
    const changed = todoListChanged(this.todos, items);
    if (hasInProgress && changed && !this.runningTool) {
      this.hudPhase = "planning";
    }
    // jeo-ref transcript: every plan CHANGE flushes a "Todo Write" tree card into
    // scrollback (☑ + strikethrough as items complete), so the checklist's history
    // is reviewable. The live pinned plan stays in the frame tail as before.
    if (changed && items.length > 0 && !this.finished) {
      const card = formatTodoWriteCard(items, {
        unicode: this.unicode,
        color: this.theme.color,
        muted: mutedPaint(this.theme),
        accent: this.theme.color ? accentPaint(this.theme) : undefined,
        fill: cardFillPaint(this.theme),
        width: Math.max(24, Math.min(100, size().cols)),
      });
      this.appendLedger(card.join("\n") + "\n", "card");
    }
    this.todos = items;
    this.draw();
  }

  /** Update estimated context usage shown in the footer. */
  setContextUsage(usedTokens: number, maxTokens?: number): void {
    this.footer.contextUsedTokens = usedTokens;
    this.footer.contextMaxTokens = maxTokens;
    this.draw();
  }

  /** Seed the turn title (no LLM call) and sync it to the terminal/tmux pane title.
   *  Called once per turn from the REPL with the user's input; refined to the first
   *  tool's verb+target on the first tool call. */
  setTurnTitle(raw: string): void {
    const first = (raw ?? "").split("\n").map(s => s.trim()).find(s => s.length > 0) ?? "";
    const title = first.length > 50 ? first.slice(0, 49) + "…" : first;
    this.turnTitle = title || null;
    this.turnTitleRefined = false;
    this.emitPaneTitle();
    this.draw();
  }

  /** Write an OSC window/pane title (`ESC]2;jeo: <title>BEL`). tmux maps this to the
   *  pane title, so multiple --tmux sessions are distinguishable at a glance. TTY only. */
  private emitPaneTitle(): void {
    if (!this.tty || !this.turnTitle) return;
    try { this.write(`\x1b]2;jeo: ${this.turnTitle}\x07`); } catch { /* terminal gone */ }
  }

  /** Render the task plan as a status-colored checklist; empty when no plan. */
  private renderPlan(color: boolean): string[] {
    if (this.todos.length === 0) return [];
    const steps = this.todos.map(t => ({
      label: t.title,
      state: (t.status === "done" ? "done" : t.status === "in_progress" ? "active" : "pending") as StepState,
    }));
    const header = formatStepHeader(steps, { unicode: this.unicode, color, label: "Todos" });
    return [header, ...formatStepTimeline(steps, { unicode: this.unicode, color, highlightActive: true, maxRows: 8, badges: false })];
  }
  /** The events object to hand to runAgentLoop. */
  events(): AgentEventsLike {
    return {
      onStep: step => {
        this.footer.step = step;
        this.thinking = true; // waiting on the model for this step
        this.hudPhase = "thinking";
        this.retryNotice = null; // a new step starts a fresh model call
        this.streamingReasoning = ""; // fresh model response this step
        this.streamingThought = "";
        this.streamingActivity = "";
        this.flushedReasoning = "";
        this.liveToolOutput = ""; // fresh step: no tool output yet
        this.currentStepStartedAt = Date.now();
        this.spinner.updateStep(step, this.footer.maxSteps);
        this.spinner.next();
        this.draw();
      },
      onModelStream: textSoFar => {
        // Surface the model's LIVE activity uniformly for every model/provider:
        // the streamed `reasoning` field when the model emits one, else a derived
        // fallback (tool being formed / reply prose head) — so no model leaves the
        // live status field silent while it streams.
        // Draws are THROTTLED to one per 100ms: the old per-delta draw() rendered
        // the full frame hundreds of times per response (a real chunk of jeo's
        // per-step latency); the 120ms timer tick covers the gaps anyway.
        const r = extractStreamingReasoning(textSoFar);
        let changed = false;
        if (r) {
          changed = r !== this.streamingReasoning;
          this.streamingReasoning = r;
          this.streamingActivity = r;
        } else {
          const fallback = extractStreamingActivity(textSoFar);
          if (fallback && fallback !== this.streamingActivity) {
            this.streamingActivity = fallback;
            changed = true;
          }
        }
        if (changed && Date.now() - this.lastStreamDraw >= 100) {
          this.lastStreamDraw = Date.now();
          this.draw();
        }
      },
      onReasoningStream: textSoFar => {
        if (this.finished) return;
        // Native thinking deltas → the SAME transient dimmed block as the JSON-reasoning
        // path (reuses the screen-safe tail renderer; no new frame structure). Ephemeral:
        // cleared on commit, never flushed into scrollback.
        if (textSoFar === this.streamingThought) return;
        this.streamingThought = textSoFar;
        if (Date.now() - this.lastStreamDraw >= 100) {
          this.lastStreamDraw = Date.now();
          this.draw();
        }
      },
      onAssistant: (_raw, invocation) => {
        this.thinking = false; // model replied; now dispatching the tool
        this.retryNotice = null; // the call got through — clear any backoff notice
        // Flush the streamed reasoning once into scrollback as a jeo-ref reasoning
        // block — the agent NAME on its own accent line, the prose below it (the
        // durable record) — then stop showing the transient live reasoning row.
        if (this.streamingReasoning && this.streamingReasoning !== this.flushedReasoning) {
          this.flushedReasoning = this.streamingReasoning;
          const name = this.theme.color ? chalk.bold(accentPaint(this.theme)("jeo")) : "jeo";
          this.appendLedger(`${name}\n${this.streamingReasoning}\n`, "reasoning");
        }
        this.streamingReasoning = "";
        this.streamingThought = "";
        this.streamingActivity = "";
        if (invocation && invocation.tool !== "done") {
          this.runningTool = true;
          this.hudPhase = "executing";
          const toolName = invocation.tool || "(no tool)";
          this.pendingIndex = this.tools.start(toolName);
          const summary = summarizeForgeInvocation(toolName, invocation.arguments);
          this.pendingTitle = summary.title;
          // Refine the turn title once to the first tool's verb+target (e.g. "read
          // package.json"), gjc-style, then lock — sharper than the raw user message.
          if (!this.turnTitleRefined) {
            this.turnTitle = summary.title.length > 50 ? summary.title.slice(0, 49) + "…" : summary.title;
            this.turnTitleRefined = true;
            this.emitPaneTitle();
          }
          // Light tools (read/find/search/…) never get a live card — their completion
          // is a single ✓ ledger line (gjc parity). Heavier tools show the invocation
          // card live, and the completed card is flushed into scrollback on result.
          if (LIGHT_TOOLS.has(toolName.toLowerCase())) {
            this.pendingForge = null;
          } else {
            this.pendingForge = summary;
            this.rememberForge(summary);
          }
          this.draw();
        } else {
          this.hudPhase = "reporting";
        }
      },
      onToolProgress: (_tool, partial) => {
        if (this.finished) return;
        // Sanitize raw child stdout (CR / EL / cursor-move escapes) before it enters the
        // frame — unsanitized control bytes tore the renderer's next \x1b[2K (literal "2K")
        // and hijacked the cursor, corrupting the live frame.
        this.liveToolOutput = sanitizeForFrame(partial);
        if (Date.now() - this.lastStreamDraw >= 100) {
          this.lastStreamDraw = Date.now();
          this.draw();
        }
      },
      onToolResult: (tool, success, output) => {
        this.runningTool = false;
        this.liveToolOutput = ""; // formatted result card now replaces the live dim output
        if (this.pendingIndex !== null) {
          this.tools.finish(this.pendingIndex, success);
          this.pendingIndex = null;
        }
        const t = (tool || "").toLowerCase();
        const target = this.pendingTitle || tool;
        this.pendingTitle = null;
        // gjc-parity glyph-first ledger line: a colored ✓/✗ leads the flushed
        // scrollback line so a wheel-scroll back through history scans like gjc's
        // tool checklist — no category/status badge clutter.
        const mark = this.unicode ? (success ? "✓" : "✗") : success ? "v" : "x";
        const paintedMark = this.theme.color ? (success ? chalk.green(mark) : chalk.red(mark)) : mark;
        const result = summarizeForgeResult(tool, success, output);
        const card = this.pendingForge;
        this.pendingForge = null;
        if (card && t === "bash") {
          // gjc-style single Bash card: command echo + `Output` divider + body + exit
          // note, under one ✓/✗-marked header — mutated in place so the live frame and
          // the non-TTY summary both show the merged card.
          card.title = `${paintedMark} Bash`;
          card.lines.push(...result.lines);
          this.flushForgeCard(card, success);
        } else if (card && t === "web_search" && success && webSearchCardLines(output, { unicode: this.unicode })) {
          // gjc-style Web Search card: `✓ Web Search: <provider> · N sources` header
          // over Query / Answer / Sources / Metadata divider sections rebuilt from
          // the structured tool output (provider chain — Anthropic native or the
          // keyless DuckDuckGo fallback).
          const ws = webSearchCardLines(output, { unicode: this.unicode })!;
          card.title = `${paintedMark} Web Search: ${ws.titleMeta}`;
          card.lines = ws.lines;
          this.flushForgeCard(card, success);
        } else if (card) {
          card.title = `${paintedMark} ${card.title}`;
          if (!success) this.rememberForge(result);
          this.flushForgeCard(card, success);
          if (!success) this.flushForgeCard(result, false);
        } else {
          // Light tool: one ✓/✗ line, plus a dim result tree for list-shaped output
          // (find/search/ls) and an error card when the tool failed.
          const { suffix, children } = this.ledgerTree(tool, success, output);
          this.appendLedger(`${paintedMark} ${target}${suffix}\n${children.map(c => `${c}\n`).join("")}`, "tool");
          if (!success) {
            this.rememberForge(result);
            this.flushForgeCard(result, false);
          }
        }
        this.draw();
      },
      onNotice: msg => {
        // Transient progress notice (e.g. rate-limit auto-retry countdown) is live
        // state, not ledger content. Pin it in the status row only; do NOT append
        // repeated retry notices into the stream/log area.
        this.retryNotice = msg;
        this.draw();
      },
      onBudget: (limit: number, reason: string) => {
        // gjc-style retry flow: the step budget extended itself — update the live
        // `step N/M` denominators and leave one durable ledger line.
        this.footer.maxSteps = limit;
        this.spinner.updateStep(this.footer.step ?? 0, limit);
        const mark = this.unicode ? "↻" : "~";
        const dim = this.theme.color ? chalk.dim : (s: string) => s;
        this.appendLedger(dim(`${mark} ${reason}`) + "\n", "notice");
        this.draw();
      },
      onUsage: (u: { inputTokens: number; outputTokens: number }) => {
        // Live cumulative token usage for the turn — shown in the final summary
        // (and available to the footer meter).
        this.turnUsage = u;
        this.draw();
      },
    };
  }

  /** Ctrl+O history/detail toggle, mid-turn: first press opens a live panel with
   *  the full last reply / tool output, second press closes it and returns to the
   *  normal activity frame. Unlike the old scrollback dump, this is reversible. */
  showDetail(lines: string[]): void {
    if (this.finished) return;
    if (this.historyLines) {
      this.historyLines = null;
      this.draw();
      return;
    }
    if (lines.length === 0) return;
    this.historyLines = lines;
    this.draw();
  }

  /** Mirror the REPL's live next-prompt draft into the running frame. The input
   * box remains visible during a turn, so typing never appears in a separate
   * queued row and Enter does not create hidden auto-execute work. */
  setLivePromptInput(text: string): void {
    if (this.finished) return;
    const next = text ?? "";
    if (next === this.livePromptInput) return;
    this.livePromptInput = next;
    this.draw();
  }

  private renderLiveInputBox(cols: number): string[] {
    const caret = this.unicode ? "▌" : "_";
    const display = this.livePromptInput ? `${this.livePromptInput}${caret}` : "";
    return renderInputBox(display, {
      cols: Math.max(24, Math.min(120, cols)),
      color: this.theme.color,
      unicode: this.unicode,
      accent: this.theme.color ? accentPaint(this.theme) : undefined,
      accentShadow: this.theme.color ? accentShadowPaint(this.theme) : undefined,
      placeholder: "Type your next message...",
      maxBodyRows: 2,
    });
  }

  /** Render a `user`-labeled query card (orange "user" header over a filled box).
   *  Shared by the live next-prompt draft and the mid-turn steering flush. */
  private renderUserCard(rawText: string, cols: number): string[] {
    const text = (rawText ?? "").trim();
    if (!text) return [];
    const boxWidth = Math.max(24, Math.min(120, cols));
    const inner = Math.max(10, boxWidth - 2);
    const g = this.unicode ? BOX_UNICODE : BOX_ASCII;
    const uc = this.theme.userCard;
    const accent = this.theme.color && uc ? chalk.hex(uc.accent).bold : (s: string) => s;
    const border = this.theme.color && uc ? chalk.hex(uc.border) : (s: string) => s;
    const shadow = this.theme.color && uc ? chalk.hex(uc.shadow) : border;
    const fill = this.theme.color && uc ? (s: string) => chalk.bgHex(uc.fill)(s) : (s: string) => s;
    // Show ALL wrapped lines — the card lives in scrollback (not a bounded live frame),
    // so a long submitted query stays fully visible (no truncation).
    const body = text
      .split("\n")
      .flatMap(line => wrapTextWithAnsi(line, Math.max(8, inner - 2)));
    const rows = body.length ? body : [""];
    const top = border(g.tl + g.h.repeat(inner) + g.tr);
    const bottom = shadow(g.bl + g.h.repeat(inner) + g.br);
    const mid = rows.map(line => {
      const content = fill(padLineTo(` ${line}`, inner, "left"));
      return border(g.v) + content + shadow(g.v);
    });
    return [`  ${accent("user")}`, top, ...mid, bottom];
  }

  /** Flush a `user` card into scrollback so a submitted query stays visible there
   *  (gjc parity), instead of only as the transient HUD turn-title / a status notice.
   *  Shared by the prompt that STARTS a turn and the mid-turn steering flush. */
  flushUserCard(text: string): void {
    const t = (text ?? "").trim();
    if (!t || this.finished) return;
    const cols = Math.max(20, size().cols);
    const lines = this.renderUserCard(t, cols);
    if (lines.length) this.appendLedger(lines.join("\n"), "card");
  }

  /** Mid-turn steering query → a `user` card in scrollback (accepted input that is
   *  now driving the running turn). Alias of {@link flushUserCard}. */
  flushSteerCard(text: string): void {
    this.flushUserCard(text);
  }

  /** Append a completed progress-ledger line. In inline mode the line is flushed
   *  straight into normal scrollback ABOVE the live frame, so tmux / terminal
   *  mouse-wheel can review the full progress history mid-turn (gjc-style); the
   *  StreamRegion copy still feeds the in-frame tail and the non-TTY / alt-screen
   *  final summary.
   *  `kind` drives the readability rhythm (jeo-ref layout): a blank spacer row is
   *  inserted when the ledger switches between groups (tool lines ↔ reasoning ↔
   *  cards ↔ notices) and around every card — same-kind lines stay adjacent so a
   *  burst of ✓ reads still scans as one block.
   *  CRITICAL: every flushed line is width-wrapped to the terminal columns first.
   *  A line longer than the terminal hard-wraps into 2+ PHYSICAL rows, which breaks
   *  the renderer's 1-line=1-row reservation math — the live frame then repaints at
   *  the wrong rows (the "screen tearing + garbled scrollback" corruption). */
  private appendLedger(text: string, kind = "line"): void {
    this.recordActivity(text);
    const needsGap = this.lastLedgerKind !== null && (kind !== this.lastLedgerKind || kind === "card");
    this.lastLedgerKind = kind;
    const body0 = needsGap ? `\n${text}` : text;
    this.stream.append(body0);
    if (this.inline && !this.finished) {
      const cols = Math.max(20, size().cols);
      const body = body0.endsWith("\n") ? body0.slice(0, -1) : body0;
      const wrapped = body
        .split("\n")
        .flatMap(line => (visibleWidth(line) <= cols ? [line] : wrapTextWithAnsi(line, cols)))
        .join("\n");
      this.renderer.insertAbove(`${wrapped}\n`);
    }
  }

  /** Record one plain-text activity entry (ANSI-stripped first line, bounded ring). */
  private recordActivity(text: string): void {
    const first = text
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .map(l => l.trim())
      .find(l => l.length > 0);
    if (!first) return;
    this.activityLog.push({ at: Date.now(), line: first.slice(0, 160) });
    if (this.activityLog.length > LaunchTui.ACTIVITY_LOG_CAP) this.activityLog.shift();
  }

  /** Recent activity entries (newest last) with turn-relative `+N.Ns` timestamps —
   *  the Ctrl+O detail view's "what just happened" tail. */
  recentActivity(n = 30): string[] {
    const base = this.startedAt || Date.now();
    return this.activityLog.slice(-Math.max(1, n)).map(e => {
      const rel = Math.max(0, (e.at - base) / 1000);
      return `+${rel.toFixed(1)}s ${e.line}`;
    });
  }

  /** gjc-style ledger tree for list-shaped tool results (find / search / ls): a dim
   *  ` · N files` / ` · N matches` count suffix for the summary line plus up to six
   *  dim `├─` child rows sampling the results, closed by `└─ … N more`. Children are
   *  flushed into scrollback with the summary, so wheel-scroll history reads like
   *  gjc's `✓ Find: pattern  39 files` block. Other tools return no decoration. */
  private ledgerTree(tool: string, success: boolean, output: string): { suffix: string; children: string[] } {
    const t = (tool || "").toLowerCase();
    if (!success || (t !== "find" && t !== "search" && t !== "ls")) return { suffix: "", children: [] };
    const rows = (output || "")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0 && !/^no match/i.test(l) && !l.startsWith("…("));
    if (rows.length === 0) return { suffix: "", children: [] };
    const dim = this.theme.color ? chalk.dim : (s: string) => s;
    const noun = t === "search" ? (rows.length === 1 ? "match" : "matches") : rows.length === 1 ? "file" : "files";
    const suffix = dim(` · ${rows.length} ${noun}`);
    const MAX_CHILDREN = 6;
    const shown = rows.slice(0, MAX_CHILDREN);
    const more = rows.length - shown.length;
    const tee = this.unicode ? "├─" : "|-";
    const end = this.unicode ? "└─" : "`-";
    const ell = this.unicode ? "…" : "...";
    const children = shown.map((l, i) =>
      dim(`  ${i === shown.length - 1 && more <= 0 ? end : tee} ${l.length > 96 ? `${l.slice(0, 95)}${ell}` : l}`),
    );
    if (more > 0) children.push(dim(`  ${end} ${ell} ${more} more ${noun}`));
    return { suffix, children };
  }

  /** Surface native workflow-engine progress (`/skill deep-interview`, etc.). */
  setWorkflowStatus(status: { skill: string; phase: string; detail?: string } | null): void {
    this.workflowStatus = status;
    if (status) {
      const detail = status.detail ? ` — ${status.detail}` : "";
      const diamond = this.unicode ? "◆" : "*";
      this.appendLedger(`${diamond} workflow ${status.skill}: ${status.phase}${detail}\n`, "workflow");
    }
    this.draw();
  }

  /**
   * Real, stable "what jeo is doing right now" for the [STEP] line — the in-flight tool's
   * actual target (file / command), else the active plan step, else overall plan progress.
   * Replaces the per-tick cycling status text so the line shows genuine content (thinking
   * about a real file/step) instead of churning decorative messages every 120ms.
   */
  private currentActivity(): string {
    const running = this.tools.currentTool();
    // An in-flight tool's real target beats the workflow phase banner (gjc-style:
    // the status row shows what is happening RIGHT NOW; the ◆ hud line carries
    // the workflow identity).
    if (this.workflowStatus && !running) {
      const detail = this.workflowStatus.detail ? ` — ${this.workflowStatus.detail}` : "";
      return `workflow ${this.workflowStatus.skill}: ${this.workflowStatus.phase}${detail}`;
    }
    // A delegated subagent's LATEST nested event beats the parent's static
    // "Task: <role> …" card title — a long task otherwise reads as a stall even
    // though the subagent is actively reading/editing/running underneath.
    if (this.subagentActive && this.subagentLive) return this.subagentLive;
    // Waiting on the model and no tool is mid-flight → make the pause legible.
    if (this.thinking && !running) {
      const elapsed = this.currentStepStartedAt ? ((Date.now() - this.currentStepStartedAt) / 1000).toFixed(1) : "0.0";
      // A provider backoff wait is the REAL current activity — show the retry notice
      // (e.g. "rate limited (HTTP 429) — auto-retry #2 in 4s") instead of an opaque
      // ever-growing "calling model (18.4s)…".
      if (this.retryNotice) return `${this.retryNotice} (${elapsed}s)`;
      return `calling model (${this.footer.model}) (${elapsed}s)…`;
    }
    if (running) {
      const last = this.forgeSummaries[this.forgeSummaries.length - 1];
      if (last?.title?.toLowerCase().startsWith("bash")) {
        const cmd = last.lines.map(l => l.trim()).find(l => l.length > 0 && !l.startsWith("#"));
        return cmd ? `bash: ${cmd}` : "bash command";
      }
      // Light tools have no live card; pendingTitle still carries the real target.
      return this.pendingTitle ?? last?.title ?? `running ${running}`;
    }
    const active = this.todos.find(t => t.status === "in_progress");
    if (active) return `step: ${active.title}`;
    if (this.todos.length > 0) {
      const done = this.todos.filter(t => t.status === "done").length;
      return `plan ${done}/${this.todos.length} complete`;
    }
    return "thinking through the next tool call";
  }

  /**
   * Surface a delegated subagent's live progress (the `task` tool) in the stream region,
   * mirroring gjc's subagent monitoring: the assignment, each nested tool call, and the
   * final outcome — so a TUI turn shows what the subagent actually did instead of going
   * silent until the task result box. The full findings still arrive as the task tool's
   * own result forge box; this is the live play-by-play.
   */
  onSubagentEvent(e: TaskSubEvent): void {
    if (this.finished) return;
    const color = this.theme.color;
    const role = e.role || "subagent";
    const roleLabel = e.index && e.total ? `${role.toUpperCase()}[${e.index}/${e.total}]` : role.toUpperCase();
    const badge = categoryBadge("subagent", { color });
    const ok = this.unicode ? "✓" : "v";
    const bad = this.unicode ? "✗" : "x";
    const branch = this.unicode ? "├─" : "|-";
    const last = this.unicode ? "└─" : "`-";
    const detail = (e.detail ?? "").split("\n").find(l => l.trim().length > 0)?.trim().slice(0, 140) ?? "";
    const summary = e.summary ? ` — ${e.summary}` : "";
    // No `step N/M` marker on nested lines — step counters carry no meaning
    // under the dynamic budget (user feedback). A tree branch keeps subagent
    // activity readable in scrollback and visually separate from parent tools.
    switch (e.kind) {
      case "start":
        this.subagentActive = true;
        this.subagentLive = `${roleLabel} ${this.unicode ? "▸" : ">"} ${detail || "starting"}`;
        this.appendLedger(`${badge} ${this.unicode ? "▸" : ">"} ${roleLabel} · ${detail}\n`, "subagent");
        break;
      case "step":
        this.subagentLive = `${roleLabel} ${this.unicode ? "·" : "-"} ${detail || "working"}`;
        this.appendLedger(`  ${badge} ${branch} ${roleLabel} · ${detail || "working"}\n`, "subagent");
        break;
      case "tool":
        this.subagentLive = `${roleLabel} ${e.success === false ? bad : ok} ${detail || "tool"}`;
        this.appendLedger(`  ${badge} ${branch} ${roleLabel} ${e.success === false ? bad : ok} ${detail || "tool"}${summary}\n`, "subagent");
        break;
      case "error":
        this.subagentLive = `${roleLabel} ${bad} ${detail || "error"}`;
        this.appendLedger(`  ${badge} ${branch} ${roleLabel} ${bad} ${detail || "error"}\n`, "subagent");
        break;
      case "done":
        this.subagentActive = false;
        this.subagentLive = null;
        this.appendLedger(`${badge} ${last} ${roleLabel} done${e.tokens ? ` (${e.tokens.input + e.tokens.output} tok)` : ""}${e.success === false ? " (incomplete)" : ""}: ${detail}\n`, "subagent");
        break;
    }
    this.draw();
  }

  start(): void {
    this.startedAt = Date.now();
    this.turnUsage = null;
    this.lastLedgerKind = null; // fresh turn: no leading spacer before the first ledger line
    this.livePromptInput = ""; // fresh turn: no next-prompt draft yet
    this.subagentLive = null; // fresh turn: no nested subagent in flight
    this.activityLog.length = 0; // per-turn ring: timestamps are turn-relative
    this.spinner.updateStep(0, this.footer.maxSteps);
    // On a real TTY the live turn renders gjc-style in the MAIN buffer by default:
    // completed ledger lines are flushed into normal scrollback as they happen, so a
    // tmux / terminal mouse-wheel scroll can review earlier progress mid-turn. The
    // differential renderer reserves frame rows with real newlines, keeping the
    // in-place repaint anchored even at the bottom of the viewport.
    // JEO_TUI_ALT_SCREEN=1 restores the legacy alternate-screen turn (scroll-isolated,
    // but with no scrollback until the turn ends).
    if (this.tty) {
      if (this.inline) {
        // Reset the renderer baseline at the anchor (with prev=[] this clears
        // nothing — the first frame's per-line EL paint + row reservation
        // overwrite/scroll every viewport row, so stale pre-turn rows can't bleed).
        this.renderer.clear();
      } else {
        this.usedAltScreen = true;
        this.write(enterAltScreen());
        this.renderer.reset();
      }
      armExitSafety(this.usedAltScreen);
    }
    this.write(hideCursor());
    this.draw();

    readWorkflowStateStrict("deep-interview")
      .then(state => {
        if (this.finished) return;
        this.mutationGuarded = !!(state && state.active && state.current_phase !== "complete");
        this.draw();
      })
      .catch(() => {
        if (this.finished) return;
        // Engine MutationGuard fails closed on corrupt state; mirror that in the UI
        // instead of showing an unlocked footer while edits are actually blocked.
        this.mutationGuarded = true;
        this.draw();
      });
    // Watch terminal resizes: rows/cols changes invalidate the previous frame, so
    // force a full repaint instead of diffing against stale line positions.
    if (this.tty) {
      process.stdout.on("resize", this.onResize);
    }
    // Animate the spinner + elapsed clock while the model is thinking.
    this.timer = setInterval(() => {
      try {
        this.tickCount++;
        // Self-healing resync: every ~3s drop the differential baseline so the next
        // draw rewrites EVERY line. Any screen corruption (stray child output, wheel
        // noise, terminal glitches) is repaired automatically without user action.
        if (this.tickCount % 25 === 0) this.renderer.reset();
        this.spinner.next();
        this.draw();
      } catch {
        // Ignore transient render races (resize/component state) so the agent turn keeps running.
      }
    }, 120);
  }

  /** Force a full repaint of the live frame (auto-invoked on resize/input noise). */
  repaint(): void {
    if (this.finished) return;
    this.renderer.reset();
    this.draw();
  }

  private readonly onResize = (): void => {
    try {
      this.repaint();
    } catch { /* resize race — next tick repaints */ }
  };

  /** Collapse the live region to static final output. */
  finish(reply: string): void {
    this.finished = true;
    this.hudPhase = "done";
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.tty) {
      process.stdout.removeListener("resize", this.onResize);
    }
    if (this.usedAltScreen) {
      // Leave the alt screen (restores the main buffer + scrollback), then print the
      // static summary below the prior output so the turn leaves exactly one record.
      this.renderer.reset();
      this.write(leaveAltScreen());
      this.write(showCursor());
    } else {
      this.renderer.clear();
      this.write(showCursor());
    }
    const timelineSteps = stepsFromTools(this.tools.snapshot());
    const totalElapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const finalLines: string[] = [];
    // jeo-ref final-report order: the ANSWER leads; the Todos checklist follows it
    // (done = checked + struck through), so the plan reads as a completion receipt.
    const planLines = this.renderPlan(this.theme.color);
    if (!this.inline) {
      // Inline scrollback already reads as a ✓/✗ checklist; the step timeline +
      // compact strip + flow line would just repeat it (gjc-style slim summary).
      if (timelineSteps.length) {
        finalLines.push(formatStepHeader(timelineSteps, { elapsedMs: totalElapsedMs, unicode: this.unicode, color: this.theme.color }));
      }
      for (const line of formatStepTimeline(timelineSteps, { unicode: this.unicode, color: this.theme.color, highlightActive: true, maxRows: 12 })) {
        finalLines.push(line);
      }
      if (timelineSteps.length > 1) {
        finalLines.push(`  ${formatStepTimelineCompact(timelineSteps, { unicode: this.unicode, color: this.theme.color })}`);
      }
    }
    if (!this.inline) {
      // Inline turns already flushed every ledger line into scrollback live; re-printing
      // the stream here would duplicate the whole history right below itself.
      for (const line of this.stream.render(size().cols)) finalLines.push(line);
    }
    if (!this.inline) {
      // Inline turns flushed every completed card into scrollback live; re-printing
      // the cards here would duplicate them right below themselves. A spacer row
      // keeps the card block from gluing to the stream above (jeo-ref rhythm).
      const forge = this.renderForge(size().cols, 3);
      if (forge.length && finalLines.length) finalLines.push("");
      finalLines.push(...forge);
    }
    if (!this.inline && timelineSteps.length > 0) {
      const arrow = this.unicode ? " → " : " -> ";
      const flow = ["thinking", "planning", "executing", "done"].join(arrow);
      const stepsCount = this.footer.step || 0;
      const durationStr = formatDuration(Date.now() - this.startedAt);
      const usageStr = this.turnUsage ? ` · ${formatUsage(this.turnUsage)}` : "";
      const doneBadge = categoryBadge("done", { color: this.theme.color });
      finalLines.push(`${doneBadge} ${flow} · ${stepsCount} steps · ${durationStr}${usageStr}`);
    }
    // jeo-ref final-report rendering: GFM tables become box-drawn tables, then
    // headings/bold/inline-code are styled (theme accent) instead of stripped.
    // color:false keeps the plain stripMarkdown text for pipes/tests.
    const tabled = renderMarkdownTables(reply, { unicode: this.unicode });
    const renderedReply = this.theme.color
      ? renderMarkdownAnsi(tabled, { accent: s => chalk.bold(accentPaint(this.theme)(s)) })
      : stripMarkdown(tabled);
    const steps = this.footer.step || 0;
    const peak = this.progress.current();
    const usageSuffix = this.turnUsage ? ` · ${formatUsage(this.turnUsage)}` : "";
    if (this.inline) {
      // jeo-ref clean ending: the ANSWER leads, then the Todos completion receipt,
      // then exactly ONE compact dim status line (steps · time · usage · evolution
      // track). The live ledger above already recorded every step. A blank spacer
      // row separates the ledger from the answer (jeo-ref vertical rhythm).
      finalLines.push("");
      finalLines.push(`jeo> ${renderedReply}`);
      if (planLines.length) {
        finalLines.push("");
        finalLines.push(...planLines);
      }
      const statusLine = `${categoryBadge("done", { color: this.theme.color })} ${steps} steps · ${formatDuration(Date.now() - this.startedAt)}${usageSuffix} · ${evolutionTrack(peak, { unicode: this.unicode, color: this.theme.color })}`;
      finalLines.push(this.theme.color ? chalk.dim(statusLine) : statusLine);
    } else {
      finalLines.push(`Evolved to: ${evolutionTrack(peak, { unicode: this.unicode, color: this.theme.color })} (took ${steps} steps in ${formatDuration(Date.now() - this.startedAt)}${usageSuffix})`);
      finalLines.push(`jeo> ${renderedReply}`);
      if (planLines.length) {
        finalLines.push(...planLines);
      }
    }
    if (this.tty) {
      // Width-wrap every summary line to the terminal FIRST. A line wider than the
      // terminal hard-wraps into 2+ physical rows, corrupting the result screen and
      // throwing off the trailing `\x1b[0J` cursor math (the reported "화면깨짐").
      // Split embedded newlines (multi-line replies / the budget consolidation
      // wrap-up), then wrap each physical line to the column count.
      const wrapCols = Math.max(20, size().cols);
      const physicalLines = finalLines.flatMap(l =>
        l.split("\n").flatMap(sub => (visibleWidth(sub) <= wrapCols ? [sub] : wrapTextWithAnsi(sub, wrapCols))),
      );
      // Main-buffer hygiene after leaving the alt screen: the cursor lands on rows
      // that still hold pre-turn content (old footer box, project-context lines).
      // Without clear-to-EOL every summary line visually MERGES with that stale
      // text, and the leftover footer reservation below renders as a torn, dead-
      // looking input box. Clear each line's tail, then everything below.
      this.write("\r\x1b[K");
      this.write(physicalLines.map(l => `${l}\x1b[K`).join("\n") + "\n");
      this.write("\x1b[0J");
    } else {
      console.log(finalLines.join("\n"));
    }
  }

  private rememberForge(summary: ForgeSummary): void {
    this.forgeSummaries.push(summary);
    if (this.forgeSummaries.length > 8) this.forgeSummaries.shift();
  }

  /** Flush a completed forge card into scrollback (inline mode) and retire it from the
   *  live array so the in-frame card region and the final summary never repeat it.
   *  Non-inline modes keep the card in `forgeSummaries` for the final static summary. */
  private flushForgeCard(summary: ForgeSummary, success?: boolean): void {
    if (!this.inline || this.finished) return;
    const width = Math.max(24, Math.min(120, size().cols));
    // gjc D2 (state-encoded border): a FAILED card gets a red border so it pops
    // out of scrollback at a glance; OK/neutral cards keep the theme accent
    // identity. The ✓/✗ title mark already encodes state, but the border tone
    // is what the eye catches first when scanning back through history.
    const errored = success === false && this.theme.color;
    const paint = errored ? (s: string) => chalk.red(s) : accentPaint(this.theme);
    const paintShadow = errored ? (s: string) => chalk.dim(chalk.red(s)) : accentShadowPaint(this.theme);
    const lines = formatForgeBox(summary, {
      width,
      maxLines: 12,
      unicode: this.unicode,
      paint,
      paintShadow,
      diffPaint: diffPaint(this.theme),
      fill: cardFillPaint(this.theme),
      color: this.theme.color,
    });
    this.appendLedger(lines.join("\n") + "\n", "card");
    const i = this.forgeSummaries.indexOf(summary);
    if (i >= 0) this.forgeSummaries.splice(i, 1);
  }

  private renderForge(
    width: number,
    maxEntries: number,
    anim?: { phase: number; colorLevel: ColorLevel; beat: string },
    dim = false,
  ): string[] {
    const floor = Math.min(24, width);
    // Fill the available width (cap at formatForgeBox's own 120 ceiling) so an
    // in-frame box does not leave a dead right-margin column inside the outer panel.
    const boxWidth = Math.max(floor, Math.min(120, width));
    const paint = this.theme.color ? accentPaint(this.theme) : (s: string) => s;
    const lines: string[] = [];
    for (const [i, summary] of this.forgeSummaries.slice(-maxEntries).entries()) {
      if (lines.length > 0) lines.push("");
      lines.push(...formatForgeBox(summary, {
        width: boxWidth,
        maxLines: 8,
        unicode: this.unicode,
        paint,
        paintShadow: accentShadowPaint(this.theme),
        diffPaint: diffPaint(this.theme),
        fill: cardFillPaint(this.theme),
        index: i + 1,
        color: this.theme.color,
        dim,
        // DNA-flow identity on LIVE cards only: the flowing helix gradient rides
        // the card border and the claw beat marks the title. Flushed/final cards
        // stay static. Suppressed while `dim` (in-flight shading takes precedence).
        ...(anim && !dim
          ? { flow: { palette: DNA_FLOW_PALETTE, phase: anim.phase, colorLevel: anim.colorLevel }, titleMark: anim.beat }
          : {}),
      }));
    }
    return lines;
  }


  /** Render the Ctrl+O panel inside the live frame. `maxRows` includes borders. */
  private renderHistoryPanel(width: number, maxRows: number): string[] {
    if (!this.historyLines || maxRows < 4) return [];
    const boxWidth = Math.max(24, Math.min(120, width));
    const inner = Math.max(10, boxWidth - 2);
    const accent = this.theme.color ? accentPaint(this.theme) : (s: string) => s;
    const dim = this.theme.color ? chalk.dim : (s: string) => s;
    const title = `${accent("history")} ${dim("· Ctrl+O closes")}`;
    const wrapped = this.historyLines.flatMap(line => {
      const physical = line.split("\n");
      return physical.flatMap(part => (visibleWidth(part) <= inner ? [part] : wrapTextWithAnsi(part, inner)));
    });
    const header = [title, "DIVIDER"];
    const bodyLimit = Math.max(0, maxRows - 2 - header.length);
    let body = wrapped;
    if (wrapped.length > bodyLimit) {
      const keep = Math.max(0, bodyLimit - 1);
      body = wrapped.slice(0, keep);
      body.push(dim(`… ${wrapped.length - keep} more line(s)`));
    } else {
      body = wrapped.slice(0, bodyLimit);
    }
    return boxBlock([...header, ...body], boxWidth, {
      glyphs: this.unicode ? BOX_UNICODE : BOX_ASCII,
      paint: this.theme.color ? accentPaint(this.theme) : (s: string) => s,
      paintShadow: this.theme.color ? accentShadowPaint(this.theme) : (s: string) => s,
      align: "left",
    });
  }
  /**
   * The gjc-style inline live frame: a flat stack with no outer border —
   *   <live forge card(s)> · <spinner status line> · <todos> · <hud line> · <model bar>
   * Completed cards and ✓ ledger lines were already flushed into scrollback above.
   */
  private composeInlineFrame(args: {
    cols: number;
    rows: number;
    stepNow: number;
    elapsedMs: number;
    idx: number;
    isThinking: boolean;
    planLines: string[];
  }): string[] {
    const { cols, rows, stepNow, elapsedMs, idx, isThinking } = args;
    const dim = this.theme.color ? chalk.dim : (s: string) => s;
    const colorLevel = detectColorLevel(process.env, isTTY());
    // One quantized animation clock for the whole frame: gradient phase cycles 20
    // steps, the claw beat advances every 3 ticks. Quantization keeps repaints
    // coherent (status field + forge border move together) and bounds per-tick work.
    const phase = (this.tickCount * 0.05) % 1;
    const beat = dnaClawBeat(Math.trunc(this.tickCount / 3), this.unicode);

    // Assemble the bottom-pinned tail FIRST (status line → todos → hud → model bar):
    // it is the live heartbeat and must always be visible; the in-flight card gets
    // whatever rows remain above it.
    const tail: string[] = [];
    // Live reasoning (gjc-style muted thinking): stream the model's forming thought
    // as a DIMMED, bounded block above the status line. It is transient — flushed
    // UN-dimmed into scrollback once the model commits to a tool/reply (onAssistant),
    // so the in-progress trace stays shaded while the final record reads in normal text.
    const liveThink = this.streamingThought.trim() || this.streamingReasoning.trim();
    if (isThinking && liveThink) {
      const wrapW = Math.max(8, Math.min(120, cols) - 2);
      const wrapped = liveThink
        .split("\n")
        .flatMap(l => wrapTextWithAnsi(l, wrapW))
        .filter(l => l.length > 0);
      // FIXED reserved height (bottom-anchored, blank-padded at top): once present the
      // block's row count is CONSTANT, so streaming content never changes the frame
      // height. The per-100ms height thrash that desynced the differential renderer
      // (duplicate model bar) is gone; height now toggles only at lifecycle boundaries.
      const ROWS = 6;
      const shown = wrapped.slice(-ROWS);
      tail.push(dim(`${this.unicode ? "│" : "|"} thinking`));
      for (let k = 0; k < ROWS - shown.length; k++) tail.push("");
      for (const l of shown) tail.push(dim(`  ${l}`));
      tail.push("");
    }

    // Live tool output (gjc-style streaming bash stdout): while a tool runs, its
    // output arrives via onToolProgress and is shown as a DIMMED, bounded tail block.
    // It is transient — cleared on result, when the formatted forge card takes over.
    if (this.runningTool && this.liveToolOutput.trim()) {
      const wrapW = Math.max(8, Math.min(120, cols) - 2);
      const wrapped = this.liveToolOutput
        .split("\n")
        .flatMap(l => wrapTextWithAnsi(l, wrapW))
        .filter(l => l.length > 0);
      // FIXED reserved height (see thinking block): constant rows while a tool streams,
      // so cumulative stdout growth does not thrash the frame height.
      const ROWS = 8;
      const shown = wrapped.slice(-ROWS);
      tail.push(dim(`${this.unicode ? "│" : "|"} output`));
      for (let k = 0; k < ROWS - shown.length; k++) tail.push("");
      for (const l of shown) tail.push(dim(`  ${l}`));
      tail.push("");
    }

    // Live status field: unboxed thinking line + compact metrics row. The model's
    // streamed activity is uniform across providers via streamingActivity and keeps
    // the ⟦esc⟧ cancel hint visible without trapping the message inside a border.
    if (isThinking) {
      const grad = themeGradient(this.theme, idx);
      const costUsd = costForUsage(this.footer.model, this.turnUsage) ?? undefined;
      const stats = this.tools.stats();
      tail.push(...renderStatusBox({
        cols: Math.max(24, Math.min(120, cols)),
        phaseLabel: this.workflowStatus ? `${this.workflowStatus.skill}:${this.workflowStatus.phase}` : this.hudPhase,
        spinner: this.spinner.current(),
        activity: this.retryNotice ?? (this.streamingActivity || this.currentActivity()),
        escHint: true,
        elapsedMs,
        stepElapsedMs: this.currentStepStartedAt ? Date.now() - this.currentStepStartedAt : undefined,
        avgStepMs: stepNow > 0 ? elapsedMs / stepNow : undefined,
        okCount: stats.ok,
        failCount: stats.fail,
        runningCount: stats.running,
        totalCount: stats.total,
        mutationGuarded: this.mutationGuarded,
        unicode: this.unicode,
        color: this.theme.color,
        colorLevel,
        phase,
        palette: [grad.from, grad.to],
        isThinking: true,
        usage: this.turnUsage,
        costUsd,
        subagentActive: this.subagentActive,
      }));
    }


    // Agent task plan (the `todo` tool) as a Todos checklist.
    if (args.planLines.length) {
      tail.push("");
      tail.push(...args.planLines);
    }

    // hud line + model status bar pinned at the bottom of the live frame (gjc layout).
    const diamond = this.unicode ? "◆" : "*";
    const hudTail = this.workflowStatus
      ? `${this.workflowStatus.skill}:${this.workflowStatus.phase}`
      : renderHud(this.hudPhase, { unicode: this.unicode, color: this.theme.color });
    tail.push("");
    tail.push(`${diamond} ${dim("hud")} ${hudTail}`);
    tail.push(...this.renderLiveInputBox(cols));
    tail.push(this.renderModelBar(cols, elapsedMs));

    // Bottom-anchor: on a too-short terminal drop tail rows from the TOP so the
    // status/todos/hud/model-bar end stays visible; spend leftover rows on the
    // in-flight tool card (whole boxes only — never half a card).
    const tailKeep = tail.length > rows ? tail.slice(tail.length - rows) : tail;
    const budget = Math.max(0, rows - tailKeep.length - 1);
    const frame: string[] = [];
    const historyK = this.historyLines ? this.renderHistoryPanel(cols, budget) : [];
    if (historyK.length) {
      frame.push(...historyK);
      if (frame.length + tailKeep.length < rows) frame.push("");
    } else {
      const forgeAnim = isThinking && this.theme.color && colorLevel >= ColorLevel.TrueColor
        ? { phase, colorLevel, beat }
        : undefined;
      const forgeK = budget > 0 ? fitForgeBoxes(this.renderForge(cols, 2, forgeAnim, true), budget) : [];
      if (forgeK.length) {
        frame.push(...forgeK);
        frame.push("");
      }
    }
    frame.push(...tailKeep);
    return frame;
  }

  /** The gjc-style one-row model status bar: ⬢ model (provider) · ◔ thinking / ⑂ branch / ▸ cwd. */
  private renderModelBar(cols: number, elapsedMs: number): string {
    const usage = this.turnUsage;
    const rate = usage && elapsedMs >= 1000 && usage.outputTokens > 0 ? usage.outputTokens / (elapsedMs / 1000) : undefined;
    const ctxPct =
      this.footer.contextUsedTokens !== undefined && this.footer.contextMaxTokens && this.footer.contextMaxTokens > 0
        ? Math.round((this.footer.contextUsedTokens / this.footer.contextMaxTokens) * 100)
        : undefined;
    return renderStatusBar({
      model: `${this.footer.model}${this.footer.provider ? ` (${this.footer.provider})` : ""}`,
      thinking: this.thinkingLevel,
      branch: this.footer.branch,
      dirtyCount: this.footer.dirtyCount,
      cwd: this.footer.cwd,
      rate,
      ctxPct,
      ctxMaxTokens: this.footer.contextMaxTokens,
      cols,
      unicode: this.unicode,
      color: this.theme.color,
      colorLevel: detectColorLevel(process.env, isTTY()),
      gradient: themeGradient(this.theme, 2),
    });
  }

  private draw(): void {
    if (this.finished) return; // never repaint a live frame after the final static output
    const { cols, rows } = size();
    const fit = this.tty; // boxed full-screen layout only on a TTY (defaults to isTTY())
    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const innerWidth = fit && !this.inline ? cols - 4 : cols;

    // Resolve the current (monotonic) stage for the track; announce a transition
    // once when it first advances. The header art is the DNA Claw brand symbol —
    // a twist-frame helix rotation combined with the flowing gradient phase.
    // Both are quantized (3 twist frames × 20 gradient phases), so the cache
    // recomputes at most once per changed tick and stays a single slot (O(1)).
    const stepNow = this.footer.step || 0;
    const idx = this.progress.observe(stepNow, this.footer.maxSteps ?? DEFAULT_MAX_STEPS);
    const isThinking = this.timer !== undefined;
    if (fit && !this.inline && this.progress.advanced() && idx > 0) {
      const arrow = this.unicode ? "\u27f6" : "->";
      this.appendLedger(`${arrow} ${transitionMessage(idx)}\n`, "notice");
    }
    const showArt = fit && !this.inline && rows >= 18 && cols >= 40;
    // One int key folds both animation axes: twist frame advances every 3 ticks,
    // gradient phase cycles 20 quantized steps (tickCount*0.05 % 1).
    const twist = isThinking ? Math.trunc(this.tickCount / 3) % dnaClawFrameCount() : 0;
    const qPhase = isThinking ? this.tickCount % 20 : 0;
    const effFrame = twist * 100 + qPhase;
    if (showArt && (idx !== this.cachedStageIndex || cols !== this.cachedCols || effFrame !== this.cachedFrame)) {
      // Commit the cache keys only AFTER the render succeeds: if renderDnaClaw ever
      // throws (resize race, bad gradient level), pre-committed keys would mark the
      // STALE art as current and freeze the header at an old frame forever.
      const art = renderDnaClaw({
        cols: innerWidth,
        phase: qPhase * 0.05,
        frame: twist,
        unicode: this.unicode,
        color: this.theme.color,
        colorLevel: detectColorLevel(process.env, isTTY()),
      });
      this.cachedArt = fit ? centerBlock(art, innerWidth) : art;
      const track = evolutionTrack(idx, { unicode: this.unicode, color: this.theme.color });
      this.cachedTrack = fit ? padLineTo(track, innerWidth, "center") : track;
      this.cachedStageIndex = idx;
      this.cachedCols = cols;
      this.cachedFrame = effFrame;
    }
    const artLinesCount = showArt ? dnaClawHeight() : 0;
    const trackCount = showArt ? 1 : 0;
    const headerHeight = artLinesCount + trackCount + (showArt ? 1 : 0);

    const toolLines = this.tools.render(fit ? Math.max(3, rows - 15) : undefined, { color: this.theme.color, indexed: fit });
    const toolListHeight = toolLines.length;

    const planLines = this.renderPlan(this.theme.color);
    const planHeight = planLines.length;

    // gjc-style inline frame: a flat stack (live card → status line → todos → hud →
    // model bar), no outer border, no mascot art — completed work lives in scrollback.
    if (fit && this.inline) {
      const inlineFrame = this.composeInlineFrame({ cols, rows, stepNow, elapsedMs, idx, isThinking, planLines });
      // Screen-safety: every rendered line is width-clamped to `cols` so a long line
      // (e.g. the model bar with a deep cwd) cannot soft-wrap into a second physical row
      // and desync the differential renderer's 1-line=1-row accounting. Frame height stays
      // content-sized so completed cards remain visible in scrollback above the live frame.
      this.renderer.render(inlineFrame.slice(0, rows).map(l => truncateToWidth(l, cols)));
      return;
    }

    // Bottom-pinned status + footer.
    const bottom: string[] = [];
    const statusMsg = this.currentActivity();
    // Live USD cost from turn usage × the model's price (undefined when the model has no
    // known price — then no $ is shown). Computed once per draw, fed to status + footer.
    const costUsd = costForUsage(this.footer.model, this.turnUsage) ?? undefined;
    if (isThinking) {
      const colorLevel = detectColorLevel(process.env, isTTY());
      const phase = (this.tickCount * 0.05) % 1;
      const grad = themeGradient(this.theme, idx);
      const palette = [grad.from, grad.to];

      if (fit) {
        bottom.push("");
        if (this.turnTitle) {
          const arrow = this.unicode ? "▸" : ">";
          const titleLine = `  ${arrow} ${this.turnTitle}`;
          bottom.push(this.theme.color ? chalk.dim(titleLine) : titleLine);
        }
        // Live status field: unboxed thinking line + compact metrics row. The
        // streamed activity is uniform across providers, with the ⟦esc⟧ cancel hint
        // right-aligned and no misleading step counter.
        const stats = this.tools.stats();
        for (const line of renderStatusBox({
          cols: innerWidth,
          phaseLabel: this.workflowStatus ? `${this.workflowStatus.skill}:${this.workflowStatus.phase}` : this.hudPhase,
          spinner: this.spinner.current(),
          activity: this.retryNotice ?? (this.streamingActivity || statusMsg),
          escHint: true,
          elapsedMs,
          stepElapsedMs: this.currentStepStartedAt ? Date.now() - this.currentStepStartedAt : undefined,
          avgStepMs: stepNow > 0 ? elapsedMs / stepNow : undefined,
          okCount: stats.ok,
          failCount: stats.fail,
          runningCount: stats.running,
          totalCount: stats.total,
          mutationGuarded: this.mutationGuarded,
          unicode: this.unicode,
          color: this.theme.color,
          colorLevel,
          phase,
          palette,
          isThinking: true,
          usage: this.turnUsage,
          costUsd,
          subagentActive: this.subagentActive,
        })) bottom.push(line);
      } else {
        // Compact fallback still keeps progress and insight separate: no decorative
        // mixed "thinking/status" line, and retry notices never become stream logs.
        let msg = statusMsg;
        if (this.theme.color && colorLevel === ColorLevel.TrueColor) {
          msg = animatedGradientText(msg, palette, phase, { colorLevel });
        }
        const redBold = this.theme.color ? chalk.red.bold : (s: string) => s;
        const guardBadge = this.mutationGuarded ? ` ${redBold("[MUTATION LOCKED]")}` : "";
        bottom.push(`  ${categoryBadge("progress", { color: this.theme.color })} elapsed ${formatDuration(elapsedMs)}`);
        bottom.push(`  ${categoryBadge("status", { color: this.theme.color })} ${msg}${guardBadge}`);
      }
    }
    // TTY only: keep the same query input box visible above the footer while the
    // turn is running; typed text edits the next-prompt draft, not a side queue.
    if (fit) {
      bottom.push(formatHintBar(undefined, { unicode: this.unicode, color: this.theme.color, cols: innerWidth }));
      bottom.push(...this.renderLiveInputBox(innerWidth));
    }
    // Live animated step strip appended to the footer when the turn has steps.
    const liveSteps = stepsFromTools(this.tools.snapshot());
    const strip = liveSteps.length
      ? `  ${formatStepTimelineCompact(liveSteps, { unicode: this.unicode, color: this.theme.color, frame: this.tickCount, cap: 16 })}`
      : "";
    bottom.push(`${this.spinner.current()} ${renderFooter({ ...this.footer, elapsedMs, costUsd, color: this.theme.color })}${strip}`);
    const bottomHeight = bottom.length;

    const forgeLines = fit ? this.renderForge(innerWidth, 2) : [];
    const forgeHeight = forgeLines.length;

    const overhead = fit ? 4 : 0; // 2 borders + 2 dividers
    const fixedHeight = headerHeight + planHeight + toolListHeight + forgeHeight + bottomHeight + overhead;
    const maxStreamLines = fit ? Math.max(0, rows - fixedHeight) : undefined;
    // Inline mode: ledger lines were already flushed into scrollback (appendLedger →
    // insertAbove); rendering the StreamRegion tail inside the frame too would show
    // every recent line TWICE the moment the user wheel-scrolls back. Tool list +
    // forge boxes keep live activity visible in-frame; the stream feeds only the
    // non-TTY / alt-screen frames and their final summaries.
    const streamLines = this.inline ? [] : this.stream.render(innerWidth, maxStreamLines);

    let frame: string[] = [];

    if (fit) {
      // Boxed TUI matching terminal width & height exactly
      // Reserve the bottom status/hint/footer FIRST — it is the live heartbeat (spinner,
      // step, ETA, mutation guard, key hints) and must NEVER be trimmed. Then fit the inner
      // sections into the remaining rows by priority, shedding the lowest-value content first
      // when the terminal is short: plan + tool list (work state) > stream > forge detail >
      // ASCII art (decorative). Previously the assembly could overflow `rows` and the final
      // slice(0, rows) silently cut the footer off the bottom.
      const avail = Math.max(0, rows - 2); // content rows inside the top + bottom borders
      const bottomKeep = bottom.slice(0, avail);
      let budget = avail - bottomKeep.length;
      const take = (lines: string[]): string[] => {
        const kept = budget > 0 ? lines.slice(0, budget) : [];
        budget -= kept.length;
        return kept;
      };
      // Keep-priority order (highest first); display order is reassembled below.
      const planK = take(planLines);
      const toolsK = take(toolLines);
      const streamK = take(streamLines);
      // Forge boxes are bordered — include as many WHOLE (most-recent) boxes as fit; never a half-box.
      const forgeK = fitForgeBoxes(forgeLines, budget);
      budget -= forgeK.length;
      let headerK: string[] = [];
      if (showArt && budget >= headerHeight) {
        headerK = [...this.cachedArt, this.cachedTrack, "DIVIDER"];
        budget -= headerHeight;
      }

      // Stage-grouped activity cards (shadcn-style rhythm + muted card headers): the
      // plan and forge boxes already self-label, so only the tool block ("Activity")
      // and the forge group ("Output") get a muted divider. Adjacent non-empty
      // sections are separated by SECTION_GAP blank lines so the live stages read as
      // distinct cards instead of one cramped wall.
      const activity = stackSections(
        [
          { lines: planK },
          { title: "Activity", lines: toolsK },
          { lines: streamK },
          { title: "Output", lines: forgeK },
        ],
        { width: innerWidth, gap: SECTION_GAP, color: this.theme.color, unicode: this.unicode },
      );
      // The labels + gaps add structural rows; spend them from the leftover budget
      // (what would otherwise be dead filler) and trim the group if the terminal is
      // too short so the assembled height never exceeds `avail`.
      const rawLen = planK.length + toolsK.length + streamK.length + forgeK.length;
      const overhead = Math.max(0, activity.length - rawLen);
      let activityGroup = activity;
      if (overhead > budget) {
        activityGroup = activity.slice(0, rawLen + budget);
        budget = 0;
      } else {
        budget -= overhead;
      }
      let trailingDivider: string[] = [];
      if (activityGroup.length && budget > 0) {
        trailingDivider = ["DIVIDER"];
        budget--;
      }
      const fillerCount = Math.max(0, budget);

      // Display order (shadcn header / spacer / content+footer): the decorative art
      // banner sits at the top, breathing room follows, then the live activity cards
      // hug the bottom status panel — no dead gap between the work area and the HUD.
      const boxedContent: string[] = [];
      for (const line of headerK) boxedContent.push(line);
      for (let i = 0; i < fillerCount; i++) boxedContent.push("");
      for (const line of activityGroup) boxedContent.push(line);
      for (const line of trailingDivider) boxedContent.push(line);
      for (const line of bottomKeep) boxedContent.push(line);

      const paint = this.theme.color ? accentPaint(this.theme) : (s: string) => s;
      frame = boxBlock(boxedContent, cols, {
        glyphs: this.unicode ? BOX_UNICODE : BOX_ASCII,
        paint,
      });

    } else {
      // Unboxed Mode (fallback for tests/non-TTY)
      const header = showArt ? [...this.cachedArt, this.cachedTrack, ""] : [];
      const body = [...planLines, ...toolLines, ...streamLines, ...forgeLines];
      frame = [...header, ...body, ...bottom];
    }

    if (fit) {
      frame = frame.slice(0, rows);
    }
    this.renderer.render(frame.map(l => truncateToWidth(l, cols)));
  }
}
