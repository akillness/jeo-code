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
import { resolveTheme, themeGradient } from "./components/themes";
import { detectColorLevel, animatedGradientText, ColorLevel } from "./components/color";
import { formatForgeBox, summarizeForgeInvocation, summarizeForgeResult, fitForgeBoxes, type ForgeSummary } from "./components/forge";
import { renderJocStatus } from "./components/status";
import { costForUsage } from "../ai/pricing";
import { categoryBadge, categoryForTool } from "./components/category-index";
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
}

export interface AgentEventsLike {
  onStep?(step: number): void;
  onAssistant?(raw: string, invocation: { tool: string; arguments?: unknown } | null): void;
  onToolResult?(tool: string, success: boolean, output: string): void;
  onNotice?(message: string): void;
  onUsage?(usage: { inputTokens: number; outputTokens: number }): void;
}

const DEFAULT_MAX_STEPS = 25;
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

  constructor(opts: LaunchTuiOptions) {
    this.write = opts.write ?? ((s: string) => process.stdout.write(s));
    this.tty = opts.tty ?? isTTY();
    this.inline = this.tty && process.env.JOC_TUI_ALT_SCREEN !== "1";
    // Row reservation is only needed (and only safe) for the inline main-buffer frame;
    // the alt screen starts at the top with a full-height frame.
    this.renderer = new Renderer(this.write, undefined, { reserve: this.inline });
    this.spinner = new Spinner(undefined, { unicode: this.unicode });
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

  /** Render the task plan as a status-colored checklist; empty when no plan. */
  private renderPlan(color: boolean): string[] {
    if (this.todos.length === 0) return [];
    const steps = this.todos.map(t => ({
      label: t.title,
      state: (t.status === "done" ? "done" : t.status === "in_progress" ? "active" : "pending") as StepState,
    }));
    const header = formatStepHeader(steps, { unicode: this.unicode, color, label: "Plan" });
    return [header, ...formatStepTimeline(steps, { unicode: this.unicode, color, highlightActive: true, maxRows: 8 })];
  }
  /** The events object to hand to runAgentLoop. */
  events(): AgentEventsLike {
    return {
      onStep: step => {
        this.footer.step = step;
        this.thinking = true; // waiting on the model for this step
        this.hudPhase = "thinking";
        this.retryNotice = null; // a new step starts a fresh model call
        this.currentStepStartedAt = Date.now();
        this.spinner.updateStep(step, this.footer.maxSteps);
        this.spinner.next();
        this.draw();
      },
      onAssistant: (_raw, invocation) => {
        this.thinking = false; // model replied; now dispatching the tool
        this.retryNotice = null; // the call got through — clear any backoff notice
        if (invocation && invocation.tool !== "done") {
          this.runningTool = true;
          this.hudPhase = "executing";
          const toolName = invocation.tool || "(no tool)";
          this.pendingIndex = this.tools.start(toolName);
          const summary = summarizeForgeInvocation(toolName, invocation.arguments);
          this.pendingTitle = summary.title;
          this.rememberForge(summary);
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
        this.rememberForge(summarizeForgeResult(tool, success, output));
        // Categorize the result so the stream reads as a classified ledger:
        // [DONE] for success, [ERR] for failure — consistent with the forge/tool-list badges.
        const catBadge = categoryBadge(categoryForTool(tool), { color: this.theme.color });
        const resBadge = categoryBadge(success ? "done" : "error", { color: this.theme.color });
        const target = this.pendingTitle || tool;
        this.pendingTitle = null;
        // gjc-parity glyph-first ledger line (logs/gjc-tui-study analysis Gap A):
        // a colored ✔/✗ leads the flushed scrollback line so a wheel-scroll back
        // through history scans like gjc's tool checklist; the category/status
        // badges stay for grep-ability and the non-TTY summary.
        const mark = this.unicode ? (success ? "✔" : "✗") : success ? "v" : "x";
        const paintedMark = this.theme.color ? (success ? chalk.green(mark) : chalk.red(mark)) : mark;
        this.appendLedger(`${paintedMark} ${catBadge} ${resBadge} ${target}\n`);
        this.draw();
      },
      onNotice: msg => {
        // Transient progress notice (e.g. rate-limit auto-retry countdown) is live
        // state, not ledger content. Pin it in the status row only; do NOT append
        // repeated retry notices into the stream/log area.
        this.retryNotice = msg;
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
   *  final summary. */
  private appendLedger(text: string): void {
    this.stream.append(text);
    if (this.inline && !this.finished) {
      this.renderer.insertAbove(text.endsWith("\n") ? text : `${text}\n`);
    }
  }

  /** Surface native workflow-engine progress (`/skill deep-interview`, etc.). */
  setWorkflowStatus(status: { skill: string; phase: string; detail?: string } | null): void {
    this.workflowStatus = status;
    if (status) {
      const detail = status.detail ? ` — ${status.detail}` : "";
      this.appendLedger(`${categoryBadge("progress", { color: this.theme.color })} workflow ${status.skill}: ${status.phase}${detail}\n`);
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
    if (this.workflowStatus) {
      const detail = this.workflowStatus.detail ? ` — ${this.workflowStatus.detail}` : "";
      return `workflow ${this.workflowStatus.skill}: ${this.workflowStatus.phase}${detail}`;
    }
    const running = this.tools.currentTool();
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
      return last?.title ?? `running ${running}`;
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
    if (timelineSteps.length) {
      finalLines.push(formatStepHeader(timelineSteps, { elapsedMs: totalElapsedMs, unicode: this.unicode, color: this.theme.color }));
    }
    for (const line of formatStepTimeline(timelineSteps, { unicode: this.unicode, color: this.theme.color, highlightActive: true, maxRows: 12 })) {
      finalLines.push(line);
    }
    if (timelineSteps.length > 1) {
      finalLines.push(`  ${formatStepTimelineCompact(timelineSteps, { unicode: this.unicode, color: this.theme.color })}`);
    }
    if (!this.inline) {
      // Inline turns already flushed every ledger line into scrollback live; re-printing
      // the stream here would duplicate the whole history right below itself.
      for (const line of this.stream.render(size().cols)) finalLines.push(line);
    }
    for (const line of this.renderForge(size().cols, 3)) finalLines.push(line);
    if (timelineSteps.length > 0) {
      const arrow = this.unicode ? " → " : " -> ";
      const flow = ["thinking", "planning", "executing", "done"].join(arrow);
      const stepsCount = this.footer.step || 0;
      const durationStr = formatDuration(Date.now() - this.startedAt);
      const usageStr = this.turnUsage ? ` · ${formatUsage(this.turnUsage)}` : "";
      const doneBadge = categoryBadge("done", { color: this.theme.color });
      finalLines.push(`${doneBadge} ${flow} · ${stepsCount} steps · ${durationStr}${usageStr}`);
    }
    // Show how far the agent evolved this turn (monotonic peak) with rich statistics.
    const steps = this.footer.step || 0;
    const peak = this.progress.current();
    const usageSuffix = this.turnUsage ? ` · ${formatUsage(this.turnUsage)}` : "";
    finalLines.push(`Evolved to: ${evolutionTrack(peak, { unicode: this.unicode, color: this.theme.color })} (took ${steps} steps in ${formatDuration(Date.now() - this.startedAt)}${usageSuffix})`);
    finalLines.push(`joc> ${reply}`);
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

  private renderForge(width: number, maxEntries: number): string[] {
    const floor = Math.min(24, width);
    // Fill the available width (cap at formatForgeBox's own 120 ceiling) so an
    // in-frame box does not leave a dead right-margin column inside the outer panel.
    const boxWidth = Math.max(floor, Math.min(120, width));
    const paint = this.theme.color ? chalk.gray : (s: string) => s;
    const lines: string[] = [];
    for (const [i, summary] of this.forgeSummaries.slice(-maxEntries).entries()) {
      if (lines.length > 0) lines.push("");
      lines.push(...formatForgeBox(summary, { width: boxWidth, maxLines: 8, unicode: this.unicode, paint, index: i + 1, color: this.theme.color }));
    }
    return lines;
  }

  private draw(): void {
    if (this.finished) return; // never repaint a live frame after the final static output
    const { cols, rows } = size();
    const fit = this.tty; // boxed full-screen layout only on a TTY (defaults to isTTY())
    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const innerWidth = fit ? cols - 4 : cols;

    // Resolve the current (monotonic) stage; announce a transition once when it
    // first advances. The art + track are cached per stage index/cols so the
    // 120ms spinner tick does not re-render the block every frame.
    const stepNow = this.footer.step || 0;
    const idx = this.progress.observe(stepNow, this.footer.maxSteps ?? DEFAULT_MAX_STEPS);
    const isThinking = this.timer !== undefined;
    if (fit && this.progress.advanced() && idx > 0) {
      const arrow = this.unicode ? "\u27f6" : "->";
      this.appendLedger(`${arrow} ${transitionMessage(idx)}\n`);
    }
    const effFrame = isThinking ? this.tickCount % stageBlocks(getStageByIndex(idx)).length : 0;
    if (idx !== this.cachedStageIndex || cols !== this.cachedCols || effFrame !== this.cachedFrame) {
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

    const showArt = fit && rows >= 18 && cols >= 40;
    const artLinesCount = showArt ? stageHeight() : 0;
    const trackCount = showArt ? 1 : 0;
    const headerHeight = artLinesCount + trackCount + (showArt ? 1 : 0);

    const toolLines = this.tools.render(fit ? Math.max(3, rows - 15) : undefined, { color: this.theme.color, indexed: fit });
    const toolListHeight = toolLines.length;

    const planLines = this.renderPlan(this.theme.color);
    const planHeight = planLines.length;

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
        bottom.push(`  ${renderHud(this.hudPhase, { unicode: this.unicode, color: this.theme.color })}`);
        bottom.push("");
        const stats = this.tools.stats();
        for (const line of renderJocStatus({
          step: stepNow,
          maxSteps: this.footer.maxSteps,
          elapsedMs,
          stepElapsedMs: this.currentStepStartedAt ? Date.now() - this.currentStepStartedAt : undefined,
          avgStepMs: stepNow > 0 ? elapsedMs / stepNow : undefined,
          message: statusMsg,
          currentTool: this.tools.currentTool(),
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

      const paint = this.theme.color ? chalk.blue : (s: string) => s;
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
