/**
 * `lsp_rename` tool — cross-file TypeScript/JavaScript symbol rename (gjc `lsp`
 * `action:"rename"` parity), using the same in-process `ts.LanguageService` as the
 * read-only `lsp` tool. MUTATING: kept as its own tool (not an action on `lsp`) so
 * the read-only-role toolset filter — which excludes tools by NAME — cannot be
 * bypassed by an `apply:true` argument hidden inside a nominally "read-only" tool.
 * Writes go through the existing `writeTool`, so the mutation lock and stale-read
 * guard apply exactly as they do for `write`/`edit`/`ast_edit`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as ts from "typescript";
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";
import { writeTool } from "./tools";
import { languageServiceFor, parseSymbolSelector, resolvePosition, lineTextAt, lineOfPosition, formatLocation } from "./ts-language-service";

/** One-line protocol description appended to the launch system prompt. */
export const LSP_RENAME_TOOL_PROTOCOL_LINE =
  `lsp_rename {file, line, symbol?, new_name, apply?} — rename a TypeScript/JavaScript symbol across every ` +
  `file in the project via the same in-process language service as 'lsp' (same file/line/symbol addressing). ` +
  `'apply' defaults to true (writes files — mutation lock/stale-read checks apply, same as write/edit); ` +
  `apply:false previews every location that would change without writing anything.`;

function err(message: string): ToolResult {
  return { success: false, output: "", error: message };
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function createLspRenameTool(): ToolHandler {
  return async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
    const fileArg = typeof args.file === "string" ? args.file.trim() : "";
    if (!fileArg) return err(`lsp_rename requires a non-empty "file".`);

    const newName = typeof args.new_name === "string" ? args.new_name.trim()
      : typeof args.newName === "string" ? args.newName.trim() : "";
    if (!newName) return err(`lsp_rename requires a non-empty "new_name".`);
    if (!IDENTIFIER_RE.test(newName)) return err(`"new_name" must be a valid identifier, got '${newName}'.`);

    const absPath = path.resolve(cwd, fileArg);
    let text: string;
    try {
      text = await fs.readFile(absPath, "utf-8");
    } catch {
      return err(`Cannot read file '${fileArg}'.`);
    }

    const lineRaw = args.line;
    const line = typeof lineRaw === "number" ? lineRaw : parseInt(String(lineRaw ?? ""), 10);
    if (!Number.isFinite(line) || line < 1) return err(`lsp_rename requires a positive integer "line".`);

    const symbol = parseSymbolSelector(typeof args.symbol === "string" ? args.symbol : undefined);
    const pos = resolvePosition(text, line, symbol);
    if ("error" in pos) return err(pos.error);

    const service = await languageServiceFor(cwd, absPath);
    const renameInfo = service.getRenameInfo(absPath, pos.position, {});
    if (!renameInfo.canRename) {
      const reason = "localizedErrorMessage" in renameInfo ? renameInfo.localizedErrorMessage : "not a renameable symbol here";
      return err(`Cannot rename here: ${reason}.`);
    }

    const locations = service.findRenameLocations(absPath, pos.position, false, false, {}) ?? [];
    if (locations.length === 0) return { success: true, output: "No rename locations found." };

    const apply = args.apply !== false; // default true

    const byFile = new Map<string, ts.TextSpan[]>();
    for (const loc of locations) {
      const spans = byFile.get(loc.fileName) ?? [];
      spans.push(loc.textSpan);
      byFile.set(loc.fileName, spans);
    }

    const preview: string[] = [];
    let totalEdits = 0;
    for (const [fName, spans] of byFile) {
      const rel = path.relative(cwd, fName) || fName;
      let content: string;
      try {
        content = await fs.readFile(fName, "utf-8");
      } catch {
        return err(`Cannot read file '${rel}' while applying rename.`);
      }

      for (const span of spans) {
        totalEdits++;
        const line1 = lineOfPosition(content, span.start);
        preview.push(formatLocation(rel, line1, lineTextAt(content, line1)));
      }

      if (apply) {
        let newText = content;
        for (const span of [...spans].sort((a, b) => b.start - a.start)) {
          newText = newText.slice(0, span.start) + newName + newText.slice(span.start + span.length);
        }
        const res = await writeTool(rel, newText, cwd);
        if (!res.success) return err(`${rel}: ${res.error ?? "write failed"}`);
      }
    }

    const header = apply
      ? `Renamed ${totalEdits} occurrence(s) across ${byFile.size} file(s):`
      : `Preview: ${totalEdits} occurrence(s) across ${byFile.size} file(s) would be renamed to '${newName}' (apply:false, nothing written):`;
    return { success: true, output: `${header}\n${preview.join("\n")}` };
  };
}
