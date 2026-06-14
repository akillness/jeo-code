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

  // Links/images FIRST: bold/code styling injects ANSI escapes whose `[` would
  // otherwise be swallowed by the `[label](url)` matcher (corrupting both).
  const styleInline = (line: string): string =>
    line
      .replace(/!\[([^\]]*)\]\(([^\)]+)\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^\)]+)\)/g, (_m, label: string, url: string) => `${label} ${chalk.dim(`(${url})`)}`)
      .replace(/`([^`]+)`/g, (_m, code: string) => chalk.cyan(code))
      .replace(/\*\*\*([^\*]+)\*\*\*/g, (_m, t: string) => chalk.bold.italic(t))
      .replace(/\*\*([^\*]+)\*\*/g, (_m, t: string) => chalk.bold(t))
      .replace(/__([^\_]+)__/g, (_m, t: string) => chalk.bold(t))
      // Single *italic* / _italic_ run AFTER the ***/**/__ passes so the doubles
      // are already consumed. The `*` form ignores list bullets ("* item" has no
      // closing `*`); the `_` form is word-boundary guarded so snake_case
      // identifiers (foo_bar_baz) are never mistaken for emphasis.
      .replace(/\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*/g, (_m, t: string) => chalk.italic(t))
      .replace(/(?<![\p{L}\p{N}_])_(?=\S)([^_\n]*?)(?<=\S)_(?![\p{L}\p{N}_])/gu, (_m, t: string) => chalk.italic(t));

  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue; // drop the fence row itself (stripMarkdown parity)
    }
    if (inFence) {
      out.push(line); // code bodies verbatim — never styled or reflowed
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      // Vertical rhythm: a heading that follows content gets one blank line of
      // breathing room above it (final-report readability), never a leading blank.
      if (out.length > 0 && out[out.length - 1]!.trim() !== "") out.push("");
      out.push(accent(styleInline(heading[2]!)));
      continue;
    }
    const quote = line.match(/^>\s+(.+)$/);
    if (quote) {
      out.push(chalk.dim(`▎ ${styleInline(quote[1]!)}`));
      continue;
    }
    if (/^[-\*_]{3,}\s*$/.test(line)) {
      out.push(chalk.dim("─".repeat(24)));
      continue;
    }
    out.push(styleInline(line));
  }
  return out.join("\n").trim();
}
