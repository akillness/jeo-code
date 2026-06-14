import chalk from "chalk";
import { renderHud, type JeoPhase } from "../components/hud";
import { padLineTo } from "../components/layout";
import { visibleWidth, truncateToWidth } from "../components/width";
import {
  evolutionTrack,
  stageIndexForStep,
  getEvolutionStatusMessage,
  meterGlyphsFor,
} from "../components/evolution";

export interface MonitorState {
  phase: JeoPhase;
  step: number;
  maxSteps: number;
  tickCount: number;
  analysisReport?: string;
}

/**
 * The `ooo ralph` sovereign monitoring HUD. Every row is padded by DISPLAY width
 * (ANSI escapes count 0, wide glyphs count 2) and the box auto-sizes to its widest
 * row, so the heavy border stays flush regardless of color/unicode content. The
 * old version padded ANSI-colored strings with `String.padEnd`, which counted the
 * SGR escape bytes and tore the right edge whenever color was on.
 */
export function renderMonitorView(state: MonitorState): string {
  const unicode = true;
  const stage = stageIndexForStep(state.step, state.maxSteps);
  const ratio = Math.max(0, Math.min(1, state.maxSteps > 0 ? state.step / state.maxSteps : 0));

  const hud = renderHud(state.phase, { unicode, color: true });
  const evo = evolutionTrack(stage, { color: true, unicode, ratio });
  const statusMsg = getEvolutionStatusMessage(state.step, state.maxSteps, state.tickCount);

  // Progress meter.
  const barWidth = 30;
  const filledWidth = Math.round(ratio * barWidth);
  const glyphs = meterGlyphsFor(stage, unicode);
  const bar = glyphs.color(glyphs.fill.repeat(filledWidth)) + chalk.dim(glyphs.empty.repeat(barWidth - filledWidth));
  const percentage = chalk.bold((ratio * 100).toFixed(1) + "%");

  const label = (s: string) => chalk.bold(s);
  const title = `${chalk.bold.yellow("ooo ralph")}${chalk.bold(" Sovereign Monitoring HUD")}`;
  const phaseRow = `${label("PHASE:")} ${hud}`;
  const evoRow = `${label("EVO  :")} ${evo}`;
  const progLeft = `${label("PROG :")} ${bar}`;
  const statusRow = chalk.italic.dim(`> ${statusMsg}`);
  const analysisRows = state.analysisReport
    ? state.analysisReport.split("\n").slice(0, 5).map(l => chalk.yellow(l))
    : [];

  // Size the inner content area to the widest row (clamped), then right-align the
  // progress percentage within that width.
  const MIN_INNER = 40;
  const MAX_INNER = 88;
  const measured = [title, phaseRow, evoRow, progLeft, statusRow, ...analysisRows].map(visibleWidth);
  const progMin = visibleWidth(progLeft) + 1 + visibleWidth(percentage);
  const inner = Math.min(MAX_INNER, Math.max(MIN_INNER, progMin, ...measured));

  const progGap = Math.max(1, inner - visibleWidth(progLeft) - visibleWidth(percentage));
  const progRow = `${progLeft}${" ".repeat(progGap)}${percentage}`;

  const paint = chalk.bold.cyan;
  const top = paint("┏" + "━".repeat(inner + 2) + "┓");
  const sep = paint("┠" + "─".repeat(inner + 2) + "┨");
  const bottom = paint("┗" + "━".repeat(inner + 2) + "┛");
  const v = paint("┃");
  const row = (content: string) => `${v} ${padLineTo(truncateToWidth(content, inner), inner, "left")} ${v}`;

  const out: string[] = [top, row(title), sep, row(phaseRow), row(evoRow), row(progRow), sep, row(statusRow)];
  if (analysisRows.length > 0) {
    out.push(sep);
    for (const line of analysisRows) out.push(row(line));
  }
  out.push(bottom);
  return out.join("\n") + "\n";
}
