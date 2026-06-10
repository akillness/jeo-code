import { test, expect } from "bun:test";
import { formatHint, formatHintBar, DEFAULT_HINTS, type KeyHint } from "../src/tui/components/hints";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("DEFAULT_HINTS covers the core interactive keys", () => {
  const keys = DEFAULT_HINTS.map(h => h.key);
  expect(keys).toContain("^C");
  expect(keys).toContain("Tab");
  expect(keys).toContain("/help");
});

test("formatHint renders '<key> <label>' (color-stripped)", () => {
  expect(strip(formatHint({ key: "^C", label: "cancel" }))).toBe("^C cancel");
  expect(formatHint({ key: "^C", label: "cancel" }, false)).toBe("^C cancel");
});

test("formatHintBar joins with a unicode separator; ASCII fallback uses '|'", () => {
  const hints: KeyHint[] = [{ key: "^C", label: "cancel" }, { key: "Tab", label: "complete" }];
  expect(strip(formatHintBar(hints, { color: false }))).toBe("  ^C cancel · Tab complete");
  expect(strip(formatHintBar(hints, { color: false, unicode: false }))).toBe("  ^C cancel | Tab complete");
});

test("formatHintBar clamps to cols and handles empty", () => {
  const long = formatHintBar(DEFAULT_HINTS, { color: false, cols: 14 });
  expect(strip(long).length).toBeLessThanOrEqual(14);
  expect(formatHintBar([])).toBe("");
});

test("formatHintBar custom indent", () => {
  expect(strip(formatHintBar([{ key: "/q", label: "quit" }], { color: false, indent: ">> " }))).toBe(">> /q quit");
});
