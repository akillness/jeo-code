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
  /** Shadow hex for the "shaded" box edges (bottom/right). A REAL darker hue —
   *  not ANSI dim — so the lit/shaded two-tone reads as depth even on terminals
   *  that render `dim` poorly. Falls back to dim(accent) when unset. */
  accentShadow?: string;
  /** Diff palette: themed +/- contrast for /diff, edit cards, and code views.
   *  `addBg`/`delBg` are full-row background tints that give added/removed
   *  lines block-level separation, not just a colored sign. */
  diff?: { add: string; del: string; addBg: string; delBg: string; hunk: string };
  /** User query card palette: themed colors for the mid-turn steering user card. */
  userCard?: { accent: string; border: string; shadow: string; fill: string };
}

/** Default diff palette (used when a theme defines none): high-contrast
 *  green/red foregrounds over deep complementary background tints. */
export const DEFAULT_DIFF_PALETTE = {
  add: "#9ece6a",
  del: "#f7768e",
  addBg: "#16261c",
  delBg: "#2a1a20",
  hunk: "#7dcfff",
} as const;

const COSMIC: EvolutionTheme = { 
  name: "cosmic",
  description: "Default — deep-space arc from cyan tide to white-hot singularity.",
  gradients: EVOLUTION_STAGE_GRADIENTS,
  color: true,
  accent: "#48dbfb",
  accentShadow: "#1b6f8c",
  userCard: { accent: "#48dbfb", border: "#1b6f8c", shadow: "#0e3c4c", fill: "#081b24" },
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
  accentShadow: "#0b6623",
  diff: { add: "#7fff00", del: "#ff5f5f", addBg: "#0c2410", delBg: "#2a1212", hunk: "#00e5a0" },
  userCard: { accent: "#39ff14", border: "#0b6623", shadow: "#053311", fill: "#031a08" },
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
  accentShadow: "#8a4500",
  userCard: { accent: "#ff8c00", border: "#8a4500", shadow: "#452200", fill: "#241100" },
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
  accentShadow: "#5c0f0f",
  userCard: { accent: "#e25656", border: "#5c0f0f", shadow: "#2e0707", fill: "#170303" },
};

const BLUE_CRAB: EvolutionTheme = {
  name: "blue-crab",
  description: "Bioluminescent ocean — abyssal navy through reef teal to seafoam glow (light-background friendly).",
  gradients: [
    { from: "#03045e", to: "#0077b6" },
    { from: "#0077b6", to: "#00b4d8" },
    { from: "#00b4d8", to: "#06d6a0" },
    { from: "#0096c7", to: "#48cae4" },
    { from: "#48cae4", to: "#caf0f8" },
  ],
  color: true,
  accent: "#0096c7",
  accentShadow: "#023e8a",
  diff: { add: "#06d6a0", del: "#ef476f", addBg: "#0a2922", delBg: "#2b1320", hunk: "#48cae4" },
  userCard: { accent: "#0096c7", border: "#023e8a", shadow: "#011f45", fill: "#000f24" },
};

const AURORA: EvolutionTheme = {
  name: "aurora",
  description: "Northern lights — arctic teal ribbons bending into violet sky.",
  gradients: [
    { from: "#0b1f3a", to: "#16c79a" },
    { from: "#16c79a", to: "#3ddad7" },
    { from: "#3ddad7", to: "#7c83fd" },
    { from: "#7c83fd", to: "#b388eb" },
    { from: "#b388eb", to: "#e7f9f3" },
  ],
  color: true,
  accent: "#3ddad7",
  accentShadow: "#1d5c8f",
  diff: { add: "#16c79a", del: "#fd7c9b", addBg: "#0c2620", delBg: "#2a1626", hunk: "#7c83fd" },
  userCard: { accent: "#3ddad7", border: "#1d5c8f", shadow: "#0e2e47", fill: "#071724" },
};

const SYNTHWAVE: EvolutionTheme = {
  name: "synthwave",
  description: "Retro neon — sunset-grid magenta pulsing against electric cyan.",
  gradients: [
    { from: "#2b1055", to: "#7303c0" },
    { from: "#7303c0", to: "#ec38bc" },
    { from: "#ec38bc", to: "#ff5e99" },
    { from: "#ff5e99", to: "#03e9f4" },
    { from: "#03e9f4", to: "#fdeff9" },
  ],
  color: true,
  accent: "#ec38bc",
  accentShadow: "#5b1a8a",
  diff: { add: "#03e9f4", del: "#ff5e99", addBg: "#0a2330", delBg: "#33122a", hunk: "#b388eb" },
  userCard: { accent: "#ec38bc", border: "#5b1a8a", shadow: "#2d0d45", fill: "#160624" },
};

const SAKURA: EvolutionTheme = {
  name: "sakura",
  description: "Cherry blossom — soft petal pink deepening to spring magenta (light-background friendly).",
  gradients: [
    { from: "#5c2a3d", to: "#b85c79" },
    { from: "#b85c79", to: "#d6336c" },
    { from: "#d6336c", to: "#f06595" },
    { from: "#f06595", to: "#faa2c1" },
    { from: "#faa2c1", to: "#fff0f6" },
  ],
  color: true,
  accent: "#d6336c",
  accentShadow: "#862e59",
  diff: { add: "#37b24d", del: "#e03131", addBg: "#13260f", delBg: "#2b1212", hunk: "#cc5de8" },
  userCard: { accent: "#d6336c", border: "#862e59", shadow: "#43172c", fill: "#210b16" },
};

const MONO: EvolutionTheme = {
  name: "mono",
  description: "Colorless — plain text for NO_COLOR / minimal terminals.",
  gradients: EVOLUTION_STAGE_GRADIENTS,
  color: false,
  accent: "#ffffff",
};

export const THEMES: readonly EvolutionTheme[] = [COSMIC, MATRIX, SOLAR, RED_CLAW, BLUE_CRAB, AURORA, SYNTHWAVE, SAKURA, MONO];

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
 *  existsSync + readFileSync + JSON.parse of ~/.jeo/config.json per keystroke.
 *  Env (`JEO_TUI_THEME`) takes precedence over this value in `resolveTheme`, so
 *  `/theme` switches stay live; external config edits apply on the next run. */
let configThemeCache: { dir: string; value: string | undefined } | undefined;

/** Test-only: clear the config-theme memo. */
export function resetThemeConfigCache(): void {
  configThemeCache = undefined;
}

function getExplicitThemeFromConfig(env: EnvLike): string | undefined {
  const home = os.homedir ? os.homedir() : undefined;
  const dir = env.JEO_CONFIG_DIR || env.JEO_CONFIG_DIR || (home ? path.join(home, ".jeo") : undefined);
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

/** Resolve the active theme from the environment (`JEO_TUI_THEME`) or config, default cosmic. */
export function resolveTheme(
  env: EnvLike = process.env,
  config?: { theme?: string; tuiTheme?: string; tui?: { theme?: string } }
): EvolutionTheme {
  const explicit = env.JEO_TUI_THEME || config?.theme || config?.tuiTheme || config?.tui?.theme || getExplicitThemeFromConfig(env);
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

/** The shaded-edge painter for box bottoms/rights. Pairs with `accentPaint` on
 *  the lit top/left edges — the two-tone contrast gives every bordered panel a
 *  pseudo-3D depth cue. Themes with an explicit `accentShadow` get a REAL
 *  darker hue (richer separation than ANSI dim); others fall back to
 *  dim(accent). Identity when the theme is colorless. */
export function accentShadowPaint(theme: EvolutionTheme): (s: string) => string {
  if (!theme.color) return (s: string) => s;
  if (theme.accentShadow) {
    const hex = theme.accentShadow;
    return (s: string) => chalk.hex(hex)(s);
  }
  const hex = theme.accent;
  return (s: string) => chalk.dim(chalk.hex(hex)(s));
}

/** Themed diff painters: foreground + full-row background tints for added /
 *  removed lines (block-level separation, not just a colored sign) and a
 *  distinct hunk-header color. Identity painters when the theme is colorless. */
export function diffPaint(theme: EvolutionTheme): {
  add: (s: string) => string;
  del: (s: string) => string;
  hunk: (s: string) => string;
  addHead: (s: string) => string;
  delHead: (s: string) => string;
} {
  if (!theme.color) {
    const id = (s: string) => s;
    return { add: id, del: id, hunk: id, addHead: id, delHead: id };
  }
  const p = theme.diff ?? DEFAULT_DIFF_PALETTE;
  return {
    add: (s: string) => chalk.bgHex(p.addBg).hex(p.add)(s),
    del: (s: string) => chalk.bgHex(p.delBg).hex(p.del)(s),
    hunk: (s: string) => chalk.hex(p.hunk).bold(s),
    addHead: (s: string) => chalk.hex(p.add).bold(s),
    delHead: (s: string) => chalk.hex(p.del).bold(s),
  };
}
