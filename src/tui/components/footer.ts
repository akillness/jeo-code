import {
  stageIndexForStep,

  overallProgress,
  nextStageName,
  stepsToNextStage,
  evolutionTrack,
  EVOLUTION_STAGE_COUNT,
} from "./evolution";

export interface FooterData {
  model: string;
  provider?: string;
  step?: number;
  maxSteps?: number;
  elapsedMs?: number;
  sessionId?: string;
  /** Append a compact evolution-stage tag (default true when step+maxSteps known). */
  showStage?: boolean;
  /** Use ASCII track markers in the stage tag (default unicode). */
  unicode?: boolean;
  /** Show an estimated time-to-completion (`eta Ns`); opt-in. */
  showEta?: boolean;
  /** Show whole-turn evolution progress (`evo NN%`) + steps to next stage; opt-in. */
  showProgress?: boolean;
  /** Colorize the stage track (default true). Set false for the mono theme. */
  color?: boolean;
}

export function renderFooter(d: FooterData): string {
  const parts: string[] = [];
  const unicode = d.unicode !== false;

  // Model & Provider
  if (d.model) {
    if (d.provider) {
      parts.push(`${d.model} (${d.provider})`);
    } else {
      parts.push(d.model);
    }
  }

  // Step
  if (d.step !== undefined) {
    if (d.maxSteps !== undefined) {
      parts.push(`step ${d.step}/${d.maxSteps}`);
    } else {
      parts.push(`step ${d.step}`);
    }
  }

  // Elapsed
  if (d.elapsedMs !== undefined) {
    const secs = Math.round(d.elapsedMs / 1000);
    parts.push(`${secs}s`);
  }

  // Estimated remaining time (opt-in): linear extrapolation from elapsed/step.
  if (
    d.showEta &&
    d.step !== undefined &&
    // ETA from a single in-flight step is dominated by model-call/backoff latency and
    // produces nonsense like "eta 442s" — require at least one COMPLETED step.
    d.step > 1 &&
    d.maxSteps !== undefined &&
    d.step < d.maxSteps &&
    d.elapsedMs !== undefined &&
    d.elapsedMs > 0
  ) {
    const etaMs = (d.elapsedMs / d.step) * (d.maxSteps - d.step);
    parts.push(`eta ${Math.round(etaMs / 1000)}s`);
  }

  // Whole-turn progress + countdown to the next stage (opt-in).
  if (d.showProgress && d.step !== undefined && d.maxSteps !== undefined) {
    const pct = Math.round(overallProgress(d.step, d.maxSteps) * 100);
    const idx = stageIndexForStep(d.step, d.maxSteps);
    if (idx < EVOLUTION_STAGE_COUNT - 1) {
      const remaining = stepsToNextStage(d.step, d.maxSteps);
      const arrow = unicode ? "\u2192" : "->";
      parts.push(`evo ${pct}% ${arrow} ${nextStageName(d.step, d.maxSteps)} in ${remaining}`);
    } else {
      parts.push(`evo ${pct}%`);
    }
  }

  // Session ID
  if (d.sessionId) {
    parts.push(d.sessionId.slice(0, 8));
  }

  // Compact evolution-stage tag, e.g. "●●●○○ Tool User (Homo Habilis) [3/5]".
  if (d.showStage !== false && d.step !== undefined && d.maxSteps !== undefined) {
    const idx = stageIndexForStep(d.step, d.maxSteps);
    parts.push(evolutionTrack(idx, { color: d.color !== false, unicode }));
  }

  return parts.join(" · ");
}
