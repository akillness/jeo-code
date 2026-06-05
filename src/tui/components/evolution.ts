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

/**
 * ASCII-only spinner fallback, one set per stage, for terminals that cannot
 * render braille/box-drawing (`supportsUnicode === false`). Index-aligned with
 * `EVOLUTION_SPINNER_FRAMES`.
 */
export const EVOLUTION_SPINNER_FRAMES_ASCII: readonly string[][] = [
  [".", "..", "...", "....", "...", ".."],
  ["-", "=", "~", "="],
  ["|", "/", "-", "\\"],
  ["[.  ]", "[.. ]", "[...]", "[ ..]", "[  .]", "[   ]"],
  ["+", "x", "*", "x"],
];

/** Stage spinner frames honoring unicode capability (defaults to unicode). */
export function spinnerFramesFor(stageIndex: number, unicode = true): string[] {
  const table = unicode ? EVOLUTION_SPINNER_FRAMES : EVOLUTION_SPINNER_FRAMES_ASCII;
  return [...table[clampStageIndex(stageIndex)]!];
}

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

/** ASCII-only meter glyphs (stage 4's block glyphs swapped for `#`/`-`). */
export const EVOLUTION_METER_GLYPHS_ASCII: readonly MeterGlyphs[] = [
  { fill: "o", empty: ".", color: chalk.cyan },
  { fill: "x", empty: " ", color: chalk.green },
  { fill: "=", empty: "-", color: chalk.yellow },
  { fill: "#", empty: "-", color: chalk.magenta },
  { fill: "#", empty: "-", color: chalk.blue },
];

/** Stage meter glyphs honoring unicode capability (defaults to unicode). */
export function meterGlyphsFor(stageIndex: number, unicode = true): MeterGlyphs {
  const table = unicode ? EVOLUTION_METER_GLYPHS : EVOLUTION_METER_GLYPHS_ASCII;
  return table[clampStageIndex(stageIndex)]!;
}

/**
 * Per-stage truecolor gradient palette (`from` → `to` hex), index-aligned with
 * the stage tables. Drives smooth per-character gradients in the ASCII art when
 * the terminal supports it; downgrades to 256/16/plain via `src/tui/components/color.ts`.
 * The palette traces a cosmic arc: cyan tide → green helix → amber tools →
 * magenta machine → white-hot singularity.
 */
export interface StageGradient {
  from: string;
  to: string;
}

export const EVOLUTION_STAGE_GRADIENTS: readonly StageGradient[] = [
  { from: "#0a3d62", to: "#48dbfb" }, // Primordial Cell — deep tide → bright cyan
  { from: "#10ac84", to: "#7bed9f" }, // Double Helix — emerald → mint
  { from: "#ff9f1a", to: "#feca57" }, // Tool User — amber → gold
  { from: "#8e44ad", to: "#f368e0" }, // AI Coding Agent — violet → magenta
  { from: "#5352ed", to: "#ffffff" }, // Singularity — indigo → white-hot
];

/** Gradient palette for a stage index (clamped). */
export function stageGradient(index: number): StageGradient {
  return EVOLUTION_STAGE_GRADIENTS[clampStageIndex(index)]!;
}

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
export function evolutionTrack(
  activeIndex: number,
  opts: { color?: boolean; unicode?: boolean; ratio?: number } = {},
): string {
  const active = clampStageIndex(activeIndex);
  const useColor = opts.color !== false;
  const unicode = opts.unicode !== false;
  const filled = unicode ? "\u25cf" : "#"; // ● / #
  const empty = unicode ? "\u25cb" : "-"; // ○ / -
  const half = unicode ? "\u25d0" : "+"; // ◐ / +  (in-progress next stage)
  // The next (not-yet-reached) stage shows a half marker while progress within
  // the current stage is partway (continuous sub-stage feedback).
  const ratio = opts.ratio;
  const nextPartial = ratio !== undefined && Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? active + 1 : -1;
  let markers = "";
  for (let i = 0; i < EVOLUTION_STAGE_COUNT; i++) {
    const glyph = i <= active ? filled : i === nextPartial ? half : empty;
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
  /** True iff the most recent `observe` increased the peak stage (a transition). */
  advanced(): boolean;
  reset(): void;
}

export function createStageProgress(): StageProgress {
  let peak = 0;
  let justAdvanced = false;
  return {
    observe(step: number, maxSteps: number): number {
      const next = Math.max(peak, stageIndexForStep(step, maxSteps));
      justAdvanced = next > peak;
      peak = next;
      return peak;
    },
    current() {
      return peak;
    },
    advanced() {
      return justAdvanced;
    },
    reset() {
      peak = 0;
      justAdvanced = false;
    },
  };
}
export const EVOLUTION_STAGE_TIPS: readonly string[] = [
  "Primordial code is forming. Use /model to switch models if details are lost.",
  "DNA replication in progress. Use /compact to clean up long context histories.",
  "Tool use discovered! The agent can run read/write/edit/bash/find/search tools.",
  "AI reasoning active. You can run workflow skills like deep-interview, ralplan, team, and ultragoal.",
  "Cosmic singularity reached. Your agent has evolved to maximum intelligence.",
];

export function getEvolutionTip(step: number, maxSteps: number): string {
  const idx = stageIndexForStep(step, maxSteps);
  return EVOLUTION_STAGE_TIPS[idx]!;
}
export const EVOLUTION_STAGE_STATUS_MESSAGES: readonly string[][] = [
  ["Synthesizing primordial logic...", "Forming basic concepts...", "Replicating data structures..."],
  ["Transcribing instructions...", "Binding code blocks...", "Mapping logic pathways..."],
  ["Analyzing codebase structure...", "Grasping edit patterns...", "Executing tool commands..."],
  ["Formulating execution plan...", "Refining syntax trees...", "Resolving type boundaries..."],
  ["Achieving absolute consensus...", "Optimizing to zero entropy...", "Transcending human limits..."],
];

export function getEvolutionStatusMessage(step: number, maxSteps: number, tickCount: number): string {
  const stageIdx = stageIndexForStep(step, maxSteps);
  const pool = EVOLUTION_STAGE_STATUS_MESSAGES[stageIdx]!;
  return pool[tickCount % pool.length]!;
}

/**
 * Fraction [0,1] of progress *within the current stage's band* — drives smooth
 * sub-stage animation (e.g. a partially-filled "next stage" marker). Step 0 and
 * non-positive/non-finite inputs yield 0; beyond budget yields 1.
 */
export function stageProgressRatio(step: number, maxSteps: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  if (!Number.isFinite(maxSteps) || maxSteps <= 0) return 0;
  const r = step / maxSteps;
  if (r <= 0.25) return r / 0.25;
  if (r <= 0.5) return (r - 0.25) / 0.25;
  if (r <= 0.75) return (r - 0.5) / 0.25;
  return Math.min(1, (r - 0.75) / 0.25);
}

/** Whole-turn completion ratio [0,1] (step against budget). */
export function overallProgress(step: number, maxSteps: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  if (!Number.isFinite(maxSteps) || maxSteps <= 0) return 0;
  return Math.max(0, Math.min(1, step / maxSteps));
}

/** Name of the next stage (clamped at the final stage). */
export function nextStageName(step: number, maxSteps: number): string {
  return EVOLUTION_STAGE_NAMES[clampStageIndex(stageIndexForStep(step, maxSteps) + 1)]!;
}

/**
 * Whole steps remaining until the stage index increases. Returns 0 at the final
 * stage. Bounded loop so a pathological `maxSteps` cannot spin forever.
 */
export function stepsToNextStage(step: number, maxSteps: number): number {
  const cur = stageIndexForStep(step, maxSteps);
  if (cur >= EVOLUTION_STAGE_COUNT - 1) return 0;
  let s = Math.max(0, Math.trunc(Number.isFinite(step) ? step : 0));
  let n = 0;
  const cap = Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps * 2 + 10 : 10;
  while (stageIndexForStep(s, maxSteps) <= cur && n < cap) {
    s++;
    n++;
  }
  return n;
}

/** Per-stage transition message, shown when the agent first enters a stage. */
export const EVOLUTION_TRANSITION_MESSAGES: readonly string[] = [
  "Spark of life — a primordial cell stirs.",
  "Strands align — the double helix forms.",
  "Tools in hand — the agent learns to build.",
  "Cognition online — the AI coding agent awakens.",
  "Singularity — intelligence transcends its bounds.",
];

/** Transition message for a stage index (clamped). */
export function transitionMessage(index: number): string {
  return EVOLUTION_TRANSITION_MESSAGES[clampStageIndex(index)]!;
}
