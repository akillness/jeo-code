import { EVOLUTION_METER_GLYPHS, stageIndexForRatio } from "./evolution";

/** Horizontal evolutionary percent/progress meter for pipeline + doctor TUI views. */

/**
 * Render an evolutionary `[#####-----] 50%` meter. The fill/empty glyphs and
 * color evolve through the five canonical stages as the ratio rises, so the
 * meter shares the same visual vocabulary as the spinner and ASCII art.
 * `value`/`max` clamp to a [0,1] ratio; `width` is the bar cell count.
 */
export function meter(value: number, max = 1, width = 20): string {
  const ratio = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  const cells = Math.max(0, Math.trunc(width));
  const filledCount = Math.round(ratio * cells);
  const { fill, empty, color } = EVOLUTION_METER_GLYPHS[stageIndexForRatio(ratio)]!;
  const bar = color(fill.repeat(filledCount)) + empty.repeat(cells - filledCount);
  return `[${bar}] ${Math.round(ratio * 100)}%`;
}

/** Render a `3/10` step counter with a trailing meter. Guards a non-positive total. */
export function stepMeter(step: number, total: number, width = 20): string {
  const safeTotal = total > 0 ? total : 0;
  return `${step}/${safeTotal} ${meter(step, safeTotal, width)}`;
}

/** Render a labeled meter, e.g. `tokens [#####-----] 50%`. Empty label → bare meter. */
export function meterLabeled(label: string, value: number, max = 1, width = 20): string {
  const bar = meter(value, max, width);
  return label ? `${label} ${bar}` : bar;
}
