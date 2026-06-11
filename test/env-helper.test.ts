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
