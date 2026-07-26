import { test, expect } from "bun:test";
import { formatHint, formatHintBar, modifierKeyLabel, DEFAULT_HINTS, type KeyHint } from "../src/tui/components/hints";

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

test("formatHintBar/formatHint default to raw keys when no platform is given", () => {
  const hints: KeyHint[] = [{ key: "^C", label: "cancel" }, { key: "Tab", label: "complete" }];
  expect(strip(formatHintBar(hints, { color: false }))).toBe("  ^C cancel · Tab complete");
  expect(strip(formatHint({ key: "^C", label: "cancel" }, false))).toBe("^C cancel");
});

test("modifierKeyLabel: macOS uses the compact caret glyph for modifier keys", () => {
  expect(modifierKeyLabel("^C", "darwin")).toBe("\u2303C");
  expect(modifierKeyLabel("^O", "darwin")).toBe("\u2303O");
  expect(modifierKeyLabel("Tab", "darwin")).toBe("Tab");
  expect(modifierKeyLabel("/help", "darwin")).toBe("/help");
});

test("modifierKeyLabel: non-macOS platforms spell out Ctrl+", () => {
  expect(modifierKeyLabel("^C", "linux")).toBe("Ctrl+C");
  expect(modifierKeyLabel("^O", "win32")).toBe("Ctrl+O");
  expect(modifierKeyLabel("Tab", "linux")).toBe("Tab");
});

test("modifierKeyLabel: macOS ASCII fallback (unicode: false) also spells out Ctrl+", () => {
  expect(modifierKeyLabel("^C", "darwin", false)).toBe("Ctrl+C");
});

test("formatHintBar renders macOS-labeled modifier keys when platform is opted in", () => {
  const hints: KeyHint[] = [{ key: "^C", label: "cancel" }, { key: "^O", label: "history" }, { key: "Tab", label: "complete" }];
  expect(strip(formatHintBar(hints, { color: false, platform: "darwin" })))
    .toBe("  \u2303C cancel · \u2303O history · Tab complete");
});

test("formatHintBar renders non-macOS-labeled modifier keys when platform is opted in", () => {
  const hints: KeyHint[] = [{ key: "^C", label: "cancel" }, { key: "^O", label: "history" }];
  expect(strip(formatHintBar(hints, { color: false, platform: "linux" })))
    .toBe("  Ctrl+C cancel · Ctrl+O history");
});

test("formatHintBar honors the ASCII fallback for macOS labels too", () => {
  const hints: KeyHint[] = [{ key: "^C", label: "cancel" }];
  expect(strip(formatHintBar(hints, { color: false, platform: "darwin", unicode: false })))
    .toBe("  Ctrl+C cancel");
});

test("formatHintBar: platform labels still clamp to cols and respect custom indent", () => {
  const hints: KeyHint[] = [{ key: "^C", label: "cancel" }, { key: "^O", label: "history" }];
  const clamped = formatHintBar(hints, { color: false, platform: "darwin", cols: 10 });
  expect(strip(clamped).length).toBeLessThanOrEqual(10);
  expect(strip(formatHintBar(hints, { color: false, platform: "linux", indent: ">> " })))
    .toBe(">> Ctrl+C cancel · Ctrl+O history");
});
