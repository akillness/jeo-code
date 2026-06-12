import * as path from "node:path";
import * as os from "node:os";
import chalk from "chalk";
import { stageIndexForStep, evolutionTrack } from "./evolution";
import { formatCost } from "../../ai/pricing";

export interface FooterData {
  model: string;
  provider?: string;
  /** Drives the evolution-stage tag only — never rendered as a `step n/m` counter
   *  (the dynamic step budget keeps extending the denominator, so the raw count
   *  carries no information — user feedback). */
  step?: number;
  maxSteps?: number;
  elapsedMs?: number;
  sessionId?: string;
  /** Append a compact evolution-stage tag (default true when step+maxSteps known). */
  showStage?: boolean;
  /** Use ASCII track markers in the stage tag (default unicode). */
  unicode?: boolean;
  /** Colorize the stage track (default true). Set false for the mono theme. */
  color?: boolean;
  /** Estimated context usage in tokens, when known. */
  contextUsedTokens?: number;
  /** Provider/model context window in tokens, when known. */
  contextMaxTokens?: number;
  cwd?: string;
  branch?: string;
  /** Uncommitted-change count for the `⑂ branch ?N` dirty flag (gjc parity); omit/0 = clean. */
  dirtyCount?: number;
  /** Live USD cost for the turn (price table × usage); omit when the model has no known price. */
  costUsd?: number;
  autoCompact?: boolean;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    let formatted = (n / 1_000_000).toFixed(1);
    if (formatted.endsWith(".0")) {
      formatted = formatted.slice(0, -2);
    }
    return formatted + "M";
  }
  if (n >= 1000) {
    return Math.round(n / 1000) + "k";
  }
  return Math.round(n).toString();
}

function middleTruncate(s: string, maxLen: number, unicode: boolean): string {
  if (s.length <= maxLen) return s;
  const ellipsis = unicode ? "…" : "...";
  const rem = maxLen - ellipsis.length;
  const leftLen = Math.ceil(rem / 2);
  const rightLen = Math.floor(rem / 2);
  const rightPart = rightLen > 0 ? s.slice(-rightLen) : "";
  return s.slice(0, leftLen) + ellipsis + rightPart;
}

export function renderFooter(d: FooterData): string {
  const parts: string[] = [];
  const unicode = d.unicode !== false;

  // Model & Provider
  if (d.model) {
    if (d.provider) {
      parts.push(`${d.model} (${d.provider})`);
    } else {
      parts.push(d.model);
    }
  }

  // CWD & Branch
  if (d.cwd !== undefined) {
    let displayCwd = d.cwd;
    const home = os.homedir();
    if (home) {
      if (displayCwd === home) {
        displayCwd = "~";
      } else if (displayCwd.startsWith(home + "/") || displayCwd.startsWith(home + "\\")) {
        displayCwd = "~" + displayCwd.slice(home.length);
      }
    }
    displayCwd = middleTruncate(displayCwd, 32, unicode);
    if (d.branch) {
      const dirty = d.dirtyCount && d.dirtyCount > 0 ? ` ?${d.dirtyCount}` : "";
      parts.push(`${displayCwd} (${d.branch}${dirty})`);
    } else {
      parts.push(displayCwd);
    }
  }

  // No `step n/m` segment (and no step-derived eta/evo%): the dynamic step budget
  // keeps extending the denominator, so those counters carried no information
  // (user feedback). `step`/`maxSteps` still drive the stage tag below.

  // Elapsed
  if (d.elapsedMs !== undefined) {
    const secs = Math.round(d.elapsedMs / 1000);
    parts.push(`${secs}s`);
  }

  // Estimated context usage (opt-in): cheap footer signal for context growth.
  if (d.contextUsedTokens !== undefined) {
    const used = Math.max(0, Math.round(d.contextUsedTokens));
    let ctxStr = "";
    if (d.contextMaxTokens && d.contextMaxTokens > 0) {
      const max = Math.round(d.contextMaxTokens);
      const pct = Math.min(999, Math.round((used / max) * 100));
      ctxStr = `ctx ${pct}%/${formatTokens(max)}`;
      if (d.autoCompact) {
        ctxStr += "(auto)";
      }
      if (d.color !== false) {
        if (pct >= 85) {
          ctxStr = chalk.red(ctxStr);
        } else if (pct >= 60) {
          ctxStr = chalk.yellow(ctxStr);
        }
      }
    } else {
      ctxStr = `ctx ~${formatTokens(used)}`;
    }
    parts.push(ctxStr);
  }

  // Session ID
  if (d.sessionId) {
    parts.push(d.sessionId.slice(0, 8));
  }

  // Live turn cost (gjc parity): only when a known price produced a figure.
  if (d.costUsd !== undefined && Number.isFinite(d.costUsd) && d.costUsd > 0) {
    parts.push(formatCost(d.costUsd));
  }

  // Compact evolution-stage tag, e.g. "●●●○○ Tool User (Homo Habilis) [3/5]".
  if (d.showStage !== false && d.step !== undefined && d.maxSteps !== undefined) {
    const idx = stageIndexForStep(d.step, d.maxSteps);
    parts.push(evolutionTrack(idx, { color: d.color !== false, unicode }));
  }

  return parts.join(" · ");
}
