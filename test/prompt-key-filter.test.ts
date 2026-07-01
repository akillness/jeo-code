import { test, expect } from "bun:test";
import {
  filterPromptInputChunk,
  pasteEscapeLength,
  stripPasteEscapes,
  endsInPaste,
  pasteMarkerTailLength,
  pasteIdleDecision,
  PASTE_MERGE_IDLE_MS,
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
// ── Chunk-boundary paste robustness (복사 붙여넣기 깨짐 수정) ───────────────────────
// A large paste is delivered to stdin in several reads, so the 6-byte bracketed-paste
// markers and a CRLF can straddle a chunk boundary. Before the carry fix the partial
// `\x1b[200~`/`\x1b[201~` bytes leaked into the input box as `00~`/`[201~` garbage and the
// in-paste flag desynced (newlines stopped folding → the paste submitted mid-way). These
// drive the exact split byte streams the live `kfDataHandler` would see.

/** Feed an ordered list of stdin chunks through ONE shared filter state (as the live
 *  adapter does) and concatenate everything forwarded to readline. */
function feed(chunks: string[], state: PromptKeyFilterState, rl: { line: string; cursor: number } | null = null): string {
  let out = "";
  for (const c of chunks) {
    const r = filterPromptInputChunk(c, rl, baseEnv(), state);
    if (!r.drop) out += r.out;
  }
  return out;
}

test("PASTE_START split across two chunks reassembles — no `00~` garbage, no premature submit", () => {
  const state = freshState();
  const out = feed(["\u001b[2", "00~alpha\nbeta" + PASTE_END], state);
  // Marker reconstructed, body newline folded to a sentinel (not a literal Enter), end clean.
  expect(out).toBe(`${PASTE_START}alpha${MULTILINE_SENTINEL}beta${PASTE_END}`);
  expect(state.inPaste).toBe(false);
  expect(state.carry).toBe("");
});

test("PASTE_END split across two chunks is stripped, not leaked as `[201~`", () => {
  const state = freshState();
  const out = feed([PASTE_START + "data\u001b[20", "1~"], state);
  expect(out).toBe(`${PASTE_START}data${PASTE_END}`);
  expect(state.inPaste).toBe(false);
});

test("a CRLF split across chunks inside a paste folds to ONE sentinel (no spurious blank line)", () => {
  const state = freshState();
  const out = feed([PASTE_START + "abc\r", "\ndef" + PASTE_END], state);
  expect(out).toBe(`${PASTE_START}abc${MULTILINE_SENTINEL}def${PASTE_END}`);
});

test("a trailing CR OUTSIDE a paste is NOT carried — Enter still submits immediately", () => {
  const state = freshState();
  const r = filterPromptInputChunk("hello\r", { line: "hello", cursor: 5 }, baseEnv(), state);
  expect(r.out).toBe("hello\r");
  expect(state.carry).toBe("");
});

test("ANSI color codes in pasted terminal output are stripped to plain text", () => {
  const state = freshState();
  const out = filterPromptInputChunk(`${PASTE_START}a\u001b[31mred\u001b[0mb${PASTE_END}`, null, baseEnv(), state).out;
  expect(out).toBe(`${PASTE_START}aredb${PASTE_END}`);
});

test("a multi-chunk paste with markers, CRLF and ANSI all split reconstructs to one clean buffer", () => {
  const state = freshState();
  const out = feed(["\u001b[2", "00~one\r", "\n\u001b[32mtwo\u001b", "[0mthree" + PASTE_END], state);
  expect(out).toBe(`${PASTE_START}one${MULTILINE_SENTINEL}twothree${PASTE_END}`);
  expect(state.inPaste).toBe(false);
});

test("pasteMarkerTailLength holds back only proper marker prefixes", () => {
  expect(pasteMarkerTailLength("hello\u001b[20")).toBe(4); // \x1b [ 2 0
  expect(pasteMarkerTailLength("hello\u001b[201")).toBe(5);
  expect(pasteMarkerTailLength("plain text")).toBe(0);
  expect(pasteMarkerTailLength(PASTE_START)).toBe(0); // a COMPLETE marker is handled in the loop
});

test("endsInPaste replays only paste toggles", () => {
  expect(endsInPaste(PASTE_START + "body", false)).toBe(true);
  expect(endsInPaste(PASTE_START + "body" + PASTE_END, false)).toBe(false);
  expect(endsInPaste("text", true)).toBe(true);
});

test("stripPasteEscapes drops CSI/OSC sequences but keeps text, tabs and newlines", () => {
  expect(stripPasteEscapes("a\u001b[31mred\u001b[0mb")).toBe("aredb");
  expect(stripPasteEscapes("x\u001b]0;title\u0007y")).toBe("xy");
  expect(stripPasteEscapes("keep\tthis\nline\r")).toBe("keep\tthis\nline\r");
  expect(stripPasteEscapes("drop\u0001bell\u0007")).toBe("dropbell");
});

test("pasteEscapeLength measures a CSI SGR sequence and returns 0 for plain text", () => {
  expect(pasteEscapeLength("\u001b[31m", 0)).toBe(5);
  expect(pasteEscapeLength("abc", 0)).toBe(0);
});

// ── Paste-merge idle gate (large-paste truncation fix, deferred #3) ───────────────
// The OLD dropped-marker fallback was a single fixed 250ms timer from the FIRST pasted
// line, so a large paste streaming in over >250ms was cut mid-paste. pasteIdleDecision
// makes the fallback idle-based: it only fires once the stream has been quiet for the
// threshold, so each freshly-arriving line resets the clock and the paste survives.
test("pasteIdleDecision: fires only once the idle gap reaches the threshold", () => {
  expect(pasteIdleDecision(0)).toEqual({ fire: false, waitMs: PASTE_MERGE_IDLE_MS });
  expect(pasteIdleDecision(100)).toEqual({ fire: false, waitMs: PASTE_MERGE_IDLE_MS - 100 });
  expect(pasteIdleDecision(PASTE_MERGE_IDLE_MS)).toEqual({ fire: true, waitMs: 0 });
  expect(pasteIdleDecision(PASTE_MERGE_IDLE_MS + 999)).toEqual({ fire: true, waitMs: 0 });
});

test("pasteIdleDecision: a steadily-arriving large paste never trips the fallback early", () => {
  // Simulate a paste that keeps delivering a line every 50ms for 2s: at each check the
  // idle gap is small, so the gate always says 'wait' — the paste is never truncated.
  for (let elapsed = 0; elapsed <= 2000; elapsed += 50) {
    const sinceLastLine = 50; // a new line just landed 50ms ago
    expect(pasteIdleDecision(sinceLastLine).fire).toBe(false);
  }
  // Only once the stream goes quiet past the threshold does it flush.
  expect(pasteIdleDecision(PASTE_MERGE_IDLE_MS + 1).fire).toBe(true);
});

test("pasteIdleDecision: a custom threshold is honored", () => {
  expect(pasteIdleDecision(400, 1000)).toEqual({ fire: false, waitMs: 600 });
  expect(pasteIdleDecision(1000, 1000)).toEqual({ fire: true, waitMs: 0 });
});
test("un-bracketed multi-line paste guard: a 3-line paste with NO bracket markers folds embedded\n breaks to sentinels instead of submitting line-by-line (the '붙여넣기가 잘 안됨' bug)", () => {
  const res = filterPromptInputChunk("first line of paste\nsecond line here\nthird and final line", null, baseEnv(), freshState());
  expect(res.out).toBe(`first line of paste${MULTILINE_SENTINEL}second line here${MULTILINE_SENTINEL}third and final line`);
});

test("un-bracketed multi-line paste guard: CRLF line endings fold too, and a lone trailing\n Enter (nothing after it) still submits normally", () => {
  const state = freshState();
  const res = filterPromptInputChunk("alpha\r\nbeta\r\ngamma", null, baseEnv(), state);
  expect(res.out).toBe(`alpha${MULTILINE_SENTINEL}beta${MULTILINE_SENTINEL}gamma`);
  // A genuine standalone Enter (this exact chunk's ONLY byte) is unaffected.
  const submit = filterPromptInputChunk("\r", { line: "gamma", cursor: 5 }, baseEnv(), state);
  expect(submit.out).toBe("\r");
});

test("un-bracketed multi-line paste guard: a single typed Enter with nothing queued after it in\n the same chunk still submits (no false positive on ordinary typing)", () => {
  const res = filterPromptInputChunk("hello\r", { line: "hello", cursor: 5 }, baseEnv(), freshState());
  expect(res.out).toBe("hello\r");
});

test("un-bracketed multi-line paste guard: does not fire INSIDE a real bracketed paste (already\n handled by the paste-fold path, no double-processing)", () => {
  const state = freshState();
  const res = filterPromptInputChunk(`${PASTE_START}one\ntwo\nthree${PASTE_END}`, null, baseEnv(), state);
  expect(res.out).toBe(`${PASTE_START}one${MULTILINE_SENTINEL}two${MULTILINE_SENTINEL}three${PASTE_END}`);
});
