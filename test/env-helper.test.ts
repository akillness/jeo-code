import { test, expect } from "bun:test";
import { jeoEnv } from "../src/util/env";

test("jeoEnv: JEO_* wins over legacy JEO_*; falls back; undefined when neither set", () => {
  expect(jeoEnv("TUI_THEME", { JEO_TUI_THEME: "matrix", JEO_TUI_THEME: "solar" })).toBe("matrix");
  expect(jeoEnv("TUI_THEME", { JEO_TUI_THEME: "solar" })).toBe("solar");
  expect(jeoEnv("TUI_THEME", {})).toBeUndefined();
  // An explicitly EMPTY JEO_* value is still a value (?? semantics, not ||) —
  // matching the inline double-read pattern this helper replaced.
  expect(jeoEnv("FLAG", { JEO_FLAG: "", JEO_FLAG: "1" })).toBe("");
});

import { resetMouseTracking } from "../src/tui/terminal";

test("resetMouseTracking disables every xterm mouse mode + coordinate encoding (reset forms only)", () => {
  const seq = resetMouseTracking();
  for (const mode of [9, 1000, 1002, 1003, 1005, 1006, 1015, 1016]) {
    expect(seq).toContain(`\x1b[?${mode}l`);
  }
  // Defensive reset must never ENABLE anything.
  expect(seq).not.toContain("h");
});

import { detectAppearance, resetAppearanceCache } from "../src/tui/components/color";
import { resolveTheme, resetThemeConfigCache } from "../src/tui/components/themes";

test("detectAppearance is process-memoized: the expensive darwin probe runs at most once per env key", () => {
  resetAppearanceCache();
  const t0 = performance.now();
  detectAppearance({}); // first call may shell out (≈12ms on macOS)
  const cold = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 50; i++) detectAppearance({});
  const warm50 = performance.now() - t1;
  // 50 cached calls must be far cheaper than ONE cold probe (keystroke-hot path).
  expect(warm50).toBeLessThan(Math.max(1, cold));
  // COLORFGBG-keyed: an advertising terminal is honored without the probe.
  expect(detectAppearance({ COLORFGBG: "15;0" })).toBe("dark");
  expect(detectAppearance({ COLORFGBG: "0;15" })).toBe("light");
});

test("resolveTheme stays fast on the keystroke-hot path (config read memoized)", () => {
  resetThemeConfigCache();
  resetAppearanceCache();
  const env = {}; // no explicit theme → worst path (config + appearance)
  resolveTheme(env); // cold: populates both memos
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) resolveTheme(env); // ≈100 keystrokes × 3 calls
  const elapsed = performance.now() - t0;
  // Pre-fix this path cost ≈35ms PER KEYSTROKE; 300 warm calls must stay far
  // under one old keystroke's budget.
  expect(elapsed).toBeLessThan(30);
});
