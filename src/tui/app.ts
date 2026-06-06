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
import { readWorkflowState } from "../agent/state";
import { size, isTTY, hideCursor, showCursor } from "./terminal";
import { Spinner } from "./components/spinner";
import { ToolList } from "./components/tool-list";
import { StreamRegion } from "./components/stream";
import { renderFooter, type FooterData } from "./components/footer";
import { getStageByIndex, renderAsciiArt, stageHeight, stageWidth } from "./components/ascii-art";
import { evolutionTrack, createStageProgress, type StageProgress, getEvolutionStatusMessage, transitionMessage } from "./components/evolution";
import { supportsUnicode } from "./components/capability";
import { centerBlock, padLineTo, fillScreen, boxBlock, BOX_ASCII, BOX_UNICODE } from "./components/layout";
import { resolveTheme } from "./components/themes";
import { formatForgeBox, summarizeForgeInvocation, summarizeForgeResult, type ForgeSummary } from "./components/forge";
import { renderJocStatus } from "./components/status";
import chalk from "chalk";

export interface LaunchTuiOptions {
  model: string;
  /** Resolved provider name for the footer (anthropic / openai / gemini / ollama). */
  provider?: string;
  sessionId?: string;
  write?: (s: string) => void;
  /** Step budget for this turn; drives the footer's `step N/M` denominator. */
  maxSteps?: number;
}

export interface AgentEventsLike {
  onStep?(step: number): void;
  onAssistant?(raw: string, invocation: { tool: string; arguments?: unknown } | null): void;
  onToolResult?(tool: string, success: boolean, output: string): void;
  onError?(message: string): void;
}

const DEFAULT_MAX_STEPS = 25;

export class LaunchTui {
  private readonly renderer: Renderer;
  private readonly write: (s: string) => void;
  private readonly spinner: Spinner;
  private readonly tools = new ToolList();
  private readonly stream = new StreamRegion();
  private readonly forgeSummaries: ForgeSummary[] = [];
  private readonly footer: FooterData;
  private startedAt = 0;
  private tickCount = 0;
  private mutationGuarded = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pendingIndex: number | null = null;
  // Cache the rendered art + track per stage so the 120ms spinner tick reuses
  // them instead of re-rendering/re-coloring the block every frame.
  private cachedStageIndex = -1;
  private cachedCols = -1;
  private cachedArt: string[] = [];
  private cachedTrack = "";
  // Monotonic stage progress so evolution only ever moves forward this turn.
  private readonly progress: StageProgress = createStageProgress();
  // Terminal unicode capability, detected once (drives spinner/track glyph set).
  private readonly unicode: boolean = supportsUnicode();
  // Active color theme (JOC_TUI_THEME), default cosmic; `mono` disables color.
  private readonly theme = resolveTheme();

  constructor(opts: LaunchTuiOptions) {
    this.write = opts.write ?? ((s: string) => process.stdout.write(s));
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

  /** The events object to hand to runAgentLoop. */
  events(): AgentEventsLike {
    return {
      onStep: step => {
        this.footer.step = step;
        this.spinner.updateStep(step, this.footer.maxSteps);
        this.spinner.next();
        this.draw();
      },
      onAssistant: (_raw, invocation) => {
        if (invocation && invocation.tool !== "done") {
          this.pendingIndex = this.tools.start(invocation.tool);
          this.rememberForge(summarizeForgeInvocation(invocation.tool, invocation.arguments));
          this.draw();
        }
      },
      onToolResult: (tool, success, output) => {
        if (this.pendingIndex !== null) {
          this.tools.finish(this.pendingIndex, success);
          this.pendingIndex = null;
        }
        this.rememberForge(summarizeForgeResult(tool, success, output));
        const marker = success ? (this.unicode ? "✓" : "v") : (this.unicode ? "✗" : "x");
        this.stream.append(`${marker} ${success ? "complete" : "error"}: ${tool}\n`);
        this.draw();
      },
      onError: msg => {
        const marker = this.unicode ? "✗" : "x";
        this.stream.append(`${marker} error: ${msg}\n`);
        this.draw();
      },
    };
  }

  start(): void {
    this.startedAt = Date.now();
    this.spinner.updateStep(0, this.footer.maxSteps);
    this.write(hideCursor());
    this.draw();

    readWorkflowState("deep-interview")
      .then(state => {
        this.mutationGuarded = !!(state && state.active && state.current_phase !== "complete");
        this.draw();
      })
      .catch(() => {});
    // Animate the spinner + elapsed clock while the model is thinking.
    this.timer = setInterval(() => {
      this.tickCount++;
      this.spinner.next();
      this.draw();
    }, 120);
  }

  /** Collapse the live region to static final output. */
  finish(reply: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.renderer.clear();
    this.write(showCursor());
    const finalLines = [...this.tools.render()];
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
    const boxWidth = Math.max(24, Math.min(96, width));
    const paint = this.theme.color ? chalk.gray : (s: string) => s;
    const lines: string[] = [];
    for (const summary of this.forgeSummaries.slice(-maxEntries)) {
      if (lines.length > 0) lines.push("");
      lines.push(...formatForgeBox(summary, { width: boxWidth, maxLines: 8, unicode: this.unicode, paint }));
    }
    return lines;
  }

  private draw(): void {
    const { cols, rows } = size();
    const fit = isTTY(); // fill terminal width+height only on a real TTY
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
    if (idx !== this.cachedStageIndex || cols !== this.cachedCols || isThinking) {
      this.cachedStageIndex = idx;
      this.cachedCols = cols;
      const art = renderAsciiArt(getStageByIndex(idx), {
        height: stageHeight(),
        width: stageWidth(),
        cols: innerWidth,
        firing: isThinking,
        frame: isThinking ? this.tickCount : 0,
      });
      this.cachedArt = fit ? centerBlock(art, innerWidth) : art;
      const track = evolutionTrack(idx, { unicode: this.unicode, color: this.theme.color });
      this.cachedTrack = fit ? padLineTo(track, innerWidth, "center") : track;
    }

    const showArt = fit && rows >= 18 && cols >= 40;
    const artLinesCount = showArt ? stageHeight() : 0;
    const trackCount = showArt ? 1 : 0;
    const headerHeight = artLinesCount + trackCount + (showArt ? 1 : 0);

    const toolLines = this.tools.render(fit ? Math.max(3, rows - 15) : undefined);
    const toolListHeight = toolLines.length;

    // Bottom-pinned status + footer.
    const bottom: string[] = [];
    const statusMsg = getEvolutionStatusMessage(stepNow, this.footer.maxSteps ?? DEFAULT_MAX_STEPS, this.tickCount);
    if (isThinking) {
      if (fit) {
        const stats = this.tools.stats();
        for (const line of renderJocStatus({
          step: stepNow,
          maxSteps: this.footer.maxSteps,
          elapsedMs,
          message: statusMsg,
          currentTool: this.tools.currentTool(),
          okCount: stats.ok,
          failCount: stats.fail,
          runningCount: stats.running,
          totalCount: stats.total,
          mutationGuarded: this.mutationGuarded,
          unicode: this.unicode,
        })) bottom.push(line);
      } else {
        // Compact single-line status off a TTY (pipes / tests).
        const guardBadge = this.mutationGuarded ? ` ${chalk.red.bold("[MUTATION LOCKED]")}` : "";
        bottom.push(`  ${chalk.italic.gray(statusMsg)}${guardBadge}`);
      }
    }
    bottom.push(`${this.spinner.current()} ${renderFooter({ ...this.footer, elapsedMs })}`);
    const bottomHeight = bottom.length;

    const forgeLines = fit ? this.renderForge(innerWidth, 2) : [];
    const forgeHeight = forgeLines.length;

    const overhead = fit ? 4 : 0; // 2 borders + 2 dividers
    const fixedHeight = headerHeight + toolListHeight + forgeHeight + bottomHeight + overhead;
    const maxStreamLines = fit ? Math.max(2, rows - fixedHeight) : undefined;
    const streamLines = this.stream.render(innerWidth, maxStreamLines);

    let frame: string[] = [];

    if (fit) {
      // Boxed TUI matching terminal width & height exactly
      const innerLines: string[] = [];
      if (showArt) {
        for (const line of this.cachedArt) innerLines.push(line);
        innerLines.push(this.cachedTrack);
        innerLines.push("DIVIDER");
      }

      for (const line of toolLines) innerLines.push(line);
      for (const line of streamLines) innerLines.push(line);
      for (const line of forgeLines) innerLines.push(line);

      innerLines.push("DIVIDER");

      const totalLines = innerLines.length + bottom.length;
      const fillerCount = Math.max(0, rows - 2 - totalLines);

      const boxedContent: string[] = [];
      for (const line of innerLines) boxedContent.push(line);
      for (let i = 0; i < fillerCount; i++) boxedContent.push("");
      for (const line of bottom) boxedContent.push(line);

      const paint = this.theme.color ? chalk.blue : (s: string) => s;
      frame = boxBlock(boxedContent, cols, {
        glyphs: this.unicode ? BOX_UNICODE : BOX_ASCII,
        paint,
      });
    } else {
      // Unboxed Mode (fallback for tests/non-TTY)
      const header = showArt ? [...this.cachedArt, this.cachedTrack, ""] : [];
      const body = [...toolLines, ...streamLines, ...forgeLines];
      frame = [...header, ...body, ...bottom];
    }

    this.renderer.render(frame);
  }
}
