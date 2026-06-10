import chalk from "chalk";
import { meter } from "./meter";
import { categoryBadge } from "./category-index";
import { animatedGradientText, ColorLevel } from "./color";

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


  return [
    `  ${categoryBadge("progress", { color: useColor })} step ${step}/${max} · ${bar} · elapsed ${elapsed}${extraStats}`,
    `  ${categoryBadge("status", { color: useColor })} ${cyanBold("joc status")} · ${msg}`,
    `  ${categoryBadge("tool", { color: useColor })} ${magentaBold("joc forge")} · ${stage}${current} · tools ${total} (${toolCounts})${guard}`,
  ];
}
