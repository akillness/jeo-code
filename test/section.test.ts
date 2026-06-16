import { test, expect } from "bun:test";
import { SECTION_GAP, sectionLabel, stackSections } from "../src/tui/components/section";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("sectionLabel: muted card header fills the width with the title embedded", () => {
  const line = stripAnsi(sectionLabel("Output", 20, { color: false }));
  expect(line).toBe("─── Output ─────────");
  expect(line.length).toBe(20);
  expect(line.startsWith("─── Output ")).toBe(true);
});

test("sectionLabel: ASCII fallback when unicode is off", () => {
  const line = sectionLabel("Activity", 16, { color: false, unicode: false });
  expect(line).toBe("--- Activity ---");
  expect(line.length).toBe(16);
  // width honored (header longer than 16 still embeds the title, no dashes left)
  const tight = sectionLabel("Activity", 8, { color: false, unicode: false });
  expect(tight.startsWith("--- Activity ")).toBe(true);
});

test("sectionLabel: plain content is the title embedded in dashes", () => {
  expect(stripAnsi(sectionLabel("Plan", 12, { color: true }))).toBe("─── Plan ───");
});

test("stackSections: separates non-empty sections by SECTION_GAP blank lines", () => {
  const out = stackSections(
    [
      { lines: ["plan-a", "plan-b"] },
      { title: "Activity", lines: ["tool-1"] },
      { lines: [] }, // dropped
      { title: "Output", lines: ["box"] },
    ],
    { width: 24, color: false },
  ).map(stripAnsi);

  expect(out).toEqual([
    "plan-a",
    "plan-b",
    "",
    "─── Activity ───────────",
    "tool-1",
    "",
    "─── Output ─────────────",
    "box",
  ]);
  expect(SECTION_GAP).toBe(1);
});

test("stackSections: empty input and all-empty sections yield no lines (no leading gap)", () => {
  expect(stackSections([], { width: 10 })).toEqual([]);
  expect(stackSections([{ lines: [] }, { title: "X", lines: [] }], { width: 10 })).toEqual([]);
});

test("stackSections: custom gap and untitled sections", () => {
  const out = stackSections(
    [
      { lines: ["a"] },
      { lines: ["b"] },
    ],
    { width: 8, gap: 2, color: false },
  ).map(stripAnsi);
  expect(out).toEqual(["a", "", "", "b"]);
});
