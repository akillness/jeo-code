import chalk from "chalk";

/**
 * Canonical "evolution" model for the joc TUI (single source of truth).
 *
 * Every evolving surface — the ASCII art, the spinner, the progress meter, and
 * the footer track — derives its stage from the functions and tables here, so a
 * turn evolves in lockstep instead of each component drifting with its own
 * threshold copy. Five stages map an agent's progress from a primordial cell to
 * a singularity:
 *
 *   0 Primordial Cell → 1 Double Helix → 2 Tool User → 3 AI Coding Agent → 4 Singularity
 */
export const EVOLUTION_STAGE_COUNT = 5;

export const EVOLUTION_STAGE_NAMES: readonly string[] = [
  "Primordial Cell",
  "Double Helix (DNA)",
  "Tool User (Homo Habilis)",
  "AI Coding Agent",
  "Super intelligence (Singularity)",
];

/** Per-stage accent color (chalk). Index-aligned with the stage tables. */
export const EVOLUTION_STAGE_COLORS: readonly ((s: string) => string)[] = [
  s => chalk.cyan(s),
  s => chalk.green(s),
  s => chalk.yellow(s),
  s => chalk.magenta(s),
  s => chalk.blue(s),
];

/** Spinner frame sets, one per evolution stage. */
export const EVOLUTION_SPINNER_FRAMES: readonly string[][] = [
  [".", "..", "...", "....", "...", ".."],
  ["\u2801", "\u2802", "\u2804", "\u2808", "\u2810", "\u2820"],
  ["|", "/", "-", "\\"],
  ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"],
  ["\u25dc", "\u25dd", "\u25de", "\u25df"],
];

export interface MeterGlyphs {
  fill: string;
  empty: string;
  color: (s: string) => string;
}

/** Progress-bar fill/empty glyphs + color, one per evolution stage. */
export const EVOLUTION_METER_GLYPHS: readonly MeterGlyphs[] = [
  { fill: "o", empty: ".", color: chalk.cyan },
  { fill: "x", empty: " ", color: chalk.green },
  { fill: "=", empty: "-", color: chalk.yellow },
  { fill: "#", empty: "-", color: chalk.magenta },
  { fill: "\u2588", empty: "\u2591", color: chalk.blue },
];

/** Clamp any index into the valid stage range [0, COUNT-1]. */
export function clampStageIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(EVOLUTION_STAGE_COUNT - 1, Math.trunc(index)));
}

/**
 * Canonical stage for a discrete agent step against a step budget. Step 0 is
 * always the primordial stage; thereafter progress is split into quartiles.
 * Guards against non-finite / non-positive `maxSteps`.
 */
export function stageIndexForStep(step: number, maxSteps: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  if (!Number.isFinite(maxSteps) || maxSteps <= 0) return 0;
  const ratio = step / maxSteps;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/**
 * Canonical stage for a continuous progress ratio in [0,1] (used by the meter,
 * which measures generic completion rather than agent steps). Five equal-ish
 * bands; non-finite ratios fall back to stage 0.
 */
export function stageIndexForRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  const r = Math.max(0, Math.min(1, ratio));
  if (r <= 0.2) return 0;
  if (r <= 0.4) return 1;
  if (r <= 0.6) return 2;
  if (r <= 0.8) return 3;
  return 4;
}

/** Stage name for a discrete step (convenience for footers/summaries). */
export function evolutionStageName(step: number, maxSteps: number): string {
  return EVOLUTION_STAGE_NAMES[stageIndexForStep(step, maxSteps)]!;
}

/**
 * Render a compact evolution track, e.g. `●●●○○ Tool User (Homo Habilis) [3/5]`.
 * The active marker is tinted with the stage color; pass `color: false` for
 * plain (NO_COLOR / non-TTY) output.
 */
export function evolutionTrack(activeIndex: number, opts: { color?: boolean } = {}): string {
  const active = clampStageIndex(activeIndex);
  const useColor = opts.color !== false;
  let markers = "";
  for (let i = 0; i < EVOLUTION_STAGE_COUNT; i++) {
    const glyph = i <= active ? "\u25cf" : "\u25cb"; // ● filled / ○ empty
    if (useColor && i === active) {
      markers += EVOLUTION_STAGE_COLORS[i]!(glyph);
    } else {
      markers += glyph;
    }
  }
  return `${markers} ${EVOLUTION_STAGE_NAMES[active]} [${active + 1}/${EVOLUTION_STAGE_COUNT}]`;
}

/**
 * Monotonic stage progress: evolution should only move forward within a turn.
 * `observe(step, maxSteps)` returns the highest stage seen so far, so a transient
 * step drop (e.g. a retry resetting the counter) never visibly "devolves" the UI.
 */
export interface StageProgress {
  observe(step: number, maxSteps: number): number;
  current(): number;
  reset(): void;
}

export function createStageProgress(): StageProgress {
  let peak = 0;
  return {
    observe(step: number, maxSteps: number): number {
      peak = Math.max(peak, stageIndexForStep(step, maxSteps));
      return peak;
    },
    current() {
      return peak;
    },
    reset() {
      peak = 0;
    },
  };
}
