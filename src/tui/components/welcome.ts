import chalk from "chalk";
import * as path from "node:path";
import * as os from "node:os";
import { renderForgeMark, FORGE_MARK_ART_GRAND } from "./ascii-art";
import { truncate, isTTY } from "../terminal";
import { detectColorLevel, ColorLevel, visibleWidth } from "./color";

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
  /** Gradient phase [0..1) for the forge mark — drives the launch sweep animation. */
  phase?: number;
  /** Lit-edge painter (top border + left edge); theme accent. Default gray. */
  accent?: (s: string) => string;
  /** Shaded-edge painter (bottom border + right edge); dimmed accent. Default dim gray. */
  accentShadow?: (s: string) => string;
  unicode?: boolean;       // default true
  color?: boolean;         // default true
}

function padLine(line: string, width: number, align: "left" | "center" | "right" = "left"): string {
  const vis = visibleWidth(line);
  if (width <= 0 || vis >= width) return line;
  const total = width - vis;
  if (align === "right") return " ".repeat(total) + line;
  if (align === "center") {
    const left = Math.floor(total / 2);
    return " ".repeat(left) + line + " ".repeat(total - left);
  }
  return line + " ".repeat(total);
}

function shortenPath(p: string | undefined, maxWidth: number, unicode: boolean): string {
  if (!p) return "-";
  let s = p;
  const home = os.homedir();
  if (home && (s === home || s.startsWith(home + path.sep))) s = "~" + s.slice(home.length);
  if (visibleWidth(s) <= maxWidth) return s;
  const ell = unicode ? "…" : "...";
  return truncate(`${ell}${s.slice(-Math.max(1, maxWidth - visibleWidth(ell)))}`, maxWidth);
}

function metaRows(d: WelcomeData, width: number, unicode: boolean, useColor: boolean): string[] {
  const labelWidth = 8;
  const valueWidth = Math.max(1, width - labelWidth - 3);
  const key = useColor ? chalk.dim : (s: string) => s;
  const rows: string[] = [];
  const push = (label: string, value: string): void => {
    const lhs = key(padLine(label, labelWidth, "right"));
    const rhs = truncate(value || "-", valueWidth);
    rows.push(padLine(`${lhs} │ ${rhs}`, width));
  };
  push("version", `v${d.version}`);
  push("folder", shortenPath(d.cwd, valueWidth, unicode));
  push("model", d.model);
  if (d.provider) push("provider", d.provider);
  if (d.thinking) push("thinking", d.thinking);
  if (d.sessionId) push("session", d.sessionId.slice(0, 8));

  const files = d.contextFiles ?? [];
  if (files.length > 0 && width >= 28) {
    const shown = files.slice(0, width >= 34 ? 3 : 2).map(f => path.basename(f));
    push("files", shown.join(", ") + (files.length > shown.length ? ` +${files.length - shown.length}` : ""));
  }
  return rows;
}

function centerColumn(lines: string[], width: number): string[] {
  return lines.map(raw => padLine(truncate(raw, width), width, "center"));
}

function zipColumns(left: string[], right: string[], leftWidth: number, gap: string, rightWidth: number): string[] {
  const n = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${padLine(left[i] ?? "", leftWidth)}${gap}${padLine(right[i] ?? "", rightWidth)}`);
  }
  return out;
}

/**
 * The gjc-style hero welcome box ("JEO forge"): one outer box with the version
 * embedded in the top border. Narrow terminals keep a single centered forge
 * column; wide terminals split into a left hero mark and a right workspace table
 * (folder, version, model, context files) so the launch capture uses the extra
 * resolution instead of leaving a dead right side.
 */
export function renderWelcome(d: WelcomeData): string[] {
  const cols = d.cols ?? 80;
  const unicode = d.unicode !== false;
  const useColor = d.color !== false;

  if (cols < 30) {
    return [ `jeo v${d.version} · ${d.model}` ];
  }

  // The banner fills the full terminal width (gjc forge: flush with the input box and
  // status bar below it). `cols - 1` leaves the last column free so a full-width row
  // never wraps; the forge mark + pills stay centered inside the box.
  const grandWidth = Math.max(...FORGE_MARK_ART_GRAND.map(l => l.length));
  // Title rides ON the top border: `─── jeo v{version} · JEO forge ───`. Defined
  // once here so the width calc and the border render below can't drift.
  const titleDashes = 3;
  const titleLabel = ` jeo v${d.version} · JEO forge `;
  const W = cols - 1;
  const inner = W - 2;

  const BOX_UNICODE = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
  const BOX_ASCII = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  const g = unicode ? BOX_UNICODE : BOX_ASCII;

  // Depth cue (two-tone borders): top border + left edge are "lit" with the
  // accent; bottom border + right edge are "shaded" with the dimmed accent.
  const lit = useColor ? (d.accent ?? chalk.gray) : (s: string) => s;
  const shadow = useColor ? (d.accentShadow ?? ((s: string) => chalk.dim(chalk.gray(s)))) : (s: string) => s;

  // Title text: ─── jeo v{version} · JEO forge ─── (bold for contrast against the border).
  // `titleDashes`/`titleLabel` were fixed above so width and render stay in sync.
  const dashStr = g.h.repeat(titleDashes);
  const titleHead = `${dashStr}${titleLabel}`;
  let topBorderLine: string;
  if (visibleWidth(titleHead) + 2 > inner) {
    const clipped = truncate(titleHead, inner);
    topBorderLine = lit(g.tl + clipped + g.h.repeat(Math.max(0, inner - visibleWidth(clipped))) + g.tr);
  } else {
    const fill = g.h.repeat(inner - visibleWidth(titleHead));
    topBorderLine = useColor
      ? lit(g.tl + dashStr) + chalk.bold(lit(titleLabel)) + lit(fill) + lit(g.tr)
      : g.tl + titleHead + fill + g.tr;
  }

  const bottomBorderPlain = g.bl + g.h.repeat(inner) + g.br;
  const bottomBorderLine = shadow(bottomBorderPlain);

  // Grand symbol when the box is wide enough; compact forge mark otherwise. In a
  // split layout, art is constrained to the left pane so the right table remains stable.
  const colorLevel = useColor ? detectColorLevel(process.env, isTTY()) : ColorLevel.None;
  const wideMeta = inner >= 86;
  const gap = wideMeta ? "   " : "";
  const rightWidth = wideMeta ? Math.min(38, Math.max(28, Math.floor(inner * 0.34))) : 0;
  const leftWidth = wideMeta ? Math.max(32, inner - rightWidth - visibleWidth(gap)) : inner;
  const grand = leftWidth >= grandWidth;
  const artLines = renderForgeMark({
    color: useColor,
    phase: d.phase ?? 0,
    unicode,
    colorLevel,
    grand,
    cols: leftWidth,
  });

  const pill = (icon: string, text: string, paint: (s: string) => string): string => {
    const p = truncate(`[ ${icon} ${text} ]`, leftWidth);
    return useColor ? paint(p) : p;
  };
  const leftContent: string[] = [];
  leftContent.push("");
  leftContent.push(useColor ? chalk.bold.cyan("Jeo forge") : "Jeo forge");
  leftContent.push(useColor ? chalk.dim("evolve · act · prove") : "evolve · act · prove");
  leftContent.push("");
  leftContent.push(...artLines);
  leftContent.push("");
  leftContent.push(pill(unicode ? "◆" : "*", d.model, chalk.cyan));
  if (d.provider) leftContent.push(pill(unicode ? "◇" : "o", d.provider, chalk.blue));
  leftContent.push("");

  let content: string[];
  if (wideMeta) {
    const tableTitle = useColor ? chalk.bold("workspace") : "workspace";
    const rightContent = [
      "",
      padLine(tableTitle, rightWidth, "center"),
      (useColor ? chalk.dim : (s: string) => s)(padLine("forge context", rightWidth, "center")),
      "",
      ...metaRows(d, rightWidth, unicode, useColor),
      "",
    ];
    content = zipColumns(centerColumn(leftContent, leftWidth), rightContent, leftWidth, gap, rightWidth);
  } else {
    content = centerColumn(leftContent, inner);
  }

  const leftBorder = lit(g.v);
  const rightBorder = shadow(g.v);
  const finalContentLines = content.map(raw => leftBorder + padLine(truncate(raw, inner), inner) + rightBorder);

  return [topBorderLine, ...finalContentLines, bottomBorderLine];
}

/**
 * Launch animation: sweep the forge mark's gradient through `cycles` FULL palette
 * cycles by re-printing the welcome box in place (cursor-up rewrites, same row
 * count every frame). The loop is SEAMLESS — the phase wraps exactly at each
 * cycle boundary with a constant frame delay, so consecutive cycles join with
 * no pause or color jump — and every repaint is wrapped in a DECSET 2026
 * synchronized update so frames land atomically (no tearing/flicker on slow
 * terminals). The FINAL frame is phase 0 — byte-identical to the static
 * `renderWelcome` — so the resting banner matches non-animated output exactly.
 * `write`/`sleep` are injectable for tests; callers gate on TTY + truecolor.
 */
export async function playWelcomeSweep(
  d: WelcomeData,
  opts: { write?: (s: string) => void; sleep?: (ms: number) => Promise<unknown>; frames?: number; delayMs?: number; cycles?: number } = {},
): Promise<void> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  const frames = Math.max(1, Math.trunc(opts.frames ?? 10));
  const cycles = Math.max(1, Math.trunc(opts.cycles ?? 2));
  const delay = opts.delayMs ?? 50;
  const total = frames * cycles;
  let lineCount = 0;
  for (let f = 0; f <= total; f++) {
    const phase = (f % frames) / frames; // wraps each cycle; f === total → 0 (the static banner)
    const lines = renderWelcome({ ...d, phase });
    const rewind = f > 0 ? `\x1b[${lineCount}A` : "";
    // BSU/ESU: the whole repaint (rewind + every row) applies atomically.
    write(`\x1b[?2026h${rewind}${lines.map(l => `${l}\x1b[K`).join("\n")}\n\x1b[?2026l`);
    lineCount = lines.length;
    if (f < total && delay > 0) await sleep(delay);
  }
}
