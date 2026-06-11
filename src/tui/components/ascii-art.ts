import chalk from "chalk";
import { stageIndexForStep, clampStageIndex, type StageGradient } from "./evolution";
import { applyGradient, hexToRgb, ColorLevel, animatedGradientText } from "./color";

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
  /**
   * Optional ASCII-only `art`/`frames` used when the caller passes `unicode: false`
   * (terminals that cannot render box-drawing / geometric glyphs). When absent the
   * stage's normal `art`/`frames` are used as-is (the other stages are already
   * ASCII-clean). Row counts should match so per-line colors stay aligned.
   */
  asciiArt?: string[];
  asciiFrames?: string[][];
}

export const EVOLUTION_STAGES: AsciiStage[] = [
  {
    name: "Primordial Cell",
    color: s => chalk.cyan(s),
    art: [
      "   ○           ○   ",
      "    ╲         ╱    ",
      "     ╭───────╮     ",
      "     │ ◕ § ◕ │     ",
      "     │ · ‿ · │     ",
      "     ╰───────╯     ",
      "    ╱ ╲     ╱ ╲    ",
      " [Primordial Cell]"
    ],
    lineColors: [
      chalk.cyan,
      chalk.cyan,
      chalk.cyan,
      s => chalk.bold.cyan(s),
      chalk.cyan,
      chalk.cyan,
      chalk.cyan,
      s => chalk.bold.cyan(s)
    ],
    // A glowing primordial cell after assets/character.png: antennae with pulsing
    // tips, a round membrane, big kawaii eyes flanking an inner DNA helix (§/≋), a
    // smile, and crab-like legs. Two frames "breathe": blink + helix pulse + leg swing.
    // Every glyph is display-width 1 (box-drawing + ambiguous-width geometrics the
    // rest of the TUI already uses) so renderAsciiArt's length-based padding and
    // app.ts/welcome.ts's visibleWidth centering stay in lockstep.
    frames: [
      [
        "   ○           ○   ",
        "    ╲         ╱    ",
        "     ╭───────╮     ",
        "     │ ◕ § ◕ │     ",
        "     │ · ‿ · │     ",
        "     ╰───────╯     ",
        "    ╱ ╲     ╱ ╲    ",
        " [Primordial Cell]"
      ],
      [
        "   ◉           ◉   ",
        "    ╲         ╱    ",
        "     ╭───────╮     ",
        "     │ ◔ ≋ ◔ │     ",
        "     │ ° ‿ ° │     ",
        "     ╰───────╯     ",
        "     ╲ ╱   ╲ ╱     ",
        " [Primordial Cell]"
      ]
    ],
    asciiArt: [
      "   o           o   ",
      "    \\         /    ",
      "     .-------.     ",
      "     | o 8 o |     ",
      "     |  \\_/  |     ",
      "     '-------'     ",
      "    / \\     / \\    ",
      " [Primordial Cell]"
    ],
    asciiFrames: [
      [
        "   o           o   ",
        "    \\         /    ",
        "     .-------.     ",
        "     | o 8 o |     ",
        "     |  \\_/  |     ",
        "     '-------'     ",
        "    / \\     / \\    ",
        " [Primordial Cell]"
      ],
      [
        "   O           O   ",
        "    \\         /    ",
        "     .-------.     ",
        "     | - % - |     ",
        "     |  \\_/  |     ",
        "     '-------'     ",
        "     \\ /   \\ /     ",
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
  /** Use the stage's ASCII-only `asciiArt`/`asciiFrames` fallback when false
   *  (terminals without box-drawing/geometric glyph support). Default true. */
  unicode?: boolean;
}

/**
 * Render a stage's ASCII art. Lines are right-padded to a uniform width (clean
 * right edge) and the block is optionally bottom-padded to a uniform height so
 * the live TUI never jumps as stages change. Color can be disabled for
 * NO_COLOR / non-TTY / plain previews.
 */
export function renderAsciiArt(stage: AsciiStage, opts: RenderAsciiOptions = {}): string[] {
  const useColor = opts.color !== false;
  const useUnicode = opts.unicode !== false;
  // ASCII-fallback source set: a non-unicode terminal gets the stage's plain-ASCII
  // art/frames (when defined) instead of box-drawing/geometric glyphs that would
  // render as tofu boxes. stageBlocks/stageFrame keep using the unicode frames so
  // stageWidth()/stageHeight() invariants are unaffected.
  const frameSet =
    !useUnicode && stage.asciiFrames && stage.asciiFrames.length > 0 ? stage.asciiFrames : stageBlocks(stage);
  const baseArt = !useUnicode && stage.asciiArt ? stage.asciiArt : stage.art;
  let source: string[];
  if (opts.frame !== undefined) {
    const t = Number.isFinite(opts.frame) ? Math.trunc(opts.frame) : 0;
    source = frameSet[((t % frameSet.length) + frameSet.length) % frameSet.length]!;
  } else {
    source = baseArt;
  }
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
export const DNA_CLAW_ART: string[] = [
  "  ╭╯   ◆  ◆   ╰╮  ",
  " ╭╯   ╱╲  ╱╲   ╰╮ ",
  " ║    ╲ ╳ ╱     ║ ",
  " ╰╮    ╳ ╳     ╭╯ ",
  "  ╰╮  ╱ ╳ ╲   ╭╯  ",
  "   ╚══○   ○══╝    ",
  "      ║   ║       ",
  "   [ DNA Claw ]   "
];

export const DNA_CLAW_ART_ASCII: string[] = [
  "  /{   *  *   }\\  ",
  " /{   / \\ / \\  }\\ ",
  " |    \\  X  /   | ",
  " \\{    X X     }/ ",
  "  \\{  / X \\   }/  ",
  "   \\==o   o==/    ",
  "      |   |       ",
  "   [ DNA Claw ]   "
];

/** Grand hero variant for the welcome forge box (gjc-style spacious banner):
 *  a wide claw whose pincers frame a twisting DNA helix. Width-1 glyphs only
 *  (box drawing + diagonals + geometrics) so padding/centering math stays exact. */
export const DNA_CLAW_ART_GRAND: string[] = [
  "      ◆◆                    ◆◆      ",
  "   ╭──╯╰──╮              ╭──╯╰──╮   ",
  "  ╭╯      ╰╮   ╲╲  ╱╱   ╭╯      ╰╮  ",
  " ╭╯        ║    ╲╳╳╱    ║        ╰╮ ",
  " ║         ║     ╳╳     ║         ║ ",
  " ║         ║    ╱╳╳╲    ║         ║ ",
  " ╰╮        ║   ╱╱  ╲╲   ║        ╭╯ ",
  "  ╰╮       ║   ╲╲  ╱╱   ║       ╭╯  ",
  "   ╰──╮    ║    ╲╳╳╱    ║    ╭──╯   ",
  "      ╰════○     ╳╳     ○════╯      ",
  "           ║    ╱╳╳╲    ║           ",
  "        [ D N A · C L A W ]         "
];

export const DNA_CLAW_ART_GRAND_ASCII: string[] = [
  "      **                    **      ",
  "   /--'`--\\              /--'`--\\   ",
  "  /'      `\\   \\\\  //   /'      `\\  ",
  " /'        |    \\XX/    |        `\\ ",
  " |         |     XX     |         | ",
  " |         |    /XX\\    |         | ",
  " \\,        |   //  \\\\   |        ,/ ",
  "  \\,       |   \\\\  //   |       ,/  ",
  "   \\--,    |    \\XX/    |    ,--/   ",
  "      \\====o     XX     o====/      ",
  "           |    /XX\\    |           ",
  "        [ D N A . C L A W ]         "
];

export function renderDnaClaw(opts: {
  cols?: number;
  phase?: number;
  unicode?: boolean;
  color?: boolean;
  colorLevel?: ColorLevel;
  /** Grand hero variant (welcome forge box); default is the compact in-turn symbol. */
  grand?: boolean;
}): string[] {
  const useUnicode = opts.unicode !== false;
  const source = opts.grand
    ? (useUnicode ? DNA_CLAW_ART_GRAND : DNA_CLAW_ART_GRAND_ASCII)
    : (useUnicode ? DNA_CLAW_ART : DNA_CLAW_ART_ASCII);
  const width = Math.max(0, ...source.map(l => l.length));

  if (opts.cols !== undefined && opts.cols < width) {
    return [];
  }

  const phase = opts.phase ?? 0;
  const useColor = opts.color !== false;
  const colorLevel = opts.colorLevel ?? ColorLevel.TrueColor;
  const palette = ["#10ac84", "#48dbfb", "#8e44ad"];

  return source.map((line, idx) => {
    const padded = line.length < width ? line + " ".repeat(width - line.length) : line;
    if (!useColor || colorLevel < ColorLevel.TrueColor) {
      return padded;
    }
    return animatedGradientText(padded, palette, phase + idx * 0.07, { colorLevel });
  });
}

export function dnaClawHeight(): number {
  return DNA_CLAW_ART.length;
}
