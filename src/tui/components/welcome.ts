import chalk from "chalk";
import * as path from "node:path";
import * as os from "node:os";
import { renderForgeMark, FORGE_MARK_ART_GRAND } from "./ascii-art";
import { truncate, isTTY } from "../terminal";
import { detectColorLevel, ColorLevel, visibleWidth } from "./color";
import { parseChangelogSections, changelogText } from "../../util/whats-new";

function getLatestChangelogItems(): { version: string; items: string[] } {
  try {
    const sections = parseChangelogSections(changelogText);
    if (sections.length > 0) {
      const latest = sections[0];
      const items: string[] = [];
      for (const g of latest.groups) {
        for (const item of g.items) {
          items.push(item);
        }
      }
      return { version: latest.version, items };
    }
  } catch {}
  return { version: "", items: [] };
}
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

function renderRightColumn(d: WelcomeData, width: number, unicode: boolean, useColor: boolean): string[] {
  const accent = useColor ? (d.accent ?? chalk.cyan) : (s: string) => s;
  const dim = useColor ? chalk.dim : (s: string) => s;
  const gray = useColor ? chalk.gray : (s: string) => s;
  const bold = useColor ? chalk.bold : (s: string) => s;
  const bulletChar = unicode ? "•" : "-";
  const hChar = unicode ? "─" : "-";
  const sepLine = dim(hChar.repeat(width));

  const lines: string[] = [];

  // 1. What's New
  lines.push(padLine(` ${bold(accent("What's New"))}`, width));
  const changelog = getLatestChangelogItems();
  if (changelog.items.length > 0) {
    const prefix = ` ${bulletChar} `;
    const textWidth = Math.max(1, width - visibleWidth(prefix));
    const shown = changelog.items.slice(0, 3);
    for (const item of shown) {
      const text = visibleWidth(item) > textWidth ? truncate(item, textWidth) : item;
      lines.push(padLine(`${dim(prefix)}${gray(text)}`, width));
    }
  } else {
    lines.push(padLine(gray(" Ready for your next prompt"), width));
  }

  lines.push(padLine(sepLine, width));

  // 2. Flow keys
  lines.push(padLine(` ${bold(accent("Flow keys"))}`, width));
  const FLOW_KEY_ITEMS = [
    { key: "/", label: "commands" },
    { key: "tab", label: "complete" },
    { key: "ctrl+l", label: "model" },
    { key: "ctrl+c", label: "cancel" },
    { key: "alt+enter", label: "newline" },
  ];
  const flowKeyItemText = (item: { key: string; label: string }) => {
    const k = useColor ? chalk.dim(item.key) : item.key;
    const l = useColor ? chalk.gray(item.label) : item.label;
    return `${k} ${l}`;
  };
  const dot = unicode ? "·" : "*";
  const flowSep = ` ${dim(dot)} `;
  let currentFlowLine = "";
  const flowLines: string[] = [];
  for (const item of FLOW_KEY_ITEMS) {
    const segment = flowKeyItemText(item);
    const next = currentFlowLine ? `${currentFlowLine}${flowSep}${segment}` : segment;
    if (currentFlowLine && visibleWidth(next) > width - 2) {
      flowLines.push(` ${currentFlowLine}`);
      currentFlowLine = segment;
    } else {
      currentFlowLine = next;
    }
  }
  if (currentFlowLine) flowLines.push(` ${currentFlowLine}`);
  for (const line of flowLines.slice(0, 2)) {
    lines.push(padLine(line, width));
  }

  lines.push(padLine(sepLine, width));

  // 3. Project pulse
  lines.push(padLine(` ${bold(accent("Project pulse"))}`, width));
  const dotChar = unicode ? "●" : "*";
  const lspStatus = useColor ? chalk.green(dotChar) : dotChar;
  lines.push(padLine(` ${lspStatus} ${gray("TypeScript")} ${dim("ready")}`, width));

  lines.push(padLine(sepLine, width));

  // 4. Session trail
  lines.push(padLine(` ${bold(accent("Session trail"))}`, width));
  const recent = d.recentSessions ?? [];
  if (recent.length > 0) {
    const bulletPrefix = ` ${bulletChar} `;
    const prefixWidth = visibleWidth(bulletPrefix);
    for (const session of recent.slice(0, 3)) {
      const timeSuffixRaw = ` (${session.timeAgo})`;
      const timeWidth = visibleWidth(timeSuffixRaw);
      const nameBudget = Math.max(1, width - prefixWidth - timeWidth);
      const nameVis = visibleWidth(session.name);
      const name = nameVis > nameBudget ? truncate(session.name, nameBudget) : session.name;
      const bullet = useColor ? chalk.dim(bulletPrefix) : bulletPrefix;
      const sName = useColor ? chalk.gray(name) : name;
      const sTime = useColor ? chalk.dim(timeSuffixRaw) : timeSuffixRaw;
      lines.push(padLine(`${bullet}${sName}${sTime}`, width));
    }
  } else {
    lines.push(padLine(gray(" No saved sessions"), width));
  }

  return lines;
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
    // Narrow-terminal one-line fallback — MUST itself be width-capped: an unbounded
    // `jeo v{version} · {model}` overflows badly with a realistic provider-qualified
    // model id (e.g. "antigravity/claude-sonnet-4-6 (antigravity)" overflows a 10-col
    // terminal by 47 columns), which is exactly the box-border/wrap misalignment a
    // real terminal-resize-down reproduces live. `cols - 1` (not `cols`) — same
    // "leave the last column free" convention as the boxed banner below: a line
    // truncated to EXACTLY `cols` is ambiguous to real terminals (a full-width row
    // followed by this line's own trailing "\n" can double-advance a row via the
    // pending-autowrap/explicit-LF ambiguity), which is a second, independent
    // corruption vector reproduced live — not just a cosmetic nicety.
    return [truncate(`jeo v${d.version} · ${d.model}`, Math.max(0, cols - 1))];
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
    const rightContent = [
      "",
      ...renderRightColumn(d, rightWidth, unicode, useColor),
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
