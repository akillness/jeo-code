/**
 * Shared file-targeting helpers for `ast_grep`/`ast_edit` — resolves a loose
 * `paths` argument (files, directories, or globs) to a deduplicated, sorted list
 * of TypeScript/JavaScript file absolute paths, respecting `.gitignore` and the
 * same ignored-directory list as `find`/`search` (see `tools.ts`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import { IGNORED_DIRS, readGitignore } from "./tools";

export const AST_SUPPORTED_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** Hard cap on how many files a single ast_grep/ast_edit call will scan — a stray
 *  `paths: ["**"]` on a huge repo must not hang the turn. */
export const AST_MAX_FILES = 500;

export function scriptKindFor(file: string): ts.ScriptKind {
  const ext = path.extname(file);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

export async function resolveTargetFiles(rawPaths: string[], cwd: string): Promise<string[]> {
  const gi = await readGitignore(cwd);
  const prunedDirs = new Set([...IGNORED_DIRS, ...gi.dirs]);
  const fileGlobs = gi.fileGlobs.map(g => new Bun.Glob(g));
  const out = new Set<string>();

  for (const raw of rawPaths) {
    if (out.size >= AST_MAX_FILES) break;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let pattern = trimmed;
    const abs = path.resolve(cwd, trimmed);
    let isDir = false;
    try { isDir = (await fs.stat(abs)).isDirectory(); } catch { /* not an existing path — treat as a glob/pattern */ }

    if (isDir) {
      pattern = `${trimmed.replace(/\/+$/, "")}/**/*`;
    } else if (!/[*?[\]]/.test(trimmed)) {
      // A plain existing (or nonexistent) file path — no glob metacharacters.
      if (AST_SUPPORTED_EXT.has(path.extname(trimmed))) out.add(abs);
      continue;
    }

    for await (const rel of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true })) {
      const norm = rel.replace(/\\/g, "/");
      const segs = norm.split("/");
      if (segs.some(s => prunedDirs.has(s))) continue;
      const base = segs[segs.length - 1] ?? norm;
      if (fileGlobs.some(g => g.match(base))) continue;
      if (!AST_SUPPORTED_EXT.has(path.extname(base))) continue;
      out.add(path.resolve(cwd, norm));
      if (out.size >= AST_MAX_FILES) break;
    }
  }
  return [...out].sort();
}
