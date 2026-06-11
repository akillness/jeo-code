import chalk from "chalk";
import { renderDnaClaw, DNA_CLAW_ART_GRAND } from "./ascii-art";
import { truncate, isTTY } from "../terminal";
import { detectColorLevel, ColorLevel } from "./color";

export interface WelcomeData {
  version: string;
  model: string;
  provider?: string;
  cwd?: string;            // absolute; render ~-shortened
  thinking?: string;       // e.g. "medium"
  sessionId?: string;      // render first 8 chars
  contextFiles?: string[]; // project context file paths (render basenames)
  recentSessions?: { name: string; timeAgo: string }[];
  cols?: number;           // default 80
  /** Gradient phase [0..1) for the DNA Claw symbol — drives the launch sweep animation. */
  phase?: number;
  /** Lit-edge painter (top border + left edge); theme accent. Default gray. */
  accent?: (s: string) => string;
  /** Shaded-edge painter (bottom border + right edge); dimmed accent. Default dim gray. */
  accentShadow?: (s: string) => string;
  unicode?: boolean;       // default true
  color?: boolean;         // default true
}

function getVisibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padLine(line: string, width: number, align: "left" | "center" | "right" = "left"): string {
  const vis = getVisibleWidth(line);
  if (width <= 0 || vis >= width) return line;
  const total = width - vis;
  if (align === "right") return " ".repeat(total) + line;
  if (align === "center") {
    const left = Math.floor(total / 2);
    return " ".repeat(left) + line + " ".repeat(total - left);
  }
  return line + " ".repeat(total);
}

/**
 * The gjc-style hero welcome box ("JEO forge"): one outer box with the version
 * embedded in the top border and a SINGLE CENTERED column inside — brand line,
 * tagline, the grand DNA Claw symbol (flowing gradient on capable terminals),
 * and the model/provider pills. Workspace details and key hints intentionally
 * live elsewhere (footer/status bar), matching the gjc forge banner.
 */
export function renderWelcome(d: WelcomeData): string[] {
  const cols = d.cols ?? 80;
  const unicode = d.unicode !== false;
  const useColor = d.color !== false;

  if (cols < 30) {
    return [ `jeo v${d.version} · ${d.model}` ];
  }

  const W = Math.min(100, cols - 2);
  const inner = W - 2;

  const BOX_UNICODE = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
  const BOX_ASCII = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  const g = unicode ? BOX_UNICODE : BOX_ASCII;

  // Depth cue (two-tone borders): top border + left edge are "lit" with the
  // accent; bottom border + right edge are "shaded" with the dimmed accent.
  const lit = useColor ? (d.accent ?? chalk.gray) : (s: string) => s;
  const shadow = useColor ? (d.accentShadow ?? ((s: string) => chalk.dim(chalk.gray(s)))) : (s: string) => s;

  // Title text: ─── jeo v{version} · JEO forge ─── (bold for contrast against the border)
  const dashStr = g.h.repeat(3);
  const titleLabel = ` jeo v${d.version} · JEO forge `;
  const titleHead = `${dashStr}${titleLabel}`;
  let topBorderLine: string;
  if (titleHead.length + 2 > inner) {
    const clipped = titleHead.slice(0, inner);
    topBorderLine = lit(g.tl + clipped + g.h.repeat(Math.max(0, inner - clipped.length)) + g.tr);
  } else {
    const fill = g.h.repeat(inner - titleHead.length);
    topBorderLine = useColor
      ? lit(g.tl + dashStr) + chalk.bold(lit(titleLabel)) + lit(fill) + lit(g.tr)
      : g.tl + titleHead + fill + g.tr;
  }

  const bottomBorderPlain = g.bl + g.h.repeat(inner) + g.br;
  const bottomBorderLine = shadow(bottomBorderPlain);

  // Grand symbol when the box is wide enough; compact DNA Claw otherwise.
  const colorLevel = useColor ? detectColorLevel(process.env, isTTY()) : ColorLevel.None;
  const grandWidth = Math.max(...DNA_CLAW_ART_GRAND.map(l => l.length));
  const grand = inner >= grandWidth;
  const artLines = renderDnaClaw({
    color: useColor,
    phase: d.phase ?? 0,
    unicode,
    colorLevel,
    grand,
    cols: inner,
  });

  // Single centered hero column (gjc forge layout): breathing room, brand,
  // tagline, the symbol, then the model/provider pills.
  const content: string[] = [];
  content.push("");
  content.push(useColor ? chalk.bold.cyan("Jeo forge") : "Jeo forge");
  content.push(useColor ? chalk.dim("evolve · act · prove") : "evolve · act · prove");
  content.push("");
  for (const line of artLines) content.push(line);
  content.push("");

  const modelIcon = unicode ? "◆" : "*";
  const modelPill = truncate(`[ ${modelIcon} ${d.model} ]`, inner);
  content.push(useColor ? chalk.cyan(modelPill) : modelPill);
  if (d.provider) {
    const providerIcon = unicode ? "◇" : "o";
    const providerPill = truncate(`[ ${providerIcon} ${d.provider} ]`, inner);
    content.push(useColor ? chalk.blue(providerPill) : providerPill);
  }
  content.push("");

  const leftBorder = lit(g.v);
  const rightBorder = shadow(g.v);
  const finalContentLines = content.map(raw => {
    const line = padLine(truncate(raw, inner), inner, "center");
    return leftBorder + line + rightBorder;
  });

  return [topBorderLine, ...finalContentLines, bottomBorderLine];
}

/**
 * One-shot launch animation: sweep the DNA Claw's gradient through a full
 * palette cycle by re-printing the welcome box in place (cursor-up rewrites,
 * same row count every frame). The FINAL frame is phase 0 — byte-identical to
 * the static `renderWelcome` — so the resting banner matches non-animated
 * output exactly. `write`/`sleep` are injectable for tests; callers gate on
 * TTY + truecolor before invoking.
 */
export async function playWelcomeSweep(
  d: WelcomeData,
  opts: { write?: (s: string) => void; sleep?: (ms: number) => Promise<unknown>; frames?: number; delayMs?: number } = {},
): Promise<void> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const frames = Math.max(1, Math.trunc(opts.frames ?? 10));
  const delay = opts.delayMs ?? 50;
  let lineCount = 0;
  for (let f = 0; f <= frames; f++) {
    const phase = (f / frames) % 1; // …last frame wraps to 0 (the static banner)
    const lines = renderWelcome({ ...d, phase });
    if (f > 0) write(`\x1b[${lineCount}A`);
    write(lines.map(l => `${l}\x1b[K`).join("\n") + "\n");
    lineCount = lines.length;
    if (f < frames && delay > 0) await sleep(delay);
  }
}
