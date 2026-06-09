import chalk from "chalk";
import { meter } from "./meter";
import { categoryBadge } from "./category-index";

export interface JocStatusData {
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
  const pct = progressPercent(step, max);
  const useColor = data.color !== false;
  const bar = meter(step, max || 1, 10, { unicode: data.unicode !== false, color: useColor });
  const elapsed = `${seconds(data.elapsedMs)}s`;
  const msg = data.message ?? "thinking through the next tool call";
  const current = data.currentTool ? `forging ${data.currentTool}` : "forge idle";
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

  return [
    `  ${categoryBadge("progress", { color: useColor })} ${cyanBold("joc thinking")} · ${msg} · step ${step}/${max} · ${pct}% ${bar} · ${elapsed}`,
    `  ${categoryBadge("tool", { color: useColor })} ${magentaBold("joc forge")} · ${current} · tools ${total} (${toolCounts})${guard}`,
  ];
}
