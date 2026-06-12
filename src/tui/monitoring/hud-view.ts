import chalk from "chalk";
import { renderHud, type JeoPhase } from "../components/hud";
import { 
  evolutionTrack, 
  stageIndexForStep, 
  getEvolutionStatusMessage,
  stageProgressRatio,
  meterGlyphsFor,
  EVOLUTION_STAGE_COLORS
} from "../components/evolution";

export interface MonitorState {
  phase: JeoPhase;
  step: number;
  maxSteps: number;
  tickCount: number;
  analysisReport?: string;
}

export function renderMonitorView(state: MonitorState): string {
  const unicode = true;
  const stage = stageIndexForStep(state.step, state.maxSteps);
  const hud = renderHud(state.phase, { unicode, color: true });
  const evo = evolutionTrack(stage, { color: true, unicode, ratio: state.step / state.maxSteps });
  const statusMsg = getEvolutionStatusMessage(state.step, state.maxSteps, state.tickCount);
  
  // Progress Bar / Meter
  const ratio = Math.max(0, Math.min(1, state.step / state.maxSteps));
  const barWidth = 30;
  const filledWidth = Math.round(ratio * barWidth);
  const glyphs = meterGlyphsFor(stage, unicode);
  const bar = glyphs.color(glyphs.fill.repeat(filledWidth)) + chalk.dim(glyphs.empty.repeat(barWidth - filledWidth));
  const percentage = (ratio * 100).toFixed(1) + "%";

  let output = "";
  output += chalk.bold.cyan("┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓") + "\n";
  output += chalk.bold.cyan("┃") + " " + chalk.bold.yellow("ooo ralph") + chalk.bold(" Sovereign Monitoring HUD") + " ".repeat(25) + chalk.bold.cyan("┃") + "\n";
  output += chalk.bold.cyan("┠──────────────────────────────────────────────────────────────┨") + "\n";
  output += chalk.bold.cyan("┃") + " " + chalk.bold("PHASE:") + " " + hud.padEnd(50) + " ".repeat(4) + chalk.bold.cyan("┃") + "\n";
  output += chalk.bold.cyan("┃") + " " + chalk.bold("EVO  :") + " " + evo.padEnd(50) + " ".repeat(4) + chalk.bold.cyan("┃") + "\n";
  output += chalk.bold.cyan("┃") + " " + chalk.bold("PROG :") + " " + bar.padEnd(50) + " " + chalk.bold(percentage).padStart(6) + chalk.bold.cyan("┃") + "\n";
  output += chalk.bold.cyan("┠──────────────────────────────────────────────────────────────┨") + "\n";
  output += chalk.bold.cyan("┃") + " " + chalk.italic.dim("> " + statusMsg).padEnd(60) + " " + chalk.bold.cyan("┃") + "\n";
  
  if (state.analysisReport) {
    output += chalk.bold.cyan("┠──────────────────────────────────────────────────────────────┨") + "\n";
    const lines = state.analysisReport.split("\n").slice(0, 5);
    for (const line of lines) {
      output += chalk.bold.cyan("┃") + " " + chalk.yellow(line.substring(0, 58).padEnd(58)) + " " + chalk.bold.cyan("┃") + "\n";
    }
  }
  output += chalk.bold.cyan("┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛") + "\n";
  
  return output;
}
