import chalk from "chalk";
import { stageIndexForStep, clampStageIndex } from "./evolution";

export interface AsciiStage {
  name: string;
  art: string[];
  color: (s: string) => string;
  lineColors?: ((s: string) => string)[];
}

export const EVOLUTION_STAGES: AsciiStage[] = [
  {
    name: "Primordial Cell",
    color: s => chalk.cyan(s),
    art: [
      "      .---.      ",
      "     / o o \\     ",
      "     \\  -  /     ",
      "      '---'      ",
      " [Primordial Cell]"
    ],
    lineColors: [
      chalk.cyan,
      chalk.cyan,
      chalk.cyan,
      chalk.cyan,
      s => chalk.bold.cyan(s)
    ]
  },
  {
    name: "Double Helix (DNA)",
    color: s => chalk.green(s),
    art: [
      "      \\  /      ",
      "       \\/       ",
      "       /\\       ",
      "      /  \\      ",
      "      \\  /      ",
      "       \\/       ",
      "       /\\       ",
      " [Double Helix] "
    ],
    lineColors: [
      chalk.green,
      chalk.cyan,
      chalk.green,
      chalk.cyan,
      chalk.green,
      chalk.cyan,
      chalk.green,
      s => chalk.bold.green(s)
    ]
  },
  {
    name: "Tool User (Homo Habilis)",
    color: s => chalk.yellow(s),
    art: [
      "       .---.     ",
      "      /| | |\\    ",
      "     | |_|_| |   ",
      "     |  ___  |---|",
      "     | |   | |   |",
      "     '-'   '-'   '-'",
      "   [Tool User]   "
    ],
    lineColors: [
      chalk.yellow,
      chalk.yellow,
      chalk.yellow,
      s => s.replace("___", chalk.red("___")),
      chalk.yellow,
      chalk.yellow,
      s => chalk.bold.yellow(s)
    ]
  },
  {
    name: "AI Coding Agent",
    color: s => chalk.magenta(s),
    art: [
      "      .-------.  ",
      "    _|_  o o  _|_",
      "   |   |  ^  |   |",
      "   |   | === |   |",
      "   |___|_____|___|",
      "     /         \\ ",
      "  [AI Coding Agent]"
    ],
    lineColors: [
      chalk.magenta,
      s => s.replace("o o", chalk.green("o o")),
      chalk.magenta,
      s => s.replace("===", chalk.cyan("===")),
      chalk.magenta,
      chalk.magenta,
      s => chalk.bold.magenta(s)
    ]
  },
  {
    name: "Super intelligence (Singularity)",
    color: s => chalk.blue(s),
    art: [
      "     _  ____   ____ ",
      "    | |/ ___| / ___|",
      " _  | | |    | |    ",
      "| |_| | |___ | |___ ",
      " \\___/ \\____| \\____|",
      "  [Singularity Era] "
    ],
    lineColors: [
      chalk.red,
      chalk.yellow,
      chalk.green,
      chalk.blue,
      chalk.magenta,
      s => chalk.bold.cyan(s)
    ]
  }
];

/**
 * Returns the evolutionary ASCII-art stage for an agent step against its budget.
 * Delegates stage selection to the canonical evolution model so the art evolves
 * in lockstep with the spinner, meter, and footer track. Guards out-of-range
 * step/maxSteps via the canonical index math.
 */
export function getEvolutionStage(step: number, maxSteps: number = 25): AsciiStage {
  return EVOLUTION_STAGES[stageIndexForStep(step, maxSteps)]!;
}

/** Returns the ASCII-art stage for an explicit stage index (clamped). */
export function getStageByIndex(index: number): AsciiStage {
  return EVOLUTION_STAGES[clampStageIndex(index)]!;
}

/** Max art line count across all stages (for stable, flicker-free block height). */
export function stageHeight(): number {
  return EVOLUTION_STAGES.reduce((h, s) => Math.max(h, s.art.length), 0);
}

/** Max plain line width across all stages (for clean right-edge alignment). */
export function stageWidth(): number {
  let w = 0;
  for (const s of EVOLUTION_STAGES) for (const line of s.art) w = Math.max(w, line.length);
  return w;
}

/** The bracketed caption line embedded in a stage's art, e.g. "[Tool User]". */
export function stageCaption(stage: AsciiStage): string | undefined {
  return stage.art.find(line => /\[.+\]/.test(line))?.trim();
}

export interface RenderAsciiOptions {
  /** Apply per-line / stage colors (default true). Pass false for NO_COLOR / plain. */
  color?: boolean;
  /** Right-pad every line to this plain width (default: this stage's max width). */
  width?: number;
  /** Bottom-pad the block to this many lines for a stable block height (default: no pad). */
  height?: number;
}

/**
 * Render a stage's ASCII art. Lines are right-padded to a uniform width (clean
 * right edge) and the block is optionally bottom-padded to a uniform height so
 * the live TUI never jumps as stages change. Color can be disabled for
 * NO_COLOR / non-TTY / plain previews.
 */
export function renderAsciiArt(stage: AsciiStage, opts: RenderAsciiOptions = {}): string[] {
  const useColor = opts.color !== false;
  const width = opts.width ?? Math.max(0, ...stage.art.map(l => l.length));
  const lines = stage.art.map((line, idx) => {
    const padded = line.length < width ? line + " ".repeat(width - line.length) : line;
    if (!useColor) return padded;
    if (stage.lineColors && stage.lineColors[idx]) return stage.lineColors[idx]!(padded);
    return stage.color(padded);
  });
  if (opts.height && lines.length < opts.height) {
    const blank = " ".repeat(width);
    while (lines.length < opts.height) lines.push(blank);
  }
  return lines;
}

export interface AnimateAsciiOptions extends RenderAsciiOptions {
  delayMs?: number;
  write?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Stream a stage's art line-by-line. `write`/`sleep` are injectable for tests. */
export async function animateAsciiArt(stage: AsciiStage, opts: AnimateAsciiOptions = {}): Promise<void> {
  const delayMs = opts.delayMs ?? 60;
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (const line of renderAsciiArt(stage, opts)) {
    write(line + "\n");
    if (delayMs > 0) await sleep(delayMs);
  }
}
