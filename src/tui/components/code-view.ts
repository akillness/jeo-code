/**
 * Code view (코드뷰) — pure formatters that render file content and diffs inside
 * the TUI with a line-number gutter, ANSI-aware width clamping, light
 * language-aware coloring, and a bounded line budget. Used by the `/view` and
 * `/diff` slash commands. Everything is a pure function over strings so it can be
 * unit-tested with an ANSI-stripping helper.
 */
import chalk from "chalk";
import { truncate } from "../terminal";
import { diffPaint, getTheme, type EvolutionTheme } from "./themes";

const LANG_BY_EXT: Record<string, string> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  json: "json", jsonc: "json",
  md: "md", markdown: "md",
  py: "py", sh: "sh", bash: "sh", zsh: "sh",
  yml: "yaml", yaml: "yaml", toml: "toml",
  css: "css", html: "html", rs: "rust", go: "go",
};

/** Line-comment token per language (used for whole-line comment dimming). */
const COMMENT_TOKEN: Record<string, string> = {
  ts: "//", js: "//", rust: "//", go: "//", css: "/*",
  py: "#", sh: "#", yaml: "#", toml: "#",
};

const KEYWORDS = new Set([
  "import", "export", "from", "const", "let", "var", "function", "return", "class",
  "interface", "type", "if", "else", "for", "while", "await", "async", "new",
  "try", "catch", "finally", "throw", "def", "fn", "pub", "struct", "enum", "impl",
]);

/** Map a file path to a language id for highlighting. Unknown → "". */
export function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext] ?? "";
}

export function languageLabel(lang: string): string {
  return lang || "text";
}

export interface ParsedRange {
  start: number;
  end?: number;
}

/** Parse "start-end" / "start-" / "start" into 1-based bounds. null when invalid. */
export function parseLineRange(spec: string): ParsedRange | null {
  const m = spec.trim().match(/^(\d+)(?:-(\d+)?)?$/);
  if (!m) return null;
  const start = Math.max(1, parseInt(m[1], 10));
  if (m[2]) {
    const end = parseInt(m[2], 10);
    if (end < start) return null;
    return { start, end };
  }
  // "start-" → open-ended; "start" → single line.
  return spec.includes("-") ? { start } : { start, end: start };
}

/** Slice content by 1-based [start,end]; returns { lines, startLine }. */
export function sliceLines(content: string, range?: ParsedRange): { lines: string[]; startLine: number } {
  const all = content.split("\n");
  if (!range) return { lines: all, startLine: 1 };
  const start = Math.min(Math.max(1, range.start), all.length || 1);
  const end = range.end ? Math.min(range.end, all.length) : all.length;
  return { lines: all.slice(start - 1, end), startLine: start };
}

/** Conservative, single-pass light highlight: whole-line comments, then string literals. */
export function lightHighlightLine(line: string, lang: string): string {
  const token = COMMENT_TOKEN[lang];
  if (token && line.trimStart().startsWith(token)) return chalk.gray(line);
  // String literals (double / single / backtick), non-greedy, no escapes handling.
  let out = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, m => chalk.green(m));
  if (out !== line) return out;
  // No strings → keyword pass on word boundaries.
  out = line.replace(/\b[A-Za-z_]+\b/g, w => (KEYWORDS.has(w) ? chalk.cyan(w) : w));
  return out;
}

/**
 * Make a line from arbitrary file/diff content safe to print in the REPL/TUI region.
 * File bytes are untrusted display data: a raw `\x1b[2J`, OSC title set, lone `\r`
 * progress-overwrite, or a stray C0 byte can clear the screen, move the cursor, or
 * corrupt the gutter. Strip CR, expand tabs, and remove ANSI/C0 control sequences.
 * jeo's own coloring is applied AFTER this, so no intended color is lost.
 */
export function sanitizeForTerminal(line: string): string {
  return line
    .replace(/\r/g, "")
    .replace(/\t/g, "  ")
    // OSC: ESC ] ... (BEL | ST)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI: ESC [ ... final-byte  (SGR, cursor moves, screen/line clears, etc.)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // other ESC-led two-byte sequences
    .replace(/\x1b[@-Z\\-_]/g, "")
    // 8-bit C1 CSI/OSC (U+009B / U+009D …) — neutralize the payload like the ESC forms
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x9d[^\x07\x9c]*(?:\x07|\x9c)/g, "")
    // any remaining C0 controls + DEL + C1 (U+0080–U+009F)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

export interface CodeViewOptions {
  startLine?: number;
  lang?: string;
  cols?: number;
  maxLines?: number;
  /** 1-based absolute line numbers to mark in the gutter. */
  highlight?: number[];
  /** Enable light coloring (default true). */
  color?: boolean;
  /** Gutter separator glyph (default "│"). */
  sep?: string;
}

/** Render code with a right-aligned line-number gutter, clamped to `cols`. */
export function formatCodeBlock(content: string, opts: CodeViewOptions = {}): string[] {
  const startLine = opts.startLine ?? 1;
  const cols = opts.cols ?? 100;
  const maxLines = opts.maxLines ?? 200;
  const sep = opts.sep ?? "│";
  const color = opts.color !== false;
  const lang = opts.lang ?? "";
  const highlight = new Set(opts.highlight ?? []);

  const allLines = content.split("\n");
  const shown = allLines.slice(0, maxLines);
  const lastNo = startLine + shown.length - 1;
  const gutterW = Math.max(String(lastNo).length, 2);

  const out: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    const no = startLine + i;
    const num = String(no).padStart(gutterW, " ");
    const sepGlyph = color ? chalk.gray(sep) : "|";
    // File-origin content can carry hostile escapes — neutralize, then expand tabs
    // so the gutter alignment is column-stable.
    const body = sanitizeForTerminal(allLines[i]!).replace(/\t/g, "  ");
    const colored = color ? lightHighlightLine(body, lang) : body;
    const marked = highlight.has(no);
    const marker = marked ? (color ? chalk.yellow("▶") : ">") : " ";
    
    let prefix = " ";
    if (body.startsWith("+")) prefix = color ? chalk.green("+") : "+";
    else if (body.startsWith("-")) prefix = color ? chalk.red("-") : "-";
    
    const line = `${marker}${prefix}${num} ${sepGlyph} ${colored}`;
    out.push(truncate(line, cols));
  }

  if (allLines.length > maxLines) {
    const more = allLines.length - maxLines;
    out.push(color ? chalk.gray(`  …(+${more} more line${more === 1 ? "" : "s"})`) : `  …(+${more} more lines)`);
  }
  return out;
}

/** Render a unified diff with themed contrast: added/removed lines carry a
 *  foreground + full-row background tint (block-level separation, not just a
 *  colored sign), file heads are bold, and hunk headers get a distinct accent.
 *  `theme` selects the palette; the default palette applies when omitted. */
export function formatDiff(
  diffText: string,
  opts: { cols?: number; maxLines?: number; color?: boolean; theme?: EvolutionTheme } = {},
): string[] {
  const cols = opts.cols ?? 100;
  const maxLines = opts.maxLines ?? 400;
  const color = opts.color !== false;
  const dp = diffPaint(opts.theme ?? getTheme(undefined));
  const lines = diffText.split("\n");
  const shown = lines.slice(0, maxLines);
  const out = shown.map(raw => {
    const l = sanitizeForTerminal(raw);
    if (!color) return truncate(l, cols);
    if (l.startsWith("+++")) return truncate(dp.addHead(l), cols);
    if (l.startsWith("---")) return truncate(dp.delHead(l), cols);
    if (l.startsWith("@@")) return truncate(dp.hunk(l), cols);
    if (l.startsWith("+")) return truncate(dp.add(l), cols);
    if (l.startsWith("-")) return truncate(dp.del(l), cols);
    return truncate(l, cols);
  });
  if (lines.length > maxLines) out.push(color ? chalk.gray(`  …(+${lines.length - maxLines} more)`) : `  …(+${lines.length - maxLines} more)`);
  return out;
}
