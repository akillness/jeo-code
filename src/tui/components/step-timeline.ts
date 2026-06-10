/**
 * Step-process timeline — a vertical, status-colored render of the agent's
 * step sequence (one row per tool step) with a state glyph, an animated active
 * marker, a connector gutter, and a summary line. Used by `LaunchTui.finish()`
 * to collapse a turn into a readable process trace. Pure functions over a step
 * list (color via chalk), so they unit-test with an ANSI-stripping helper.
 */
import chalk from "chalk";
import { categoryBadge, type UiCategory } from "./category-index";
import type { ToolStatus } from "./tool-list";

export type StepState = "pending" | "active" | "done" | "failed";

export interface TimelineStep {
  label: string;
  state: StepState;
  /** Optional trailing detail (e.g. a file path or short result note). */
  detail?: string;
}

const GLYPH_UNICODE: Record<StepState, string> = { pending: "○", active: "◐", done: "●", failed: "✗" };
const GLYPH_ASCII: Record<StepState, string> = { pending: "o", active: "*", done: "x", failed: "!" };
const SPIN_UNICODE = ["◐", "◓", "◑", "◒"];
const SPIN_ASCII = ["|", "/", "-", "\\"];

/** Glyph for a step state; an `active` step with a frame index animates a spinner. */
export function stepGlyph(state: StepState, opts: { unicode?: boolean; frame?: number } = {}): string {
  const unicode = opts.unicode !== false;
  if (state === "active" && typeof opts.frame === "number") {
    const set = unicode ? SPIN_UNICODE : SPIN_ASCII;
    return set[((opts.frame % set.length) + set.length) % set.length];
  }
  return (unicode ? GLYPH_UNICODE : GLYPH_ASCII)[state];
}

/** Map a state to its chalk colorizer (identity when color is off). */
export function colorForState(state: StepState, color = true): (s: string) => string {
  if (!color) return (s: string) => s;
  switch (state) {
    case "pending": return chalk.gray;
    case "active": return chalk.yellow;
    case "done": return chalk.green;
    case "failed": return chalk.red;
  }
}

/** Map a live ToolStatus to a timeline state. */
export function stateFromToolStatus(status: ToolStatus): StepState {
  return status === "running" ? "active" : status === "ok" ? "done" : "failed";
}

/** Build timeline steps from a ToolList snapshot. */
export function stepsFromTools(rows: { tool: string; status: ToolStatus }[]): TimelineStep[] {
  return rows.map(r => ({ label: r.tool, state: stateFromToolStatus(r.status) }));
}

export interface StepSummary {
  pending: number;
  active: number;
  done: number;
  failed: number;
  total: number;
}

export function summarizeSteps(steps: TimelineStep[]): StepSummary {
  const s: StepSummary = { pending: 0, active: 0, done: 0, failed: 0, total: steps.length };
  for (const step of steps) s[step.state]++;
  return s;
}

/** One-line summary, e.g. "✓3 ✗1 ·1 / 5" (ASCII: "ok3 x1 .1 / 5"). */
export function formatStepSummary(steps: TimelineStep[], opts: { unicode?: boolean; color?: boolean } = {}): string {
  const unicode = opts.unicode !== false;
  const color = opts.color !== false;
  const s = summarizeSteps(steps);
  const okMark = unicode ? "✓" : "ok";
  const failMark = unicode ? "✗" : "x";
  const pendMark = unicode ? "·" : ".";
  const wrap = (fn: (x: string) => string, t: string) => (color ? fn(t) : t);
  const parts = [
    wrap(chalk.green, `${okMark}${s.done}`),
    s.failed ? wrap(chalk.red, `${failMark}${s.failed}`) : "",
    s.active ? wrap(chalk.yellow, `${unicode ? "◐" : "*"}${s.active}`) : "",
    s.pending ? wrap(chalk.gray, `${pendMark}${s.pending}`) : "",
  ].filter(Boolean);
  return `${parts.join(" ")} / ${s.total}`;
}

export interface TimelineOptions {
  unicode?: boolean;
  color?: boolean;
  /** Animation frame for the active step's spinner. */
  frame?: number;
  /** Draw a connector gutter (│ / └) between steps. */
  connectors?: boolean;
  /** Truncate labels+detail to this many visible chars. */
  maxWidth?: number;
  /** Title line above the timeline. */
  title?: string;
  /** Bold the active step row. */
  highlightActive?: boolean;
  /** Keep only the most recent N rows (older collapse to a "(+M earlier)" line). */
  maxRows?: number;
}

/**
 * Render a numbered, status-colored step timeline:
 *   1 ● read        ok
 *   2 ◐ bash        running…
 *   3 ✗ edit        FAILED
 */
export function formatStepTimeline(steps: TimelineStep[], opts: TimelineOptions = {}): string[] {
  const unicode = opts.unicode !== false;
  const color = opts.color !== false;
  const connectors = opts.connectors ?? true;
  if (steps.length === 0) return [opts.title ?? (color ? chalk.gray("  (no steps)") : "  (no steps)")];

  const out: string[] = [];
  if (opts.title) out.push(opts.title);
  const idxW = String(steps.length).length;
  const vbar = unicode ? "│" : "|";
  const corner = unicode ? "└" : "`";

  // Keep only the most recent maxRows; collapse the rest to a count line.
  let startIdx = 0;
  if (opts.maxRows && opts.maxRows > 0 && steps.length > opts.maxRows) {
    startIdx = steps.length - opts.maxRows;
    out.push(color ? chalk.gray(`  · (+${startIdx} earlier)`) : `  · (+${startIdx} earlier)`);
  }

  for (let i = startIdx; i < steps.length; i++) {
    const step = steps[i];
    const last = i === steps.length - 1;
    const conn = connectors ? (last ? corner : vbar) : " ";
    const glyph = stepGlyph(step.state, { unicode, frame: opts.frame });
    const paint = colorForState(step.state, color);
    let label = step.label;
    if (step.detail) label += ` ${step.detail}`;
    if (opts.maxWidth && label.length > opts.maxWidth) label = label.slice(0, opts.maxWidth - 1) + "…";
    if (color) {
      if (step.state === "done") {
        label = `\x1b[9m${chalk.gray(chalk.dim(label))}\x1b[29m`;
      } else if (step.state === "failed") {
        label = chalk.red(label);
      } else if (step.state === "active") {
        if (opts.highlightActive) {
          label = chalk.cyan.bold(label);
        }
      } else if (step.state === "pending") {
        label = chalk.dim(label);
      }
    }
    const cat: UiCategory = step.state === "active" ? "progress" : step.state === "done" ? "done" : step.state === "failed" ? "error" : "tool";
    const badge = categoryBadge(cat, { index: i + 1, color });
    out.push(`  ${conn} ${paint(glyph)} ${badge} ${label}`);
  }
  return out;
}

/** Compact duration: 0.9s under a minute, else Mm Ss; sub-second as Nms. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** Header line: "Steps  ✓2 ✗1 ◐1 / 4  ·  3.2s". */
export function formatStepHeader(
  steps: TimelineStep[],
  opts: { elapsedMs?: number; unicode?: boolean; color?: boolean; label?: string } = {},
): string {
  const color = opts.color !== false;
  const title = opts.label ?? "Steps";
  const head = color ? chalk.bold(title) : title;
  const summary = formatStepSummary(steps, { unicode: opts.unicode, color });
  const tail = typeof opts.elapsedMs === "number" ? `  ·  ${formatDuration(opts.elapsedMs)}` : "";
  return `${head}  ${summary}${tail}`;
}

/** Horizontal glyph strip, e.g. "● ● ✗ ◐" — a glanceable status bar. */
export function formatStepTimelineCompact(
  steps: TimelineStep[],
  opts: { unicode?: boolean; color?: boolean; frame?: number; cap?: number } = {},
): string {
  if (steps.length === 0) return "";
  const unicode = opts.unicode !== false;
  const color = opts.color !== false;
  const cap = opts.cap ?? 40;
  const shown = steps.slice(-cap);
  const glyphs = shown.map(s => {
    const g = stepGlyph(s.state, { unicode, frame: opts.frame });
    return color ? colorForState(s.state, true)(g) : g;
  });
  const overflow = steps.length > cap ? (color ? chalk.gray(` +${steps.length - cap}`) : ` +${steps.length - cap}`) : "";
  return glyphs.join(" ") + overflow;
}

/** A done/total progress bar: "▓▓▓░░ 3/5" (ascii: "###.. 3/5"). */
export function formatProgressBar(
  done: number,
  total: number,
  opts: { width?: number; unicode?: boolean; color?: boolean } = {},
): string {
  const width = Math.max(1, opts.width ?? 10);
  const unicode = opts.unicode !== false;
  const color = opts.color !== false;
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const filled = Math.round(ratio * width);
  const fillCh = unicode ? "▓" : "#";
  const emptyCh = unicode ? "░" : ".";
  const bar = fillCh.repeat(filled) + emptyCh.repeat(width - filled);
  const painted = color ? chalk.green(fillCh.repeat(filled)) + chalk.gray(emptyCh.repeat(width - filled)) : bar;
  return `${painted} ${done}/${total}`;
}
