/**
 * Telegram HTML formatting helpers (gjc `notifications-sdk` HTML-format-source
 * parity, scoped to jeo's needs). All notify-daemon Telegram output is sent
 * with `parse_mode: "HTML"`. This module is the single source of truth for:
 * escaping dynamic text, converting a bounded markdown subset into Telegram
 * HTML, and safely truncating/splitting a finished message to Telegram's
 * 4096-char limit without breaking tags or entities. `ask`-tool inline-button
 * layout helpers (`buttonLabel`, `buildButtonGrid`, etc.) are OUT OF SCOPE —
 * jeo has no `ask` tool (see Tier 2 contract).
 *
 * Discipline: escape first, tag second. Telegram only parses a small tag set
 * (b, i, u, s, code, pre, a, blockquote, tg-spoiler); a stray `<` or unbalanced
 * tag can make Telegram reject the whole message, so dynamic text is always
 * escaped before any tag is emitted.
 */

// Telegram Bot API constants (parse mode + hard per-message length cap).
export const TELEGRAM_PARSE_MODE = "HTML" as const;
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Tags Telegram parses in HTML mode (used by the truncation/split guards). */
const ALLOWED_TAGS: Record<string, true> = { b: true, i: true, u: true, s: true, code: true, pre: true, a: true, blockquote: true, "tg-spoiler": true };

/** Escape text for Telegram HTML body content (`& < >`). */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a value for use inside a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/** Wrap already-escaped text in a Telegram tag. */
function tag(name: string, escaped: string): string {
  return `<${name}>${escaped}</${name}>`;
}

/** Bold the given raw text (escaped internally). */
export function bold(raw: string): string {
  return tag("b", escapeHtml(raw));
}

/** Italicize the given raw text (escaped internally). */
export function italic(raw: string): string {
  return tag("i", escapeHtml(raw));
}

/** Render the given raw text as inline code (escaped internally). */
export function code(raw: string): string {
  return tag("code", escapeHtml(raw));
}

/** Render the given raw text as a preformatted block (escaped internally). */
export function pre(raw: string): string {
  return tag("pre", escapeHtml(raw));
}

const PLACEHOLDER_PREFIX = "\u0000ph";
const PLACEHOLDER_SUFFIX = "\u0000";

/** Only http(s) and mailto links are emitted; anything else stays literal. */
function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url);
}

/** Column alignment parsed from a GFM table separator cell. */
type ColumnAlign = "left" | "right" | "center";

/** Split a markdown table row into trimmed cells, honoring escaped `\|`. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

/** A line is a candidate table row when it contains an unescaped `|`. */
function looksLikeTableRow(line: string): boolean {
  return /(?:^|[^\\])\|/.test(line);
}

/** A separator row has only dashes/colons/spaces per cell, with at least one dash. */
function isTableSeparator(line: string): boolean {
  if (!looksLikeTableRow(line)) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

/** Derive a column alignment from a separator cell (`:---`, `---:`, `:---:`). */
function parseAlign(cell: string): ColumnAlign {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/** Render parsed table parts as an aligned, monospace-friendly plain-text grid. */
function renderTableText(header: string[], aligns: ColumnAlign[], body: string[][]): string {
  const rows = [header, ...body];
  const cols = Math.max(header.length, ...body.map(r => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = 1;
    for (const row of rows) w = Math.max(w, (row[c] ?? "").length);
    widths[c] = w;
  }
  const padCell = (value: string, c: number): string => {
    const width = widths[c]!;
    const pad = width - value.length;
    if (pad <= 0) return value;
    const align = aligns[c] ?? "left";
    if (align === "right") return " ".repeat(pad) + value;
    if (align === "center") {
      const leftPad = Math.floor(pad / 2);
      return " ".repeat(leftPad) + value + " ".repeat(pad - leftPad);
    }
    return value + " ".repeat(pad);
  };
  const renderRow = (row: string[]): string =>
    Array.from({ length: cols }, (_v, c) => padCell(row[c] ?? "", c)).join(" | ");
  const divider = widths.map(w => "-".repeat(w)).join("-|-");
  return [renderRow(header), divider, ...body.map(renderRow)].join("\n");
}

/**
 * Replace GFM tables with stashed monospace `<pre>` blocks. Telegram HTML has no
 * table primitive, so a header row followed by a `|---|` separator is rendered as
 * an aligned plain-text grid (cell content escaped by `pre`).
 */
function convertMarkdownTables(text: string, stash: (html: string) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const headerLine = lines[i]!;
    const separatorLine = lines[i + 1];
    if (looksLikeTableRow(headerLine) && separatorLine !== undefined && isTableSeparator(separatorLine)) {
      const header = splitTableRow(headerLine);
      const aligns = splitTableRow(separatorLine).map(parseAlign);
      const body: string[][] = [];
      let j = i + 2;
      for (; j < lines.length; j++) {
        const row = lines[j]!;
        if (!looksLikeTableRow(row) || isTableSeparator(row)) break;
        body.push(splitTableRow(row));
      }
      out.push(stash(pre(renderTableText(header, aligns, body))));
      i = j - 1;
      continue;
    }
    out.push(headerLine);
  }
  return out.join("\n");
}

/**
 * Convert a bounded markdown subset into Telegram HTML. Supported: fenced code,
 * GFM tables, inline code, links (`http(s)`/`mailto` only), `#`-headers (bolded,
 * Telegram HTML has no heading tag), `>` blockquotes (merged across consecutive
 * lines), and `**bold**`/`*italic*` emphasis. Everything else passes through
 * escaped, so unsupported/malformed markdown degrades to literal text rather
 * than breaking the message.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const placeholders: string[] = [];
  const stash = (html: string): string => {
    const token = `${PLACEHOLDER_PREFIX}${placeholders.length}${PLACEHOLDER_SUFFIX}`;
    placeholders.push(html);
    return token;
  };

  let text = markdown;

  // 1. Fenced code blocks (protect literal content before any other transform).
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, body: string) => stash(pre(body)));

  // 1b. GFM tables -> aligned monospace <pre> block (no native table primitive).
  text = convertMarkdownTables(text, stash);

  // 2. Inline code.
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) => stash(code(body)));

  // 3. Links (capture raw URL before escaping). Unsafe/malformed links stay literal.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) => {
    if (!isSafeUrl(url)) return whole;
    return stash(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`);
  });

  // 4. Escape everything that remains (placeholders contain no escapable chars).
  text = escapeHtml(text);

  // 5. Line-level transforms on escaped text: headers and merged blockquotes.
  const lines = text.split("\n");
  const out: string[] = [];
  let quoteBuffer: string[] | null = null;
  const flushQuote = () => {
    if (quoteBuffer) {
      out.push(tag("blockquote", quoteBuffer.join("\n")));
      quoteBuffer = null;
    }
  };
  for (const line of lines) {
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      if (!quoteBuffer) {
        quoteBuffer = [];
      }
      quoteBuffer.push(quote[1] ?? "");
      continue;
    }
    flushQuote();
    const header = /^(#{1,6})\s+(.*)$/.exec(line);
    out.push(header ? tag("b", header[2] ?? "") : line);
  }
  flushQuote();
  text = out.join("\n");

  // 6. Inline emphasis (bold before italic; unbalanced markers stay literal).
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, body: string) => tag("b", body));
  text = text.replace(/\*([^*\n]+)\*/g, (_m, body: string) => tag("i", body));

  // 7. Restore protected placeholders.
  text = text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, "g"),
    (_m, i: string) => placeholders[Number(i)] ?? "",
  );

  return text;
}

interface Token {
  value: string;
  /** Tag name if this token opens a tag, else undefined. */
  open?: string;
  /** Exact opening tag text, including attributes, for safe chunk reopening. */
  openTag?: string;
  /** Tag name if this token closes a tag, else undefined. */
  close?: string;
}

/** Tokenize HTML into tags, entities, and single characters (never splits them). */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < html.length) {
    const ch = html[i]!;
    if (ch === "<") {
      const end = html.indexOf(">", i);
      if (end !== -1) {
        const raw = html.slice(i, end + 1);
        const close = /^<\/([a-z-]+)>$/i.exec(raw);
        const openMatch = /^<([a-z-]+)(?:\s[^>]*)?>$/i.exec(raw);
        const token: Token = { value: raw };
        if (close && ALLOWED_TAGS[close[1]!.toLowerCase()]) token.close = close[1]!.toLowerCase();
        else if (openMatch && ALLOWED_TAGS[openMatch[1]!.toLowerCase()]) {
          token.open = openMatch[1]!.toLowerCase();
          token.openTag = raw;
        }
        tokens.push(token);
        i = end + 1;
        continue;
      }
    }
    if (ch === "&") {
      const end = html.indexOf(";", i);
      if (end !== -1 && end - i <= 10) {
        tokens.push({ value: html.slice(i, end + 1) });
        i = end + 1;
        continue;
      }
    }
    tokens.push({ value: ch });
    i++;
  }
  return tokens;
}

/**
 * Truncate a finished Telegram HTML message to at most `max` chars without
 * splitting a tag or entity, closing any still-open allowed tags and appending
 * `marker`. The final string is guaranteed to be <= `max`.
 */
export function truncateTelegramHtml(message: string, max = TELEGRAM_MESSAGE_LIMIT, marker = "… [truncated]"): string {
  if (message.length <= max) return message;

  // When `max` is too small to even hold the marker, drop it so the hard
  // length guarantee (output.length <= max) still holds.
  const effectiveMarker = marker.length <= max ? marker : "";

  const tokens = tokenize(message);
  const stack: string[] = [];
  let out = "";

  const closersFor = (s: string[]): string =>
    s
      .map(t => `</${t}>`)
      .reverse()
      .join("");

  for (const token of tokens) {
    // Simulate accepting this token, then ensure we can still close + mark.
    const nextStack = [...stack];
    if (token.open) nextStack.push(token.open);
    else if (token.close) {
      const idx = nextStack.lastIndexOf(token.close);
      if (idx !== -1) nextStack.splice(idx, 1);
    }
    const projected = out.length + token.value.length + closersFor(nextStack).length + effectiveMarker.length;
    if (projected > max) break;
    out += token.value;
    if (token.open) stack.push(token.open);
    else if (token.close) {
      const idx = stack.lastIndexOf(token.close);
      if (idx !== -1) stack.splice(idx, 1);
    }
  }

  return out + closersFor(stack) + effectiveMarker;
}

interface OpenTag {
  name: string;
  tag: string;
}

/** Split a finished Telegram HTML message into ordered chunks without splitting tags or entities. */
export function splitTelegramHtml(message: string, max = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (message.length <= max) return [message];
  const chunks: string[] = [];
  const tokens = tokenize(message);
  const stack: OpenTag[] = [];
  let out = "";
  let chunkHasBody = false;

  const closersFor = (s: OpenTag[]): string =>
    s
      .map(t => `</${t.name}>`)
      .reverse()
      .join("");
  const openersFor = (s: OpenTag[]): string => s.map(t => t.tag).join("");
  const minimumChunkLengthFor = (s: OpenTag[]): number => openersFor(s).length + closersFor(s).length + 1;
  const flush = (): void => {
    if (!chunkHasBody) return;
    chunks.push(out + closersFor(stack));
    out = openersFor(stack);
    chunkHasBody = false;
  };

  const updateStackForClose = (name: string): boolean => {
    const idx = stack.findLastIndex(t => t.name === name);
    if (idx === -1) return false;
    stack.splice(idx, 1);
    return true;
  };

  for (const token of tokens) {
    if (token.open) {
      const nextStack = [...stack, { name: token.open, tag: token.openTag ?? token.value }];
      if (minimumChunkLengthFor(nextStack) > max) continue;
      if (chunkHasBody && out.length + token.value.length + closersFor(nextStack).length > max) flush();
      if (out.length + token.value.length + closersFor(nextStack).length > max) continue;
      out += token.value;
      chunkHasBody = true;
      stack.push({ name: token.open, tag: token.openTag ?? token.value });
      continue;
    }

    if (token.close) {
      const idx = stack.findLastIndex(t => t.name === token.close);
      if (idx === -1) continue;
      const nextStack = stack.toSpliced(idx, 1);
      if (chunkHasBody && out.length + token.value.length + closersFor(nextStack).length > max) flush();
      if (out.length + token.value.length + closersFor(nextStack).length > max) {
        updateStackForClose(token.close);
        continue;
      }
      out += token.value;
      chunkHasBody = true;
      updateStackForClose(token.close);
      continue;
    }

    if (chunkHasBody && out.length + token.value.length + closersFor(stack).length > max) flush();
    out += token.value;
    chunkHasBody = true;
  }
  if (chunkHasBody) chunks.push(out + closersFor(stack));
  return chunks;
}

/** Finalize an optional message: undefined passthrough, else safe-truncate. */
export function finalizeTelegramHtml(message?: string): string | undefined {
  if (message === undefined) return undefined;
  return truncateTelegramHtml(message);
}
