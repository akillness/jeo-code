/**
 * `ast_edit` tool — structural (AST-based) codemod for TypeScript/JavaScript, gjc
 * `ast_edit` parity via the same pure-TS metavariable matcher as `ast_grep`. MUTATING:
 * excluded from read-only subagent roles (see `subagents.ts`'s `MUTATING` set).
 *
 * Each match is replaced by rendering the `replacement` template — `$NAME`/`$$$NAME`
 * substituted with that match's captured text — then splicing the result into the
 * original file text (matches within one file are applied in reverse source order so
 * earlier replacements never shift later offsets; overlapping matches are resolved by
 * keeping the earliest and skipping any later match that starts before it ends).
 * Writes go through the existing `writeTool` so the deep-interview mutation lock and
 * stale-read guard apply exactly as they do for `write`/`edit`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import { writeTool } from "./tools";
import { findMatches, parsePattern, renderReplacement, type MatchResult } from "./ast-match";
import { resolveTargetFiles, scriptKindFor } from "./ast-file-scan";

/** One-line protocol description appended to the launch system prompt. */
export const AST_EDIT_TOOL_PROTOCOL_LINE =
  `ast_edit {pattern, replacement, paths} — structural TypeScript/JavaScript rewrite. Same ` +
  `pattern metavariables as ast_grep; 'replacement' is a template where $NAME/$$$NAME are ` +
  `substituted with that match's captured text (empty replacement deletes matches). Rewrites ` +
  `every match across the given files/dirs/globs and writes the files (mutation lock and ` +
  `stale-read checks apply, same as write/edit).`;

function pathsOf(args: Record<string, any>): string[] {
  if (Array.isArray(args.paths)) return args.paths.map((p: unknown) => String(p));
  if (typeof args.paths === "string" && args.paths.trim()) return [args.paths];
  return [];
}

export function createAstEditTool(): ToolHandler {
  return async (args: Record<string, any>, cwd: string, _onProgress, signal): Promise<ToolResult> => {
    const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
    if (!pattern) {
      return { success: false, output: "", error: `ast_edit requires a non-empty "pattern".` };
    }
    const replacement = typeof args.replacement === "string" ? args.replacement
      : typeof args.out === "string" ? args.out : undefined;
    if (replacement === undefined) {
      return { success: false, output: "", error: `ast_edit requires a "replacement" template string (use "" to delete matches).` };
    }
    try {
      parsePattern(pattern);
    } catch (err: any) {
      return { success: false, output: "", error: `ast_edit pattern error: ${err.message}` };
    }

    const rawPaths = pathsOf(args);
    if (rawPaths.length === 0) {
      return { success: false, output: "", error: `ast_edit requires a non-empty "paths" array (files, directories, or globs).` };
    }

    let files: string[];
    try {
      files = await resolveTargetFiles(rawPaths, cwd);
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
    if (files.length === 0) {
      return {
        success: true,
        output: "No TypeScript/JavaScript files matched the given paths (ast_edit only covers .ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts).",
      };
    }

    const perFile: { file: string; replaced: number }[] = [];
    let totalReplaced = 0;

    for (const abs of files) {
      let original: string;
      try {
        original = await fs.readFile(abs, "utf-8");
      } catch {
        continue;
      }
      const sf = ts.createSourceFile(abs, original, ts.ScriptTarget.Latest, true, scriptKindFor(abs));
      const matches = findMatches(pattern, sf);
      if (matches.length === 0) continue;

      // Greedy non-overlap selection: earliest-starting match wins any overlap.
      const sorted = [...matches].sort((a, b) => a.node.getStart(sf) - b.node.getStart(sf));
      const selected: MatchResult[] = [];
      let lastEnd = -1;
      for (const m of sorted) {
        const start = m.node.getStart(sf);
        if (start < lastEnd) continue;
        selected.push(m);
        lastEnd = m.node.getEnd();
      }
      if (selected.length === 0) continue;

      const edits = selected.map(m => ({
        start: m.node.getStart(sf),
        end: m.node.getEnd(),
        text: renderReplacement(replacement, m.captures),
      }));
      let newText = original;
      for (const e of [...edits].sort((a, b) => b.start - a.start)) {
        newText = newText.slice(0, e.start) + e.text + newText.slice(e.end);
      }

      const rel = path.relative(cwd, abs) || abs;
      const res = await writeTool(rel, newText, cwd, signal);
      if (!res.success) {
        return { success: false, output: "", error: `${rel}: ${res.error ?? "write failed"}` };
      }
      perFile.push({ file: rel, replaced: selected.length });
      totalReplaced += selected.length;
    }

    if (totalReplaced === 0) {
      return { success: true, output: `0 matches for pattern across ${files.length} file(s) — nothing rewritten.` };
    }
    const lines = perFile.map(f => `- ${f.file}: ${f.replaced} replacement(s)`);
    return { success: true, output: `${totalReplaced} replacement(s) across ${perFile.length} file(s):\n${lines.join("\n")}` };
  };
}
