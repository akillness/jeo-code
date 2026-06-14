import { expect, test } from "bun:test";
import chalk from "chalk";
import { stripMarkdown, renderMarkdownAnsi } from "../src/tui/components/markdown-text";

test("stripMarkdown strips headers, bold, italic, code blocks, links, and blockquotes", () => {
  const input = `
# Header 1
## Header 2

This is **bold** and *italic* text.

Here is some \`inline code\`.

\`\`\`ts
const x = 1;
\`\`\`

Check out [Google](https://google.com).

> This is a blockquote.

---
`;

  const expected = `Header 1
Header 2

This is bold and italic text.

Here is some inline code.


const x = 1;

Check out Google (https://google.com).

This is a blockquote.`;

  expect(stripMarkdown(input)).toBe(expected.trim());
});

// ---- renderMarkdownAnsi (jeo-ref final-report styling) ----------------------

test("renderMarkdownAnsi styles headings/bold/inline-code; fences drop, bodies verbatim", () => {
  const prev = chalk.level;
  chalk.level = 3;
  try {
    const md = "## 반영 경로 확인\n\n- `jeo` 심링크 — **즉시 반영**\n\n```sh\nbun test # ** not styled **\n```\ndone";
    const out = renderMarkdownAnsi(md, { accent: s => `<H>${s}</H>` });
    expect(out).toContain("<H>반영 경로 확인</H>"); // heading painted, hashes gone
    expect(out).not.toMatch(/^##\s/m);
    expect(out).toContain("\u001b[1m즉시 반영\u001b[22m"); // bold styled
    expect(out).toContain("\u001b[36mjeo\u001b[39m"); // inline code cyan
    expect(out).toContain("bun test # ** not styled **"); // fence body untouched
    expect(out).not.toContain("```");
  } finally {
    chalk.level = prev;
  }
});

test("renderMarkdownAnsi: visible text matches stripMarkdown (style adds color only)", () => {
  const prev = chalk.level;
  chalk.level = 3;
  try {
    const md = "# Title\n\n**bold** and `code` plus [Google](https://google.com).\n\n> quoted line\n\n---";
    const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
    const styled = stripAnsi(renderMarkdownAnsi(md));
    expect(styled).toContain("Title");
    expect(styled).toContain("bold and code plus Google (https://google.com).");
    expect(styled).toContain("▎ quoted line"); // quote keeps a visible gutter mark
    expect(styled).toContain("─".repeat(24)); // hr becomes a rule, not dropped text
  } finally {
    chalk.level = prev;
  }
});

test("renderMarkdownAnsi: empty input and plain text pass through", () => {
  expect(renderMarkdownAnsi("")).toBe("");
  expect(renderMarkdownAnsi("plain text, no markdown")).toBe("plain text, no markdown");
});

test("renderMarkdownAnsi: single *italic* / _italic_ is styled and never breaks lists or snake_case", () => {
  const prev = chalk.level;
  chalk.level = 3;
  try {
    const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
    const styled = renderMarkdownAnsi("This is *important* and _also italic_ text.");
    expect(styled).toContain("\u001b[3m"); // italic SGR applied
    expect(stripAnsi(styled)).toBe("This is important and also italic text."); // markers gone
    // Bullet "* item" (no closing *), inline math "a * b", and snake_case must NOT italicize.
    const safe = renderMarkdownAnsi("keep snake_case_name and a * b and\n* bullet item");
    expect(safe).not.toContain("\u001b[3m");
    expect(stripAnsi(safe)).toContain("snake_case_name");
  } finally {
    chalk.level = prev;
  }
});

test("renderMarkdownAnsi: a heading following content gets one blank line above (vertical rhythm)", () => {
  const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
  const out = stripAnsi(renderMarkdownAnsi("intro paragraph here.\n## Heading Two\nbody text")).split("\n");
  expect(out).toEqual(["intro paragraph here.", "", "Heading Two", "body text"]);
  // A leading heading never gains a blank line above it.
  expect(stripAnsi(renderMarkdownAnsi("## Top\nbody")).split("\n")[0]).toBe("Top");
});