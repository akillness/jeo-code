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
import { size, isTTY, hideCursor, showCursor } from "./terminal";
import { Spinner } from "./components/spinner";
import { ToolList } from "./components/tool-list";
import { StreamRegion } from "./components/stream";
import { renderFooter, type FooterData } from "./components/footer";
import { getEvolutionStage, renderAsciiArt, stageHeight } from "./components/ascii-art";
import { evolutionTrack, stageIndexForStep } from "./components/evolution";

export interface LaunchTuiOptions {
  model: string;
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
  private readonly spinner = new Spinner();
  private readonly tools = new ToolList();
  private readonly stream = new StreamRegion();
  private readonly footer: FooterData;
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pendingIndex: number | null = null;

  constructor(opts: LaunchTuiOptions) {
    this.write = opts.write ?? ((s: string) => process.stdout.write(s));
    this.renderer = new Renderer(this.write);
    this.footer = { model: opts.model, sessionId: opts.sessionId, maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS };
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
          this.draw();
        }
      },
      onToolResult: (_tool, success) => {
        if (this.pendingIndex !== null) {
          this.tools.finish(this.pendingIndex, success);
          this.pendingIndex = null;
        }
        this.draw();
      },
      onError: msg => {
        this.stream.append(`! ${msg}`);
        this.draw();
      },
    };
  }

  start(): void {
    this.startedAt = Date.now();
    this.spinner.updateStep(0, this.footer.maxSteps);
    this.write(hideCursor());
    this.draw();
    // Animate the spinner + elapsed clock while the model is thinking.
    this.timer = setInterval(() => {
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
    // Show how far the agent evolved this turn.
    const reached = stageIndexForStep(this.footer.step ?? 0, this.footer.maxSteps ?? DEFAULT_MAX_STEPS);
    finalLines.push(`Evolved to: ${evolutionTrack(reached)}`);
    finalLines.push(`joc> ${reply}`);
    console.log(finalLines.join("\n"));
  }

  private draw(): void {
    const cols = size().cols;
    const elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
    const frame: string[] = [];

    // Prepend evolutionary ASCII art at a stable block height (no flicker as
    // stages change), then the live evolution track.
    const stepNow = this.footer.step || 0;
    const stage = getEvolutionStage(stepNow, this.footer.maxSteps);
    for (const line of renderAsciiArt(stage, { height: stageHeight() })) {
      frame.push(line);
    }
    frame.push(evolutionTrack(stageIndexForStep(stepNow, this.footer.maxSteps ?? DEFAULT_MAX_STEPS)));
    frame.push(""); // spacing line

    for (const line of this.tools.render()) frame.push(line);
    for (const line of this.stream.render(cols)) frame.push(line);
    frame.push(`${this.spinner.current()} ${renderFooter({ ...this.footer, elapsedMs })}`);
    this.renderer.render(frame);
  }
}
