import chalk from "chalk";
import { BOX_UNICODE, BOX_ASCII, padLineTo } from "./layout";
import { truncate } from "../terminal";

export function renderUpdateBox(
  current: string,
  latest: string,
  opts?: { cols?: number; unicode?: boolean; color?: boolean }
): string[] {
  const cols = opts?.cols ?? 80;
  const useColor = opts?.color !== false;
  const useUnicode = opts?.unicode !== false;

  const width = Math.min(64, cols - 2);
  const inner = Math.max(0, width - 2);

  const title = " Update ";
  const titleLen = title.length;

  const g = useUnicode ? BOX_UNICODE : BOX_ASCII;
  const paintYellow = useColor ? chalk.yellow : (s: string) => s;
  const paintBold = useColor ? chalk.bold : (s: string) => s;
  const paintCyan = useColor ? chalk.cyan : (s: string) => s;

  let top: string;
  if (inner >= titleLen + 6) {
    const left = Math.floor((inner - titleLen) / 2);
    const right = inner - titleLen - left;
    top = paintYellow(g.tl + g.h.repeat(left) + title + g.h.repeat(right) + g.tr);
  } else {
    top = paintYellow(g.tl + g.h.repeat(inner) + g.tr);
  }

  const bottom = paintYellow(g.bl + g.h.repeat(inner) + g.br);

  const lines = [
    paintBold("Update Available"),
    `New version ${latest} is available (current ${current}).`,
    `Run: ${paintCyan("jeo update")}`,
  ];

  const mid = lines.map(line => {
    const truncated = truncate(line, inner);
    const padded = padLineTo(truncated, inner, "center");
    return paintYellow(g.v) + padded + paintYellow(g.v);
  });

  return [top, ...mid, bottom];
}
