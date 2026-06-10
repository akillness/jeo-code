import { meterGlyphsFor, stageIndexForRatio } from "./evolution";
import { size } from "../terminal";

export interface MeterOptions {
  /** Use ASCII-only glyphs for terminals without unicode (default true = unicode). */
  unicode?: boolean;
  /** Whether to render color (default true). */
  color?: boolean;
}

/** Horizontal evolutionary percent/progress meter for pipeline + doctor TUI views. */

/**
 * Render an evolutionary `[#####-----] 50%` meter. The fill/empty glyphs and
 * color evolve through the five canonical stages as the ratio rises, so the
 * meter shares the same visual vocabulary as the spinner and ASCII art.
 * `value`/`max` clamp to a [0,1] ratio; `width` is the bar cell count.
 */
export function meter(value: number, max = 1, width?: number, opts: MeterOptions = {}): string {
  const ratio = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  const cells = width !== undefined ? Math.max(0, Math.trunc(width)) : Math.max(10, Math.min(40, size().cols - 30));
  const filledCount = Math.round(ratio * cells);
  const { fill, empty, color } = meterGlyphsFor(stageIndexForRatio(ratio), opts.unicode !== false);
  const paint = opts.color !== false ? color : (s: string) => s;
  const bar = paint(fill.repeat(filledCount)) + empty.repeat(cells - filledCount);
  return `[${bar}] ${Math.round(ratio * 100)}%`;
}

/** Render a `3/10` step counter with a trailing meter. Guards a non-positive total. */
export function stepMeter(step: number, total: number, width?: number): string {
  const safeTotal = total > 0 ? total : 0;
  return `${step}/${safeTotal} ${meter(step, safeTotal, width)}`;
}

/** Render a labeled meter, e.g. `tokens [#####-----] 50%`. Empty label → bare meter. */
export function meterLabeled(label: string, value: number, max = 1, width?: number): string {
  const bar = meter(value, max, width);
  return label ? `${label} ${bar}` : bar;
}

const SPARK_UNICODE = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];
const SPARK_ASCII = ["_", ".", ",", "-", "=", "+", "*", "#"];

/**
 * Render a compact sparkline from a series of values, e.g. `▁▂▃▅▇`. Values are
 * normalized against the series max (or `opts.max`). Empty / all-equal series
 * are handled (flat low bar). `opts.unicode:false` uses an ASCII ramp.
 */
export function sparkline(values: number[], opts: { unicode?: boolean; max?: number } = {}): string {
  const ramp = opts.unicode === false ? SPARK_ASCII : SPARK_UNICODE;
  const finite = values.filter(v => Number.isFinite(v));
  if (finite.length === 0) return "";
  const hi = opts.max ?? Math.max(...finite);
  const lo = Math.min(...finite);
  const span = hi - lo;
  const last = ramp.length - 1;
  return finite
    .map(v => {
      if (span <= 0) return ramp[0]!;
      const t = (v - lo) / span;
      return ramp[Math.max(0, Math.min(last, Math.round(t * last)))]!;
    })
    .join("");
}
