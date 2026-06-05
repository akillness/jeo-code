import { stageIndexForStep, EVOLUTION_STAGE_NAMES, EVOLUTION_STAGE_COUNT } from "./evolution";

export interface FooterData {
  model: string;
  provider?: string;
  step?: number;
  maxSteps?: number;
  elapsedMs?: number;
  sessionId?: string;
  /** Append a compact evolution-stage tag (default true when step+maxSteps known). */
  showStage?: boolean;
}

export function renderFooter(d: FooterData): string {
  const parts: string[] = [];

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

  // Session ID
  if (d.sessionId) {
    parts.push(d.sessionId.slice(0, 8));
  }

  // Compact evolution-stage tag, e.g. "evo 3/5 Tool User (Homo Habilis)".
  if (d.showStage !== false && d.step !== undefined && d.maxSteps !== undefined) {
    const idx = stageIndexForStep(d.step, d.maxSteps);
    parts.push(`evo ${idx + 1}/${EVOLUTION_STAGE_COUNT} ${EVOLUTION_STAGE_NAMES[idx]}`);
  }

  return parts.join(" · ");
}
