/** Horizontal percent/progress meter for pipeline + doctor TUI views (TUI M4). */

/** Render a `[####----] 50%` meter. `value`/`max` clamp to [0,1]; width is the bar cell count. */
export function meter(value: number, max = 1, width = 20): string {
  const ratio = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  const filled = Math.round(ratio * width);
  const bar = "#".repeat(filled) + "-".repeat(width - filled);
  return `[${bar}] ${Math.round(ratio * 100)}%`;
}

/** Render a `3/10` step counter with a trailing meter. */
export function stepMeter(step: number, total: number, width = 20): string {
  return `${step}/${total} ${meter(step, total, width)}`;
}
