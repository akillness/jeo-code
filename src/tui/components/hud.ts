import chalk from "chalk";

export type JocPhase = "thinking" | "planning" | "executing" | "reporting" | "done";

export interface HudOptions {
  unicode?: boolean;
  color?: boolean;
}

export function renderHud(phase: JocPhase, opts: HudOptions = {}): string {
  const unicode = opts.unicode !== false;
  const color = opts.color !== false;

  const phases: JocPhase[] = ["thinking", "planning", "executing", "reporting", "done"];
  const activeIndex = phases.indexOf(phase);

  const arrow = unicode ? " → " : " -> ";
  const renderedArrow = color ? chalk.dim(arrow) : arrow;

  const parts = phases.map((p, i) => {
    let glyph = "";
    let formatted = "";

    if (i < activeIndex) {
      // Completed
      glyph = unicode ? "✔" : "v";
      formatted = `${glyph} ${p}`;
      if (color) {
        formatted = chalk.green(formatted);
      }
    } else if (i === activeIndex) {
      // Active
      glyph = unicode ? "●" : "*";
      formatted = `${glyph} ${p}`;
      if (color) {
        formatted = chalk.cyan.bold(formatted);
      }
    } else {
      // Future
      glyph = unicode ? "○" : "o";
      formatted = `${glyph} ${p}`;
      if (color) {
        formatted = chalk.dim(formatted);
      }
    }
    return formatted;
  });

  return parts.join(renderedArrow);
}

export interface DerivePhaseInput {
  thinking: boolean;
  runningTool: boolean;
  todosActive: boolean;
  finished: boolean;
}

export function derivePhase(input: DerivePhaseInput): JocPhase {
  if (input.finished) {
    return "done";
  }
  if (input.runningTool) {
    return "executing";
  }
  if (input.thinking) {
    return "thinking";
  }
  if (input.todosActive) {
    return "planning";
  }
  return "reporting";
}
