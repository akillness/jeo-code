import chalk from "chalk";

export interface AsciiStage {
  name: string;
  art: string[];
  color: (s: string) => string;
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
    ]
  }
];

/**
 * Returns the evolutionary ASCII art stage based on the current step and maxSteps.
 */
export function getEvolutionStage(step: number, maxSteps: number = 25): AsciiStage {
  if (step === 0) return EVOLUTION_STAGES[0];
  const ratio = step / maxSteps;
  if (ratio <= 0.25) return EVOLUTION_STAGES[1];
  if (ratio <= 0.50) return EVOLUTION_STAGES[2];
  if (ratio <= 0.75) return EVOLUTION_STAGES[3];
  return EVOLUTION_STAGES[4];
}

/**
 * Renders the ASCII art for a given stage, optionally with padding/margins.
 */
export function renderAsciiArt(stage: AsciiStage): string[] {
  return stage.art.map(line => stage.color(line));
}
