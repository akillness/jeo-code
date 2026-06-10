import chalk from "chalk";
import { renderHud, type JocPhase } from "../components/hud";
import { evolutionTrack, stageIndexForStep } from "../components/evolution";

export interface MonitorState {
  phase: JocPhase;
  step: number;
  maxSteps: number;
  analysisReport?: string;
}

export function renderMonitorView(state: MonitorState): string {
  const hud = renderHud(state.phase, { unicode: true, color: true });
  const stage = stageIndexForStep(state.step, state.maxSteps);
  const evo = evolutionTrack(stage, { color: true });
  
  let output = "";
  output += chalk.bold("=== joc Sovereign Monitoring HUD ===") + "\n";
  output += chalk.bold("HUD Status:") + " " + hud + "\n";
  output += chalk.bold("Evolution:") + " " + evo + "\n";
  output += chalk.dim("Step: " + state.step + "/" + state.maxSteps) + "\n";
  
  if (state.analysisReport) {
    output += "\n" + chalk.yellow.bold("--- Self-Analysis Report ---") + "\n";
    output += state.analysisReport;
  }
  
  return output;
}
