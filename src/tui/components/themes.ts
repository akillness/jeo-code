/**
 * Evolution TUI themes — selectable palettes for the five-stage identity.
 *
 * A theme only re-skins the *colors* (per-stage gradient palettes) and whether
 * color is emitted at all. The stage model, art, spinner, meter glyphs, and
 * track structure are theme-independent, so switching a theme never changes
 * layout — only the look. `cosmic` is the default; `mono` is the colorless
 * fallback for plain terminals.
 */
import { EVOLUTION_STAGE_GRADIENTS, EVOLUTION_STAGE_COUNT, type StageGradient } from "./evolution";
import { clampStageIndex } from "./evolution";
import type { EnvLike } from "./color";

export interface EvolutionTheme {
  name: string;
  description: string;
  /** Per-stage gradient palettes (index-aligned, length EVOLUTION_STAGE_COUNT). */
  gradients: readonly StageGradient[];
  /** Whether the theme emits color at all (`mono` = false → plain output). */
  color: boolean;
}

const COSMIC: EvolutionTheme = {
  name: "cosmic",
  description: "Default — deep-space arc from cyan tide to white-hot singularity.",
  gradients: EVOLUTION_STAGE_GRADIENTS,
  color: true,
};

const MATRIX: EvolutionTheme = {
  name: "matrix",
  description: "Terminal green — every stage glows in shades of phosphor green.",
  gradients: [
    { from: "#003b00", to: "#00ff41" },
    { from: "#005f00", to: "#39ff14" },
    { from: "#008f11", to: "#7fff00" },
    { from: "#00b300", to: "#aaff00" },
    { from: "#00ff41", to: "#ccffcc" },
  ],
  color: true,
};

const SOLAR: EvolutionTheme = {
  name: "solar",
  description: "Warm star — embers to corona, red through gold to white.",
  gradients: [
    { from: "#7a1f00", to: "#ff6b00" },
    { from: "#a83200", to: "#ff8c00" },
    { from: "#d35400", to: "#ffb700" },
    { from: "#e67e22", to: "#ffd24a" },
    { from: "#ff8c00", to: "#fff5cc" },
  ],
  color: true,
};

const MONO: EvolutionTheme = {
  name: "mono",
  description: "Colorless — plain text for NO_COLOR / minimal terminals.",
  gradients: EVOLUTION_STAGE_GRADIENTS,
  color: false,
};

export const THEMES: readonly EvolutionTheme[] = [COSMIC, MATRIX, SOLAR, MONO];

/** Look up a theme by name (case-insensitive); unknown names fall back to cosmic. */
export function getTheme(name: string | undefined): EvolutionTheme {
  if (!name) return COSMIC;
  const lc = name.trim().toLowerCase();
  return THEMES.find(t => t.name === lc) ?? COSMIC;
}

/** Theme names + descriptions for `joc evolve --list-themes`. */
export function listThemes(): { name: string; description: string }[] {
  return THEMES.map(t => ({ name: t.name, description: t.description }));
}

/** Resolve the active theme from the environment (`JOC_TUI_THEME`), default cosmic. */
export function resolveTheme(env: EnvLike = process.env): EvolutionTheme {
  return getTheme(env.JOC_TUI_THEME);
}

/** The gradient palette for a stage index under a theme (clamped). */
export function themeGradient(theme: EvolutionTheme, index: number): StageGradient {
  const i = clampStageIndex(index);
  return theme.gradients[i] ?? theme.gradients[EVOLUTION_STAGE_COUNT - 1]!;
}
