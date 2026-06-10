import { test, expect } from "bun:test";
import { formatDuration, formatTokenCount, formatUsage } from "../src/tui/components/duration";

test("formatDuration: sub-minute stays in seconds", () => {
  expect(formatDuration(0)).toBe("0s");
  expect(formatDuration(42_000)).toBe("42s");
  expect(formatDuration(59_400)).toBe("59s");
});

test("formatDuration: minute-first past 60s (the 105s case)", () => {
  expect(formatDuration(105_000)).toBe("1m 45s");
  expect(formatDuration(60_000)).toBe("1m");
  expect(formatDuration(12 * 60_000)).toBe("12m");
});

test("formatDuration: hours", () => {
  expect(formatDuration(62 * 60_000)).toBe("1h 2m");
  expect(formatDuration(120 * 60_000)).toBe("2h");
});

test("formatTokenCount: unit scaling", () => {
  expect(formatTokenCount(950)).toBe("950");
  expect(formatTokenCount(12_345)).toBe("12.3k");
  expect(formatTokenCount(123_456)).toBe("123k");
  expect(formatTokenCount(1_234_567)).toBe("1.2M");
  expect(formatTokenCount(-5)).toBe("0");
});

test("formatUsage: composed line and empty cases", () => {
  expect(formatUsage({ inputTokens: 12_345, outputTokens: 1_234 })).toBe("12.3k in / 1.2k out tokens");
  expect(formatUsage(undefined)).toBe("");
  expect(formatUsage({})).toBe("");
});
