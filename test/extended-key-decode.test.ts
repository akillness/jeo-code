import { test, expect } from "bun:test";
import {
  matchExtendedKey,
  decodeExtendedKeys,
  chunkHasCtrlC,
  normalizeKeypress,
  filterPromptInputChunk,
  createInFlightAbortHarness,
  SHIFT_ENTER_SEQS,
  MULTILINE_SENTINEL,
  type NormalizedKey,
  type PromptKeyFilterEnv,
  type PromptKeyFilterState,
} from "../src/commands/launch/input";
import { systemClipboardPasteCommand } from "../src/tui/clipboard";

// jeo negotiates the kitty keyboard protocol (CSI-u) and xterm modifyOtherKeys at the
// prompt so Shift+Enter is distinguishable — but those protocols RE-ENCODE the keys the
// rest of the REPL matches by their classic bytes: Esc arrives as `CSI 27u` (readline
// sees an unknown sequence — Esc dead), Ctrl+C as `CSI 99;5u` (no \u0003 anywhere —
// Ctrl+C dead). These tests pin the decode-back-to-legacy-bytes contract at every layer
// that consumed it live: the single-escape matcher, the whole-string decoder, the
// Ctrl+C scanner, readline keypress normalization, the prompt input filter, and the
// mid-turn ESC/Ctrl+C abort harness.

const baseEnv = (over: Partial<PromptKeyFilterEnv> = {}): PromptKeyFilterEnv => ({
  loneLfShiftEnter: false,
  slashMatchCount: 0,
  historyPanelOpen: false,
  columns: 80,
  ...over,
});
const freshState = (): PromptKeyFilterState => ({ inPaste: false });

// ── matchExtendedKey: one escape → legacy bytes + consumed length ────────────────

test("matchExtendedKey decodes kitty and modifyOtherKeys escapes to legacy bytes", () => {
  const cases: Array<{ name: string; seq: string; out: string }> = [
    { name: "kitty Esc (the 'esc dead' bug)", seq: "\u001b[27u", out: "\u001b" },
    { name: "kitty Esc keeps meaning escape under any modifier", seq: "\u001b[27;2u", out: "\u001b" },
    { name: "kitty Ctrl+C (the 'ctrl+c dead' bug)", seq: "\u001b[99;5u", out: "\u0003" },
    { name: "modifyOtherKeys Ctrl+C", seq: "\u001b[27;5;99~", out: "\u0003" },
    { name: "kitty Ctrl+V", seq: "\u001b[118;5u", out: "\u0016" },
    { name: "key RELEASE event is swallowed, never input", seq: "\u001b[99;5:3u", out: "" },
    { name: "unknown functional code is swallowed, not leaked as text", seq: "\u001b[57376;5u", out: "" },
    { name: "modified Enter never fabricates a submit (\\r)", seq: "\u001b[13;2u", out: "" },
  ];
  for (const c of cases) {
    // len must equal the FULL escape length: a short len would leak the tail
    // (e.g. `:3u`) into the draft as literal text.
    expect(matchExtendedKey(c.seq, 0), c.name).toEqual({ out: c.out, len: c.seq.length });
  }
});

test("matchExtendedKey returns null for non-extended input and honors the start index", () => {
  expect(matchExtendedKey("abc", 0)).toBeNull();
  expect(matchExtendedKey("\u001b[A", 0)).toBeNull(); // legacy arrow — not CSI-u/MOK
  expect(matchExtendedKey("\u001b[200~", 0)).toBeNull(); // paste marker — not this decoder's job
  // Matches only AT `i`, not anywhere later in the string.
  expect(matchExtendedKey("ab\u001b[27u", 0)).toBeNull();
  expect(matchExtendedKey("ab\u001b[27u", 2)).toEqual({ out: "\u001b", len: 5 });
});

// ── decodeExtendedKeys: whole-string decode ──────────────────────────────────────

test("decodeExtendedKeys decodes embedded escapes and leaves surrounding text intact", () => {
  expect(decodeExtendedKeys("ab\u001b[99;5u cd")).toBe("ab\u0003 cd");
});

test("decodeExtendedKeys is identity on plain text and legacy escapes", () => {
  expect(decodeExtendedKeys("hello world")).toBe("hello world");
  expect(decodeExtendedKeys("\u001b[A\u001b[B")).toBe("\u001b[A\u001b[B");
});

test("every SHIFT_ENTER_SEQS member survives decodeExtendedKeys VERBATIM", () => {
  // The filter (not this decoder) owns the meaning of a modified Enter. If any of
  // these decoded here, a Shift+Enter would either submit a draft or vanish.
  for (const seq of SHIFT_ENTER_SEQS) {
    expect(decodeExtendedKeys(seq), JSON.stringify(seq)).toBe(seq);
    expect(decodeExtendedKeys(`ab${seq}cd`), JSON.stringify(seq)).toBe(`ab${seq}cd`);
  }
});

// ── chunkHasCtrlC: one scanner for every Ctrl+C encoding ─────────────────────────

test("chunkHasCtrlC detects all three Ctrl+C encodings", () => {
  expect(chunkHasCtrlC("\u0003")).toBe(true); // legacy byte
  expect(chunkHasCtrlC("\u001b[99;5u")).toBe(true); // kitty CSI-u
  expect(chunkHasCtrlC("\u001b[27;5;99~")).toBe(true); // xterm modifyOtherKeys
  // mods 6 = 1 + (Shift|Ctrl bits 5): Ctrl IS held, so Ctrl+Shift+C still cancels.
  expect(chunkHasCtrlC("\u001b[99;6u")).toBe(true);
});

test("chunkHasCtrlC is false for plain text and non-Ctrl encodings", () => {
  expect(chunkHasCtrlC("hello")).toBe(false);
  // mods 2 = Shift only: decodes to the plain letter, never \u0003.
  expect(chunkHasCtrlC("\u001b[99;2u")).toBe(false);
});

// ── normalizeKeypress: readline keypress events under kitty/MOK ──────────────────

test("normalizeKeypress maps a kitty Esc event to name 'escape'", () => {
  const key = normalizeKeypress({ sequence: "\u001b[27u", name: undefined });
  expect(key?.name).toBe("escape");
  expect(key?.ctrl).toBe(false);
});

test("normalizeKeypress maps kitty Ctrl+C / Ctrl+V to named ctrl keys", () => {
  const c = normalizeKeypress({ sequence: "\u001b[99;5u" });
  expect(c?.name).toBe("c");
  expect(c?.ctrl).toBe(true);
  const v = normalizeKeypress({ sequence: "\u001b[118;5u" });
  expect(v?.name).toBe("v");
  expect(v?.ctrl).toBe(true);
});

test("normalizeKeypress leaves already-named keys and undefined untouched", () => {
  const named: NormalizedKey = { name: "return", sequence: "\r" };
  expect(normalizeKeypress(named)).toEqual({ name: "return", sequence: "\r" });
  expect(normalizeKeypress(undefined)).toBeUndefined();
});

// ── filterPromptInputChunk: the live stdin → readline path ───────────────────────

test("filter decodes a kitty Ctrl+C mid-stream so readline still sees \\u0003", () => {
  expect(filterPromptInputChunk("\u001b[99;5u", null, baseEnv(), freshState()).out).toBe("\u0003");
});

test("filter turns every newly-added modified-Enter form into the hard-break sentinel", () => {
  // kitty Alt/Ctrl+Enter, modifyOtherKeys Alt+Enter, and alt-as-meta ESC+CR — each
  // was a live "Shift+Enter submits instead of breaking" report on some terminal.
  for (const seq of ["\u001b[13;3u", "\u001b[13;5u", "\u001b[27;3;13~", "\u001b\r"]) {
    const r = filterPromptInputChunk(seq, null, baseEnv(), freshState());
    expect(r.out, JSON.stringify(seq)).toBe(MULTILINE_SENTINEL);
  }
});

test("a trailing \\r\\n outside a paste is ONE Enter — no phantom byte for the next prompt", () => {
  // Even with the lone-LF Shift+Enter rule ON, the \n half of a CRLF Enter must not
  // become a phantom break (nor a second submit).
  const r = filterPromptInputChunk("hi\r\n", null, baseEnv({ loneLfShiftEnter: true }), freshState());
  expect(r.out).toBe("hi\r");
});

test("a CRLF split ACROSS chunks: the leading \\n of the next chunk is swallowed via crTail", () => {
  const env = baseEnv({ loneLfShiftEnter: true });
  const state = freshState();
  expect(filterPromptInputChunk("hi\r", null, env, state).out).toBe("hi\r");
  // Same physical Enter keystroke — without the crTail carry this \n would insert a
  // phantom break at the fresh prompt.
  expect(filterPromptInputChunk("\n", null, env, state).out).toBe("");
});

test("backslash continuation: Enter on a draft ending in \\ becomes backspace + sentinel", () => {
  const rl = { line: "foo\\", cursor: 4 };
  const r = filterPromptInputChunk("\r", rl, baseEnv(), freshState());
  expect(r.out).toBe(`\u007f${MULTILINE_SENTINEL}`);
});

test("backslash continuation does NOT fire on an ordinary draft — Enter still submits", () => {
  const rl = { line: "foo", cursor: 3 };
  expect(filterPromptInputChunk("\r", rl, baseEnv(), freshState()).out).toBe("\r");
});

test("doc-nav: Ctrl+Home/Ctrl+End and kitty Cmd+Up jump the caret across the whole draft", () => {
  const line = `abc${MULTILINE_SENTINEL}def`;
  const home = { line, cursor: 5 };
  expect(filterPromptInputChunk("\u001b[1;5H", home, baseEnv(), freshState()).out).toBe("");
  expect(home.cursor).toBe(0);
  const end = { line, cursor: 5 };
  expect(filterPromptInputChunk("\u001b[1;5F", end, baseEnv(), freshState()).out).toBe("");
  expect(end.cursor).toBe(line.length);
  const cmdUp = { line, cursor: 5 };
  expect(filterPromptInputChunk("\u001b[1;9A", cmdUp, baseEnv(), freshState()).out).toBe("");
  expect(cmdUp.cursor).toBe(0);
});

test("doc-nav sequences are consumed even without an rl handle — params never leak as text", () => {
  expect(filterPromptInputChunk("\u001b[1;5H", null, baseEnv(), freshState()).out).toBe("");
  expect(filterPromptInputChunk("\u001b[1;9A", null, baseEnv(), freshState()).out).toBe("");
});

// ── createInFlightAbortHarness: mid-turn ESC / Ctrl+C under kitty/MOK ────────────

const fakeStdin = () => ({
  isTTY: true,
  isRaw: false,
  setRawMode(_raw: boolean) {},
  resume() {},
  on() {},
  off() {},
});

test("abort harness: kitty-encoded ESC aborts the live turn", () => {
  const notices: string[] = [];
  const h = createInFlightAbortHarness({
    captureEsc: true,
    stdin: fakeStdin(),
    onAbortNotice: msg => notices.push(msg),
  });
  try {
    h.handleData("\u001b[27u");
    expect(h.controller.signal.aborted).toBe(true);
    expect(notices).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

test("abort harness: kitty and modifyOtherKeys Ctrl+C take the SIGINT hard-exit path", () => {
  for (const seq of ["\u001b[99;5u", "\u001b[27;5;99~"]) {
    let hardExit = 0;
    const notices: string[] = [];
    const h = createInFlightAbortHarness({
      captureEsc: true,
      stdin: fakeStdin(),
      onAbortNotice: msg => notices.push(msg),
      onHardExit: () => { hardExit++; },
    });
    try {
      h.handleData(seq);
      expect(h.controller.signal.aborted, JSON.stringify(seq)).toBe(true);
      expect(hardExit, JSON.stringify(seq)).toBe(1);
      expect(notices, JSON.stringify(seq)).toEqual([]); // Ctrl+C is silent — no ESC notice
    } finally {
      h.dispose();
    }
  }
});

// ── systemClipboardPasteCommand: per-platform Ctrl+V read-tool resolution ────────

test("systemClipboardPasteCommand: per-platform tool resolution", () => {
  const has = (set: string[]) => (bin: string) => (set.includes(bin) ? `/usr/bin/${bin}` : null);
  expect(systemClipboardPasteCommand("darwin", has(["pbpaste"]))).toEqual(["pbpaste"]);
  expect(systemClipboardPasteCommand("darwin", has([]))).toBeNull();
  // -Raw keeps embedded newlines intact — dropping it re-breaks multi-line paste.
  expect(systemClipboardPasteCommand("win32", has([]))).toEqual([
    "powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw",
  ]);
  // Linux: Wayland wins over X11 when both present.
  expect(systemClipboardPasteCommand("linux", has(["wl-paste", "xclip", "xsel"]))).toEqual(["wl-paste", "--no-newline"]);
  expect(systemClipboardPasteCommand("linux", has(["xclip"]))).toEqual(["xclip", "-selection", "clipboard", "-o"]);
  expect(systemClipboardPasteCommand("linux", has(["xsel"]))).toEqual(["xsel", "--clipboard", "--output"]);
  expect(systemClipboardPasteCommand("linux", has([]))).toBeNull();
});
