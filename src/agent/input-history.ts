/**
 * Cross-launch input-history persistence for the interactive prompt.
 *
 * readline only remembers lines typed in the CURRENT run, so ↑ at the prompt
 * recalled nothing on a fresh launch (and only this-run prompts otherwise). This
 * persists submitted prompts to a per-workspace file so ↑ recalls "previously
 * used queries" across launches — the same recall a shell gives you — and it
 * composes with `/resume`'s in-session seeding (gjc-style durable input history).
 *
 * Pure filesystem helpers, kept tiny and best-effort: a read/write failure never
 * breaks the prompt. The file is newline-delimited, oldest→newest on disk.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = "input-history";
/** How many recent entries to hydrate into readline on launch. */
export const HISTORY_LOAD_LIMIT = 200;
/** Hard cap on the on-disk file so it can't grow without bound. */
export const HISTORY_FILE_CAP = 1000;
/** Skip persisting pathological single lines (giant pastes etc.). */
const MAX_ENTRY_LEN = 2000;

function jeoDir(cwd: string): string {
  return path.join(cwd, ".jeo");
}

export function inputHistoryPath(cwd: string): string {
  return path.join(jeoDir(cwd), FILE);
}

function readLines(cwd: string): string[] {
  try {
    return fs
      .readFileSync(inputHistoryPath(cwd), "utf-8")
      .split("\n")
      .map(l => l.replace(/\s+$/, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Load recent prompts NEWEST-FIRST, deduplicated, for readline's `rl.history`
 * (which is itself newest-first). At most `limit` entries; never throws.
 */
export function loadInputHistory(cwd: string, limit = HISTORY_LOAD_LIMIT): string[] {
  const lines = readLines(cwd); // oldest → newest
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]!;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line); // walking backward → already newest-first
  }
  return out;
}

/**
 * Append one submitted prompt (best-effort, never throws). Skips blanks, the
 * immediate duplicate of the last entry, multi-line/over-long pastes, and trims
 * the file to `cap` lines so it stays bounded.
 */
export function appendInputHistory(cwd: string, line: string, cap = HISTORY_FILE_CAP): void {
  try {
    const entry = line.trim();
    if (!entry || entry.includes("\n") || entry.length > MAX_ENTRY_LEN) return;
    const existing = readLines(cwd);
    if (existing.length > 0 && existing[existing.length - 1] === entry) return;
    existing.push(entry);
    const trimmed = existing.length > cap ? existing.slice(existing.length - cap) : existing;
    fs.mkdirSync(jeoDir(cwd), { recursive: true });
    fs.writeFileSync(inputHistoryPath(cwd), `${trimmed.join("\n")}\n`, "utf-8");
  } catch {
    /* best-effort: history persistence must never break the prompt */
  }
}
