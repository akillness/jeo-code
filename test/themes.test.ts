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

test("resolveTheme reads JOC_TUI_THEME from env", () => {
  expect(resolveTheme({ JOC_TUI_THEME: "solar" }).name).toBe("solar");
  expect(resolveTheme({}).name).toBe("cosmic");
});

test("listThemes returns all names + descriptions", () => {
  const list = listThemes();
  expect(list.map(t => t.name).sort()).toEqual(["cosmic", "matrix", "mono", "solar"]);
});

test("themeGradient is clamped and returns hex pairs", () => {
  const matrix = getTheme("matrix");
  expect(themeGradient(matrix, 0)).toEqual(matrix.gradients[0]!);
  expect(themeGradient(matrix, 99)).toEqual(matrix.gradients[EVOLUTION_STAGE_COUNT - 1]!);
  expect(themeGradient(matrix, 1).from).toMatch(/^#[0-9a-f]{6}$/i);
});
