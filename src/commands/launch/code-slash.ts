/**
 * Read-only code-inspection slash handlers extracted from launch.ts.
 *
 * Each handler is a self-contained async function that takes the raw slash
 * input plus the working directory (and, for `/diff`, the active theme) and
 * returns the lines to print. They perform no closure-bound side effects, so
 * the REPL dispatch just prints whatever lines come back — matching the
 * `{ lines }` contract used by the other extracted slash handlers.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import chalk from "chalk";
import { findTool, searchTool } from "../../agent/tools";
import {
  detectLanguage,
  languageLabel,
  parseLineRange,
  sliceLines,
  formatCodeBlock,
  formatDiff,
} from "../../tui/components/code-view";
import { categoryBadge } from "../../tui/components/category-index";
import { size as terminalSize } from "../../tui/terminal";
import type { EvolutionTheme } from "../../tui/components/themes";

/** `/view <file> [start-end]` — render a file (optionally a line range) as a code block. */
export async function handleViewSlash(input: string, cwd: string): Promise<string[]> {
  const tokens = input.substring(5).trim().split(/\s+/).filter(Boolean);
  const file = tokens[0];
  if (!file) {
    return ["Usage: /view <file> [start-end]   (e.g. /view src/cli.ts 1-40)"];
  }
  let content: string;
  try {
    content = await fs.promises.readFile(path.resolve(cwd, file), "utf-8");
  } catch (err) {
    return [`! cannot read ${file}: ${(err as Error).message}`];
  }
  const range = tokens[1] ? parseLineRange(tokens[1]) : undefined;
  if (tokens[1] && !range) {
    return [`Invalid range '${tokens[1]}'. Use start-end | start- | start.`];
  }
  const lang = detectLanguage(file);
  const { lines, startLine } = sliceLines(content, range ?? undefined);
  const { cols } = terminalSize();
  const out: string[] = [
    `${categoryBadge("file")} ${chalk.bold(`${file}`)}${chalk.gray(`  (${languageLabel(lang)}, lines ${startLine}-${startLine + lines.length - 1})`)}`,
  ];
  for (const line of formatCodeBlock(lines.join("\n"), { startLine, lang, cols: Math.max(40, cols - 1), maxLines: 200 })) {
    out.push(line);
  }
  return out;
}

/** `/diff [path]` — render `git diff` (optionally pathspec-scoped) with theme coloring. */
export async function handleDiffSlash(input: string, cwd: string, theme: EvolutionTheme): Promise<string[]> {
  const target = input.substring(5).trim();
  const proc = Bun.spawnSync(["git", "diff", ...(target ? ["--", target] : [])], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0 && !proc.stdout.length) {
    return [`! git diff failed: ${proc.stderr.toString().trim() || "not a git repo?"}`];
  }
  const text = proc.stdout.toString();
  if (!text.trim()) {
    return ["(no unstaged changes)"];
  }
  const { cols } = terminalSize();
  const out: string[] = [`${categoryBadge("diff")} git diff${target ? ` -- ${target}` : ""}`];
  for (const line of formatDiff(text, { cols: Math.max(40, cols - 1), maxLines: 400, theme })) out.push(line);
  return out;
}

/** `/find <glob>` — list files matching a glob via the shared findTool. */
export async function handleFindSlash(input: string, cwd: string): Promise<string[]> {
  const glob = input.substring(5).trim();
  if (!glob) {
    return ["Usage: /find <glob>   (e.g. /find src/**/*.ts)"];
  }
  const res = await findTool(glob, cwd);
  return [
    `${categoryBadge("search")} find files matching '${glob}':`,
    res.success ? (res.output || "(no matches)") : `! ${res.error}`,
  ];
}

/** `/search <pattern> [glob]` — grep the tree via the shared searchTool. */
export async function handleSearchSlash(input: string, cwd: string): Promise<string[]> {
  const tokens = input.substring(7).trim().split(/\s+/).filter(Boolean);
  const pattern = tokens[0];
  const glob = tokens[1] ?? "*";
  if (!pattern) {
    return ["Usage: /search <pattern> [glob]   (e.g. /search resolveProvider src/**/*.ts)"];
  }
  const res = await searchTool(pattern, glob, cwd);
  return [
    `${categoryBadge("search")} search pattern '${pattern}' in '${glob}':`,
    res.success ? (res.output || "(no matches)") : `! ${res.error}`,
  ];
}
