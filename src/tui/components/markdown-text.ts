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
