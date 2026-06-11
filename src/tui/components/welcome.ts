import chalk from "chalk";
import os from "node:os";
import { getStageByIndex, renderAsciiArt } from "./ascii-art";
import { truncate } from "../terminal";

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

function shortenCwd(cwd: string): string {
  const home = process.env.HOME ?? os.homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) {
    return "~" + cwd.slice(home.length);
  }
  return cwd;
}

function formatWorkspaceLine(label: string, value: string, width: number, useColor: boolean): string {
  const combinedPlain = label + value;
  if (combinedPlain.length <= width) {
    return useColor ? chalk.dim(label) + value : combinedPlain;
  } else {
    const allowedValueLen = Math.max(0, width - label.length);
    const truncatedValue = value.slice(0, allowedValueLen);
    return useColor ? chalk.dim(label) + truncatedValue : label + truncatedValue;
  }
}

function formatSessionLine(name: string, timeAgo: string, width: number, useColor: boolean, unicode: boolean): string {
  const bullet = unicode ? "•" : "*";
  const label = `${bullet} `;
  const valueSuffix = ` (${timeAgo})`;
  const totalLabel = `${bullet} `;
  const plainText = `${totalLabel}${name}${valueSuffix}`;
  if (plainText.length <= width) {
    if (useColor) {
      return `${chalk.cyan(bullet)} ${name} ${chalk.dim(valueSuffix)}`;
    } else {
      return plainText;
    }
  } else {
    const allowedNameLen = Math.max(0, width - totalLabel.length - valueSuffix.length);
    const truncatedName = name.slice(0, allowedNameLen);
    if (useColor) {
      return `${chalk.cyan(bullet)} ${truncatedName} ${chalk.dim(valueSuffix)}`;
    } else {
      return `${totalLabel}${truncatedName}${valueSuffix}`;
    }
  }
}

export function renderWelcome(d: WelcomeData): string[] {
  const cols = d.cols ?? 80;
  const unicode = d.unicode !== false;
  const useColor = d.color !== false;

  if (cols < 30) {
    return [ `joc v${d.version} · ${d.model}` ];
  }

  const W = Math.min(100, cols - 2);
  const inner = W - 2;

  const BOX_UNICODE = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
  const BOX_ASCII = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  const g = unicode ? BOX_UNICODE : BOX_ASCII;

  // Title text: ─── joc v{version} · evolution forge ───
  const dashStr = (unicode ? "─" : "-").repeat(3);
  const titleText = `${dashStr} joc v${d.version} · evolution forge ${dashStr}`;

  let topBorderContent = titleText;
  if (topBorderContent.length > inner) {
    topBorderContent = topBorderContent.slice(0, inner);
  } else {
    topBorderContent = topBorderContent + g.h.repeat(inner - topBorderContent.length);
  }
  const topBorderPlain = g.tl + topBorderContent + g.tr;
  const topBorderLine = useColor ? chalk.gray(topBorderPlain) : topBorderPlain;

  const bottomBorderPlain = g.bl + g.h.repeat(inner) + g.br;
  const bottomBorderLine = useColor ? chalk.gray(bottomBorderPlain) : bottomBorderPlain;

  // Compile LEFT column
  const artLines = renderAsciiArt(getStageByIndex(0), {
    color: useColor,
    firing: false,
    frame: 0
  });

  const leftLines: string[] = [];
  leftLines.push("");
  leftLines.push(useColor ? chalk.bold.cyan("jeo-code") : "jeo-code");
  leftLines.push(useColor ? chalk.dim("evolve · act · prove") : "evolve · act · prove");
  leftLines.push("");
  for (const line of artLines) {
    leftLines.push(line);
  }
  leftLines.push("");

  const modelIcon = unicode ? "◆" : "*";
  leftLines.push(useColor ? chalk.cyan(`[ ${modelIcon} ${d.model} ]`) : `[ ${modelIcon} ${d.model} ]`);

  if (d.provider) {
    const providerIcon = unicode ? "◇" : "o";
    leftLines.push(useColor ? chalk.blue(`[ ${providerIcon} ${d.provider} ]`) : `[ ${providerIcon} ${d.provider} ]`);
  }

  const finalContentLines: string[] = [];

  if (W >= 64) {
    // Two columns
    const leftWidth = Math.min(32, Math.floor(inner * 0.45));
    const rightWidth = inner - 1 - leftWidth;

    // Compile RIGHT column
    const workspaceLines: string[] = [];
    if (d.cwd) {
      const shortened = shortenCwd(d.cwd);
      workspaceLines.push(formatWorkspaceLine("cwd ", shortened, rightWidth, useColor));
    }
    if (d.thinking) {
      workspaceLines.push(formatWorkspaceLine("thinking ", d.thinking, rightWidth, useColor));
    }
    if (d.sessionId) {
      const session8 = d.sessionId.slice(0, 8);
      workspaceLines.push(formatWorkspaceLine("session ", session8, rightWidth, useColor));
    }
    if (d.contextFiles && d.contextFiles.length > 0) {
      // Dedupe repeated basenames (e.g. nested AGENTS.md files) so the narrow
      // workspace column lists distinct names instead of "AGENTS.md, AGENTS.md, …".
      const basenames = [...new Set(d.contextFiles.map(f => f.split(/[/\\]/).pop() || f))];
      const joined = basenames.join(", ");
      const label = `context ${d.contextFiles.length} file(s): `;
      workspaceLines.push(formatWorkspaceLine(label, joined, rightWidth, useColor));
    }

    const sessionTrailLines: string[] = [];
    if (!d.recentSessions || d.recentSessions.length === 0) {
      sessionTrailLines.push(useColor ? chalk.dim("No saved trails") : "No saved trails");
    } else {
      const sessions = d.recentSessions.slice(0, 3);
      for (const s of sessions) {
        sessionTrailLines.push(formatSessionLine(s.name, s.timeAgo, rightWidth, useColor, unicode));
      }
    }

    const rightLines: string[] = [];
    rightLines.push(useColor ? chalk.bold("Flow keys") : "Flow keys");
    rightLines.push(useColor ? chalk.dim("/ commands · /model model") : "/ commands · /model model");
    rightLines.push(useColor ? chalk.dim("/skill skills · /sessions history") : "/skill skills · /sessions history");
    rightLines.push(useColor ? chalk.dim("/exit quit · /help all") : "/exit quit · /help all");
    rightLines.push("DIVIDER");
    rightLines.push(useColor ? chalk.bold("Workspace") : "Workspace");
    for (const line of workspaceLines) {
      rightLines.push(line);
    }
    rightLines.push("DIVIDER");
    rightLines.push(useColor ? chalk.bold("Session trail") : "Session trail");
    for (const line of sessionTrailLines) {
      rightLines.push(line);
    }

    const maxLines = Math.max(leftLines.length, rightLines.length);
    for (let i = 0; i < maxLines; i++) {
      const rawL = leftLines[i] ?? "";
      const rawR = rightLines[i] ?? "";

      const truncatedL = truncate(rawL, leftWidth);
      const l = padLine(truncatedL, leftWidth, "center");

      let r = "";
      if (rawR === "DIVIDER") {
        const sepChar = unicode ? "─" : "-";
        r = useColor ? chalk.dim(sepChar.repeat(rightWidth)) : sepChar.repeat(rightWidth);
      } else {
        const truncatedR = truncate(rawR, rightWidth);
        r = padLine(truncatedR, rightWidth, "left");
      }

      const leftBorder = useColor ? chalk.gray(g.v) : g.v;
      const midBorder = useColor ? chalk.gray(g.v) : g.v;
      const rightBorder = useColor ? chalk.gray(g.v) : g.v;
      finalContentLines.push(leftBorder + l + midBorder + r + rightBorder);
    }
  } else {
    // Single column
    for (let i = 0; i < leftLines.length; i++) {
      const rawL = leftLines[i] ?? "";
      const truncatedL = truncate(rawL, inner);
      const l = padLine(truncatedL, inner, "center");
      const leftBorder = useColor ? chalk.gray(g.v) : g.v;
      const rightBorder = useColor ? chalk.gray(g.v) : g.v;
      finalContentLines.push(leftBorder + l + rightBorder);
    }
  }

  return [topBorderLine, ...finalContentLines, bottomBorderLine];
}
