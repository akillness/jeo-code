import { test, expect } from "bun:test";
import { renderMarkdownTables } from "../src/tui/components/markdown-table";

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
  // gjc #997 parity: `\|` is a literal pipe, not a column separator. A naive
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
