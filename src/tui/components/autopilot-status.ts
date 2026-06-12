import chalk from "chalk";
import { padLineTo } from "./layout";
import { truncate } from "../terminal";

export interface AutopilotStatusPanelData {
  task: string;
  goal: string;
  eval: string;
  baseline: string;
  best: string;
  attempts: number;
  kept: number;
  reverted: number;
  sinceImprove: number;
  converged: boolean;
  recommendation: string;
}

export function renderAutopilotStatusPanel(
  data: AutopilotStatusPanelData,
  opts: { cols?: number; unicode?: boolean; color?: boolean } = {},
): string[] {
  const width = Math.max(40, Math.min(120, opts.cols ?? 88));
  const useColor = opts.color !== false;
  const unicode = opts.unicode !== false;
  const ruleChar = unicode ? "─" : "-";
  const arrow = unicode ? "→" : "->";
  const keptMark = unicode ? "✓" : "v";
  const revertedMark = unicode ? "↶" : "r";
  const status = data.converged
    ? "CONVERGED"
    : data.recommendation.startsWith("continue")
      ? "CONTINUE"
      : "STOP";

  const yellow = useColor ? chalk.hex("#f2b84b") : (s: string) => s;
  const title = useColor ? chalk.hex("#f2b84b").bold : (s: string) => s;
  const green = useColor ? chalk.green : (s: string) => s;
  const red = useColor ? chalk.red : (s: string) => s;
  const cyan = useColor ? chalk.cyan : (s: string) => s;
  const dim = useColor ? chalk.dim : (s: string) => s;
  const statusPaint = useColor
    ? status === "CONTINUE"
      ? chalk.green.bold
      : status === "CONVERGED"
        ? chalk.yellow.bold
        : chalk.red.bold
    : (s: string) => s;

  const fit = (line: string) => padLineTo(truncate(line, width), width, "left");
  const rule = yellow(ruleChar.repeat(width));
  const score = `${dim("score")} ${cyan(data.baseline)} ${dim(arrow)} ${cyan(data.best)}`;
  const attempts = `${dim("attempts")} ${data.attempts} · ${green(`${keptMark} ${data.kept} kept`)} · ${red(`${revertedMark} ${data.reverted} reverted`)} · patience ${data.sinceImprove}`;

  return [
    rule,
    fit(`${title("Autopilot Ratchet")} ${statusPaint(status)}`),
    fit(`${dim("task")} ${data.task}`),
    fit(`${dim("eval")} ${data.goal} · ${data.eval}`),
    fit(score),
    fit(attempts),
    fit(`${dim("next")} ${data.recommendation}`),
    rule,
  ];
}
