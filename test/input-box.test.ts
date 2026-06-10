import { test, expect } from "bun:test";
import { renderInputBox } from "../src/tui/components/input-box";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("renderInputBox draws a boxed input area containing only the body and cwdLabel if provided", () => {
  const outWithCwd = renderInputBox("inspect @src/commands", { cols: 36, color: false, unicode: false, cwdLabel: "@ src" }).map(stripAnsi);
  
  // Top border is the first line
  expect(outWithCwd[0]).toBe("+----------------------------------+");
  
  // No rendered line contains "CMD" or "input" as a title
  for (const line of outWithCwd) {
    expect(line.includes("CMD")).toBe(false);
    expect(line.includes("input")).toBe(false);
  }
  
  // Body shows the typed line
  expect(outWithCwd.join("\n")).toContain("inspect @src/commands");
  
  // cwdLabel renders as its own row when provided
  const rowWithCwd = outWithCwd.find(line => line.includes("@ src"));
  expect(rowWithCwd).toBeDefined();
  
  const outWithoutCwd = renderInputBox("inspect @src/commands", { cols: 36, color: false, unicode: false }).map(stripAnsi);
  // cwdLabel is absent otherwise
  const rowWithoutCwd = outWithoutCwd.find(line => line.includes("@ src"));
  expect(rowWithoutCwd).toBeUndefined();
});

test("renderInputBox wraps long input across multiple rows", () => {
  const out = renderInputBox("x".repeat(80), { cols: 24, color: false, unicode: false }).map(stripAnsi);
  expect(out.length).toBeGreaterThan(5);
  expect(out.every(line => line.length <= 24)).toBe(true);
});
