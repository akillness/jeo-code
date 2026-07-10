import { test, expect, afterEach } from "bun:test";
import { size, watchResize } from "../src/tui/terminal";

// terminal.size() reads process.stdout.columns/rows. In a non-TTY process (CI) those
// are READ-ONLY accessors, so a plain `process.stdout.columns = 40` throws
// "Attempted to assign to readonly property". Define them as configurable data
// properties instead so the override works in both TTY (local) and non-TTY (CI).
function setStdoutSize(cols: number | undefined, rows: number | undefined): void {
  Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true, writable: true });
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true, writable: true });
}
function setGetWindowSize(fn: (() => [number, number]) | undefined): void {
  if (fn === undefined) {
    Object.defineProperty(process.stdout, "getWindowSize", { value: undefined, configurable: true, writable: true });
    return;
  }
  Object.defineProperty(process.stdout, "getWindowSize", { value: fn, configurable: true, writable: true });
}

const origCols = process.stdout.columns;
const origRows = process.stdout.rows;
const origGetWindowSize = (process.stdout as unknown as { getWindowSize?: () => [number, number] }).getWindowSize;

afterEach(() => {
  setStdoutSize(origCols, origRows);
  setGetWindowSize(origGetWindowSize);
});

test("size() falls back to process.stdout.columns/rows when getWindowSize is unavailable", () => {
  setGetWindowSize(undefined);
  setStdoutSize(97, 31);
  expect(size()).toEqual({ cols: 97, rows: 31 });
});

test("size() falls back to defaults (80x24) when columns/rows are unset and getWindowSize is unavailable", () => {
  setGetWindowSize(undefined);
  setStdoutSize(undefined, undefined);
  expect(size()).toEqual({ cols: 80, rows: 24 });
});

// Regression: the root cause of jeo's "screen stays at its starting size" bug. Node/Bun
// only refresh process.stdout.columns/.rows on a real 'resize' (SIGWINCH) event — a
// missed SIGWINCH (backgrounded tmux pane, SIGCONT race) leaves them permanently stale
// no matter how many times something re-reads them. `size()` intentionally does NOT
// call getWindowSize() itself (that would break every test/tool that stubs columns/rows
// directly) — the self-healing lives in watchResize(), verified below.
test("size() prefers the cached columns/rows even when getWindowSize would disagree (test-double compatibility)", () => {
  setGetWindowSize(() => [200, 60]);
  setStdoutSize(40, 24);
  expect(size()).toEqual({ cols: 40, rows: 24 });
});

test("watchResize: self-heals a stale process.stdout.columns/rows cache via a live getWindowSize() probe, firing onChange with the CORRECTED geometry", async () => {
  setStdoutSize(80, 24);
  // Simulate a missed SIGWINCH: the cached columns/rows never move, but the OS-level
  // geometry (what getWindowSize() would report via a real ioctl) already changed.
  setGetWindowSize(() => [120, 40]);

  const changes: Array<{ cols: number; rows: number }> = [];
  const stop = watchResize((cols, rows) => changes.push({ cols, rows }), 5);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally {
    stop();
  }

  expect(changes.length).toBeGreaterThan(0);
  expect(changes[0]).toEqual({ cols: 120, rows: 40 });
  // The stale cache itself must be corrected too, so every OTHER reader of size()
  // (draw(), resizeRepaint(), idleResizeHandler()) sees the fixed geometry as well —
  // not just this callback.
  expect(size()).toEqual({ cols: 120, rows: 40 });
});

test("watchResize: never fires when the live geometry hasn't actually changed", async () => {
  setStdoutSize(80, 24);
  setGetWindowSize(() => [80, 24]);

  const changes: Array<{ cols: number; rows: number }> = [];
  const stop = watchResize((cols, rows) => changes.push({ cols, rows }), 5);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally {
    stop();
  }

  expect(changes.length).toBe(0);
});

test("watchResize: falls back to comparing size() against itself when getWindowSize is unavailable (still catches a real 'resize' event landing between polls)", async () => {
  setGetWindowSize(undefined);
  setStdoutSize(80, 24);

  const changes: Array<{ cols: number; rows: number }> = [];
  const stop = watchResize((cols, rows) => changes.push({ cols, rows }), 5);
  // Simulate a real SIGWINCH's effect: Node/Bun updating the cached fields directly.
  await new Promise(resolve => setTimeout(resolve, 15));
  setStdoutSize(100, 30);
  await new Promise(resolve => setTimeout(resolve, 30));
  stop();

  expect(changes.length).toBeGreaterThan(0);
  expect(changes[changes.length - 1]).toEqual({ cols: 100, rows: 30 });
});

test("watchResize: a getWindowSize() reporting 0,0 (no controlling terminal) is treated as unavailable, not as an actual size", async () => {
  setStdoutSize(80, 24);
  setGetWindowSize(() => [0, 0]);

  const changes: Array<{ cols: number; rows: number }> = [];
  const stop = watchResize((cols, rows) => changes.push({ cols, rows }), 5);
  await new Promise(resolve => setTimeout(resolve, 30));
  stop();

  expect(changes.length).toBe(0);
  expect(size()).toEqual({ cols: 80, rows: 24 });
});
