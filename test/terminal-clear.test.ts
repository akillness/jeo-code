import { test, expect } from "bun:test";
import { clearScreen, clearVisible } from "../src/tui/terminal";

test("clearVisible erases the visible screen and homes the cursor", () => {
  expect(clearVisible()).toBe("\x1b[2J\x1b[H");
});

test("clearVisible PRESERVES scrollback (no 3J), unlike clearScreen", () => {
  expect(clearVisible().includes("3J")).toBe(false);
  expect(clearScreen().includes("3J")).toBe(true);
});

test("clearVisible still clears the on-screen content (2J) and homes (H)", () => {
  const seq = clearVisible();
  expect(seq.includes("2J")).toBe(true);
  expect(seq.endsWith("\x1b[H")).toBe(true);
});
