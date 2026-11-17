import chalk from "chalk";
import { renderMarkdownTables } from "./markdown-table";
import { wrapTextWordAware, wrapTextWithAnsi } from "./width";

export interface MarkdownAnsiOptions {
  /** Heading painter (theme accent + bold); default chalk.bold. */
  accent?: (s: string) => string;
  /** Secondary-text painter for link URLs, the blockquote gutter, horizontal rules,
   *  and ~~struck~~ text. jeo tone uses a REAL theme mid-tone hue here instead of ANSI
   *  `dim`, which collapses to near-invisible on dark terminals (parity with the
   *  todo/forge cards). Default chalk.dim when no theme painter is threaded. */
  muted?: (s: string) => string;
  /** Inline `code` painter; default chalk.cyan so code stays distinct from accent headings. */
  code?: (s: string) => string;
}

export interface MarkdownBlockOptions extends MarkdownAnsiOptions {
  /** Enable ANSI colors/styles (false → plain text matching stripMarkdown + tables). Default true. */
  color?: boolean;
  /** Use Unicode box-drawing / gutter glyphs (false → ASCII). Default true. */
  unicode?: boolean;
  /** Target terminal display width for tables and word-aware line wrapping. */
  maxWidth?: number;
}

interface FenceState {
  char: "`" | "~";
  len: number;
}

function matchOpenFence(trimmed: string): FenceState | null {
  const bt = trimmed.match(/^(`{3,})([^`]*)$/);
  if (bt) return { char: "`", len: bt[1]!.length };
  const tl = trimmed.match(/^(~{3,})(.*)$/);
  if (tl) return { char: "~", len: tl[1]!.length };
  return null;
}

function isCloseFence(trimmed: string, fence: FenceState): boolean {
  const ch = fence.char;
  if (!trimmed.startsWith(ch.repeat(fence.len))) return false;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== ch) return false;
  }
  return true;
}

/** True for box-drawn table lines already laid out by `renderMarkdownTables`.
 *  Such lines already contain exact display-width padding (plus optional ANSI in
 *  cells) and must pass through `renderMarkdownAnsi` / `stripMarkdown` untouched. */
export function isBoxTableLine(line: string, inAsciiTable: boolean): { isTable: boolean; nextAscii: boolean } {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (!plain) return { isTable: false, nextAscii: false };
  if (/^[┌├└][─┬┼┴]+[┐┤┘]$/.test(plain)) return { isTable: true, nextAscii: false };
  if (/^│.*│$/.test(plain)) return { isTable: true, nextAscii: false };
  if (/^\+(?:-+\+)+$/.test(plain)) return { isTable: true, nextAscii: true };
  if (inAsciiTable && /^\|.*\|$/.test(plain)) return { isTable: true, nextAscii: true };
  return { isTable: false, nextAscii: false };
}

function makeTokenPrefix(source: string): string {
  // Choose a private-use delimiter pair guaranteed absent from `source`.
  for (let code = 0xe100; code <= 0xe8ff; code++) {
    const ch = String.fromCharCode(code);
    if (!source.includes(ch)) return ch;
  }
  return "\u0000";
}

function countBackticksAt(s: string, idx: number): number {
  let n = 0;
  while (idx + n < s.length && s[idx + n] === "`") n++;
  return n;
}

function isEscapedAt(s: string, idx: number): boolean {
  let slashes = 0;
  for (let i = idx - 1; i >= 0 && s[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

/** Extract inline CommonMark code spans (`code` or ``co`de``) into placeholders so
 *  asterisks, underscores, tildes, and brackets inside inline code are never parsed
 *  as emphasis or links. */
function maskInlineCode(
  line: string,
  delim: string,
): { masked: string; codes: string[] } {
  if (!line.includes("`")) return { masked: line, codes: [] };
  const codes: string[] = [];
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`" && !isEscapedAt(line, i)) {
      const tickLen = countBackticksAt(line, i);
      let j = i + tickLen;
      let closeIdx = -1;
      while (j < line.length) {
        if (line[j] === "`") {
          const closeLen = countBackticksAt(line, j);
          if (closeLen === tickLen) {
            closeIdx = j;
            break;
          }
          j += closeLen;
          continue;
        }
        j++;
      }
      if (closeIdx !== -1) {
        let body = line.slice(i + tickLen, closeIdx);
        if (body.length >= 2 && body.startsWith(" ") && body.endsWith(" ") && body.trim().length > 0) {
          body = body.slice(1, -1);
        }
        const idx = codes.length;
        codes.push(body);
        out += `${delim}C${idx}${delim}`;
        i = closeIdx + tickLen;
        continue;
      }
      out += line.slice(i, i + tickLen);
      i += tickLen;
      continue;
    }
    out += line[i]!;
    i++;
  }
  return { masked: out, codes };
}

function applyEmphasis(
  text: string,
  painters?: {
    bold: (s: string) => string;
    italic: (s: string) => string;
    boldItalic: (s: string) => string;
    strike: (s: string) => string;
  },
): string {
  const id = (s: string) => s;
  const p = painters ?? { bold: id, italic: id, boldItalic: id, strike: id };
  return text
    .replace(/\*\*\*(?=\S)([^\n]+?)(?<=\S)\*\*\*/g, (_m, t: string) => p.boldItalic(t))
    .replace(/(?<![\p{L}\p{N}_])___(?=\S)([^\n]+?)(?<=\S)___(?![\p{L}\p{N}_])/gu, (_m, t: string) => p.boldItalic(t))
    .replace(/\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g, (_m, t: string) => p.bold(t))
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)([^\n]+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, (_m, t: string) => p.bold(t))
    .replace(/\*(?=\S)([^*\n]*?)(?<=\S)\*/g, (_m, t: string) => p.italic(t))
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)([^_\n]*?)(?<=\S)_(?![\p{L}\p{N}_])/gu, (_m, t: string) => p.italic(t))
    .replace(/~~(?=\S)([^~\n]*?)(?<=\S)~~/g, (_m, t: string) => p.strike(t));
}

function formatInlineCore(
  line: string,
  mode: {
    color: boolean;
    muted: (s: string) => string;
    code: (s: string) => string;
  },
): string {
  if (!line) return "";
  const delim = makeTokenPrefix(line);
  const { masked, codes } = maskInlineCode(line, delim);

  // Protect images & links before running emphasis regexes so underscores or stars
  // inside URLs (e.g. https://example.com/my_file_path) are never stripped or styled.
  const links: { label: string; url: string; image: boolean }[] = [];
  const withLinkTokens = masked
    .replace(/!\[([^\]]*)\]\(([^)\n]+)\)/g, (_m, alt: string, url: string) => {
      const idx = links.length;
      links.push({ label: alt, url, image: true });
      return `${delim}L${idx}${delim}`;
    })
    .replace(/\[([^\]]+)\]\(([^)\n]+)\)/g, (_m, label: string, url: string) => {
      const idx = links.length;
      links.push({ label, url, image: false });
      return `${delim}L${idx}${delim}`;
    });

  const painters = mode.color
    ? {
        bold: (s: string) => chalk.bold(s),
        italic: (s: string) => chalk.italic(s),
        boldItalic: (s: string) => chalk.bold.italic(s),
        strike: (s: string) => chalk.strikethrough(mode.muted(s)),
      }
    : undefined;

  let formatted = applyEmphasis(withLinkTokens, painters);

  if (links.length > 0) {
    formatted = formatted.replace(new RegExp(`${delim}L(\\d+)${delim}`, "g"), (_m, rawIdx: string) => {
      const entry = links[Number(rawIdx)]!;
      const labelText = applyEmphasis(entry.label, painters);
      if (entry.image) return labelText;
      return mode.color ? `${labelText} ${mode.muted(`(${entry.url})`)}` : `${labelText} (${entry.url})`;
    });
  }

  if (codes.length > 0) {
    formatted = formatted.replace(new RegExp(`${delim}C(\\d+)${delim}`, "g"), (_m, rawIdx: string) => {
      const snippet = codes[Number(rawIdx)]!;
      return mode.color ? mode.code(snippet) : snippet;
    });
  }

  // Unescape common backslash-escaped punctuation (`\*`, `\_`, `\`\`, `\\`, `\|`, `\[`, `\]`, `\~`, `\#`, `\>`)
  return formatted.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, "$1");
}

/** Strip inline Markdown formatting on a single line (preserving code spans and
 *  snake_case identifiers). Useful inside table cells before measuring widths. */
export function stripInlineMarkdown(line: string): string {
  return formatInlineCore(line, {
    color: false,
    muted: s => s,
    code: s => s,
  });
}

/** Style inline Markdown formatting on a single line into ANSI text. */
export function styleInlineMarkdown(line: string, opts: MarkdownAnsiOptions = {}): string {
  return formatInlineCore(line, {
    color: true,
    muted: opts.muted ?? ((s: string) => chalk.dim(s)),
    code: opts.code ?? ((s: string) => chalk.cyan(s)),
  });
}

/**
 * Strip markdown formatting from text, returning plain text.
 * Preserves fenced code bodies verbatim, leaves box-drawn tables untouched,
 * and avoids corrupting `snake_case_identifiers` or underscores inside URLs.
 */
export function stripMarkdown(text: string): string {
  if (!text) return "";

  const out: string[] = [];
  let fence: FenceState | null = null;
  let inAsciiTable = false;

  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();

    if (fence) {
      if (isCloseFence(trimmed, fence)) {
        fence = null;
      } else {
        out.push(rawLine);
      }
      inAsciiTable = false;
      continue;
    }

    const opened = matchOpenFence(trimmed);
    if (opened) {
      fence = opened;
      out.push("");
      inAsciiTable = false;
      continue;
    }

    const tableInfo = isBoxTableLine(rawLine, inAsciiTable);
    if (tableInfo.isTable) {
      inAsciiTable = tableInfo.nextAscii;
      out.push(rawLine);
      continue;
    }
    inAsciiTable = false;

    if (trimmed === "") {
      out.push("");
      continue;
    }

    // Horizontal rules
    if (/^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(rawLine)) {
      out.push("");
      continue;
    }

    // Headings
    const heading = rawLine.match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/);
    if (heading) {
      out.push(stripInlineMarkdown(heading[1]!));
      continue;
    }

    // Blockquotes
    const quote = rawLine.match(/^\s{0,3}(>+)\s?(.*)$/);
    if (quote) {
      out.push(stripInlineMarkdown(quote[2]!));
      continue;
    }

    out.push(stripInlineMarkdown(rawLine));
  }

  return out.join("\n").trim();
}

/**
 * Render markdown as styled ANSI text (jeo-ref final-report format): headings
 * become painted section titles, **bold** / `inline code` keep visual weight,
 * fences/links/quotes degrade cleanly, and pre-rendered box tables pass through
 * verbatim without corrupting column alignment. Fenced code BODIES are passed
 * through untouched (only the opening/closing fence rows are dropped).
 */
export function renderMarkdownAnsi(text: string, opts: MarkdownAnsiOptions = {}): string {
  if (!text) return "";
  const accent = opts.accent ?? ((s: string) => chalk.bold(s));
  const muted = opts.muted ?? ((s: string) => chalk.dim(s));
  const code = opts.code ?? ((s: string) => chalk.cyan(s));
  const inlineOpts: MarkdownAnsiOptions = { accent, muted, code };

  const out: string[] = [];
  let fence: FenceState | null = null;
  let inAsciiTable = false;

  // Types: "empty" | "heading" | "blockquote" | "list" | "code" | "table" | "prose"
  let lastType: "empty" | "heading" | "blockquote" | "list" | "code" | "table" | "prose" = "empty";

  const ensureBlankLine = () => {
    if (out.length > 0 && out[out.length - 1] !== "") {
      out.push("");
    }
  };

  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();

    if (fence) {
      if (isCloseFence(trimmed, fence)) {
        fence = null;
        ensureBlankLine();
        lastType = "empty";
      } else {
        out.push(rawLine); // code bodies verbatim
        lastType = "code";
      }
      inAsciiTable = false;
      continue;
    }

    const opened = matchOpenFence(trimmed);
    if (opened) {
      ensureBlankLine();
      fence = opened;
      lastType = "code";
      inAsciiTable = false;
      continue;
    }

    const tableInfo = isBoxTableLine(rawLine, inAsciiTable);
    if (tableInfo.isTable) {
      if (lastType !== "table" && lastType !== "empty") {
        ensureBlankLine();
      }
      inAsciiTable = tableInfo.nextAscii;
      out.push(rawLine);
      lastType = "table";
      continue;
    }
    inAsciiTable = false;

    if (trimmed === "") {
      ensureBlankLine();
      lastType = "empty";
      continue;
    }

    const heading = rawLine.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/);
    if (heading) {
      ensureBlankLine();
      out.push(accent(styleInlineMarkdown(heading[2]!, inlineOpts)));
      lastType = "heading";
      continue;
    }

    const quote = rawLine.match(/^\s{0,3}(>+)\s?(.*)$/);
    if (quote) {
      if (lastType !== "blockquote" && lastType !== "empty") {
        ensureBlankLine();
      }
      const depth = quote[1]!.length;
      const gutter = "▎ ".repeat(depth);
      const body = styleInlineMarkdown(quote[2]!, inlineOpts);
      out.push(muted(body ? `${gutter}${body}` : gutter.trimEnd()));
      lastType = "blockquote";
      continue;
    }

    if (/^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(rawLine)) {
      ensureBlankLine();
      out.push(muted("─".repeat(24)));
      ensureBlankLine();
      lastType = "empty";
      continue;
    }

    // List item (unordered or ordered, including GFM task checkboxes `[ ]` / `[x]`).
    const listMatch = rawLine.match(/^(\s*)([*\-+]|\d+[.)])\s+(.*)$/);
    if (listMatch) {
      if (lastType !== "list" && lastType !== "empty") {
        ensureBlankLine();
      }
      const [, indent, bullet, rest] = listMatch;
      const task = rest!.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        const checked = task[1]!.toLowerCase() === "x";
        const box = checked ? chalk.green("✔") : muted("☐");
        out.push(`${indent}${bullet} ${box} ${styleInlineMarkdown(task[2]!, inlineOpts)}`);
      } else {
        out.push(`${indent}${bullet} ${styleInlineMarkdown(rest!, inlineOpts)}`);
      }
      lastType = "list";
      continue;
    }

    // Default prose line
    if (lastType !== "prose" && lastType !== "empty" && lastType !== "list" && lastType !== "heading") {
      ensureBlankLine();
    }
    out.push(styleInlineMarkdown(rawLine, inlineOpts));
    lastType = "prose";
  }

  return out.join("\n").trim();
}

/** Wrap pre-rendered Markdown output to `maxWidth` while preserving box-drawn tables,
 *  hanging indentation on list items, and blockquote gutters. */
export function wrapRenderedMarkdownLines(
  text: string,
  maxWidth: number,
  opts: { muted?: (s: string) => string } = {},
): string[] {
  const width = Math.max(12, maxWidth);
  const out: string[] = [];
  let inAsciiTable = false;

  for (const line of text.split("\n")) {
    const tableInfo = isBoxTableLine(line, inAsciiTable);
    inAsciiTable = tableInfo.nextAscii;
    if (tableInfo.isTable) {
      // Box tables were already laid out to fit `maxWidth` (or keep structure intact).
      out.push(line);
      continue;
    }

    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    if (!plain) {
      out.push("");
      continue;
    }

    const quoteMatch = plain.match(/^((?:▎\s)+)/);
    if (quoteMatch) {
      const gutter = quoteMatch[1]!;
      if (gutter.length < width) {
        const contGutter = opts.muted ? opts.muted(gutter) : gutter;
        out.push(...wrapTextWordAware(line, width, { continuationIndent: contGutter }));
        continue;
      }
    }

    const listMatch = plain.match(/^(\s*(?:[*\-+]|\d+[.)])\s+(?:[✔☐]\s+)?)/);
    if (listMatch) {
      const prefixLen = Math.min(Math.floor(width / 3), listMatch[1]!.length);
      if (prefixLen > 0) {
        out.push(...wrapTextWordAware(line, width, { continuationIndent: " ".repeat(prefixLen) }));
        continue;
      }
    }

    const leadingWs = plain.match(/^(\s+)/);
    if (leadingWs && leadingWs[1]!.length < Math.floor(width / 3)) {
      out.push(...wrapTextWordAware(line, width, { continuationIndent: leadingWs[1]! }));
      continue;
    }

    out.push(...wrapTextWordAware(line, width));
  }
  return out;
}

/** Unified Markdown block renderer: converts GFM tables (formatting inline Markdown
 *  inside cells BEFORE measuring column widths, fitting total width to `maxWidth`),
 *  renders ANSI or plain Markdown, and optionally wraps non-table lines word-aware. */
export function renderMarkdownBlock(text: string, opts: MarkdownBlockOptions = {}): string {
  if (!text) return "";
  const color = opts.color !== false;
  const unicode = opts.unicode !== false;
  const inlineOpts: MarkdownAnsiOptions = {
    accent: opts.accent,
    muted: opts.muted,
    code: opts.code,
  };
  const tabled = renderMarkdownTables(text, {
    unicode,
    ...(opts.maxWidth !== undefined ? { maxWidth: opts.maxWidth } : {}),
    formatCell: cell => (color ? styleInlineMarkdown(cell, inlineOpts) : stripInlineMarkdown(cell)),
  });
  const rendered = color ? renderMarkdownAnsi(tabled, inlineOpts) : stripMarkdown(tabled);
  if (opts.maxWidth === undefined) return rendered;
  const muted = color ? (opts.muted ?? ((s: string) => chalk.dim(s))) : undefined;
  return wrapRenderedMarkdownLines(rendered, opts.maxWidth, { muted }).join("\n");
}
