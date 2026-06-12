import { test, expect } from "bun:test";
import {
  THEMES,
  getTheme,
  listThemes,
  resolveTheme,
  themeGradient,
} from "../src/tui/components/themes";
import { EVOLUTION_STAGE_COUNT } from "../src/tui/components/evolution";

test("every theme has a length-5 gradient table", () => {
  for (const t of THEMES) {
    expect(t.gradients.length).toBe(EVOLUTION_STAGE_COUNT);
    expect(typeof t.name).toBe("string");
    expect(typeof t.description).toBe("string");
  }
});

test("getTheme is case-insensitive and falls back to cosmic", () => {
  expect(getTheme("MATRIX").name).toBe("matrix");
  expect(getTheme("  solar ").name).toBe("solar");
  expect(getTheme("nope").name).toBe("cosmic");
  expect(getTheme(undefined).name).toBe("cosmic");
});

test("mono theme is colorless; others emit color", () => {
  expect(getTheme("mono").color).toBe(false);
  expect(getTheme("cosmic").color).toBe(true);
  expect(getTheme("matrix").color).toBe(true);
});

test("resolveTheme reads JOC_TUI_THEME from env or config with priorities", () => {
  // 1. Explicit env JOC_TUI_THEME is top priority
  expect(resolveTheme({ JOC_TUI_THEME: "solar" }).name).toBe("solar");
  expect(resolveTheme({ JOC_TUI_THEME: "red-claw" }).name).toBe("red-claw");
  expect(resolveTheme({ JOC_TUI_THEME: "blue-crab" }).name).toBe("blue-crab");

  // 2. Config theme is second priority
  expect(resolveTheme({}, { theme: "matrix" }).name).toBe("matrix");
  expect(resolveTheme({}, { tuiTheme: "solar" }).name).toBe("solar");
  expect(resolveTheme({}, { tui: { theme: "red-claw" } }).name).toBe("red-claw");

  // 3. NO_COLOR fallback
  expect(resolveTheme({ NO_COLOR: "1" }).name).toBe("mono");

  // 4. COLORFGBG appearance detection (needs color capability to not fallback to mono)
  // 0-6, 8, 232-243: dark -> cosmic
  expect(resolveTheme({ COLORFGBG: "7;0", COLORTERM: "truecolor" }).name).toBe("cosmic");
  expect(resolveTheme({ COLORFGBG: "15;8", COLORTERM: "truecolor" }).name).toBe("cosmic");
  // 7, 9-15, 244-255: light -> blue-crab
  expect(resolveTheme({ COLORFGBG: "0;7", COLORTERM: "truecolor" }).name).toBe("blue-crab");
  expect(resolveTheme({ COLORFGBG: "0;15", COLORTERM: "truecolor" }).name).toBe("blue-crab");
  expect(resolveTheme({ COLORFGBG: "0;244", COLORTERM: "truecolor" }).name).toBe("blue-crab");

  // 16-231 (color cube): Y = 0.299 * R + 0.587 * G + 0.114 * B
  // index 16 -> r=0, g=0, b=0 -> Y=0 -> dark -> cosmic
  expect(resolveTheme({ COLORFGBG: "0;16", COLORTERM: "truecolor" }).name).toBe("cosmic");
  // index 231 -> r=5, g=5, b=5 -> Y=255 -> light -> blue-crab
  expect(resolveTheme({ COLORFGBG: "0;231", COLORTERM: "truecolor" }).name).toBe("blue-crab");

  // 5. Unknown fallback
  if (process.platform !== "darwin") {
    expect(resolveTheme({ COLORTERM: "truecolor" }).name).toBe("cosmic");
  } else {
    expect(["cosmic", "blue-crab"]).toContain(resolveTheme({ COLORTERM: "truecolor" }).name);
  }
  expect(resolveTheme({}).name).toBe("mono");
});

test("listThemes returns all names + descriptions including red-claw and blue-crab", () => {
  const list = listThemes();
  expect(list.map(t => t.name).sort()).toEqual(["aurora", "blue-crab", "cosmic", "matrix", "mono", "red-claw", "sakura", "solar", "synthwave"]);
});

test("themeGradient is clamped and returns hex pairs", () => {
  const matrix = getTheme("matrix");
  expect(themeGradient(matrix, 0)).toEqual(matrix.gradients[0]!);
  expect(themeGradient(matrix, 99)).toEqual(matrix.gradients[EVOLUTION_STAGE_COUNT - 1]!);
  expect(themeGradient(matrix, 1).from).toMatch(/^#[0-9a-f]{6}$/i);
});
