import { test, expect } from "bun:test";
import { renderInputBox } from "../src/tui/components/input-box";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("renderInputBox draws a boxed input area with command badge", () => {
  const out = renderInputBox("inspect @src/commands", { cols: 36, color: false, unicode: false, cwdLabel: "@ src" }).map(stripAnsi);
  expect(out[0]).toBe("+----------------------------------+");
  expect(out[1]).toContain("[CMD] input · @ src");
  expect(out[2]).toContain("+");
  expect(out.join("\n")).toContain("inspect @src/commands");
});

test("renderInputBox wraps long input across multiple rows", () => {
  const out = renderInputBox("x".repeat(80), { cols: 24, color: false, unicode: false }).map(stripAnsi);
  expect(out.length).toBeGreaterThan(5);
  expect(out.every(line => line.length <= 24)).toBe(true);
});
