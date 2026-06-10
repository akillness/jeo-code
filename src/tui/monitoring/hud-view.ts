import chalk from "chalk";
import { renderHud, derivePhase, type JocPhase } from "../components/hud";
import { evolutionTrack } from "../components/evolution";

export interface MonitorState {
  phase: JocPhase;
  step: number;
  maxSteps: number;
  analysisReport?: string;
}

export function renderMonitorView(state: MonitorState): string {
  const hud = renderHud(state.phase, { unicode: true, color: true });
  const evo = evolutionTrack(state.step, { color: true });
  
  let output = ;
  output += ;
  output += ;
  
  if (state.analysisReport) {
    output += ;
    output += state.analysisReport;
  }
  
  return output;
}
