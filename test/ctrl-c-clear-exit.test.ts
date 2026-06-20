import { test, expect } from "bun:test";
import { decideCtrlC, CTRLC_COLLAPSE_MS } from "../src/commands/launch/input";

// Prompt Ctrl+C contract: a first press on a NON-EMPTY box clears it; a press on an
// already-EMPTY box hard-exits. The several delivery paths of one physical press
// (keypress + SIGINT + raw \u0003 byte) must collapse so a single Ctrl+C can never
// both clear and then exit.

const FAR = CTRLC_COLLAPSE_MS + 1000; // well outside the de-dup window

test("text in the box → first Ctrl+C clears it (stays at the prompt)", () => {
  expect(decideCtrlC(true, FAR)).toBe("clear");
});

test("empty box → Ctrl+C exits jeo", () => {
  expect(decideCtrlC(false, FAR)).toBe("exit");
});

test("the typed-then-cleared sequence: clear, then a later press exits", () => {
  // 1st press with content present → clear.
  expect(decideCtrlC(true, FAR)).toBe("clear");
  // box is now empty; a genuine 2nd press (outside the window) → exit.
  expect(decideCtrlC(false, FAR)).toBe("exit");
});

test("duplicate delivery of one press is ignored within the collapse window", () => {
  // Same physical press arriving again 0ms / just under the window later.
  expect(decideCtrlC(true, 0)).toBe("ignore");
  expect(decideCtrlC(false, 0)).toBe("ignore");
  expect(decideCtrlC(false, CTRLC_COLLAPSE_MS - 1)).toBe("ignore");
});

test("exactly at the window boundary is a real, separate press (not collapsed)", () => {
  expect(decideCtrlC(false, CTRLC_COLLAPSE_MS)).toBe("exit");
  expect(decideCtrlC(true, CTRLC_COLLAPSE_MS)).toBe("clear");
});

test("the collapse window is overridable (and gates the ignore decision)", () => {
  expect(decideCtrlC(false, 80, 100)).toBe("ignore"); // 80ms < custom 100ms window
  expect(decideCtrlC(false, 120, 100)).toBe("exit"); // 120ms ≥ window → real press
});
