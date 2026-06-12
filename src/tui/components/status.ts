import chalk from "chalk";
import { boxBlock, BOX_UNICODE, BOX_ASCII, padLineTo } from "./layout";
import { meter } from "./meter";
import { categoryBadge } from "./category-index";
import { animatedGradientText, applyBgGradient, hexToRgb, visibleWidth, ColorLevel } from "./color";
import * as os from "node:os";
import { formatUsage } from "./duration";
import { formatCost } from "../../ai/pricing";

/**
 * One-row status bar pinned directly above the boxed input (gjc-layout parity):
 *   <bg-gradient block: ⬢ model · ◔ thinking / ⑂ branch *D ?N / ▸ cwd>  …  ⤴ R/s · ctx P%/MaxM
 * The left identity segment rides the theme's gradient as a BACKGROUND block;
 * right-side live stats stay plain so they read at a glance.
 */
export interface StatusBarData {
  model: string;
  /** Thinking level label ("high", …); omitted when unset. */
  thinking?: string;
  branch?: string;
  /** Uncommitted-change count for the `?N` dirty flag; omit/0 = clean. */
  dirtyCount?: number;
  cwd?: string;
  /** Live output-token rate (tokens/s); omitted when not in a turn. */
  rate?: number;
  /** Estimated context usage 0-100 (%), when known. */
  ctxPct?: number;
  /** Context window in tokens, when known. */
  ctxMaxTokens?: number;
  cols: number;
  unicode?: boolean;
  color?: boolean;
  colorLevel?: ColorLevel;
  /** Theme gradient (from→to hex) for the left segment background. */
  gradient?: { from: string; to: string };
}

function shortTokens(n: number): string {
  if (n >= 1_000_000) {
    const v = (n / 1_000_000).toFixed(1);
    return (v.endsWith(".0") ? v.slice(0, -2) : v) + "M";
  }
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return Math.round(n).toString();
}

function shortenCwd(cwd: string, maxLen: number, unicode: boolean): string {
  let s = cwd;
  const home = os.homedir();
  if (home && (s === home || s.startsWith(home + "/") || s.startsWith(home + "\\"))) {
    s = "~" + s.slice(home.length);
  }
  if (s.length <= maxLen) return s;
  const ell = unicode ? "…" : "...";
  return ell + s.slice(-(Math.max(1, maxLen - ell.length)));
}

export function renderStatusBar(d: StatusBarData): string {
  const unicode = d.unicode !== false;
  const useColor = d.color !== false;
  const cols = Math.max(24, Math.trunc(d.cols));
  const sep = " / ";

  // Right side first — it has priority and fixed width.
  const rightParts: string[] = [];
  if (typeof d.rate === "number" && Number.isFinite(d.rate) && d.rate > 0) {
    rightParts.push(`${unicode ? "⤴" : "^"} ${d.rate >= 100 ? d.rate.toFixed(0) : d.rate.toFixed(1)}/s`);
  }
  if (typeof d.ctxPct === "number" && Number.isFinite(d.ctxPct)) {
    const pct = Math.max(0, Math.min(999, Math.round(d.ctxPct)));
    const cap = d.ctxMaxTokens && d.ctxMaxTokens > 0 ? `/${shortTokens(d.ctxMaxTokens)}` : "";
    rightParts.push(`${unicode ? "▦" : "#"} ${pct}%${cap}`);
  }
  let right = rightParts.join(" · ");
  if (useColor && right) {
    const pct = d.ctxPct ?? 0;
    right = pct >= 85 ? chalk.red(right) : pct >= 60 ? chalk.yellow(right) : chalk.gray(right);
  }
  const rightWidth = rightParts.length ? visibleWidth(rightParts.join(" · ")) : 0;

  // Left identity segment (plain text; painted as one bg block at the end).
  const bits: string[] = [];
  let modelBit = `${unicode ? "⬢" : "*"} ${d.model}`;
  if (d.thinking) modelBit += ` · ${unicode ? "◔" : "@"} ${d.thinking}`;
  bits.push(modelBit);
  if (d.branch) {
    const dirty = d.dirtyCount && d.dirtyCount > 0 ? ` ?${d.dirtyCount}` : "";
    bits.push(`${unicode ? "⑂" : "y"} ${d.branch}${dirty}`);
  }
  // Budget the cwd into whatever width remains (right stats + 2-col gap reserved).
  const leftBudget = Math.max(8, cols - rightWidth - (rightWidth > 0 ? 2 : 0));
  if (d.cwd) {
    const used = visibleWidth(` ${bits.join(sep)}${sep}${unicode ? "▸" : ">"}  `);
    const room = leftBudget - used - 1;
    if (room >= 4) bits.push(`${unicode ? "▸" : ">"} ${shortenCwd(d.cwd, room, unicode)}`);
  }
  let left = ` ${bits.join(sep)} `;
  if (visibleWidth(left) > leftBudget) left = left.slice(0, leftBudget);

  const gap = Math.max(0, cols - visibleWidth(left) - rightWidth);
  const level = d.colorLevel ?? (useColor ? ColorLevel.TrueColor : ColorLevel.None);
  const grad = d.gradient ?? { from: "#0a3d62", to: "#48dbfb" };
  const paintedLeft = useColor
    ? applyBgGradient(left, hexToRgb(grad.from), hexToRgb(grad.to), level)
    : left;
  return `${paintedLeft}${" ".repeat(gap)}${right}`;
}

export interface JeoStatusData {
  colorLevel?: number;
  phase?: number;
  palette?: readonly string[];
  isThinking?: boolean;
  step?: number;
  maxSteps?: number;
  elapsedMs?: number;
  message?: string;
  currentTool?: string;
  okCount?: number;
  failCount?: number;
  runningCount?: number;
  totalCount?: number;
  mutationGuarded?: boolean;
  unicode?: boolean;
  color?: boolean;
  /** Compact evolution-stage identity (e.g. "●●○○○ Double Helix (DNA) [2/5]") shown in the
   *  forge line so the current stage — the double helix — is always exposed, even when the
   *  large ASCII art is dropped on short terminals. */
  stage?: string;
  stepElapsedMs?: number;
  avgStepMs?: number;
  /** Cumulative turn token usage (engine onUsage) shown live on the [STEP] row. */
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** Live USD cost for the turn (price table × usage); omit when the model has no known price. */
  costUsd?: number;
  /** True while a delegated subagent turn is in flight — renders gjc's `(sub)` marker. */
  subagentActive?: boolean;

}

export function progressPercent(step: number | undefined, maxSteps: number | undefined): number {
  if (!Number.isFinite(step) || !Number.isFinite(maxSteps) || (maxSteps ?? 0) <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((step ?? 0) / (maxSteps ?? 1)) * 100)));
}

function seconds(ms: number | undefined): number {
  return Number.isFinite(ms) && (ms ?? 0) > 0 ? Math.round((ms ?? 0) / 1000) : 0;
}

export function renderJeoStatus(data: JeoStatusData): string[] {
  const step = Number.isFinite(data.step) ? Math.max(0, Math.trunc(data.step ?? 0)) : 0;
  const max = Number.isFinite(data.maxSteps) && (data.maxSteps ?? 0) > 0 ? Math.trunc(data.maxSteps ?? 0) : 0;
  const useColor = data.color !== false;
  const bar = meter(step, max || 1, 10, { unicode: data.unicode !== false, color: useColor });
  const elapsed = `${seconds(data.elapsedMs)}s`;
  let msg = data.message ?? "thinking through the next tool call";
  const level = data.colorLevel ?? (useColor ? ColorLevel.TrueColor : ColorLevel.None);
  if (useColor && data.isThinking && level === ColorLevel.TrueColor && data.palette && data.palette.length > 0) {
    const phase = data.phase ?? 0;
    msg = animatedGradientText(msg, data.palette, phase, { colorLevel: level });
  }
  const current = data.currentTool ? `forging ${data.currentTool}` : "forge idle";
  const stage = data.stage ? `${data.stage} · ` : "";
  const ok = data.okCount ?? 0;
  const fail = data.failCount ?? 0;
  const running = data.runningCount ?? 0;
  const total = data.totalCount ?? ok + fail + running;

  const cyanBold = useColor ? chalk.cyan.bold : (s: string) => s;
  const magentaBold = useColor ? chalk.magenta.bold : (s: string) => s;
  const redBold = useColor ? chalk.red.bold : (s: string) => s;
  const green = useColor ? chalk.green : (s: string) => s;
  const yellow = useColor ? chalk.yellow : (s: string) => s;
  const red = useColor ? chalk.red : (s: string) => s;
  const toolCounts = `${green(`${ok} ok`)} / ${red(`${fail} fail`)} / ${yellow(`${running} running`)}`;

  const guard = data.mutationGuarded ? ` · ${redBold("mutation locked")}` : "";
  let extraStats = "";
  if (Number.isFinite(data.stepElapsedMs)) {
    extraStats += ` · step ${(data.stepElapsedMs! / 1000).toFixed(1)}s`;
  }
  if (Number.isFinite(data.avgStepMs)) {
    extraStats += ` · avg ${(data.avgStepMs! / 1000).toFixed(1)}s`;
  }
  // Live token spend for the turn — visible per step, not only in the final summary.
  if (data.usage && (data.usage.inputTokens || data.usage.outputTokens)) {
    extraStats += ` · ${formatUsage(data.usage)}`;
    // gjc-parity live output-token rate (logs/gjc-tui-study analysis Gap B):
    // `⤴ N.N/s` like gjc's HUD. Derived purely from existing usage + elapsed —
    // no new data sources; gated past the first second so a fresh turn doesn't
    // flash a meaningless spike.
    const elapsedSec = (data.elapsedMs ?? 0) / 1000;
    if (elapsedSec >= 1 && (data.usage.outputTokens ?? 0) > 0) {
      const rate = data.usage.outputTokens / elapsedSec;
      const glyph = data.unicode !== false ? "⤴" : "^";
      extraStats += ` · ${glyph} ${rate >= 100 ? rate.toFixed(0) : rate.toFixed(1)}/s`;
    }
  }
  // Live USD cost (gjc parity `$0.42 (sub)`): only when a known price produced a figure.
  if (typeof data.costUsd === "number" && Number.isFinite(data.costUsd) && data.costUsd > 0) {
    extraStats += ` · ${formatCost(data.costUsd)}`;
  }
  if (data.subagentActive) {
    extraStats += " (sub)";
  }
  return [
    `  ${categoryBadge("progress", { color: useColor })} step ${step}/${max} · ${bar} · elapsed ${elapsed}${extraStats}`,
    `  ${categoryBadge("status", { color: useColor })} ${cyanBold("jeo status")} · ${msg}`,
    `  ${categoryBadge("tool", { color: useColor })} ${magentaBold("jeo forge")} · ${stage}${current} · tools ${total} (${toolCounts})${guard}`,
  ];

}

export interface StatusBoxData extends JeoStatusData {
  /** Inner frame width the box should fill. */
  cols: number;
  /** Phase label embedded in the title border (thinking/planning/executing/reporting). */
  phaseLabel?: string;
  /** Current spinner frame glyph. */
  spinner?: string;
  /** Live streamed model activity (reasoning/uniform fallback); overrides `message`. */
  activity?: string;
  /** Append gjc's ⟦esc⟧ cancel hint to the activity row. */
  escHint?: boolean;
}

/**
 * gjc-style live STATUS BOX — replaces the [STEP]/[STATUS]/[TOOL] triple rows.
 * The thinking process renders inside a bordered box (gjc status-box format):
 *
 *   ╭─ ● thinking · step 3/25 ────────────────────────────╮
 *   │ ⠙ <live reasoning / current activity>         ⟦esc⟧ │
 *   │ ▰▰▱▱ 12% · 12s · avg 2.5s · 8.2k in / 30 out · ⤴ 6/s · 2 ok │
 *   ╰──────────────────────────────────────────────────────╯
 *
 * Steps are part of the TITLE (`step n/m`), the activity row carries the live
 * thinking text uniformly for every model, and one compact metrics row folds
 * meter/timing/usage/rate/cost/tool-counts together.
 */
export function renderStatusBox(data: StatusBoxData): string[] {
  const unicode = data.unicode !== false;
  const useColor = data.color !== false;
  const cols = Math.max(24, Math.trunc(data.cols));
  const inner = cols - 2;
  const step = Number.isFinite(data.step) ? Math.max(0, Math.trunc(data.step ?? 0)) : 0;
  const max = Number.isFinite(data.maxSteps) && (data.maxSteps ?? 0) > 0 ? Math.trunc(data.maxSteps ?? 0) : 0;
  const dim = useColor ? chalk.dim : (s: string) => s;
  const gray = useColor ? chalk.gray : (s: string) => s;

  // Activity row: spinner + live thinking text (+ right-aligned ⟦esc⟧, gjc parity).
  let activity = (data.activity?.trim() || data.message || "thinking through the next tool call").replace(/\s+/g, " ");
  const level = data.colorLevel ?? (useColor ? ColorLevel.TrueColor : ColorLevel.None);
  const esc = data.escHint ? (unicode ? "⟦esc⟧" : "[esc]") : "";
  const spin = data.spinner ?? "";
  const headWidth = visibleWidth(`${spin} `) + (esc ? visibleWidth(esc) + 1 : 0);
  const room = Math.max(8, inner - 2 - headWidth);
  if (visibleWidth(activity) > room) {
    let w = 0; let cut = "";
    for (const ch of activity) {
      const cw = visibleWidth(ch);
      if (w + cw > room - 1) break;
      cut += ch; w += cw;
    }
    activity = cut + (unicode ? "…" : "...");
  }
  if (useColor && data.isThinking && level === ColorLevel.TrueColor && data.palette && data.palette.length > 0) {
    activity = animatedGradientText(activity, data.palette, data.phase ?? 0, { colorLevel: level });
  }
  const escPad = esc ? " ".repeat(Math.max(1, inner - 2 - visibleWidth(`${spin} `) - visibleWidth(activity.replace(/\x1b\[[0-9;]*m/g, "")) - visibleWidth(esc))) + dim(esc) : "";
  const activityRow = ` ${spin} ${activity}${escPad}`;

  // Compact metrics row: meter · elapsed · step/avg · usage · rate · cost · tools.
  const bar = meter(step, max || 1, 10, { unicode, color: useColor });
  const bits: string[] = [`${bar}`, `${seconds(data.elapsedMs)}s`];
  if (Number.isFinite(data.stepElapsedMs)) bits.push(`step ${(data.stepElapsedMs! / 1000).toFixed(1)}s`);
  if (Number.isFinite(data.avgStepMs)) bits.push(`avg ${(data.avgStepMs! / 1000).toFixed(1)}s`);
  if (data.usage && (data.usage.inputTokens || data.usage.outputTokens)) {
    bits.push(formatUsage(data.usage));
    const elapsedSec = (data.elapsedMs ?? 0) / 1000;
    if (elapsedSec >= 1 && (data.usage.outputTokens ?? 0) > 0) {
      const rate = data.usage.outputTokens / elapsedSec;
      bits.push(`${unicode ? "⤴" : "^"} ${rate >= 100 ? rate.toFixed(0) : rate.toFixed(1)}/s`);
    }
  }
  if (typeof data.costUsd === "number" && Number.isFinite(data.costUsd) && data.costUsd > 0) bits.push(formatCost(data.costUsd));
  const ok = data.okCount ?? 0;
  const fail = data.failCount ?? 0;
  const running = data.runningCount ?? 0;
  if (ok + fail + running > 0) {
    const counts: string[] = [];
    if (ok) counts.push(useColor ? chalk.green(`${ok} ok`) : `${ok} ok`);
    if (fail) counts.push(useColor ? chalk.red(`${fail} fail`) : `${fail} fail`);
    if (running) counts.push(useColor ? chalk.yellow(`${running} run`) : `${running} run`);
    bits.push(counts.join(" / "));
  }
  if (data.subagentActive) bits.push("(sub)");
  if (data.mutationGuarded) bits.push(useColor ? chalk.red.bold("mutation locked") : "mutation locked");
  const metricsRow = ` ${gray(bits.join(" · "))}`;

  // Title border: ─ ● thinking · step 3/25 ─ (steps live in the TITLE now).
  const g = unicode ? BOX_UNICODE : BOX_ASCII;
  const phaseGlyph = unicode ? "●" : "*";
  const title = ` ${phaseGlyph} ${data.phaseLabel ?? "thinking"}${max ? ` · step ${step}/${max}` : ""} `;
  const body = boxBlock([activityRow, metricsRow], cols, { glyphs: g, paint: gray, paintShadow: useColor ? (s: string) => chalk.dim(chalk.gray(s)) : undefined, align: "left" });
  // Embed the title into the top border (welcome-box style).
  const titleText = `${g.h}${title}`;
  const room2 = inner - visibleWidth(titleText);
  const top = g.tl + titleText + (room2 > 0 ? g.h.repeat(room2) : "") + g.tr;
  body[0] = useColor ? gray(g.tl + g.h) + chalk.cyan.bold(title) + gray(g.h.repeat(Math.max(0, room2)) + g.tr) : top;
  return body;
}
