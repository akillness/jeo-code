/**
 * In-process TypeScript "language service" host (gjc `lsp` parity for TS/JS/TSX/JSX
 * ONLY — no external `typescript-language-server` process, no other languages).
 * Built directly on the `typescript` compiler API's `ts.LanguageService`, which is
 * the exact engine `tsserver`/most TS editor integrations run on top of — so
 * definition/references/hover/rename here match what a real TS language server
 * would report, just without the LSP wire protocol or multi-language support.
 *
 * One `ts.LanguageService` is cached per project root (`cwd`) and reused across
 * calls within a turn. `getScriptVersion` stats the file on every call (no manual
 * invalidation needed) so edits made by `write`/`edit`/`ast_edit` earlier in the
 * same turn are picked up on the next `lsp` call. A file outside the project's
 * `tsconfig.json` "include" set is added to the tracked root set on first use.
 */
import * as ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveTargetFiles } from "./ast-file-scan";

interface CachedService {
  service: ts.LanguageService;
  extraFiles: Set<string>;
}

const serviceCache = new Map<string, CachedService>();

function fileVersion(absPath: string): string {
  try {
    const st = fs.statSync(absPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
}

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  allowJs: true,
  checkJs: false,
  esModuleInterop: true,
  resolveJsonModule: true,
  strict: false,
};

function loadProjectFiles(cwd: string): { options: ts.CompilerOptions; fileNames: string[] } {
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!configFile.error) {
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
      if (parsed.fileNames.length > 0) return { options: parsed.options, fileNames: parsed.fileNames };
    }
  }
  return { options: DEFAULT_COMPILER_OPTIONS, fileNames: [] };
}

/** Get (or lazily create) the cached `ts.LanguageService` for a project root. */
async function getCached(cwd: string): Promise<CachedService> {
  const existing = serviceCache.get(cwd);
  if (existing) return existing;

  const fromConfig = loadProjectFiles(cwd);
  // No tsconfig.json (or it named zero files) — scan the whole project tree for
  // supported TS/JS files instead of starting with an EMPTY root set. Without this,
  // "references"/"rename" starting from a declaration would only ever see the ONE
  // file explicitly queried: TS's own module resolution pulls in files a root file
  // IMPORTS, never the reverse (files that import a root file), so a project with
  // no tsconfig would silently miss every cross-file usage.
  const fileNames = fromConfig.fileNames.length > 0 ? fromConfig.fileNames : await resolveTargetFiles(["**/*"], cwd);
  const options = fromConfig.options;
  const rootFiles = new Set(fileNames);
  const extraFiles = new Set<string>();

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...rootFiles, ...extraFiles],
    getScriptVersion: fileVersion,
    getScriptSnapshot: (fileName) => {
      try {
        return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf-8"));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => cwd,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  const cached: CachedService = { service, extraFiles };
  serviceCache.set(cwd, cached);
  return cached;
}

/** Get the language service for `cwd`, ensuring `absPath` is tracked (added to the
 *  root set if the project's tsconfig didn't already include it). */
export async function languageServiceFor(cwd: string, absPath: string): Promise<ts.LanguageService> {
  const cached = await getCached(cwd);
  if (!cached.extraFiles.has(absPath)) cached.extraFiles.add(absPath);
  return cached.service;
}

export interface SymbolSelector { text: string; occurrence: number }

/** Parse a loose `"name"` or `"name#N"` selector (1-indexed occurrence, default 1). */
export function parseSymbolSelector(input: string | undefined): SymbolSelector | undefined {
  if (!input) return undefined;
  const m = /^(.*)#(\d+)$/.exec(input);
  if (m) return { text: m[1]!, occurrence: Math.max(1, parseInt(m[2]!, 10)) };
  return { text: input, occurrence: 1 };
}

export type PositionResult = { position: number } | { error: string };

/** Resolve a 1-indexed `line` (+ optional symbol substring selector) to an absolute
 *  character offset in `fileText`, using the TS compiler's own line map (so CRLF
 *  files are handled correctly, unlike naive `split("\n")` offset arithmetic). */
export function resolvePosition(fileText: string, line1: number, symbol?: SymbolSelector): PositionResult {
  const sf = ts.createSourceFile("__pos__.tsx", fileText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const lineCount = sf.getLineStarts().length;
  if (line1 < 1 || line1 > lineCount) {
    return { error: `line ${line1} is out of range (file has ${lineCount} lines)` };
  }
  const lineStart = sf.getPositionOfLineAndCharacter(line1 - 1, 0);
  const lineEnd = line1 < lineCount ? sf.getPositionOfLineAndCharacter(line1, 0) : fileText.length;
  const lineText = fileText.slice(lineStart, lineEnd).replace(/\r?\n$/, "");

  if (!symbol) return { position: lineStart };

  let idx = -1;
  let from = 0;
  for (let i = 0; i < symbol.occurrence; i++) {
    idx = lineText.indexOf(symbol.text, from);
    if (idx === -1) break;
    from = idx + 1;
  }
  if (idx === -1) {
    return { error: `symbol '${symbol.text}' (occurrence ${symbol.occurrence}) not found on line ${line1}: ${lineText.trim().slice(0, 120)}` };
  }
  return { position: lineStart + idx + Math.max(0, Math.floor(symbol.text.length / 2)) };
}

/** One line of a file, 1-indexed, trimmed for display. */
export function lineTextAt(fileText: string, line1: number): string {
  const lines = fileText.split(/\r?\n/);
  return (lines[line1 - 1] ?? "").trim();
}

/** Convert a 0-indexed TS `position` in `fileText` to a 1-indexed line number. */
export function lineOfPosition(fileText: string, position: number): number {
  const sf = ts.createSourceFile("__pos__.tsx", fileText, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  return sf.getLineAndCharacterOfPosition(position).line + 1;
}

/** A short, uniform `path:line: text` result line. */
export function formatLocation(relPath: string, line1: number, text: string): string {
  return `${relPath}:${line1}: ${text.length > 160 ? text.slice(0, 159) + "…" : text}`;
}
