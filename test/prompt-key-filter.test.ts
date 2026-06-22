import { test, expect } from "bun:test";
import {
  filterPromptInputChunk,
  MULTILINE_SENTINEL,
  PASTE_START,
  PASTE_END,
  type PromptKeyFilterEnv,
  type PromptKeyFilterState,
} from "../src/commands/launch/input";

// filterPromptInputChunk is the stdin → readline byte rewriter for the boxed multi-line
// prompt, extracted from launch.ts so the FULL keystroke wiring (not just the pure
// decision helper) is testable without a live readline/PTY. These tests drive raw escape
// byte streams through it the way the real `kfDataHandler` does, asserting exactly which
// bytes reach readline and how the caret / paste state mutate — the closest automated
// stand-in for live-terminal verification of the "↓ cuts the lower text" fix.

const UP = "\u001b[A";
const DOWN = "\u001b[B";

const baseEnv = (over: Partial<PromptKeyFilterEnv> = {}): PromptKeyFilterEnv => ({
  loneLfShiftEnter: false,
  slashMatchCount: 0,
  historyPanelOpen: false,
  columns: 80,
  ...over,
});
const freshState = (): PromptKeyFilterState => ({ inPaste: false });

test("ordinary printable input passes straight through to readline", () => {
  expect(filterPromptInputChunk("hello", null, baseEnv(), freshState()).out).toBe("hello");
});

test("reported bug fixed: ↓ at the bottom of a genuine multi-line draft is SWALLOWED, draft survives", () => {
  // A deliberate multi-line message (Shift+Enter breaks → sentinels), caret on the last row.
  const raw = `line one${MULTILINE_SENTINEL}line two${MULTILINE_SENTINEL}line three`;
  const rl = { line: raw, cursor: raw.length };
  const res = filterPromptInputChunk(DOWN, rl, baseEnv(), freshState());
  // The arrow bytes are consumed (not forwarded) so readline's input-history recall — which
  // would WIPE the whole draft — never fires. drop=false (it was processed), out="" (nothing
  // emitted), and the caret stays put.
  expect(res.drop).toBe(false);
  expect(res.out).toBe("");
  expect(rl.cursor).toBe(raw.length);
});

test("↑ at the top of a genuine multi-line draft is likewise swallowed", () => {
  const raw = `line one${MULTILINE_SENTINEL}line two`;
  const rl = { line: raw, cursor: 0 };
  const res = filterPromptInputChunk(UP, rl, baseEnv(), freshState());
  expect(res.out).toBe("");
  expect(rl.cursor).toBe(0);
});

test("↓ from the top row of a multi-line draft MOVES the caret and is not forwarded", () => {
  const raw = `line one${MULTILINE_SENTINEL}line two${MULTILINE_SENTINEL}line three`;
  const rl = { line: raw, cursor: 0 };
  const res = filterPromptInputChunk(DOWN, rl, baseEnv(), freshState());
  expect(res.out).toBe(""); // consumed: readline must not also move the caret
  expect(rl.cursor).toBeGreaterThan(0); // caret descended a visual row
});

test("↓ on a short single-row draft FORWARDS the arrow so readline recalls history", () => {
  const rl = { line: "hello world", cursor: 11 };
  const res = filterPromptInputChunk(DOWN, rl, baseEnv(), freshState());
  expect(res.out).toBe(DOWN);
});

test("arrows on an EMPTY draft are forwarded straight to readline history", () => {
  const rl = { line: "", cursor: 0 };
  expect(filterPromptInputChunk(UP, rl, baseEnv(), freshState()).out).toBe(UP);
  expect(filterPromptInputChunk(DOWN, rl, baseEnv(), freshState()).out).toBe(DOWN);
});

test("arrows are yielded to an open slash dropdown or Ctrl+O history panel", () => {
  const raw = `a${MULTILINE_SENTINEL}b`;
  const rl = { line: raw, cursor: raw.length };
  expect(filterPromptInputChunk(DOWN, rl, baseEnv({ slashMatchCount: 2 }), freshState()).out).toBe(DOWN);
  expect(filterPromptInputChunk(UP, rl, baseEnv({ historyPanelOpen: true }), freshState()).out).toBe(UP);
});

test("xterm and kitty Shift+Enter sequences become a hard-break sentinel", () => {
  expect(filterPromptInputChunk("\u001b[27;2;13~", null, baseEnv(), freshState()).out).toBe(MULTILINE_SENTINEL);
  expect(filterPromptInputChunk("\u001b[13;2u", null, baseEnv(), freshState()).out).toBe(MULTILINE_SENTINEL);
});

test("a Shift+Enter embedded in typed text splits the chunk into a sentinel-joined draft", () => {
  const res = filterPromptInputChunk("line one\u001b[27;2;13~line two", null, baseEnv(), freshState());
  expect(res.out).toBe(`line one${MULTILINE_SENTINEL}line two`);
});

test("a lone LF becomes a sentinel only with the opt-in toggle, else passes through", () => {
  expect(filterPromptInputChunk("\n", null, baseEnv({ loneLfShiftEnter: true }), freshState()).out).toBe(MULTILINE_SENTINEL);
  expect(filterPromptInputChunk("\n", null, baseEnv({ loneLfShiftEnter: false }), freshState()).out).toBe("\n");
});

test("bracketed paste folds newlines to sentinels and the in-paste flag persists across chunks", () => {
  const state = freshState();
  const r1 = filterPromptInputChunk(`${PASTE_START}alpha\nbeta`, null, baseEnv(), state);
  expect(state.inPaste).toBe(true);
  expect(r1.out).toBe(`${PASTE_START}alpha${MULTILINE_SENTINEL}beta`);
  // Second chunk continues the same paste: CRLF and LF both fold, end marker closes it.
  const r2 = filterPromptInputChunk(`gamma\r\ndelta${PASTE_END}`, null, baseEnv(), state);
  expect(state.inPaste).toBe(false);
  expect(r2.out).toBe(`gamma${MULTILINE_SENTINEL}delta${PASTE_END}`);
});

test("mouse-report and terminal capability-response sequences are swallowed", () => {
  expect(filterPromptInputChunk("\u001b[<0;10;5M", null, baseEnv(), freshState()).out).toBe("");
  expect(filterPromptInputChunk("\u001b[?62;4;9;22c", null, baseEnv(), freshState()).out).toBe("");
});

test("Option+Left combo is normalized to the word-left control byte readline acts on", () => {
  expect(filterPromptInputChunk("\u001b[1;3D", null, baseEnv(), freshState()).out).toBe("\u001bb");
});

test("Ctrl+L (the redraw hotkey) is never forwarded to readline", () => {
  expect(filterPromptInputChunk("\u000c", null, baseEnv(), freshState()).out).toBe("");
});

test("a standalone Backspace on an empty buffer is DROPPED (no spurious close → no hard exit)", () => {
  const res = filterPromptInputChunk("\u007f", { line: "", cursor: 0 }, baseEnv(), freshState());
  expect(res.drop).toBe(true);
  expect(res.out).toBe("");
});

test("a Backspace with text in the buffer is forwarded so editing still works", () => {
  const res = filterPromptInputChunk("\u007f", { line: "abc", cursor: 3 }, baseEnv(), freshState());
  expect(res.drop).toBe(false);
  expect(res.out).toBe("\u007f");
});
