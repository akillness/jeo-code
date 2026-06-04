export interface FooterData {
  model: string;
  provider?: string;
  step?: number;
  maxSteps?: number;
  elapsedMs?: number;
  sessionId?: string;
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

  return parts.join(" · ");
}
