import { test, expect } from "bun:test";
import { jeoEnv } from "../src/util/env";

test("jeoEnv: JEO_* wins over legacy JOC_*; falls back; undefined when neither set", () => {
  expect(jeoEnv("TUI_THEME", { JEO_TUI_THEME: "matrix", JOC_TUI_THEME: "solar" })).toBe("matrix");
  expect(jeoEnv("TUI_THEME", { JOC_TUI_THEME: "solar" })).toBe("solar");
  expect(jeoEnv("TUI_THEME", {})).toBeUndefined();
  // An explicitly EMPTY JEO_* value is still a value (?? semantics, not ||) —
  // matching the inline double-read pattern this helper replaced.
  expect(jeoEnv("FLAG", { JEO_FLAG: "", JOC_FLAG: "1" })).toBe("");
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
