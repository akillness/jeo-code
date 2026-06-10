/**
 * Human-scale duration + token-usage formatting for status lines.
 *
 * gjc renders elapsed time at minute granularity once a turn crosses 60s
 * ("took 3 steps in 1m 45s"), and surfaces live token usage per turn. These
 * helpers are pure so both the TUI footer/summary and the plain stream sink
 * share one formatting contract.
 */

/** Format milliseconds as "42s", "1m 45s", "12m", or "1h 2m" (minute-first past 60s). */
export function formatDuration(ms: number): string {
  const totalSecs = Math.max(0, Math.round(ms / 1000));
  if (totalSecs < 60) return `${totalSecs}s`;
  const totalMins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (totalMins < 60) return secs ? `${totalMins}m ${secs}s` : `${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

/** Compact token count: 950 → "950", 12_345 → "12.3k", 1_234_567 → "1.2M". */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

/** "12.3k in / 1.2k out tokens" — empty string when usage was never reported. */
export function formatUsage(usage?: { inputTokens?: number; outputTokens?: number }): string {
  if (!usage || (usage.inputTokens == null && usage.outputTokens == null)) return "";
  return `${formatTokenCount(usage.inputTokens ?? 0)} in / ${formatTokenCount(usage.outputTokens ?? 0)} out tokens`;
}
