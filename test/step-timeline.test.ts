import { test, expect } from "bun:test";
import chalk from "chalk";
import {
  stepGlyph,
  colorForState,
  stateFromToolStatus,
  stepsFromTools,
  summarizeSteps,
  formatStepSummary,
  formatStepTimeline,
  formatDuration,
  formatStepHeader,
  formatStepTimelineCompact,
  formatProgressBar,
  type TimelineStep,
} from "../src/tui/components/step-timeline";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const STEPS: TimelineStep[] = [
  { label: "read", state: "done" },
  { label: "bash", state: "active" },
  { label: "edit", state: "failed" },
  { label: "write", state: "pending" },
];

test("stepGlyph: state glyphs + animated active spinner, unicode/ascii", () => {
  expect(stepGlyph("done")).toBe("●");
  expect(stepGlyph("failed")).toBe("✗");
  expect(stepGlyph("pending", { unicode: false })).toBe("o");
  // active with a frame animates a spinner (cycles)
  expect(stepGlyph("active", { frame: 0 })).toBe("◐");
  expect(stepGlyph("active", { frame: 1 })).toBe("◓");
  expect(stepGlyph("active", { frame: 0, unicode: false })).toBe("|");
  // negative frame is handled
  expect(stepGlyph("active", { frame: -1 })).toBe("◒");
});

test("colorForState: identity when color disabled", () => {
  expect(colorForState("done", false)("x")).toBe("x");
  expect(strip(colorForState("failed", true)("x"))).toBe("x");
});

test("stateFromToolStatus / stepsFromTools map tool rows to states", () => {
  expect(stateFromToolStatus("running")).toBe("active");
  expect(stateFromToolStatus("ok")).toBe("done");
  expect(stateFromToolStatus("fail")).toBe("failed");
  const steps = stepsFromTools([{ tool: "read", status: "ok" }, { tool: "bash", status: "fail" }]);
  expect(steps).toEqual([{ label: "read", state: "done" }, { label: "bash", state: "failed" }]);
});

test("summarizeSteps counts by state", () => {
  expect(summarizeSteps(STEPS)).toEqual({ done: 1, active: 1, failed: 1, pending: 1, total: 4 });
});

test("formatStepSummary renders counts / total; ascii fallback", () => {
  expect(strip(formatStepSummary(STEPS))).toBe("✓1 ✗1 ◐1 ·1 / 4");
  expect(strip(formatStepSummary(STEPS, { unicode: false }))).toBe("ok1 x1 *1 .1 / 4");
  // all-done omits the zero buckets
  const done = [{ label: "a", state: "done" as const }, { label: "b", state: "done" as const }];
  expect(strip(formatStepSummary(done))).toBe("✓2 / 2");
});

test("formatStepTimeline: numbered, connector gutter, last uses corner", () => {
  const out = formatStepTimeline(STEPS, { color: false }).map(strip);
  expect(out[0]).toContain("│"); // non-last connector
  expect(out[0]).toContain("1 read");
  expect(out[3]).toContain("└"); // last connector corner
  expect(out[3]).toContain("4 write");
});

test("formatStepTimeline: ascii connectors + title + empty", () => {
  const out = formatStepTimeline(STEPS, { color: false, unicode: false, title: "Steps:" });
  expect(out[0]).toBe("Steps:");
  expect(strip(out[1])).toContain("|");
  expect(strip(out[out.length - 1])).toContain("`");
  expect(formatStepTimeline([], { color: false })).toEqual(["  (no steps)"]);
});

test("formatStepTimeline: detail + maxWidth truncation", () => {
  const out = formatStepTimeline([{ label: "read", state: "done", detail: "src/very/long/path.ts" }], { color: false, maxWidth: 10 }).map(strip);
  expect(out[0]).toContain("…");
  expect(out[0].length).toBeLessThan(40);
});

test("formatDuration: ms / seconds / minutes", () => {
  expect(formatDuration(0)).toBe("0ms");
  expect(formatDuration(340)).toBe("340ms");
  expect(formatDuration(1200)).toBe("1.2s");
  expect(formatDuration(59_900)).toBe("59.9s");
  expect(formatDuration(90_000)).toBe("1m 30s");
});

test("formatStepHeader: title + summary + elapsed", () => {
  const out = strip(formatStepHeader(STEPS, { elapsedMs: 3200 }));
  expect(out).toContain("Steps");
  expect(out).toContain("/ 4");
  expect(out).toContain("3.2s");
  // no elapsed → no trailing duration
  expect(strip(formatStepHeader(STEPS))).not.toMatch(/\d+(\.\d+)?s\b/);
});

test("formatStepTimelineCompact: glyph strip + overflow + empty", () => {
  expect(strip(formatStepTimelineCompact(STEPS))).toBe("● ◐ ✗ ○");
  expect(strip(formatStepTimelineCompact(STEPS, { unicode: false }))).toBe("x * ! o");
  expect(formatStepTimelineCompact([])).toBe("");
  const many: TimelineStep[] = Array.from({ length: 5 }, () => ({ label: "x", state: "done" as const }));
  expect(strip(formatStepTimelineCompact(many, { cap: 3 }))).toContain("+2");
});

test("formatProgressBar: ratio fill + count, ascii fallback", () => {
  expect(strip(formatProgressBar(3, 5, { width: 5 }))).toBe("▓▓▓░░ 3/5");
  expect(strip(formatProgressBar(3, 5, { width: 5, unicode: false }))).toBe("###.. 3/5");
  expect(strip(formatProgressBar(0, 0, { width: 4 }))).toBe("░░░░ 0/0");
  expect(strip(formatProgressBar(10, 5, { width: 4 }))).toBe("▓▓▓▓ 10/5"); // clamped fill
});

test("formatStepTimeline: maxRows keeps recent + (+N earlier); highlightActive bolds active", () => {
  const many: TimelineStep[] = Array.from({ length: 6 }, (_, i) => ({ label: `s${i}`, state: "done" as const }));
  const out = formatStepTimeline(many, { color: false, maxRows: 3 }).map(strip);
  expect(out[0]).toContain("(+3 earlier)");
  expect(out[out.length - 1]).toContain("s5");
  // highlightActive adds ANSI bold around the active label when colored
  const active: TimelineStep[] = [{ label: "bash", state: "active" }];
  const prev = chalk.level;
  chalk.level = 3;
  try {
    const hl = formatStepTimeline(active, { color: true, highlightActive: true });
    expect(/\x1b\[1m/.test(hl[0])).toBe(true);
  } finally {
    chalk.level = prev;
  }
});
