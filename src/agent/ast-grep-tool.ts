/**
 * `ast_grep` tool — structural (AST-based) code search for TypeScript/JavaScript,
 * gjc `ast_grep` parity via a pure-TS metavariable matcher (see `ast-match.ts`),
 * scoped to `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.mts`/`.cts` — NOT the native
 * ast-grep binary and NOT multi-language. Read-only; safe for every subagent role.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import { findMatches, parsePattern, type MatchResult } from "./ast-match";
import { resolveTargetFiles, scriptKindFor } from "./ast-file-scan";

/** One-line protocol description appended to the launch system prompt. */
export const AST_GREP_TOOL_PROTOCOL_LINE =
  `ast_grep {pattern, paths} — structural TypeScript/JavaScript search (files/dirs/globs in ` +
  `'paths'). Pattern metavariables: $NAME captures one node (repeats must match identical ` +
  `code), $_ is a wildcard node, $$$NAME/$$$ capture/ignore zero-or-more sibling nodes in a ` +
  `list (call args, statements, class members, ...). Whitespace/formatting is ignored — this ` +
  `matches AST shape, not text.`;

const MAX_MATCHES_PER_FILE = 20;
const MAX_TOTAL_MATCHES = 200;

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function snippet(sf: ts.SourceFile, node: ts.Node): string {
  const oneLine = node.getText(sf).replace(/\s+/g, " ").trim();
  return oneLine.length > 140 ? oneLine.slice(0, 139) + "…" : oneLine;
}

function captureSummary(m: MatchResult): string {
  const flat: Record<string, string> = { ...m.captures.single };
  for (const [k, v] of Object.entries(m.captures.multi)) flat[k] = v.join(", ");
  return Object.keys(flat).length ? ` ${JSON.stringify(flat)}` : "";
}

function pathsOf(args: Record<string, any>): string[] {
  if (Array.isArray(args.paths)) return args.paths.map((p: unknown) => String(p));
  if (typeof args.paths === "string" && args.paths.trim()) return [args.paths];
  return [];
}

export function createAstGrepTool(): ToolHandler {
  return async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
    const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
    if (!pattern) {
      return { success: false, output: "", error: `ast_grep requires a non-empty "pattern".` };
    }
    try {
      parsePattern(pattern);
    } catch (err: any) {
      return { success: false, output: "", error: `ast_grep pattern error: ${err.message}` };
    }

    const rawPaths = pathsOf(args);
    if (rawPaths.length === 0) {
      return { success: false, output: "", error: `ast_grep requires a non-empty "paths" array (files, directories, or globs).` };
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
        output: "No TypeScript/JavaScript files matched the given paths (ast_grep only covers .ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts).",
      };
    }

    const lines: string[] = [];
    let total = 0;
    let filesWithMatches = 0;
    for (const abs of files) {
      if (total >= MAX_TOTAL_MATCHES) break;
      let text: string;
      try {
        text = await fs.readFile(abs, "utf-8");
      } catch {
        continue;
      }
      const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKindFor(abs));
      const matches = findMatches(pattern, sf);
      if (matches.length === 0) continue;
      filesWithMatches++;
      const rel = path.relative(cwd, abs) || abs;
      for (const m of matches.slice(0, MAX_MATCHES_PER_FILE)) {
        if (total >= MAX_TOTAL_MATCHES) break;
        total++;
        const line = lineOf(sf, m.node.getStart(sf));
        lines.push(`${rel}:${line}: ${snippet(sf, m.node)}${captureSummary(m)}`);
      }
    }

    if (total === 0) {
      return { success: true, output: `0 matches for pattern across ${files.length} file(s).` };
    }
    const capNote = total >= MAX_TOTAL_MATCHES ? ` (truncated at ${MAX_TOTAL_MATCHES})` : "";
    return { success: true, output: `${total} match(es) in ${filesWithMatches} file(s)${capNote}:\n${lines.join("\n")}` };
  };
}
