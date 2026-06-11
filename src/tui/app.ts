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
import { getStageByIndex, renderAsciiArt, stageHeight, stageWidth, stageBlocks } from "./components/ascii-art";
import { evolutionTrack, createStageProgress, type StageProgress, transitionMessage } from "./components/evolution";
import type { TaskSubEvent } from "../agent/task-tool";
import { supportsUnicode } from "./components/capability";
import { centerBlock, padLineTo, boxBlock, BOX_ASCII, BOX_UNICODE } from "./components/layout";
import { SECTION_GAP, stackSections } from "./components/section";
import { resolveTheme, themeGradient, accentPaint } from "./components/themes";
import { detectColorLevel, animatedGradientText, ColorLevel } from "./components/color";
import { formatForgeBox, summarizeForgeInvocation, summarizeForgeResult, fitForgeBoxes, type ForgeSummary } from "./components/forge";
import { renderJocStatus, renderStatusBar, renderStatusBox } from "./components/status";
import { costForUsage, formatCost } from "../ai/pricing";
import { renderMarkdownTables } from "./components/markdown-table";
import { visibleWidth, wrapTextWithAnsi } from "./components/width";
import { categoryBadge } from "./components/category-index";
import { formatStepTimeline, stepsFromTools, formatStepHeader, formatStepTimelineCompact, type StepState } from "./components/step-timeline";
import { formatHintBar } from "./components/hints";
import { formatDuration, formatUsage } from "./components/duration";
import { renderHud, derivePhase, type JocPhase } from "./components/hud";
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
  onNotice?(message: string): void;
  onUsage?(usage: { inputTokens: number; outputTokens: number }): void;
  onModelStream?(textSoFar: string): void;
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
 *  prose-replying models, show the reply head — so the status box behaves identically
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
// test flipping JOC_TUI_ALT_SCREEN) is restored correctly.
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
  private hudPhase: JocPhase = "thinking";
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
  // Auto-derived turn title (no LLM call): seeded from the first user message, refined
  // once to the first tool's verb+target. Shown in the HUD and synced to the tmux pane
  // title under --tmux so multiple sessions are distinguishable at a glance (gjc parity).
  private turnTitle: string | null = null;
  private turnTitleRefined = false;
  // Live "reasoning" text streamed from the model's response this step (the optional
  // `"reasoning"` field of the forming tool-call JSON). Shown dim under the HUD while
  // the model responds, then flushed once into scrollback as a `jeo · …` ledger line.
  private streamingReasoning = "";
  /** Uniform live-activity text for the status box (reasoning OR derived fallback). */
  private streamingActivity = "";
  /** Last stream-driven draw (ms epoch) — throttles per-delta repaints to ≤10/s. */
  private lastStreamDraw = 0;
  private flushedReasoning = "";
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
  // Active color theme (JOC_TUI_THEME), default cosmic; `mono` disables color.
  private readonly theme = resolveTheme(process.env);
  // Whether the live turn may use the alternate screen buffer (real TTY only).
  private readonly tty: boolean;
  // gjc-style inline rendering (default on a TTY): the live frame repaints in place in
  // the MAIN buffer and every completed ledger line is flushed into normal scrollback
  // first, so tmux / terminal mouse-wheel can scroll back through earlier progress
  // mid-turn. JOC_TUI_ALT_SCREEN=1 opts back into the legacy alternate-screen turn
  // (scroll-isolated, but no mid-turn scrollback).
  private readonly inline: boolean;
  // Thinking-level label for the gjc-style model status bar.
  private readonly thinkingLevel?: string;

  constructor(opts: LaunchTuiOptions) {
    this.write = opts.write ?? ((s: string) => process.stdout.write(s));
    this.tty = opts.tty ?? isTTY();
    this.inline = this.tty && process.env.JOC_TUI_ALT_SCREEN !== "1";
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
      showEta: true,
      showProgress: true,
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

  /** Write an OSC window/pane title (`ESC]2;joc: <title>BEL`). tmux maps this to the
   *  pane title, so multiple --tmux sessions are distinguishable at a glance. TTY only. */
  private emitPaneTitle(): void {
    if (!this.tty || !this.turnTitle) return;
    try { this.write(`\x1b]2;joc: ${this.turnTitle}\x07`); } catch { /* terminal gone */ }
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
        this.streamingActivity = "";
        this.flushedReasoning = "";
        this.currentStepStartedAt = Date.now();
        this.spinner.updateStep(step, this.footer.maxSteps);
        this.spinner.next();
        this.draw();
      },
      onModelStream: textSoFar => {
        // Surface the model's LIVE activity uniformly for every model/provider:
        // the streamed `reasoning` field when the model emits one, else a derived
        // fallback (tool being formed / reply prose head) — so no model leaves the
        // status box silent while it streams.
        // Draws are THROTTLED to one per 100ms: the old per-delta draw() rendered
        // the full frame hundreds of times per response (a real chunk of joc's
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
      onAssistant: (_raw, invocation) => {
        this.thinking = false; // model replied; now dispatching the tool
        this.retryNotice = null; // the call got through — clear any backoff notice
        // Flush the streamed reasoning once into scrollback as a `jeo · …` ledger line
        // (the durable record), then stop showing the transient live reasoning row.
        if (this.streamingReasoning && this.streamingReasoning !== this.flushedReasoning) {
          this.flushedReasoning = this.streamingReasoning;
          const dim = this.theme.color ? chalk.dim : (s: string) => s;
          this.appendLedger(dim(`jeo · ${this.streamingReasoning}`) + "\n");
        }
        this.streamingReasoning = "";
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
      onToolResult: (tool, success, output) => {
        this.runningTool = false;
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
          this.flushForgeCard(card);
        } else if (card) {
          card.title = `${paintedMark} ${card.title}`;
          if (!success) this.rememberForge(result);
          this.flushForgeCard(card);
          if (!success) this.flushForgeCard(result);
        } else {
          // Light tool: one ✓/✗ line, plus a dim result tree for list-shaped output
          // (find/search/ls) and an error card when the tool failed.
          const { suffix, children } = this.ledgerTree(tool, success, output);
          this.appendLedger(`${paintedMark} ${target}${suffix}\n${children.map(c => `${c}\n`).join("")}`);
          if (!success) {
            this.rememberForge(result);
            this.flushForgeCard(result);
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
        this.appendLedger(dim(`${mark} ${reason}`) + "\n");
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

  /** Append a completed progress-ledger line. In inline mode the line is flushed
   *  straight into normal scrollback ABOVE the live frame, so tmux / terminal
   *  mouse-wheel can review the full progress history mid-turn (gjc-style); the
   *  StreamRegion copy still feeds the in-frame tail and the non-TTY / alt-screen
   *  final summary.
   *  CRITICAL: every flushed line is width-wrapped to the terminal columns first.
   *  A line longer than the terminal hard-wraps into 2+ PHYSICAL rows, which breaks
   *  the renderer's 1-line=1-row reservation math — the live frame then repaints at
   *  the wrong rows (the "screen tearing + garbled scrollback" corruption). */
  private appendLedger(text: string): void {
    this.stream.append(text);
    if (this.inline && !this.finished) {
      const cols = Math.max(20, size().cols);
      const body = text.endsWith("\n") ? text.slice(0, -1) : text;
      const wrapped = body
        .split("\n")
        .flatMap(line => (visibleWidth(line) <= cols ? [line] : wrapTextWithAnsi(line, cols)))
        .join("\n");
      this.renderer.insertAbove(`${wrapped}\n`);
    }
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
      this.appendLedger(`${diamond} workflow ${status.skill}: ${status.phase}${detail}\n`);
    }
    this.draw();
  }

  /**
   * Real, stable "what joc is doing right now" for the [STEP] line — the in-flight tool's
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
    const badge = categoryBadge("subagent", { color });
    const ok = this.unicode ? "✓" : "v";
    const bad = this.unicode ? "✗" : "x";
    const detail = (e.detail ?? "").split("\n").find(l => l.trim().length > 0)?.trim().slice(0, 140) ?? "";
    const summary = e.summary ? ` — ${e.summary}` : "";
    const step = e.step && e.maxSteps ? ` step ${e.step}/${e.maxSteps}` : "";
    switch (e.kind) {
      case "start":
        this.subagentActive = true;
        this.appendLedger(`${badge} ${role} ${this.unicode ? "▸" : ">"} start: ${detail}\n`);
        break;
      case "step":
        this.appendLedger(`  ${badge} ${role}${step}: ${detail || "working"}\n`);
        break;
      case "tool":
        this.appendLedger(`  ${badge} ${role} ${e.success === false ? bad : ok} ${detail || "tool"}${summary}\n`);
        break;
      case "error":
        this.appendLedger(`  ${badge} ${role} ${bad} ${detail || "error"}\n`);
        break;
      case "done":
        this.subagentActive = false;
        this.appendLedger(`${badge} ${role} ${this.unicode ? "◂" : "<"} done${e.success === false ? " (incomplete)" : ""}: ${detail}\n`);
        break;
    }
    this.draw();
  }

  start(): void {
    this.startedAt = Date.now();
    this.turnUsage = null;
    this.spinner.updateStep(0, this.footer.maxSteps);
    // On a real TTY the live turn renders gjc-style in the MAIN buffer by default:
    // completed ledger lines are flushed into normal scrollback as they happen, so a
    // tmux / terminal mouse-wheel scroll can review earlier progress mid-turn. The
    // differential renderer reserves frame rows with real newlines, keeping the
    // in-place repaint anchored even at the bottom of the viewport.
    // JOC_TUI_ALT_SCREEN=1 restores the legacy alternate-screen turn (scroll-isolated,
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
    for (const line of this.renderPlan(this.theme.color)) finalLines.push(line);
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
      // the cards here would duplicate them right below themselves.
      for (const line of this.renderForge(size().cols, 3)) finalLines.push(line);
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
    // Render any GFM markdown tables in the reply as box-drawn tables (B8). Plain
    // replies are returned unchanged by the cheap no-`|` guard.
    const renderedReply = renderMarkdownTables(reply, { unicode: this.unicode });
    const steps = this.footer.step || 0;
    const peak = this.progress.current();
    const usageSuffix = this.turnUsage ? ` · ${formatUsage(this.turnUsage)}` : "";
    if (this.inline) {
      // gjc-style clean ending: the ANSWER leads, followed by exactly ONE compact dim
      // status line (steps · time · usage · evolution track). The live ledger above
      // already recorded every step, so no timeline/flow repetition here.
      finalLines.push(`joc> ${renderedReply}`);
      const statusLine = `${categoryBadge("done", { color: this.theme.color })} ${steps} steps · ${formatDuration(Date.now() - this.startedAt)}${usageSuffix} · ${evolutionTrack(peak, { unicode: this.unicode, color: this.theme.color })}`;
      finalLines.push(this.theme.color ? chalk.dim(statusLine) : statusLine);
    } else {
      finalLines.push(`Evolved to: ${evolutionTrack(peak, { unicode: this.unicode, color: this.theme.color })} (took ${steps} steps in ${formatDuration(Date.now() - this.startedAt)}${usageSuffix})`);
      finalLines.push(`joc> ${renderedReply}`);
    }
    if (this.tty) {
      // Main-buffer hygiene after leaving the alt screen: the cursor lands on rows
      // that still hold pre-turn content (old footer box, project-context lines).
      // Without clear-to-EOL every summary line visually MERGES with that stale
      // text, and the leftover footer reservation below renders as a torn, dead-
      // looking input box. Clear each line's tail, then everything below.
      this.write("\r\x1b[K");
      this.write(finalLines.map(l => `${l}\x1b[K`).join("\n") + "\n");
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
  private flushForgeCard(summary: ForgeSummary): void {
    if (!this.inline || this.finished) return;
    const width = Math.max(24, Math.min(120, size().cols));
    const lines = formatForgeBox(summary, {
      width,
      maxLines: 12,
      unicode: this.unicode,
      paint: accentPaint(this.theme),
      color: this.theme.color,
    });
    this.appendLedger(lines.join("\n") + "\n");
    const i = this.forgeSummaries.indexOf(summary);
    if (i >= 0) this.forgeSummaries.splice(i, 1);
  }

  private renderForge(width: number, maxEntries: number): string[] {
    const floor = Math.min(24, width);
    // Fill the available width (cap at formatForgeBox's own 120 ceiling) so an
    // in-frame box does not leave a dead right-margin column inside the outer panel.
    const boxWidth = Math.max(floor, Math.min(120, width));
    const paint = this.theme.color ? accentPaint(this.theme) : (s: string) => s;
    const lines: string[] = [];
    for (const [i, summary] of this.forgeSummaries.slice(-maxEntries).entries()) {
      if (lines.length > 0) lines.push("");
      lines.push(...formatForgeBox(summary, { width: boxWidth, maxLines: 8, unicode: this.unicode, paint, index: i + 1, color: this.theme.color }));
    }
    return lines;
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

    // Assemble the bottom-pinned tail FIRST (status line → todos → hud → model bar):
    // it is the live heartbeat and must always be visible; the in-flight card gets
    // whatever rows remain above it.
    const tail: string[] = [];

    // gjc status box: the live thinking process renders in a bordered box —
    // phase + step n/m embedded in the title border, the model's streamed
    // activity (uniform across providers via streamingActivity) on the spinner
    // row with the ⟦esc⟧ cancel hint, and one compact metrics row.
    if (isThinking) {
      const colorLevel = detectColorLevel(process.env, isTTY());
      const grad = themeGradient(this.theme, idx);
      const costUsd = costForUsage(this.footer.model, this.turnUsage) ?? undefined;
      const stats = this.tools.stats();
      tail.push(...renderStatusBox({
        cols: Math.max(24, Math.min(120, cols)),
        phaseLabel: this.workflowStatus ? `${this.workflowStatus.skill}:${this.workflowStatus.phase}` : this.hudPhase,
        spinner: this.spinner.current(),
        activity: this.retryNotice ?? (this.streamingActivity || this.currentActivity()),
        escHint: true,
        step: stepNow,
        maxSteps: this.footer.maxSteps,
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
        phase: (this.tickCount * 0.05) % 1,
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
    tail.push(this.renderModelBar(cols, elapsedMs));

    // Bottom-anchor: on a too-short terminal drop tail rows from the TOP so the
    // status/todos/hud/model-bar end stays visible; spend leftover rows on the
    // in-flight tool card (whole boxes only — never half a card).
    const tailKeep = tail.length > rows ? tail.slice(tail.length - rows) : tail;
    const budget = Math.max(0, rows - tailKeep.length - 1);
    const forgeK = budget > 0 ? fitForgeBoxes(this.renderForge(cols, 2), budget) : [];
    const frame: string[] = [];
    if (forgeK.length) {
      frame.push(...forgeK);
      frame.push("");
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

    // Resolve the current (monotonic) stage; announce a transition once when it
    // first advances. The art + track are cached per stage index/cols so the
    // 120ms spinner tick does not re-render the block every frame.
    const stepNow = this.footer.step || 0;
    const idx = this.progress.observe(stepNow, this.footer.maxSteps ?? DEFAULT_MAX_STEPS);
    const isThinking = this.timer !== undefined;
    if (fit && !this.inline && this.progress.advanced() && idx > 0) {
      const arrow = this.unicode ? "\u27f6" : "->";
      this.appendLedger(`${arrow} ${transitionMessage(idx)}\n`);
    }
    const showArt = fit && !this.inline && rows >= 18 && cols >= 40;
    const effFrame = isThinking ? this.tickCount % stageBlocks(getStageByIndex(idx)).length : 0;
    if (showArt && (idx !== this.cachedStageIndex || cols !== this.cachedCols || effFrame !== this.cachedFrame)) {
      // Commit the cache keys only AFTER the render succeeds: if renderAsciiArt ever
      // throws (resize race, bad gradient level), pre-committed keys would mark the
      // STALE art as current and freeze the header at an old stage forever.
      const art = renderAsciiArt(getStageByIndex(idx), {
        height: stageHeight(),
        width: stageWidth(),
        cols: innerWidth,
        firing: isThinking,
        frame: isThinking ? this.tickCount : 0,
        color: this.theme.color,
        gradient: themeGradient(this.theme, idx),
        colorLevel: detectColorLevel(process.env, isTTY()),
      });
      this.cachedArt = fit ? centerBlock(art, innerWidth) : art;
      const track = evolutionTrack(idx, { unicode: this.unicode, color: this.theme.color });
      this.cachedTrack = fit ? padLineTo(track, innerWidth, "center") : track;
      this.cachedStageIndex = idx;
      this.cachedCols = cols;
      this.cachedFrame = effFrame;
    }
    const artLinesCount = showArt ? stageHeight() : 0;
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
      this.renderer.render(inlineFrame.slice(0, rows));
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
        // gjc status box: the live thinking process renders inside a bordered box —
        // phase + step n/m embedded in the title border, the streamed activity
        // (uniform for every model) on the spinner row with the ⟦esc⟧ cancel hint,
        // and one compact metrics row (meter/timing/usage/rate/cost/tool counts).
        const stats = this.tools.stats();
        for (const line of renderStatusBox({
          cols: innerWidth,
          phaseLabel: this.workflowStatus ? `${this.workflowStatus.skill}:${this.workflowStatus.phase}` : this.hudPhase,
          spinner: this.spinner.current(),
          activity: this.retryNotice ?? (this.streamingActivity || statusMsg),
          escHint: true,
          step: stepNow,
          maxSteps: this.footer.maxSteps,
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
        bottom.push(`  ${categoryBadge("progress", { color: this.theme.color })} step ${stepNow}/${this.footer.maxSteps} · elapsed ${formatDuration(elapsedMs)}`);
        bottom.push(`  ${categoryBadge("status", { color: this.theme.color })} ${msg}${guardBadge}`);
      }
    }
    // TTY only: a key-hint bar above the footer (kept out of non-TTY/test frames).
    if (fit) bottom.push(formatHintBar(undefined, { unicode: this.unicode, color: this.theme.color, cols: innerWidth }));
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
    this.renderer.render(frame);
  }
}
