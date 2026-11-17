import { test, expect } from "bun:test";
import chalk from "chalk";
import { renderMarkdownTables } from "../src/tui/components/markdown-table";
import { styleInlineMarkdown } from "../src/tui/components/markdown-text";
import { visibleWidth } from "../src/tui/components/width";

/** Count box-drawing column rules (│) in a rendered row = columns + 1. Ignores
 *  any ASCII `|` that is literal cell content. */
function pipeCount(line: string): number {
  return (line.match(/│/g) ?? []).length;
}

test("renders a basic GFM table as a box-drawn grid", () => {
  const out = renderMarkdownTables("| A | B |\n| --- | --- |\n| 1 | 2 |");
  const lines = out.split("\n");
  expect(lines[0]).toContain("┌");
  expect(lines).toContain("│ A │ B │");
  expect(lines).toContain("│ 1 │ 2 │");
  expect(lines[lines.length - 1]).toContain("┘");
});

test("honors escaped pipes inside a cell instead of splitting on them", () => {
  // `\|` is a literal pipe, not a column separator. A naive
  // split would grow a phantom 3rd column and corrupt the row.
  const out = renderMarkdownTables("| Col A | Col B |\n| --- | --- |\n| a \\| b | c |");
  const lines = out.split("\n");
  // The literal pipe survives inside the first cell.
  const body = lines.find(l => l.includes("a | b"));
  expect(body).toBeDefined();
  // Body row must still have exactly two columns (three vertical rules), not three.
  expect(pipeCount(body!)).toBe(3);
});

test("a line whose only pipe is escaped is not treated as a table row", () => {
  const text = "just a literal \\| pipe in prose";
  expect(renderMarkdownTables(text)).toBe(text);
});

test("applies column alignment from the delimiter row", () => {
  const out = renderMarkdownTables("| L | Right |\n| :--- | ---: |\n| a | b |");
  // Right-aligned column pads on the left so the value hugs the right edge.
  expect(out).toContain("│     b │");
});

test("passes through text that contains no tables untouched", () => {
  const text = "# Heading\n\nSome prose with no pipes at all.";
  expect(renderMarkdownTables(text)).toBe(text);
});

test("a table needs a delimiter row to be recognized", () => {
  // Two pipe rows with no `|---|` delimiter is not a table — left verbatim.
  const text = "| a | b |\n| c | d |";
  expect(renderMarkdownTables(text)).toBe(text);
});

test("inline markdown (**bold**, `code`, links, CJK, emoji) keeps every table row at identical display width", () => {
  const prev = chalk.level;
  chalk.level = 3;
  try {
    const md = [
      "| **항목** | `파일` | 상태 |",
      "| :--- | :--- | ---: |",
      "| **빌드 검증** | `src/tui/app.ts` | [로그](https://example.com/run_1) 🚀 |",
      "| 일반 텍스트 | `foo_bar` | OK |",
    ].join("\n");
    const out = renderMarkdownTables(md, {
      unicode: true,
      formatCell: c => styleInlineMarkdown(c),
    });
    const lines = out.split("\n");
    const rowWidths = lines.map(l => visibleWidth(l));
    expect(new Set(rowWidths).size).toBe(1);
    expect(out).not.toContain("**항목**");
    expect(out).not.toContain("`src/tui/app.ts`");
  } finally {
    chalk.level = prev;
  }
});

test("wide table fits within maxWidth and wraps multi-line cells cleanly inside borders", () => {
  const md = [
    "| Column | Description | Notes |",
    "| --- | --- | --- |",
    "| alpha | This is a very long description column with multiple English words and 한국어 텍스트 | short |",
    "| `<br>` tag | Line one<br>Line two | ok |",
  ].join("\n");
  const maxWidth = 58;
  const out = renderMarkdownTables(md, { unicode: true, maxWidth });
  const lines = out.split("\n");
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(maxWidth);
  }
  expect(new Set(lines.map(l => visibleWidth(l))).size).toBe(1);
  expect(out).toContain("multiple");
  expect(out).toContain("텍스트");
  expect(out).toContain("<br> tag");
  expect(out).toContain("Line one");
  expect(out).toContain("Line two");
});

test("pipe lines inside fenced code blocks are never parsed as GFM tables", () => {
  const md = [
    "```md",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "```",
    "",
    "| Real | Table |",
    "| --- | --- |",
    "| ok | yes |",
  ].join("\n");
  const out = renderMarkdownTables(md);
  expect(out).toContain("| A | B |");
  expect(out).toContain("┌──────┬───────┐");
});
