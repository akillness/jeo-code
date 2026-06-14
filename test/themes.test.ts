import { test, expect } from "bun:test";
import chalk from "chalk";
import {
  THEMES,
  getTheme,
  listThemes,
  resolveTheme,
  themeGradient,
  accentPaint,
  accentShadowPaint,
  diffPaint,
  DEFAULT_DIFF_PALETTE,
} from "../src/tui/components/themes";
import { EVOLUTION_STAGE_COUNT } from "../src/tui/components/evolution";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Config isolation: resolveTheme falls back to the GLOBAL config's theme when the
// env carries none — without pointing JEO_CONFIG_DIR at an empty dir, this test
// breaks the moment the developer's real ~/.jeo/config.json has a theme set.
const ISO = { JEO_CONFIG_DIR: mkdtempSync(join(tmpdir(), "jeo-themes-iso-")) };

test("every theme has a length-5 gradient table and userCard if colored", () => {
  for (const t of THEMES) {
    expect(t.gradients.length).toBe(EVOLUTION_STAGE_COUNT);
    expect(typeof t.name).toBe("string");
    expect(typeof t.description).toBe("string");
    if (t.color) {
      expect(t.userCard).toBeDefined();
      expect(typeof t.userCard?.accent).toBe("string");
      expect(typeof t.userCard?.border).toBe("string");
      expect(typeof t.userCard?.shadow).toBe("string");
      expect(typeof t.userCard?.fill).toBe("string");
    }
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

test("resolveTheme reads JEO_TUI_THEME from env or config with priorities", () => {
  // 1. Explicit env JEO_TUI_THEME is top priority
  expect(resolveTheme({ JEO_TUI_THEME: "solar" }).name).toBe("solar");
  expect(resolveTheme({ JEO_TUI_THEME: "red-claw" }).name).toBe("red-claw");
  expect(resolveTheme({ JEO_TUI_THEME: "blue-crab" }).name).toBe("blue-crab");

  // 2. Config theme is second priority
  expect(resolveTheme({}, { theme: "matrix" }).name).toBe("matrix");
  expect(resolveTheme({}, { tuiTheme: "solar" }).name).toBe("solar");
  expect(resolveTheme({}, { tui: { theme: "red-claw" } }).name).toBe("red-claw");

  // 3. NO_COLOR fallback
  expect(resolveTheme({ ...ISO, NO_COLOR: "1" }).name).toBe("mono");

  // 4. COLORFGBG appearance detection (needs color capability to not fallback to mono)
  // 0-6, 8, 232-243: dark -> cosmic
  expect(resolveTheme({ ...ISO, COLORFGBG: "7;0", COLORTERM: "truecolor" }).name).toBe("cosmic");
  expect(resolveTheme({ ...ISO, COLORFGBG: "15;8", COLORTERM: "truecolor" }).name).toBe("cosmic");
  // 7, 9-15, 244-255: light -> blue-crab
  expect(resolveTheme({ ...ISO, COLORFGBG: "0;7", COLORTERM: "truecolor" }).name).toBe("blue-crab");
  expect(resolveTheme({ ...ISO, COLORFGBG: "0;15", COLORTERM: "truecolor" }).name).toBe("blue-crab");
  expect(resolveTheme({ ...ISO, COLORFGBG: "0;244", COLORTERM: "truecolor" }).name).toBe("blue-crab");

  // 16-231 (color cube): Y = 0.299 * R + 0.587 * G + 0.114 * B
  // index 16 -> r=0, g=0, b=0 -> Y=0 -> dark -> cosmic
  expect(resolveTheme({ ...ISO, COLORFGBG: "0;16", COLORTERM: "truecolor" }).name).toBe("cosmic");
  // index 231 -> r=5, g=5, b=5 -> Y=255 -> light -> blue-crab
  expect(resolveTheme({ ...ISO, COLORFGBG: "0;231", COLORTERM: "truecolor" }).name).toBe("blue-crab");

  // 5. Unknown fallback
  if (process.platform !== "darwin") {
    expect(resolveTheme({ ...ISO, COLORTERM: "truecolor" }).name).toBe("cosmic");
  } else {
    expect(["cosmic", "blue-crab"]).toContain(resolveTheme({ ...ISO, COLORTERM: "truecolor" }).name);
  }
  expect(resolveTheme({ ...ISO }).name).toBe("mono");
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

test("nine themes are registered, including the three new palettes", () => {
  const names = THEMES.map(t => t.name);
  expect(names).toEqual(["cosmic", "matrix", "solar", "red-claw", "blue-crab", "aurora", "synthwave", "sakura", "mono"]);
  for (const fresh of ["aurora", "synthwave", "sakura"]) {
    const t = getTheme(fresh);
    expect(t.color).toBe(true);
    expect(t.gradients.length).toBe(EVOLUTION_STAGE_COUNT);
    expect(t.accentShadow).toBeDefined();
    expect(t.diff).toBeDefined();
  }
});

test("accentShadowPaint uses the theme's REAL shadow hue (depth two-tone), distinct from the lit accent", () => {
  const savedLevel = chalk.level;
  chalk.level = 3; // force truecolor — bun test runs without a TTY (level 0 → no escapes)
  try {
  for (const t of THEMES.filter(t => t.color && t.accentShadow)) {
    const lit = accentPaint(t)("x");
    const shaded = accentShadowPaint(t)("x");
    expect(shaded).not.toBe(lit);            // two-tone: edges must differ
    expect(shaded).not.toContain("\x1b[2m"); // real darker hue, not ANSI dim
    expect(shaded).toContain("\x1b[");       // still colored
  }
  // mono: identity painters (no escapes at all)
  expect(accentShadowPaint(getTheme("mono"))("x")).toBe("x");
  } finally {
    chalk.level = savedLevel;
  }
});

test("diffPaint: themed palettes with bg tints; default palette fallback; mono identity", () => {
  const savedLevel = chalk.level;
  chalk.level = 3;
  try {
  // blue-crab defines its own diff palette → painters differ from the default-palette themes.
  const crab = diffPaint(getTheme("blue-crab"));
  const cosmic = diffPaint(getTheme("cosmic")); // no diff field → DEFAULT_DIFF_PALETTE
  expect(crab.add("+x")).not.toBe(cosmic.add("+x"));
  // Added/removed rows carry a background tint (48;2;… truecolor bg sequence).
  expect(cosmic.add("+x")).toContain("\x1b[48;2;");
  expect(cosmic.del("-x")).toContain("\x1b[48;2;");
  expect(crab.add("+x")).toContain("\x1b[48;2;");
  // Hunk headers are bold-accented, not bg-tinted.
  expect(cosmic.hunk("@@ -1 +1 @@")).toContain("\x1b[1m");
  expect(cosmic.hunk("@@ -1 +1 @@")).not.toContain("\x1b[48;2;");
  expect(DEFAULT_DIFF_PALETTE.add).toBeTruthy();
  // mono → identity
  const mono = diffPaint(getTheme("mono"));
  expect(mono.add("+x")).toBe("+x");
  expect(mono.del("-x")).toBe("-x");
  } finally {
    chalk.level = savedLevel;
  }
});

test("blue-crab is the fancy bioluminescent revamp (new accent + seafoam arc)", () => {
  const crab = getTheme("blue-crab");
  expect(crab.accent).toBe("#0096c7");
  expect(crab.accentShadow).toBe("#023e8a");
  expect(crab.gradients[4]!.to.toLowerCase()).toBe("#caf0f8"); // seafoam glow finale
});
