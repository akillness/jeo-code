import chalk from "chalk";
/**
 * Strip markdown formatting from text, returning plain text.
 */
export function stripMarkdown(text: string): string {
  if (!text) return "";

  let out = text;

  // 1. Remove code block fences (e.g. ```ts or ```)
  out = out.replace(/^```[a-zA-Z0-9_-]*\s*$/gm, "");

  // 2. Remove inline code backticks
  out = out.replace(/`([^`]+)`/g, "$1");

  // 3. Remove headers (e.g. # Header -> Header)
  out = out.replace(/^#+\s+(.+)$/gm, "$1");

  // 4. Remove bold/italic markers
  out = out.replace(/\*\*\*([^\*]+)\*\*\*/g, "$1");
  out = out.replace(/\*\*([^\*]+)\*\*/g, "$1");
  out = out.replace(/\*([^\*]+)\*/g, "$1");
  out = out.replace(/___([^\_]+)___/g, "$1");
  out = out.replace(/__([^\_]+)__/g, "$1");
  out = out.replace(/_([^\_]+)_/g, "$1");
  out = out.replace(/~~([^~\n]+)~~/g, "$1");

  // 5. Convert links [text](url) -> text (url)
  out = out.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, "$1 ($2)");

  // 6. Convert images ![alt](url) -> alt
  out = out.replace(/!\[([^\]]*)\]\(([^\)]+)\)/g, "$1");

  // 7. Remove blockquote markers (> text -> text)
  out = out.replace(/^>\s+(.+)$/gm, "$1");

  // 8. Remove horizontal rules
  out = out.replace(/^[-\*_]{3,}\s*$/gm, "");

  return out.trim();
}

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

/**
 * Render markdown as styled ANSI text (jeo-ref final-report format): headings
 * become painted section titles, **bold** / `inline code` keep visual weight,
 * fences/links/quotes degrade exactly like stripMarkdown. Fenced code BODIES are
 * passed through untouched (only the ``` fence rows are dropped) so code samples
 * are never reformatted. Pure + stateless — safe for the one-shot finish path.
 */
export function renderMarkdownAnsi(text: string, opts: MarkdownAnsiOptions = {}): string {
  if (!text) return "";
  const accent = opts.accent ?? ((s: string) => chalk.bold(s));
  const muted = opts.muted ?? ((s: string) => chalk.dim(s));
  const code = opts.code ?? ((s: string) => chalk.cyan(s));

  // Links/images FIRST: bold/code styling injects ANSI escapes whose `[` would
  // otherwise be swallowed by the `[label](url)` matcher (corrupting both).
  const styleInline = (line: string): string =>
    line
      .replace(/!\[([^\]]*)\]\(([^\)]+)\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^\)]+)\)/g, (_m, label: string, url: string) => `${label} ${muted(`(${url})`)}`)
      .replace(/`([^`]+)`/g, (_m, c: string) => code(c))
      .replace(/\*\*\*([^\*]+)\*\*\*/g, (_m, t: string) => chalk.bold.italic(t))
      .replace(/\*\*([^\*]+)\*\*/g, (_m, t: string) => chalk.bold(t))
      .replace(/__([^\_]+)__/g, (_m, t: string) => chalk.bold(t))
      // Single *italic* / _italic_ run AFTER the ***/**/__ passes so the doubles
      // are already consumed. The `*` form ignores list bullets ("* item" has no
      // closing `*`); the `_` form is word-boundary guarded so snake_case
      // identifiers (foo_bar_baz) are never mistaken for emphasis.
      .replace(/\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*/g, (_m, t: string) => chalk.italic(t))
      .replace(/(?<![\p{L}\p{N}_])_(?=\S)([^_\n]*?)(?<=\S)_(?![\p{L}\p{N}_])/gu, (_m, t: string) => chalk.italic(t))
      // ~~strikethrough~~ → struck + muted: retracted/superseded text reads as
      // de-emphasized (jeo tone parity with done-todo rows). Runs last so it never
      // eats an earlier emphasis marker.
      .replace(/~~([^~\n]+)~~/g, (_m, t: string) => chalk.strikethrough(muted(t)));

  const out: string[] = [];
  let inFence = false;
  
  // Track the type of the last pushed content line to manage rhythm
  // Types: "empty" | "heading" | "blockquote" | "list" | "code" | "prose"
  let lastType: "empty" | "heading" | "blockquote" | "list" | "code" | "prose" = "empty";

  const ensureBlankLine = () => {
    if (out.length > 0 && out[out.length - 1] !== "") {
      out.push("");
    }
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    
    // Check if we are toggling a code fence
    if (/^```/.test(trimmed)) {
      ensureBlankLine();
      inFence = !inFence;
      lastType = inFence ? "code" : "empty";
      continue;
    }

    if (inFence) {
      out.push(line); // code bodies verbatim
      lastType = "code";
      continue;
    }

    if (trimmed === "") {
      ensureBlankLine();
      lastType = "empty";
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      ensureBlankLine();
      out.push(accent(styleInline(heading[2]!)));
      lastType = "heading";
      continue;
    }

    const quote = line.match(/^>\s+(.+)$/);
    if (quote) {
      if (lastType !== "blockquote" && lastType !== "empty") {
        ensureBlankLine();
      }
      out.push(muted(`▎ ${styleInline(quote[1]!)}`));
      lastType = "blockquote";
      continue;
    }

    if (/^[-\*_]{3,}\s*$/.test(line)) {
      ensureBlankLine();
      out.push(muted("─".repeat(24)));
      ensureBlankLine();
      lastType = "empty";
      continue;
    }

    // Check if list item
    const isList = /^\s*([*\-+]\s|\d+\.\s)/.test(line);
    if (isList) {
      if (lastType !== "list" && lastType !== "empty") {
        ensureBlankLine();
      }
      out.push(styleInline(line));
      lastType = "list";
      continue;
    }

    // Default prose line
    if (lastType !== "prose" && lastType !== "empty" && lastType !== "list" && lastType !== "heading") {
      // Transitioning from list/quote/code to prose -> ensure blank line
      ensureBlankLine();
    }
    out.push(styleInline(line));
    lastType = "prose";
  }

  return out.join("\n").trim();
}
