/**
 * Evolution TUI themes — selectable palettes for the five-stage identity.
 *
 * A theme only re-skins the *colors* (per-stage gradient palettes) and whether
 * color is emitted at all. The stage model, art, spinner, meter glyphs, and
 * track structure are theme-independent, so switching a theme never changes
 * layout — only the look. `cosmic` is the default; `mono` is the colorless
 * fallback for plain terminals.
 */
import chalk from "chalk";
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
  /** Accent hex for UI chrome — borders, prompt mark, model status bar (gjc-style). */
  accent: string;
}

const COSMIC: EvolutionTheme = {
  name: "cosmic",
  description: "Default — deep-space arc from cyan tide to white-hot singularity.",
  gradients: EVOLUTION_STAGE_GRADIENTS,
  color: true,
  accent: "#48dbfb",
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
  accent: "#39ff14",
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
  accent: "#ff8c00",
};

const RED_CLAW: EvolutionTheme = {
  name: "red-claw",
  description: "Dark theme — crimson claw glowing from deep embers.",
  gradients: [
    { from: "#2b0000", to: "#4a0000" },
    { from: "#4a0000", to: "#8b0000" },
    { from: "#8b0000", to: "#b22222" },
    { from: "#b22222", to: "#dc143c" },
    { from: "#dc143c", to: "#ff0000" },
  ],
  color: true,
  accent: "#e25656",
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
  accent: "#118ab2",
};

const MONO: EvolutionTheme = {
  name: "mono",
  description: "Colorless — plain text for NO_COLOR / minimal terminals.",
  gradients: EVOLUTION_STAGE_GRADIENTS,
  color: false,
  accent: "#ffffff",
};

export const THEMES: readonly EvolutionTheme[] = [COSMIC, MATRIX, SOLAR, RED_CLAW, BLUE_CRAB, MONO];

/** Look up a theme by name (case-insensitive); unknown names fall back to cosmic. */
export function getTheme(name: string | undefined): EvolutionTheme {
  if (!name) return COSMIC;
  const lc = name.trim().toLowerCase();
  return THEMES.find(t => t.name === lc) ?? COSMIC;
}

/** Theme names + descriptions for `jeo evolve --list-themes`. */
export function listThemes(): { name: string; description: string }[] {
  return THEMES.map(t => ({ name: t.name, description: t.description }));
}

/** Process-lifetime memo: this runs on the keystroke-hot path (theme resolution
 *  inside the input-box repaint), and an UNCACHED call does a synchronous
 *  existsSync + readFileSync + JSON.parse of ~/.joc/config.json per keystroke.
 *  Env (`JEO_TUI_THEME`) takes precedence over this value in `resolveTheme`, so
 *  `/theme` switches stay live; external config edits apply on the next run. */
let configThemeCache: { dir: string; value: string | undefined } | undefined;

/** Test-only: clear the config-theme memo. */
export function resetThemeConfigCache(): void {
  configThemeCache = undefined;
}

function getExplicitThemeFromConfig(env: EnvLike): string | undefined {
  const home = os.homedir ? os.homedir() : undefined;
  const dir = env.JEO_CONFIG_DIR || env.JOC_CONFIG_DIR || (home ? path.join(home, ".joc") : undefined);
  if (!dir) return undefined;
  if (configThemeCache && configThemeCache.dir === dir) return configThemeCache.value;
  const filePath = path.join(dir, "config.json");
  let value: string | undefined;
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf-8");
      const config = JSON.parse(data);
      value = config.theme || config.tuiTheme || config.tui?.theme;
    }
  } catch {
    // ignore — treated as "no configured theme"
  }
  configThemeCache = { dir, value };
  return value;
}

/** Resolve the active theme from the environment (`JEO_TUI_THEME`, legacy `JOC_TUI_THEME`) or config, default cosmic. */
export function resolveTheme(
  env: EnvLike = process.env,
  config?: { theme?: string; tuiTheme?: string; tui?: { theme?: string } }
): EvolutionTheme {
  const explicit = env.JEO_TUI_THEME || env.JOC_TUI_THEME || config?.theme || config?.tuiTheme || config?.tui?.theme || getExplicitThemeFromConfig(env);
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

/** A chalk-style painter for the theme's accent color; identity when the theme is colorless. */
export function accentPaint(theme: EvolutionTheme): (s: string) => string {
  if (!theme.color) return (s: string) => s;
  const hex = theme.accent;
  return (s: string) => chalk.hex(hex)(s);
}

/** A dimmed accent painter for the "shaded" box edges (bottom/right). Paired with
 *  `accentPaint` on the lit top/left edges, the two-tone contrast gives every
 *  bordered panel a pseudo-3D depth cue. Identity when the theme is colorless. */
export function accentShadowPaint(theme: EvolutionTheme): (s: string) => string {
  if (!theme.color) return (s: string) => s;
  const hex = theme.accent;
  return (s: string) => chalk.dim(chalk.hex(hex)(s));
}
