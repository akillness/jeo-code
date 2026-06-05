import { test, expect } from "bun:test";
import { truncate } from "../src/tui/terminal";
import { visibleWidth, stripAnsi, applyGradient, ColorLevel } from "../src/tui/components/color";

test("truncate plain strings by visible length (unchanged behavior)", () => {
  expect(truncate("hello", 3)).toBe("hel");
  expect(truncate("hi", 5)).toBe("hi");
  expect(truncate("abc", 0)).toBe("");
});

test("truncate counts only visible columns of a colored line", () => {
  const colored = "\x1b[31mhello\x1b[0m"; // visible width 5
  const cut = truncate(colored, 3);
  expect(stripAnsi(cut)).toBe("hel"); // 3 visible chars kept
  expect(cut).toContain("\x1b[31m"); // color preserved
  expect(cut.endsWith("\x1b[0m")).toBe(true); // reset appended on cut
});

test("truncate keeps a colored line intact when it fits", () => {
  const colored = "\x1b[32mok\x1b[0m";
  expect(truncate(colored, 10)).toBe(colored);
});

test("truncate never spills a raw escape when cutting a gradient line", () => {
  const grad = applyGradient("abcdefghij", { r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }, ColorLevel.TrueColor);
  const cut = truncate(grad, 4);
  expect(visibleWidth(cut)).toBe(4);
  // No dangling partial escape: stripping ANSI yields exactly the first 4 chars.
  expect(stripAnsi(cut)).toBe("abcd");
  expect(cut.endsWith("\x1b[0m")).toBe(true);
});

test("visibleWidth ignores escapes; matches plain length otherwise", () => {
  expect(visibleWidth("\x1b[1m\x1b[38;2;1;2;3mX\x1b[0m")).toBe(1);
  expect(visibleWidth("hello world")).toBe(11);
});
