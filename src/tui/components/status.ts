import chalk from "chalk";
import { categoryBadge } from "./category-index";

import { animatedGradientText, applyBgGradient, hexToRgb, visibleWidth, ColorLevel } from "./color";
import * as os from "node:os";
import { formatUsage } from "./duration";
import { formatCost } from "../../ai/pricing";
import { applyDimensionalGradient, stageGradient, stageIndexForStep } from "./evolution";

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
  /** PromptRouter's resolved tier ("trivial"/"standard"/"complex") when THIS turn's
   *  model was chosen by routing rather than the session/default model directly —
   *  omitted when routing didn't engage this turn (pinned model, routing off, or
   *  the credential-readiness gate fell back). Renders as a persistent `⚡tier`
   *  marker so the routed model stays visible without depending on the transient
   *  `[route] …` console notice, which intentionally stays silent for routine
   *  unescalated `standard`-tier turns. */
  routedTier?: "trivial" | "standard" | "complex";
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
  if (d.routedTier) modelBit += ` ${unicode ? "⚡" : "~"}${d.routedTier}`;
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
    ? applyDimensionalGradient(left, Date.now(), grad.from, grad.to, level, true)
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
  const useColor = data.color !== false;
  const elapsed = `${seconds(data.elapsedMs)}s`;
  let msg = data.message ?? "thinking through the next tool call";
  const level = data.colorLevel ?? (useColor ? ColorLevel.TrueColor : ColorLevel.None);
  if (useColor && level !== ColorLevel.None && (data.isThinking !== false)) {
    let fromHex = "#0a3d62";
    let toHex = "#48dbfb";
    if (data.palette && data.palette.length > 0) {
      fromHex = data.palette[0]!;
      toHex = data.palette[data.palette.length - 1]!;
    } else {
      const stageIdx = stageIndexForStep(data.step ?? 0, data.maxSteps ?? 25);
      const grad = stageGradient(stageIdx);
      fromHex = grad.from;
      toHex = grad.to;
    }
    msg = applyDimensionalGradient(msg, Date.now(), fromHex, toHex, level, false);
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
    extraStats += ` · now ${(data.stepElapsedMs! / 1000).toFixed(1)}s`;
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
  // No step counter / step-driven meter here: with the dynamic step budget the
  // denominator keeps extending, so `step n/m` carried no information (user feedback).
  return [
    `  ${categoryBadge("progress", { color: useColor })} elapsed ${elapsed}${extraStats}`,
    `  ${categoryBadge("status", { color: useColor })} ${cyanBold("jeo status")} · ${msg}`,
    `  ${categoryBadge("tool", { color: useColor })} ${magentaBold("jeo forge")} · ${stage}${current} · tools ${total} (${toolCounts})${guard}`,
  ];

}

export interface StatusBoxData extends JeoStatusData {
  /** Frame width the status lines should fit. */
  cols: number;
  /** Phase label leading the activity row (thinking/planning/executing/reporting). */
  phaseLabel?: string;
  /** Current spinner frame glyph. */
  spinner?: string;
  /** Live streamed model activity (reasoning/uniform fallback); overrides `message`. */
  activity?: string;
  /** Append gjc's ⟦esc⟧ cancel hint to the activity row. */
  escHint?: boolean;
}

/**
 * Live status lines — UNBOXED (user feedback: the message/status must not be
 * trapped inside a border). A fixed two-row layout:
 *
 *   ⠙ thinking · <live reasoning / current activity>          ⟦esc⟧
 *     12s · now 2.5s · avg 2.5s · 8.2k in / 30 out · ⤴ 6/s · 2 ok
 *
 * The spinner + dim phase label lead the live thinking text, the cancel hint is
 * right-aligned, and one compact dim metrics row folds timing/usage/rate/cost/
 * tool-counts together. Step counters and the step-driven meter are deliberately
 * absent: the dynamic step budget keeps extending the denominator, so `step n/m`
 * carried no information.
 */
export function renderStatusBox(data: StatusBoxData): string[] {
  const unicode = data.unicode !== false;
  const useColor = data.color !== false;
  const cols = Math.max(24, Math.trunc(data.cols));
  const dim = useColor ? chalk.dim : (s: string) => s;
  const gray = useColor ? chalk.gray : (s: string) => s;

  // Activity row: spinner + phase + live thinking text (+ right-aligned ⟦esc⟧).
  let activity = (data.activity?.trim() || data.message || "thinking through the next tool call").replace(/\s+/g, " ");
  const level = data.colorLevel ?? (useColor ? ColorLevel.TrueColor : ColorLevel.None);
  const esc = data.escHint ? (unicode ? "⟦esc⟧" : "[esc]") : "";
  const spin = data.spinner ?? "";
  const phaseLabel = data.phaseLabel ?? "thinking";
  const headPlain = `${spin ? `${spin} ` : ""}${phaseLabel} ${unicode ? "·" : "-"} `;
  const room = Math.max(8, cols - 1 - visibleWidth(headPlain) - (esc ? visibleWidth(esc) + 1 : 0));
  if (visibleWidth(activity) > room) {
    let w = 0; let cut = "";
    for (const ch of activity) {
      const cw = visibleWidth(ch);
      if (w + cw > room - 1) break;
      cut += ch; w += cw;
    }
    activity = cut + (unicode ? "…" : "...");
  }
  const plainActivityWidth = visibleWidth(activity);
  if (useColor && level !== ColorLevel.None && (data.isThinking !== false)) {
    let fromHex = "#0a3d62";
    let toHex = "#48dbfb";
    if (data.palette && data.palette.length > 0) {
      fromHex = data.palette[0]!;
      toHex = data.palette[data.palette.length - 1]!;
    } else {
      const stageIdx = stageIndexForStep(data.step ?? 0, data.maxSteps ?? 25);
      const grad = stageGradient(stageIdx);
      fromHex = grad.from;
      toHex = grad.to;
    }
    activity = applyDimensionalGradient(activity, Date.now(), fromHex, toHex, level, false);
  }
  const escPad = esc
    ? " ".repeat(Math.max(1, cols - 1 - visibleWidth(headPlain) - plainActivityWidth - visibleWidth(esc))) + dim(esc)
    : "";
  const head = useColor
    ? `${spin ? `${spin} ` : ""}${chalk.cyan.bold(phaseLabel)} ${dim(unicode ? "·" : "-")} `
    : headPlain;
  const activityRow = ` ${head}${activity}${escPad}`;

  // Compact metrics row: elapsed · now/avg timing · usage · rate · cost · tools.
  const bits: string[] = [`${seconds(data.elapsedMs)}s`];
  if (Number.isFinite(data.stepElapsedMs)) bits.push(`now ${(data.stepElapsedMs! / 1000).toFixed(1)}s`);
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
  // Width-fit by dropping trailing WHOLE segments (never mid-ANSI cuts): the
  // leading elapsed/timing bits carry the most signal and always survive.
  const metricsIndent = "   ";
  const maxMetricsWidth = Math.max(8, cols - metricsIndent.length);
  while (bits.length > 1 && visibleWidth(bits.join(" · ")) > maxMetricsWidth) bits.pop();
  const metricsRow = `${metricsIndent}${gray(bits.join(" · "))}`;
  return [activityRow, metricsRow];
}
