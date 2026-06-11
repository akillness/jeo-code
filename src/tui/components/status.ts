import chalk from "chalk";
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

export interface JocStatusData {
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

export function renderJocStatus(data: JocStatusData): string[] {
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


  const bgPaint = data.palette && data.palette.length > 0 && data.palette[0] === "#2b0000" ? chalk.bgRed.white : (s: string) => s;
  return [
    `  ${categoryBadge("progress", { color: useColor })} step ${step}/${max} · ${bar} · elapsed ${elapsed}${extraStats}`,
    bgPaint(`  ${categoryBadge("status", { color: useColor })} ${cyanBold("joc status")} · ${msg}`),
    `  ${categoryBadge("tool", { color: useColor })} ${magentaBold("joc forge")} · ${stage}${current} · tools ${total} (${toolCounts})${guard}`,
  ];

}
