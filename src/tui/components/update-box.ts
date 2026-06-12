import chalk from "chalk";
import { padLineTo } from "./layout";
import { truncate } from "../terminal";

export function renderUpdateBox(
  current: string,
  latest: string,
  opts?: { cols?: number; unicode?: boolean; color?: boolean }
): string[] {
  void current;

  const cols = opts?.cols ?? 80;
  const useColor = opts?.color !== false;
  const useUnicode = opts?.unicode !== false;
  const width = Math.max(24, Math.min(120, cols));

  const ruleChar = useUnicode ? "─" : "-";
  const paintRule = useColor ? chalk.hex("#f2b84b") : (s: string) => s;
  const paintTitle = useColor ? chalk.hex("#f2b84b").bold : (s: string) => s;
  const paintCommand = useColor ? chalk.hex("#ff6b4a") : (s: string) => s;

  const rule = paintRule(ruleChar.repeat(width));
  const fit = (line: string) => padLineTo(truncate(line, width), width, "left");

  return [
    rule,
    fit(paintTitle("Update Available")),
    fit(`New version ${latest} is available. Run: ${paintCommand("jeo update")}`),
    rule,
  ];
}
