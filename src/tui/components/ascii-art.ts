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

/**
 * Renders the ASCII art for a given stage, optionally with padding/margins.
 */
export function renderAsciiArt(stage: AsciiStage): string[] {
  return stage.art.map((line, idx) => {
    if (stage.lineColors && stage.lineColors[idx]) {
      return stage.lineColors[idx](line);
    }
    return stage.color(line);
  });
}
export async function animateAsciiArt(stage: AsciiStage, delayMs = 60): Promise<void> {
  const lines = renderAsciiArt(stage);
  for (const line of lines) {
    process.stdout.write(line + "\n");
    await Bun.sleep(delayMs);
  }
}
