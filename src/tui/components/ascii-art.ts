import chalk from "chalk";
import { stageIndexForStep, clampStageIndex, type StageGradient } from "./evolution";
import { applyGradient, hexToRgb, ColorLevel } from "./color";

export interface AsciiStage {
  name: string;
  art: string[];
  color: (s: string) => string;
  lineColors?: ((s: string) => string)[];
  /**
   * Optional animation frames (each a full art block). When present the live TUI
   * cycles them by tick for a "breathing"/rotating effect; `art` is frame 0 and
   * the fallback when `frames` is absent. Frames should match `art`'s line count.
   */
  frames?: string[][];
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
    ],
    // Pulsing membrane + nucleus (a primordial cell "breathing").
    frames: [
      [
        "      .---.      ",
        "     / o o \\     ",
        "     \\  -  /     ",
        "      '---'      ",
        " [Primordial Cell]"
      ],
      [
        "      .===.      ",
        "     / O O \\     ",
        "     \\  ~  /     ",
        "      '==='      ",
        " [Primordial Cell]"
      ]
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
    ],
    // Twisting double helix (diagonals flip to simulate rotation).
    frames: [
      [
        "      \\  /      ",
        "       \\/       ",
        "       /\\       ",
        "      /  \\      ",
        "      \\  /      ",
        "       \\/       ",
        "       /\\       ",
        " [Double Helix] "
      ],
      [
        "       \\/       ",
        "       /\\       ",
        "      /  \\      ",
        "      \\  /      ",
        "       \\/       ",
        "       /\\       ",
        "      /  \\      ",
        " [Double Helix] "
      ],
      [
        "      /  \\      ",
        "      \\  /      ",
        "       \\/       ",
        "       /\\       ",
        "      /  \\      ",
        "      \\  /      ",
        "       \\/       ",
        " [Double Helix] "
      ]
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

/** All art blocks for a stage (its animation `frames`, or `[art]` as a fallback). */
export function stageBlocks(stage: AsciiStage): string[][] {
  return stage.frames && stage.frames.length > 0 ? stage.frames : [stage.art];
}

/** The art block for a given animation tick (wraps; falls back to `art`). */
export function stageFrame(stage: AsciiStage, tick = 0): string[] {
  const blocks = stageBlocks(stage);
  const t = Number.isFinite(tick) ? Math.trunc(tick) : 0;
  const i = ((t % blocks.length) + blocks.length) % blocks.length;
  return blocks[i]!;
}

/** Max art line count across all stages + frames (for stable block height). */
export function stageHeight(): number {
  let h = 0;
  for (const s of EVOLUTION_STAGES) for (const block of stageBlocks(s)) h = Math.max(h, block.length);
  return h;
}

/** Max plain line width across all stages + frames (for clean right-edge alignment). */
export function stageWidth(): number {
  let w = 0;
  for (const s of EVOLUTION_STAGES) for (const block of stageBlocks(s)) for (const line of block) w = Math.max(w, line.length);
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
  /** Terminal width. If the terminal width is less than the art width, returns an empty block. */
  cols?: number;
  /** Whether to overlay synapses firing animation (random glowing dots). */
  firing?: boolean;
  /** Animation tick: selects a `stage.frames` block (wraps); default frame 0. */
  frame?: number;
  /**
   * Paint each line with a left→right truecolor gradient (`from`→`to` hex),
   * downgrading to 256/16/plain per `colorLevel`. Takes precedence over
   * per-line colors; suppresses the `firing` overlay for a clean gradient.
   */
  gradient?: StageGradient;
  /** Color tier for gradient rendering (default TrueColor). */
  colorLevel?: ColorLevel;
}

/**
 * Render a stage's ASCII art. Lines are right-padded to a uniform width (clean
 * right edge) and the block is optionally bottom-padded to a uniform height so
 * the live TUI never jumps as stages change. Color can be disabled for
 * NO_COLOR / non-TTY / plain previews.
 */
export function renderAsciiArt(stage: AsciiStage, opts: RenderAsciiOptions = {}): string[] {
  const useColor = opts.color !== false;
  const source = opts.frame !== undefined ? stageFrame(stage, opts.frame) : stage.art;
  const width = opts.width ?? Math.max(0, ...source.map(l => l.length));
  if (opts.cols !== undefined && opts.cols < width) {
    return [];
  }
  const gradient = useColor ? opts.gradient : undefined;
  const level = opts.colorLevel ?? ColorLevel.TrueColor;
  const lines = source.map((line, idx) => {
    let padded = line.length < width ? line + " ".repeat(width - line.length) : line;
    if (gradient) {
      return applyGradient(padded, hexToRgb(gradient.from), hexToRgb(gradient.to), level);
    }
    if (opts.firing && useColor) {
      const spaceIdxs: number[] = [];
      for (let i = 0; i < padded.length; i++) {
        if (padded[i] === " ") {
          spaceIdxs.push(i);
        }
      }
      if (spaceIdxs.length > 0) {
        const chars = ["*", ".", "o", "+", "\u2727"];
        const numSparks = Math.min(2, Math.floor(Math.random() * 3));
        const arr = padded.split("");
        for (let s = 0; s < numSparks; s++) {
          const randSpace = spaceIdxs[Math.floor(Math.random() * spaceIdxs.length)];
          const randChar = chars[Math.floor(Math.random() * chars.length)];
          arr[randSpace] = chalk.yellow.bold(randChar);
        }
        padded = arr.join("");
      }
    }
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

export interface AnimateFramesOptions extends RenderAsciiOptions {
  /** Frames to play across (default = the stage's frame count). */
  frames?: number;
  /** Delay between frames in ms (default 120). */
  frameDelayMs?: number;
  write?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Play a stage's animation frames in place by clearing and redrawing the block
 * `frames` times. Returns the number of frames drawn. `write`/`sleep` are
 * injectable so tests can run with zero delay.
 */
export async function animateFrames(stage: AsciiStage, opts: AnimateFramesOptions = {}): Promise<number> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const delay = opts.frameDelayMs ?? 120;
  const total = Math.max(1, opts.frames ?? stageBlocks(stage).length);
  const height = opts.height ?? stageHeight();
  for (let f = 0; f < total; f++) {
    const block = renderAsciiArt(stage, { ...opts, frame: f, height });
    write(block.join("\n") + "\n");
    if (delay > 0 && f < total - 1) await sleep(delay);
  }
  return total;
}
