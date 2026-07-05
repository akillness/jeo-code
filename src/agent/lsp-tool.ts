/**
 * `lsp` tool — read-only TypeScript/JavaScript language-service queries (gjc `lsp`
 * parity, scoped to TS/JS/TSX/JSX via the in-process `ts.LanguageService` from
 * `ts-language-service.ts` — NOT a real LSP client/server, NOT multi-language).
 * Safe for every subagent role. Cross-file rename (mutating) is the separate
 * `lsp_rename` tool so the read-only-role toolset filter (which gates by tool
 * NAME, not by argument) cannot be bypassed by a `rename` action hidden in here.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import { languageServiceFor, parseSymbolSelector, resolvePosition, lineTextAt, lineOfPosition, formatLocation } from "./ts-language-service";
import { resolveTargetFiles } from "./ast-file-scan";

/** One-line protocol description appended to the launch system prompt. */
export const LSP_TOOL_PROTOCOL_LINE =
  `lsp {action:"definition"|"references"|"hover"|"symbols"|"diagnostics", file, line?, symbol?} — ` +
  `TypeScript/JavaScript language-service queries (in-process ts.LanguageService, not a real LSP server). ` +
  `'symbol' is a substring on 'line' used to resolve the column automatically (append "#N" to pick the Nth ` +
  `occurrence). 'definition'/'references'/'hover' need file+line(+symbol); 'symbols' needs only file; ` +
  `'diagnostics' takes file (a path, glob, or "*" for the whole project) and needs no line/symbol. Cross-file ` +
  `rename is the separate 'lsp_rename' tool.`;

async function readAbs(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

function err(message: string): ToolResult {
  return { success: false, output: "", error: message };
}

interface ResolvedTarget {
  absPath: string;
  rel: string;
  text: string;
  position: number;
}

async function resolveTarget(args: Record<string, any>, cwd: string): Promise<ResolvedTarget | { error: string }> {
  const fileArg = typeof args.file === "string" ? args.file.trim() : "";
  if (!fileArg) return { error: `lsp requires a non-empty "file".` };
  const absPath = path.resolve(cwd, fileArg);
  const text = await readAbs(absPath);
  if (text === null) return { error: `Cannot read file '${fileArg}'.` };

  const lineRaw = args.line;
  const line = typeof lineRaw === "number" ? lineRaw : parseInt(String(lineRaw ?? ""), 10);
  if (!Number.isFinite(line) || line < 1) return { error: `lsp requires a positive integer "line".` };

  const symbol = parseSymbolSelector(typeof args.symbol === "string" ? args.symbol : undefined);
  const pos = resolvePosition(text, line, symbol);
  if ("error" in pos) return { error: pos.error };

  return { absPath, rel: path.relative(cwd, absPath) || absPath, text, position: pos.position };
}

const MAX_REFERENCES_FULL = 50;
const MAX_DIAGNOSTIC_FILES = 50;

export function createLspTool(): ToolHandler {
  return async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
    const action = String(args.action ?? "").trim().toLowerCase();

    if (action === "definition") {
      const t = await resolveTarget(args, cwd);
      if ("error" in t) return err(t.error);
      const service = await languageServiceFor(cwd, t.absPath);
      const result = service.getDefinitionAndBoundSpan(t.absPath, t.position);
      const defs = result?.definitions ?? [];
      if (defs.length === 0) return { success: true, output: "No definition found." };
      const lines: string[] = [];
      for (const d of defs) {
        const dText = (await readAbs(d.fileName)) ?? "";
        const dLine = lineOfPosition(dText, d.textSpan.start);
        const rel = path.relative(cwd, d.fileName) || d.fileName;
        lines.push(formatLocation(rel, dLine, lineTextAt(dText, dLine)));
      }
      return { success: true, output: lines.join("\n") };
    }

    if (action === "references") {
      const t = await resolveTarget(args, cwd);
      if ("error" in t) return err(t.error);
      const service = await languageServiceFor(cwd, t.absPath);
      const refs = service.getReferencesAtPosition(t.absPath, t.position) ?? [];
      if (refs.length === 0) return { success: true, output: "No references found." };
      const lines: string[] = [];
      for (let i = 0; i < refs.length; i++) {
        const r = refs[i]!;
        const rel = path.relative(cwd, r.fileName) || r.fileName;
        const rText = (await readAbs(r.fileName)) ?? "";
        const rLine = lineOfPosition(rText, r.textSpan.start);
        lines.push(i < MAX_REFERENCES_FULL ? formatLocation(rel, rLine, lineTextAt(rText, rLine)) : `${rel}:${rLine}`);
      }
      return { success: true, output: `${refs.length} reference(s):\n${lines.join("\n")}` };
    }

    if (action === "hover") {
      const t = await resolveTarget(args, cwd);
      if ("error" in t) return err(t.error);
      const service = await languageServiceFor(cwd, t.absPath);
      const info = service.getQuickInfoAtPosition(t.absPath, t.position);
      if (!info) return { success: true, output: "No hover info available at that position." };
      const signature = (info.displayParts ?? []).map(p => p.text).join("");
      const doc = (info.documentation ?? []).map(p => p.text).join("").trim();
      return { success: true, output: doc ? `${signature}\n\n${doc}` : signature };
    }

    if (action === "symbols") {
      const fileArg = typeof args.file === "string" ? args.file.trim() : "";
      if (!fileArg) return err(`lsp {action:"symbols"} requires a non-empty "file".`);
      const absPath = path.resolve(cwd, fileArg);
      const text = await readAbs(absPath);
      if (text === null) return err(`Cannot read file '${fileArg}'.`);
      const service = await languageServiceFor(cwd, absPath);
      const items = service.getNavigationBarItems(absPath);
      const lines: string[] = [];
      const walk = (nodes: readonly ts.NavigationBarItem[], depth: number) => {
        for (const n of nodes) {
          const span = n.spans[0];
          const line1 = span ? lineOfPosition(text, span.start) : undefined;
          lines.push(`${"  ".repeat(depth)}${n.text} (${n.kind})${line1 ? ` — line ${line1}` : ""}`);
          if (n.childItems && n.childItems.length) walk(n.childItems, depth + 1);
        }
      };
      walk(items, 0);
      return { success: true, output: lines.length ? lines.join("\n") : "No symbols found." };
    }

    if (action === "diagnostics") {
      const fileArg = args.file;
      const rawPaths = fileArg === "*"
        ? ["**/*"]
        : Array.isArray(fileArg) ? fileArg.map((p: unknown) => String(p))
        : typeof fileArg === "string" && fileArg.trim() ? [fileArg.trim()]
        : [];
      if (rawPaths.length === 0) {
        return err(`lsp {action:"diagnostics"} requires a "file" (path, glob, or "*" for the whole project).`);
      }
      let files: string[];
      try {
        files = await resolveTargetFiles(rawPaths, cwd);
      } catch (e: any) {
        return err(e.message);
      }
      if (files.length === 0) return { success: true, output: "No matching TypeScript/JavaScript files." };

      const scanned = files.slice(0, MAX_DIAGNOSTIC_FILES);
      const lines: string[] = [];
      let count = 0;
      for (const absPath of scanned) {
        const service = await languageServiceFor(cwd, absPath);
        const text = (await readAbs(absPath)) ?? "";
        const diags = [...service.getSyntacticDiagnostics(absPath), ...service.getSemanticDiagnostics(absPath)];
        if (diags.length === 0) continue;
        const rel = path.relative(cwd, absPath) || absPath;
        for (const d of diags) {
          count++;
          const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
          const line1 = d.start !== undefined ? lineOfPosition(text, d.start) : 0;
          lines.push(`${rel}:${line1}: ${msg}`);
        }
      }
      if (count === 0) return { success: true, output: `0 diagnostics across ${scanned.length} file(s).` };
      const note = files.length > MAX_DIAGNOSTIC_FILES ? ` (scanned first ${MAX_DIAGNOSTIC_FILES} of ${files.length} files)` : "";
      return { success: true, output: `${count} diagnostic(s)${note}:\n${lines.join("\n")}` };
    }

    return err(`Unknown lsp action '${action}'. Use definition | references | hover | symbols | diagnostics.`);
  };
}
