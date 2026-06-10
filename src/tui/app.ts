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
import { centerBlock, padLineTo, fillScreen, boxBlock, BOX_ASCII, BOX_UNICODE } from "./components/layout";
import { resolveTheme, themeGradient } from "./components/themes";
import { detectColorLevel } from "./components/color";
import { formatForgeBox, summarizeForgeInvocation, summarizeForgeResult, fitForgeBoxes, type ForgeSummary } from "./components/forge";
import { renderJocStatus } from "./components/status";
import { categoryBadge, categoryForTool } from "./components/category-index";
import { formatStepTimeline, stepsFromTools, formatStepHeader, formatStepTimelineCompact, type StepState } from "./components/step-timeline";
import { formatHintBar } from "./components/hints";
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
}

export interface AgentEventsLike {
  onStep?(step: number): void;
  onAssistant?(raw: string, invocation: { tool: string; arguments?: unknown } | null): void;
  onToolResult?(tool: string, success: boolean, output: string): void;
  onNotice?(message: string): void;
}

const DEFAULT_MAX_STEPS = 25;

// Registered once per process: if we exit while still in the alternate screen
// (e.g. an uncaught crash mid-turn), restore the main buffer + cursor so the
// terminal is never left stuck on a blank alt screen.
let altScreenExitSafetyArmed = false;

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
  // Latest transient provider notice (rate-limit auto-retry countdown); pinned into the
  // [STEP] status row while waiting so backoff is visible at a glance. Cleared on the
  // next step / model reply.
  private retryNotice: string | null = null;
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
  private readonly theme = resolveTheme();
  // Whether the live turn may use the alternate screen buffer (real TTY only).
  private readonly tty: boolean;

  constructor(opts: LaunchTuiOptions) {
    this.write = opts.write ?? ((s: string) => process.stdout.write(s));
    this.tty = opts.tty ?? isTTY();
    this.renderer = new Renderer(this.write);
    this.spinner = new Spinner(undefined, { unicode: this.unicode });
    this.footer = {
      model: opts.model,
      provider: opts.provider,
      sessionId: opts.sessionId,
      maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
      unicode: this.unicode,
      showEta: true,
      showProgress: true,
    };
  }

  /** Whether a TUI should be used at all (TTY required). */
  static usable(noTui: boolean): boolean {
    return isTTY() && !noTui;
  }

  /** Update the agent-declared task plan (driven by the `todo` tool). */
  setTodos(items: { title: string; status: "pending" | "in_progress" | "done" }[]): void {
    this.todos = items;
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
          const toolName = invocation.tool || "(no tool)";
          this.pendingIndex = this.tools.start(toolName);
          const summary = summarizeForgeInvocation(toolName, invocation.arguments);
          this.pendingTitle = summary.title;
          this.rememberForge(summary);
          this.draw();
        }
      },
      onToolResult: (tool, success, output) => {
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
        this.stream.append(`${catBadge} ${resBadge} ${target}\n`);
        this.draw();
      },
      onNotice: msg => {
        // Transient progress notice (e.g. rate-limit auto-retry countdown) — informational,
        // styled as progress, not as a terminal error. Also pinned into the [STEP] status
        // row via currentActivity() so the wait is legible without scanning the stream.
        this.retryNotice = msg;
        this.stream.append(`${categoryBadge("progress", { color: this.theme.color })} ${msg}\n`);
        this.draw();
      },
    };
  }

  /**
   * Real, stable "what joc is doing right now" for the [STEP] line — the in-flight tool's
   * actual target (file / command), else the active plan step, else overall plan progress.
   * Replaces the per-tick cycling status text so the line shows genuine content (thinking
   * about a real file/step) instead of churning decorative messages every 120ms.
   */
  private currentActivity(): string {
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
        this.stream.append(`${badge} ${role} ${this.unicode ? "▸" : ">"} start: ${detail}\n`);
        break;
      case "step":
        this.stream.append(`  ${badge} ${role}${step}: ${detail || "working"}\n`);
        break;
      case "tool":
        this.stream.append(`  ${badge} ${role} ${e.success === false ? bad : ok} ${detail || "tool"}${summary}\n`);
        break;
      case "error":
        this.stream.append(`  ${badge} ${role} ${bad} ${detail || "error"}\n`);
        break;
      case "done":
        this.stream.append(`${badge} ${role} ${this.unicode ? "◂" : "<"} done${e.success === false ? " (incomplete)" : ""}: ${detail}\n`);
        break;
    }
    this.draw();
  }

  start(): void {
    this.startedAt = Date.now();
    this.spinner.updateStep(0, this.footer.maxSteps);
    // On a real TTY, render the transient live turn in the alternate screen buffer.
    // It has no scrollback, so mouse-wheel scroll can't fight the 120ms in-place
    // repaint (the old "scroll → flicker / screen disappears" bug); the main buffer
    // + scrollback stay intact and the final summary is printed there in finish().
    if (this.tty) {
      this.usedAltScreen = true;
      this.write(enterAltScreen());
      this.renderer.reset();
      if (!altScreenExitSafetyArmed) {
        altScreenExitSafetyArmed = true;
        process.once("exit", () => {
          try { process.stdout.write(leaveAltScreen() + showCursor()); } catch { /* terminal gone */ }
        });
      }
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
    // Animate the spinner + elapsed clock while the model is thinking.
    this.timer = setInterval(() => {
      try {
        this.tickCount++;
        this.spinner.next();
        this.draw();
      } catch {
        // Ignore transient render races (resize/component state) so the agent turn keeps running.
      }
    }, 120);
  }

  /** Collapse the live region to static final output. */
  finish(reply: string): void {
    this.finished = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
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
    for (const line of this.stream.render(size().cols)) finalLines.push(line);
    for (const line of this.renderForge(size().cols, 3)) finalLines.push(line);
    // Show how far the agent evolved this turn (monotonic peak) with rich statistics.
    const elapsedSecs = Math.round((Date.now() - this.startedAt) / 1000);
    const steps = this.footer.step || 0;
    const peak = this.progress.current();
    finalLines.push(`Evolved to: ${evolutionTrack(peak, { unicode: this.unicode, color: this.theme.color })} (took ${steps} steps in ${elapsedSecs}s)`);
    finalLines.push(`joc> ${reply}`);
    console.log(finalLines.join("\n"));
  }

  private rememberForge(summary: ForgeSummary): void {
    this.forgeSummaries.push(summary);
    if (this.forgeSummaries.length > 8) this.forgeSummaries.shift();
  }

  private renderForge(width: number, maxEntries: number): string[] {
    const floor = Math.min(24, width);
    const boxWidth = Math.max(floor, Math.min(96, width));
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
      this.stream.append(`${arrow} ${transitionMessage(idx)}\n`);
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
    if (isThinking) {
      if (fit) {
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
        })) bottom.push(line);
      } else {
        // Compact single-line status off a TTY (pipes / tests).
        const italicGray = this.theme.color ? chalk.italic.gray : (s: string) => s;
        const redBold = this.theme.color ? chalk.red.bold : (s: string) => s;
        const guardBadge = this.mutationGuarded ? ` ${redBold("[MUTATION LOCKED]")}` : "";
        bottom.push(`  ${italicGray(statusMsg)}${guardBadge}`);
      }
    }
    // TTY only: a key-hint bar above the footer (kept out of non-TTY/test frames).
    if (fit) bottom.push(formatHintBar(undefined, { unicode: this.unicode, color: this.theme.color, cols: innerWidth }));
    // Live animated step strip appended to the footer when the turn has steps.
    const liveSteps = stepsFromTools(this.tools.snapshot());
    const strip = liveSteps.length
      ? `  ${formatStepTimelineCompact(liveSteps, { unicode: this.unicode, color: this.theme.color, frame: this.tickCount, cap: 16 })}`
      : "";
    bottom.push(`${this.spinner.current()} ${renderFooter({ ...this.footer, elapsedMs, color: this.theme.color })}${strip}`);
    const bottomHeight = bottom.length;

    const forgeLines = fit ? this.renderForge(innerWidth, 2) : [];
    const forgeHeight = forgeLines.length;

    const overhead = fit ? 4 : 0; // 2 borders + 2 dividers
    const fixedHeight = headerHeight + planHeight + toolListHeight + forgeHeight + bottomHeight + overhead;
    const maxStreamLines = fit ? Math.max(0, rows - fixedHeight) : undefined;
    const streamLines = this.stream.render(innerWidth, maxStreamLines);

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

      // Display order: art header → plan → tools → stream → forge → trailing divider.
      const innerLines = [...headerK, ...planK, ...toolsK, ...streamK, ...forgeK];
      let trailingDivider: string[] = [];
      if (innerLines.length && budget > 0) {
        trailingDivider = ["DIVIDER"];
        budget--;
      }
      const fillerCount = Math.max(0, budget);

      const boxedContent: string[] = [];
      for (const line of innerLines) boxedContent.push(line);
      for (const line of trailingDivider) boxedContent.push(line);
      for (let i = 0; i < fillerCount; i++) boxedContent.push("");
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
