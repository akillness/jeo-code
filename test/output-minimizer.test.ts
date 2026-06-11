import { test, expect } from "bun:test";
import { minimizeToolOutput } from "../src/agent/output-minimizer";

test("minimizeToolOutput: strips passing bun-test rows, keeps failure + summary", () => {
  const output = [
    "bun test v1.0.0",
    "✓ adds numbers",
    "✓ subtracts numbers",
    "✓ multiplies numbers",
    "✓ divides numbers",
    "✗ handles divide by zero",
    "  expected 0 to equal Infinity",
    "",
    " 4 pass",
    " 1 fail",
    "Ran 5 tests across 1 file",
  ].join("\n");

  const { text, filtered } = minimizeToolOutput(output, "bash");

  expect(filtered).toBeGreaterThan(0);
  // passing rows gone
  expect(text).not.toContain("✓ adds numbers");
  expect(text).not.toContain("✓ divides numbers");
  // failing row + diagnostic kept
  expect(text).toContain("✗ handles divide by zero");
  expect(text).toContain("expected 0 to equal Infinity");
  // summary/counts kept
  expect(text).toContain("4 pass");
  expect(text).toContain("1 fail");
  expect(text).toContain("Ran 5 tests");
  // note appended
  expect(text).toContain("passing test lines hidden");
});

test("minimizeToolOutput: leaves plain command output untouched", () => {
  const ls = ["src", "test", "package.json", "README.md", "tsconfig.json"].join("\n");
  const { text, filtered } = minimizeToolOutput(ls, "bash");
  expect(filtered).toBe(0);
  expect(text).toBe(ls);

  const echo = "hello world";
  const r2 = minimizeToolOutput(echo, "bash");
  expect(r2.filtered).toBe(0);
  expect(r2.text).toBe(echo);
});

test("minimizeToolOutput: strips cargo per-test ok rows, keeps test result", () => {
  const output = [
    "running 4 tests",
    "test math::adds ... ok",
    "test math::subs ... ok",
    "test math::muls ... ok",
    "test math::divs ... ok",
    "",
    "test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured",
  ].join("\n");

  const { text, filtered } = minimizeToolOutput(output, "bash");

  expect(filtered).toBeGreaterThan(0);
  expect(text).not.toContain("test math::adds ... ok");
  expect(text).not.toContain("test math::divs ... ok");
  expect(text).toContain("test result: ok");
});

test("minimizeToolOutput: passing-looking lines without a summary stay untouched", () => {
  const output = ["✓ one", "✓ two", "✓ three"].join("\n");
  const { text, filtered } = minimizeToolOutput(output, "bash");
  expect(filtered).toBe(0);
  expect(text).toBe(output);
});
