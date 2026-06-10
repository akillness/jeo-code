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
import { detectColorLevel, ColorLevel, detectAppearance, type EnvLike } from "./color";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

const RED_CLAW: EvolutionTheme = {
  name: "red-claw",
  description: "Dark theme — crimson claw glowing from deep embers.",
  gradients: [
    { from: "#2b0000", to: "#4a0000" },
    { from: "#4a0000", to: "#8b0000" },
    { from: "#8b0000", to: "#d90429" },
    { from: "#d90429", to: "#ef233c" },
    { from: "#ef233c", to: "#ffffff" },
  ],
  color: true,
};

const BLUE_CRAB: EvolutionTheme = {
  name: "blue-crab",
  description: "Light theme — cool ocean blue crab shell concept for light backgrounds.",
  gradients: [
    { from: "#0a192f", to: "#172a45" },
    { from: "#172a45", to: "#3066be" },
    { from: "#3066be", to: "#118ab2" },
    { from: "#118ab2", to: "#006d77" },
    { from: "#006d77", to: "#023e8a" },
  ],
  color: true,
};

const MONO: EvolutionTheme = {
  name: "mono",
  description: "Colorless — plain text for NO_COLOR / minimal terminals.",
  gradients: EVOLUTION_STAGE_GRADIENTS,
  color: false,
};

export const THEMES: readonly EvolutionTheme[] = [COSMIC, MATRIX, SOLAR, RED_CLAW, BLUE_CRAB, MONO];

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

function getExplicitThemeFromConfig(env: EnvLike): string | undefined {
  const home = os.homedir ? os.homedir() : undefined;
  const dir = env.JOC_CONFIG_DIR || (home ? path.join(home, ".joc") : undefined);
  if (!dir) return undefined;
  const filePath = path.join(dir, "config.json");
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf-8");
      const config = JSON.parse(data);
      return config.theme || config.tuiTheme || config.tui?.theme;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Resolve the active theme from the environment (`JOC_TUI_THEME`) or config, default cosmic. */
export function resolveTheme(
  env: EnvLike = process.env,
  config?: { theme?: string; tuiTheme?: string; tui?: { theme?: string } }
): EvolutionTheme {
  const explicit = env.JOC_TUI_THEME || config?.theme || config?.tuiTheme || config?.tui?.theme || getExplicitThemeFromConfig(env);
  if (explicit) {
    return getTheme(explicit);
  }

  if (detectColorLevel(env) === ColorLevel.None) {
    return getTheme("mono");
  }

  const appearance = detectAppearance(env);
  if (appearance === "light") {
    return getTheme("blue-crab");
  }

  return getTheme("cosmic");
}

/** The gradient palette for a stage index under a theme (clamped). */
export function themeGradient(theme: EvolutionTheme, index: number): StageGradient {
  const i = clampStageIndex(index);
  return theme.gradients[i] ?? theme.gradients[EVOLUTION_STAGE_COUNT - 1]!;
}
