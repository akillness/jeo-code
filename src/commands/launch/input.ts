import { verticalCursorOffset, rowBoundaryOffset } from "../../tui/components/input-box";


export interface InFlightAbortHarness {
  controller: AbortController;
  handleSigint(): void;
  handleData(chunk: string | Uint8Array): void;
  dispose(): void;
}

interface AbortHarnessOptions {
  controller?: AbortController;
  captureEsc?: boolean;
  stdin?: {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?(raw: boolean): void;
    resume?(): void;
    on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
    off(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
  };
  onAbortNotice?: (message: string) => void;
  onHardExit?: () => void;
  /** Invoked when stray escape-sequence noise (wheel scroll etc.) arrives mid-turn. */
  onNoise?: () => void;
  /** Invoked when Ctrl+O (\u000f) is pressed mid-turn — the detail-view binding.
   *  Without this hook the byte would be swallowed into the buffered input queue,
   *  which is why Ctrl+O historically "did nothing" while the TUI owned stdin. */
  onDetailKey?: () => void;
  /** Invoked when Ctrl+\\ (\u001c) is pressed mid-turn — the safety kill-switch binding. */
  onKillSwitch?: () => void;
  /** Invoked when an arrow / PageUp / PageDown key arrives mid-turn — scrolls the
   *  open Ctrl+O detail panel. dir -1 = up/back, +1 = down/forward; page = full jump. */
  onScrollKey?: (dir: -1 | 1, page: boolean) => void;
  /** Invoked with printable keyboard input received while the live turn owns stdin. */
  onBufferedInput?: (chunk: string) => void;
  /** True while the input queue is inside a bracketed paste (mid-paste chunks
   *  carry no marker and must keep routing to the queue, not the noise path). */
  pasteActive?: () => boolean;
}

/** Bracketed-paste markers (DECSET 2004): terminals wrap pasted text in these so
 *  an app can treat the paste as DATA instead of keystrokes — the prompt_toolkit
 *  paste contract. jeo enables the mode for the REPL TTY so a multi-line paste
 *  arrives atomically and executes one command per line, in order. */
export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

/** True when a stdin chunk is ONLY backspace bytes (DEL 0x7f or BS 0x08) — i.e. a
 *  standalone Backspace keystroke with nothing else. A backspace on an EMPTY input
 *  line is a no-op edit, but some Bun readline builds turn it into a spurious `close`
 *  event, which the REPL would treat as a hard exit ("Backspace quits jeo"). The
 *  input filter swallows these when the line buffer is already empty so the byte never
 *  reaches readline and the close can't fire. */
export function isStandaloneBackspace(chunk: string): boolean {
  return chunk.length > 0 && /^[\x7f\b]+$/.test(chunk);
}

/** Private-use sentinel the input filter substitutes for an EXPLICIT line break
 *  (Shift+Enter / a pasted newline) before the bytes reach readline, so the draft can
 *  carry hard newlines through readline's single-line buffer. A line that merely
 *  SOFT-WRAPS at the box width contains NO sentinel — that distinction is the whole
 *  point of `isGenuineMultilineDraft`. */
export const MULTILINE_SENTINEL = "\uE000";

/** True when the draft has at least one EXPLICIT line break (a sentinel) — i.e. the
 *  user deliberately made it multi-line. A long single line that the box soft-wraps to
 *  several visual rows is NOT multi-line and returns false. */
export function isGenuineMultilineDraft(line: string): boolean {
  return line.includes(MULTILINE_SENTINEL);
}

/** Whether an Up/Down keystroke should be CONSIDERED for moving the caret between the
 *  box's visual rows (textarea feel) instead of going straight to readline. True for any
 *  non-empty draft when no slash dropdown or Ctrl+O history panel owns the arrows.
 *
 *  This is a gate, NOT the final decision: the caller still consults
 *  `verticalCursorOffset`, which returns a target offset only when there is a visual row
 *  to move to. So ↑/↓ edit a MULTI-ROW draft — whether it spans rows via explicit
 *  Shift+Enter breaks OR a long line the box soft-wraps — yet still fall through to
 *  input-history recall at the boundaries: ↑ on the TOP visual row, ↓ on the BOTTOM row,
 *  and any single-visual-row draft (where `verticalCursorOffset` yields null). That
 *  boundary-aware split gives full arrow-key cursor movement for editing multi-row input
 *  while preserving "↑ recalls the previous prompt" once the caret can climb no higher. */
export function shouldBoxVerticalNav(
  line: string,
  opts: { slashMatchCount: number; historyPanelOpen: boolean },
): boolean {
  return line.length > 0 && opts.slashMatchCount === 0 && !opts.historyPanelOpen;
}

/** The action an Up/Down keystroke should take on the boxed prompt, given the draft and
 *  caret. `expandedLine` has explicit breaks expanded to "\n" (the wrapped row model the
 *  box renders); `rawLine` keeps the sentinels so a genuine multi-line draft is detectable.
 *
 *  - "move":    a visual row exists in `dir` → reposition the caret to `cursor` (textarea feel).
 *  - "swallow": no row to move to AND the draft is a GENUINE multi-line message → keep the
 *               keystroke INSIDE the box. Falling through to readline at the top/bottom edge
 *               would recall input history and WIPE the multi-line draft the user is composing
 *               (the "↓ cuts the lower text" bug) — so the boundary key is a deliberate no-op.
 *  - "history": no row to move to on a SOFT-WRAPPED single line → fall through to readline so
 *               ↑/↓ recall input history at the edges (the dominant one-liner REPL expectation). */
export type BoxVerticalNavAction =
  | { kind: "move"; cursor: number }
  | { kind: "swallow" }
  | { kind: "history" };

export function boxVerticalNavAction(
  expandedLine: string,
  rawLine: string,
  cursor: number,
  width: number,
  dir: "up" | "down",
): BoxVerticalNavAction {
  const next = verticalCursorOffset(expandedLine, cursor, width, dir);
  if (next != null) return { kind: "move", cursor: next };
  return isGenuineMultilineDraft(rawLine) ? { kind: "swallow" } : { kind: "history" };
}


/**
 * macOS / fixterms combo-key normalization for the boxed prompt's line editor.
 *
 * Bun's readline acts on Ctrl+arrow (CSI `1;5D`/`1;5C` → word jump), Home/End, and the
 * Emacs control bytes (Ctrl+A/E/W/U/K, Meta+b/f/d, Meta+DEL) — but it does NOT act on
 * the modifier-flagged cursor keys macOS users reach for most: Option+Left/Right (word
 * jump, CSI `1;3D`/`1;3C`) and Cmd+Left/Right (line start/end, CSI `1;9D`/`1;9C`) are
 * inert. Rather than racing readline for cursor state in a keypress handler, we rewrite
 * each inert combo to the canonical control byte readline DOES act on, BEFORE it reaches
 * readline. readline stays the single owner of `rl.line`/`rl.cursor`; the box just reads
 * and repaints. Replacement targets are empirically verified against Bun's readline.
 *
 * Modifier digit in `CSI 1;<m><dir>`: 3=Alt/Option, 5=Ctrl (already handled), 9=Cmd/Super.
 * Both the CSI form and the ESC-prefixed alt-as-meta form (`ESC ESC [ D`) are covered. */
export const CURSOR_COMBO_REWRITES: ReadonlyArray<readonly [string, string]> = [
  ["\u001b[1;3D", "\u001bb"],     // Option+Left   → word left
  ["\u001b[1;3C", "\u001bf"],     // Option+Right  → word right
  ["\u001b\u001b[D", "\u001bb"],  // Option+Left   (ESC-prefixed alt-as-meta)
  ["\u001b\u001b[C", "\u001bf"],  // Option+Right  (ESC-prefixed alt-as-meta)
  ["\u001b[1;9D", "\u0001"],      // Cmd+Left      → line start (Ctrl+A)
  ["\u001b[1;9C", "\u0005"],      // Cmd+Right     → line end   (Ctrl+E)
  ["\u001b[127;3u", "\u0017"],    // Option+Backspace (kitty CSI-u) → delete word left (Ctrl+W)
  ["\u001b[127;9u", "\u0015"],    // Cmd+Backspace    (kitty CSI-u) → delete to line start (Ctrl+U)
  ["\u001b[3;3~", "\u001bd"],     // Option+Delete (forward) → delete word right (Meta+d)
];

/** First combo-key rewrite whose source sequence begins at `data[i]`, else undefined. */
export function matchCursorCombo(data: string, i: number): readonly [string, string] | undefined {
  for (const pair of CURSOR_COMBO_REWRITES) if (data.startsWith(pair[0], i)) return pair;
  return undefined;
}

/** Byte length of a terminal MOUSE-REPORT sequence beginning at `data[i]`, else 0.
 *  jeo never requests mouse reporting (resetMouseTracking disables it), but tmux
 *  `mouse on` — which `jeo --tmux` sets so wheel-scroll reaches copy-mode — or a stale
 *  pane can still deliver reports. Their payload bytes (X10 `ESC[M` + 3 raw bytes, or
 *  SGR `ESC[<b;x;y` + `M`/`m`) would otherwise land in the prompt as typed text — the
 *  "값 입력" corruption where clicking/scrolling sprays digits into the input box. The
 *  filter swallows the whole sequence so it never reaches readline. `ESC[<` and `ESC[M`
 *  are input-unambiguous (mouse-only), so an unterminated tail (split across chunks) is
 *  consumed too rather than leaked. */
export function matchMouseReport(data: string, i: number): number {
  if (data.startsWith("\u001b[<", i)) {
    let j = i + 3;
    while (j < data.length && data[j] !== "M" && data[j] !== "m") j++;
    return (j < data.length ? j + 1 : data.length) - i;
  }
  if (data.startsWith("\u001b[M", i)) {
    return Math.min(6, data.length - i);
  }
  return 0;
}

/** Byte length of a terminal CAPABILITY-RESPONSE sequence beginning at `data[i]`, else 0.
 *  These are REPLIES the terminal sends to capability queries — Primary/Secondary Device
 *  Attributes (`ESC[?…c` / `ESC[>…c` / `ESC[=…c`), XTVERSION and other DCS replies
 *  (`ESC P…ST`), and OSC replies like a color query (`ESC]11;rgb:…ST`). jeo never sends
 *  these queries, but tmux probes the OUTER terminal on attach, and the outer terminal's
 *  answers can land on stdin (the leaked `62;4;9;22c…>|xterm.js(…)` garbage in the prompt).
 *  They are never typed input, so the whole sequence is swallowed. A reply split across
 *  chunks (no terminator yet) consumes the tail rather than leaking it. */
export function matchTerminalReport(data: string, i: number): number {
  // CSI device-attribute / mode replies: ESC [ (? | > | =) … <final letter>.
  if (data.startsWith("\u001b[?", i) || data.startsWith("\u001b[>", i) || data.startsWith("\u001b[=", i)) {
    let j = i + 3;
    while (j < data.length && !/[A-Za-z]/.test(data[j]!)) j++; // params: digits ; : $ → final letter
    return (j < data.length ? j + 1 : data.length) - i;
  }
  // DCS (ESC P … ) or OSC (ESC ] … ) reply — terminated by ST (ESC \) or BEL.
  if (data.startsWith("\u001bP", i) || data.startsWith("\u001b]", i)) {
    let j = i + 2;
    while (j < data.length) {
      if (data[j] === "\u0007") return j + 1 - i;                       // BEL
      if (data[j] === "\u001b" && data[j + 1] === "\\") return j + 2 - i; // ST
      j++;
    }
    return data.length - i; // unterminated tail (split chunk) — consume the rest
  }
  return 0;
}

/** Remove every terminal MOUSE-REPORT and CAPABILITY-RESPONSE sequence from a plain
 *  (non-paste) input segment. The live-turn drain (`queuePromptInputChunk`) reads RAW
 *  stdin, so a wheel/click report or a tmux-probed device-attribute reply buffered during
 *  a running turn would otherwise have its printable remnant (`[M`, SGR digits, or
 *  `62;4;9;22c…`) fed into the next prompt — the same "값 입력" corruption the keyFilter
 *  blocks on the idle path. */
export function stripMouseReports(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const m = matchMouseReport(s, i) || matchTerminalReport(s, i);
    if (m > 0) { i += m; continue; }
    out += s[i];
    i += 1;
  }
  return out;
}

/** Apply combo-key rewrites across a plain (non-paste) input segment. Shares
 *  `matchCursorCombo` with the live input filter, so the filter and this exported
 *  helper can never diverge. */
export function rewriteCursorCombos(plain: string): string {
  let out = "";
  let i = 0;
  while (i < plain.length) {
    const combo = matchCursorCombo(plain, i);
    if (combo) { out += combo[1]; i += combo[0].length; continue; }
    out += plain[i];
    i += 1;
  }
  return out;
}

/** Byte length of a terminal ESCAPE SEQUENCE beginning at `s[i]`, else 0 — used to STRIP
 *  escapes embedded in PASTED text (copied colored terminal output carries `\x1b[31m`-style
 *  SGR codes; left intact they reach readline as literal escapes that corrupt the input box,
 *  or as leftover `[31m` garbage text). Covers CSI (`ESC [ … final-byte`), OSC/DCS/PM/APC/SOS
 *  (`ESC ] | P | ^ | _ | X … ST|BEL`), and the two-byte `ESC <char>` form. A sequence split
 *  across the end of the segment consumes the remaining tail. */
export function pasteEscapeLength(s: string, i: number): number {
  if (s[i] !== "\u001b") return 0;
  const c = s[i + 1];
  if (c === undefined) return 1; // lone trailing ESC
  if (c === "[") { // CSI: params/intermediates until a final byte 0x40–0x7e
    let j = i + 2;
    while (j < s.length && !(s[j]! >= "\u0040" && s[j]! <= "\u007e")) j++;
    return (j < s.length ? j + 1 : s.length) - i;
  }
  if (c === "]" || c === "P" || c === "^" || c === "_" || c === "X") { // OSC/DCS/PM/APC/SOS → ST or BEL
    let j = i + 2;
    while (j < s.length) {
      if (s[j] === "\u0007") return j + 1 - i;                         // BEL
      if (s[j] === "\u001b" && s[j + 1] === "\\") return j + 2 - i;    // ST
      j++;
    }
    return s.length - i;
  }
  return 2; // two-byte ESC <char>
}

/** Remove every terminal escape sequence AND stray C0 control byte (except `\t`/`\n`/`\r`,
 *  which carry layout meaning the caller handles) from a chunk of PASTED text, so copied
 *  ANSI-colored output drops to its plain characters instead of corrupting the prompt.
 *  Shared by every paste path (the idle key-filter, the live-turn drain, mid-turn capture)
 *  so they sanitize identically. */
export function stripPasteEscapes(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const esc = pasteEscapeLength(s, i);
    if (esc > 0) { i += esc; continue; }
    const ch = s[i]!;
    if (ch === "\n" || ch === "\r" || ch === "\t" || ch >= " ") out += ch;
    i += 1;
  }
  return out;
}

export interface PromptInputQueue {
  pendingLines: string[];
  partial: string;
  /** Complete lines that arrived inside a bracketed PASTE: intentional batch
   *  commands, served one per prompt in order. Never folded into the typed-line
   *  prefill (that contract is for keystrokes typed during a live turn). */
  pastedLines: string[];
  /** True while a bracketed paste spans chunks (between \x1b[200~ and \x1b[201~). */
  inPaste: boolean;
}

/** Typed (non-paste) keystrokes: printable chars build the partial, Enter promotes
 *  it to pendingLines, backspace edits — ESC/ctrl noise segments are rejected. */
function feedTypedSegment(state: PromptInputQueue, segment: string): boolean {
  if (!segment || segment.includes("\u001b") || segment.includes("\u0003")) return false;
  let accepted = false;
  const normalized = segment.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const ch of Array.from(normalized)) {
    if (ch === "\n") {
      if (state.partial.length > 0) accepted = true;
      state.pendingLines.push(state.partial);
      state.partial = "";
    } else if (ch === "\u007f" || ch === "\b") {
      const chars = Array.from(state.partial);
      chars.pop();
      state.partial = chars.join("");
      accepted = true;
    } else if (ch === "\t" || ch >= " ") {
      state.partial += ch;
      accepted = true;
    }
  }
  return accepted;
}

/** Pasted body: pure DATA — newlines split commands into pastedLines, the trailing
 *  partial stays editable, and any ANSI escape sequence from copied terminal output is
 *  STRIPPED (via `stripPasteEscapes`) instead of being interpreted/leaked as keystrokes.
 *  Shares the sanitizer with the idle key-filter so every paste path behaves identically. */
function feedPasteBody(state: PromptInputQueue, body: string): boolean {
  if (!body) return false;
  let accepted = false;
  const normalized = stripPasteEscapes(body).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const ch of Array.from(normalized)) {
    if (ch === "\n") {
      state.pastedLines.push(state.partial);
      state.partial = "";
      accepted = true;
    } else if (ch === "\t" || ch >= " ") {
      state.partial += ch;
      accepted = true;
    }
  }
  return accepted;
}

export function queuePromptInputChunk(state: PromptInputQueue, chunk: string): boolean {
  if (!chunk) return false;
  let accepted = false;
  let rest = chunk;
  while (rest.length > 0) {
    if (state.inPaste) {
      const end = rest.indexOf(PASTE_END);
      const body = end === -1 ? rest : rest.slice(0, end);
      if (end !== -1) state.inPaste = false;
      rest = end === -1 ? "" : rest.slice(end + PASTE_END.length);
      if (feedPasteBody(state, body)) accepted = true;
    } else {
      const start = rest.indexOf(PASTE_START);
      const plain = start === -1 ? rest : rest.slice(0, start);
      if (start !== -1) state.inPaste = true;
      rest = start === -1 ? "" : rest.slice(start + PASTE_START.length);
      if (feedTypedSegment(state, stripMouseReports(plain))) accepted = true;
    }
  }
  return accepted;
}

/** Live-turn prompt capture: printable input edits the SAME next-prompt line the
 * idle footer will show after the turn finishes. Enter does NOT promote a hidden
 * queue entry; it merely marks the current line as ready, so the existing input
 * box stays the single source of truth and the user presses Enter once more at
 * the real prompt to run it. */
function feedLivePromptSegment(state: PromptInputQueue, segment: string): boolean {
  if (!segment || segment.includes("\u001b") || segment.includes("\u0003")) return false;
  let accepted = false;
  const normalized = segment.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const ch of Array.from(normalized)) {
    if (ch === "\n") {
      accepted = true;
    } else if (ch === "\u007f" || ch === "\b") {
      const chars = Array.from(state.partial);
      chars.pop();
      state.partial = chars.join("");
      accepted = true;
    } else if (ch === "\t" || ch >= " ") {
      state.partial += ch;
      accepted = true;
    }
  }
  return accepted;
}

function feedLivePromptPasteBody(state: PromptInputQueue, body: string): boolean {
  if (!body) return false;
  const normalized = stripPasteEscapes(body).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const flattened = normalized.split("\n").map(part => part.trim()).filter(Boolean).join(" ");
  if (!flattened) return false;
  state.partial = state.partial ? `${state.partial} ${flattened}` : flattened;
  return true;
}

export function captureLivePromptInputChunk(state: PromptInputQueue, chunk: string): boolean {
  if (!chunk) return false;
  let accepted = false;
  let rest = chunk;
  while (rest.length > 0) {
    if (state.inPaste) {
      const end = rest.indexOf(PASTE_END);
      const body = end === -1 ? rest : rest.slice(0, end);
      if (end !== -1) state.inPaste = false;
      rest = end === -1 ? "" : rest.slice(end + PASTE_END.length);
      if (feedLivePromptPasteBody(state, body)) accepted = true;
    } else {
      const start = rest.indexOf(PASTE_START);
      const plain = start === -1 ? rest : rest.slice(0, start);
      if (start !== -1) state.inPaste = true;
      rest = start === -1 ? "" : rest.slice(start + PASTE_START.length);
      if (feedLivePromptSegment(state, plain)) accepted = true;
    }
  }
  return accepted;
}

/**
 * TTY "new input first" contract: fold any queued FULL lines (stray
 * Enter-terminated buffer noise, or older persisted queues) into the editable
 * prompt prefill instead of leaving them to auto-execute as the next prompt.
 * Without this, stale queued lines ran BEFORE the user's fresh input — jeo
 * appeared to "continue the previous work first". Returns the number of lines
 * folded. Pure over the queue object — piped/non-TTY callers must NOT use this
 * (scripted stdin relies on in-order line execution).
 */
export function restoreQueuedLinesToPrefill(state: PromptInputQueue): number {
  const lines = state.pendingLines.splice(0, state.pendingLines.length).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return 0;
  const restored = lines.join(" ");
  state.partial = state.partial ? `${restored} ${state.partial}`.trim() : restored;
  return lines.length;
}

export function createInFlightAbortHarness(opts: AbortHarnessOptions = {}): InFlightAbortHarness {
  const controller = opts.controller ?? new AbortController();
  const stdin = opts.stdin ?? process.stdin;
  const captureEsc = opts.captureEsc === true && !!stdin.isTTY;
  const wasRaw = !!stdin.isRaw;
  let rawChanged = false;

  const abortNow = (message: string) => {
    if (controller.signal.aborted) return false;
    opts.onAbortNotice?.(message);
    controller.abort();
    return true;
  };

  const handleSigint = () => {
    if (!controller.signal.aborted) controller.abort();
    opts.onHardExit?.();
  };

  const handleData = (chunk: string | Uint8Array) => {
    if (!captureEsc || controller.signal.aborted) return;
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (text.includes(PASTE_START) || opts.pasteActive?.()) {
      opts.onBufferedInput?.(text);
      return;
    }
    if (text === "\u000f") {
      opts.onDetailKey?.();
      return;
    }
    if (text === "\u001c") {
      opts.onKillSwitch?.();
      return;
    }
    if (text === "\u001b[A") { opts.onScrollKey?.(-1, false); return; }
    if (text === "\u001b[B") { opts.onScrollKey?.(1, false); return; }
    if (text === "\u001b[5~") { opts.onScrollKey?.(-1, true); return; }
    if (text === "\u001b[6~") { opts.onScrollKey?.(1, true); return; }
    const escAt = text.indexOf("\u001b");
    const sigintAt = text.indexOf("\u0003");
    const controlAt =
      escAt === -1 ? sigintAt :
      sigintAt === -1 ? escAt :
      Math.min(escAt, sigintAt);
    if (controlAt >= 0) {
      const printablePrefix = text.slice(0, controlAt);
      if (printablePrefix) opts.onBufferedInput?.(printablePrefix);
      if (text[controlAt] === "\u0003") {
        handleSigint();
        return;
      }
      if (text === "\u001b") {
        abortNow("ESC pressed — cancelling current run…");
        return;
      }
      opts.onNoise?.();
      return;
    }
    opts.onBufferedInput?.(text);
  };

  process.on("SIGINT", handleSigint);
  if (captureEsc) {
    stdin.on("data", handleData);
    if (stdin.setRawMode && !wasRaw) {
      stdin.setRawMode(true);
      rawChanged = true;
    }
    stdin.resume?.();
  }

  return {
    controller,
    handleSigint,
    handleData,
    dispose() {
      process.removeListener("SIGINT", handleSigint);
      if (captureEsc) {
        stdin.off("data", handleData);
        if (rawChanged) stdin.setRawMode?.(false);
      }
    },
  };
}

/** Classify a mid-turn Enter draft. `/` (slash command) and `$` (skill) are jeo's
 *  command sigils: such a line must run as a COMMAND, never be steered as literal text
 *  into the running model. Anything else is a STEER query fed to the live turn; blank
 *  is EMPTY (ignored). Pure + exported so the live-turn handler and tests can't drift. */
export function classifyMidTurnLine(line: string): "command" | "steer" | "empty" {
  const t = line.trim();
  if (!t) return "empty";
  // A lone sigil ("/" or "$") has no command name — ignore it instead of aborting the
  // running turn to dispatch an empty command (a stray slash should not interrupt work).
  if (t === "/" || t === "$") return "empty";
  return /^[/$]/.test(t) ? "command" : "steer";
}
/** Default window (ms) over which the several delivery paths of ONE physical Ctrl+C
 *  press — readline 'keypress', the rl/process 'SIGINT' event, and the raw \u0003 stdin
 *  byte — collapse into a single logical action. A genuine second press (the user
 *  reacting to the just-cleared box) is far slower than this, so it is never swallowed. */
export const CTRLC_COLLAPSE_MS = 50;

export type CtrlCAction = "ignore" | "clear" | "exit";

/** Decide what a Ctrl+C at the idle prompt should do, given whether the input box
 *  currently holds anything clearable (typed text, a pending clipboard image, or a
 *  queued pasted batch) and how long ago the previous Ctrl+C was handled:
 *
 *   - within `collapseMs` of the last handled press → "ignore" (duplicate delivery of
 *     the SAME keystroke; acting on both would let one press clear AND then exit).
 *   - input present                                  → "clear" (wipe the box, stay put).
 *   - box already empty                              → "exit" (hard terminal break, 130).
 *
 *  Pure so the "first Ctrl+C clears, next Ctrl+C exits" contract is unit-testable
 *  without a live TTY. */
export function decideCtrlC(
  hasInput: boolean,
  msSinceLastCtrlC: number,
  collapseMs: number = CTRLC_COLLAPSE_MS,
): CtrlCAction {
  if (msSinceLastCtrlC < collapseMs) return "ignore";
  return hasInput ? "clear" : "exit";
}

/** Shift+Enter encodings the box rewrites to a hard-break SENTINEL: the xterm
 *  `modifyOtherKeys` form (`CSI 27;2;13~`) and the kitty keyboard-protocol form
 *  (`CSI 13;2u`). Shared by the live input filter and its tests so they can't drift. */
export const SHIFT_ENTER_SEQS: readonly string[] = ["\u001b[27;2;13~", "\u001b[13;2u"];
/** Sequences that should jump the caret to the START of the current VISUAL ROW: macOS
 *  Cmd+Left (`CSI 1;9D`) and the platform-neutral Home key in both its xterm (`CSI H`)
 *  and vt220 (`CSI 1~`) forms, plus the SS3 variant (`ESC O H`) some terminals send in
 *  application-cursor-keys mode. Windows terminals have no Cmd-combo equivalent — bare
 *  Home is the "적절한 윈도우 단축키" for this action, so it must get the SAME row-aware
 *  treatment as Cmd+Left, not just readline's native (whole-buffer) binding. */
export const ROW_HOME_SEQS: readonly string[] = ["\u001b[1;9D", "\u001b[H", "\u001b[1~", "\u001bOH"];
/** Mirror of {@link ROW_HOME_SEQS} for the END of the current visual row: macOS
 *  Cmd+Right (`CSI 1;9C`) and the xterm/vt220/SS3 End key forms. */
export const ROW_END_SEQS: readonly string[] = ["\u001b[1;9C", "\u001b[F", "\u001b[4~", "\u001bOF"];


/** Minimal readline view the prompt key-filter reads (and mutates `cursor` on a
 *  vertical-nav "move"). The live filter passes the real readline interface; tests
 *  pass a plain object. */
export interface PromptKeyFilterRl {
  line: string;
  cursor: number;
}

/** Per-keystroke context the filter needs that is NOT derivable from the bytes:
 *  the opt-in lone-LF Shift+Enter toggle, whether a slash dropdown / Ctrl+O history
 *  panel currently owns the arrow keys, and the terminal width (for the box's
 *  soft-wrap row model). */
export interface PromptKeyFilterEnv {
  loneLfShiftEnter: boolean;
  slashMatchCount: number;
  historyPanelOpen: boolean;
  /** `process.stdout.columns ?? 80` — the raw column count BEFORE the box's own insets. */
  columns: number;
}

/** Carried across chunks: a bracketed paste can span several stdin chunks, so the
 *  in-paste flag must survive between filter calls. `carry` holds a trailing byte run
 *  that MIGHT be the start of a split escape sequence — a bracketed-paste marker
 *  (`\x1b[200~`/`\x1b[201~`) or a `\r` that could be the front of a `\r\n` — sliced off
 *  the end of one chunk and re-prepended to the next so a marker straddling a stdin read
 *  boundary is never half-interpreted (the "긴 텍스트 붙여넣으면 `00~`/`[201~` 쓰레기가
 *  새거나 중간에 제출됨" corruption). Concatenation is always re-parsed, so carrying is
 *  safe even when the tail turns out NOT to be a marker. */
export interface PromptKeyFilterState {
  inPaste: boolean;
  carry?: string;
}

/** Length of the longest trailing run of `data` that is a PROPER prefix of a
 *  bracketed-paste marker (so it could be a marker split across a stdin chunk boundary).
 *  Returns 0 when the tail cannot begin a marker. Both markers share the `\x1b[20` stem,
 *  so e.g. a trailing `\x1b`, `\x1b[`, `\x1b[2`, `\x1b[20`, `\x1b[200`, or `\x1b[201` is
 *  held back for the next chunk; a full marker (handled in the main loop) is not. */
export function pasteMarkerTailLength(data: string): number {
  const markers = [PASTE_START, PASTE_END] as const;
  const max = Math.min(Math.max(PASTE_START.length, PASTE_END.length) - 1, data.length);
  for (let k = max; k >= 1; k--) {
    const tail = data.slice(data.length - k);
    for (const m of markers) if (m.length > k && m.startsWith(tail)) return k;
  }
  return 0;
}

/** Whether `data` (already free of any trailing partial marker) leaves the filter INSIDE
 *  a bracketed paste, given the entry state — by replaying only the paste toggles. Used to
 *  decide if a trailing lone `\r` is a CRLF/CR split inside paste body (carry it) versus a
 *  real Enter at the prompt (must NOT be carried). */
export function endsInPaste(data: string, startInPaste: boolean): boolean {
  let inPaste = startInPaste;
  let i = 0;
  while (i < data.length) {
    if (!inPaste && data.startsWith(PASTE_START, i)) { inPaste = true; i += PASTE_START.length; continue; }
    if (inPaste && data.startsWith(PASTE_END, i)) { inPaste = false; i += PASTE_END.length; continue; }
    i += 1;
  }
  return inPaste;
}

export interface PromptKeyFilterResult {
  /** Bytes to forward to readline. */
  out: string;
  /** True when the whole chunk was consumed and NOTHING should be written (the
   *  empty-line standalone-Backspace guard) — distinct from an empty `out`. */
  drop: boolean;
}

/** The stdin → readline byte rewriter for the boxed multi-line prompt, extracted as a
 *  pure function so the full keystroke wiring — paste folding, mouse/terminal-report
 *  swallowing, Shift+Enter → SENTINEL, combo-key normalization, and the boundary-aware
 *  Up/Down box navigation — is testable WITHOUT a live readline/PTY. The live filter in
 *  `launch.ts` is a thin adapter over this: feed it each chunk, forward `out` unless
 *  `drop`, and let it mutate `rl.cursor` (textarea caret moves) and `state.inPaste`.
 *
 *  The "swallow" branch is the fix for the "↓ cuts the lower text" bug: at the top/bottom
 *  visual row of a GENUINE multi-line draft the key is consumed (no bytes emitted) so it
 *  can't reach readline's input-history recall and wipe the message being composed. */
export function filterPromptInputChunk(
  data: string,
  rl: PromptKeyFilterRl | null,
  env: PromptKeyFilterEnv,
  state: PromptKeyFilterState,
): PromptKeyFilterResult {
  // Re-attach any byte run carried from the previous chunk (a split paste marker or a
  // dangling `\r`), then hold back a fresh trailing partial so a bracketed-paste marker —
  // or a `\r\n` straddling this read boundary — is never half-interpreted. Carrying is
  // safe: the concatenation is re-parsed next call, so a tail that turns out NOT to be a
  // marker is simply emitted one chunk later.
  data = (state.carry ?? "") + data;
  state.carry = "";
  const markerTail = pasteMarkerTailLength(data);
  if (markerTail > 0) {
    state.carry = data.slice(data.length - markerTail);
    data = data.slice(0, data.length - markerTail);
  } else if (data.endsWith("\r") && endsInPaste(data, state.inPaste)) {
    // A lone trailing `\r` INSIDE a paste may be the front of a CRLF split across chunks —
    // carry it so `\r\n` folds to ONE sentinel instead of two (no spurious blank line).
    // Outside a paste a trailing `\r` is Enter (submit) and must pass through untouched.
    state.carry = "\r";
    data = data.slice(0, data.length - 1);
  }
  // Empty-line Backspace guard: a standalone Backspace with an empty buffer is a no-op
  // that some Bun readline builds turn into a spurious `close` (hard exit) — drop it
  // before it reaches readline. Forwarded normally inside a paste or with text present.
  if (!state.inPaste && isStandaloneBackspace(data) && !(rl?.line ?? "")) {
    return { out: "", drop: true };
  }
  let out = "";
  let i = 0;
  while (i < data.length) {
    if (!state.inPaste && data.startsWith(PASTE_START, i)) { state.inPaste = true; out += PASTE_START; i += PASTE_START.length; continue; }
    if (state.inPaste && data.startsWith(PASTE_END, i)) { state.inPaste = false; out += PASTE_END; i += PASTE_END.length; continue; }
    if (state.inPaste) {
      if (data.startsWith("\r\n", i)) { out += MULTILINE_SENTINEL; i += 2; continue; }
      if (data[i] === "\n" || data[i] === "\r") { out += MULTILINE_SENTINEL; i += 1; continue; }
      // Pasted DATA: drop whole ANSI escape sequences (e.g. the `\x1b[31m` color codes in
      // copied terminal output, which would otherwise reach readline as literal escapes —
      // or leftover `[31m` text — and corrupt the box), then keep printable text + tabs and
      // drop any remaining C0 control byte. Shares `pasteEscapeLength`/the same keep rule as
      // `stripPasteEscapes` so every paste path sanitizes identically. Surrogate halves
      // (emoji) are >= " " and pass through intact.
      const esc = pasteEscapeLength(data, i);
      if (esc > 0) { i += esc; continue; }
      const ch = data[i]!;
      if (ch === "\t" || ch >= " ") out += ch;
      i += 1; continue;
    }
    const mouse = matchMouseReport(data, i);
    if (mouse > 0) { i += mouse; continue; }
    const report = matchTerminalReport(data, i);
    if (report > 0) { i += report; continue; }
    let matched = false;
    for (const seq of SHIFT_ENTER_SEQS) {
      if (data.startsWith(seq, i)) { out += MULTILINE_SENTINEL; i += seq.length; matched = true; break; }
    }
    if (matched) continue;
    // Row-aware Home/End: macOS Cmd+Left/Right and the bare Home/End keys (the Windows/
    // Linux equivalent — there is no Cmd-combo there) jump to the START/END of the
    // CURRENT VISUAL ROW, not the whole buffer. Native readline binds these to
    // beginning-of-line/end-of-line, which is only correct on a single-row draft; on a
    // multi-row draft (Shift+Enter breaks or box soft-wrap) it overshoots past the
    // current row. Checked BEFORE `matchCursorCombo` (which would otherwise rewrite
    // Cmd+Left/Right to the whole-buffer Ctrl+A/E) so this always wins when `rl` can
    // supply a cursor to compute from; without `rl` it falls through to that rewrite
    // (or, for bare Home/End, straight to readline's native binding) as a safe degrade.
    const rowEdge = ROW_HOME_SEQS.find(seq => data.startsWith(seq, i)) !== undefined ? "start"
      : ROW_END_SEQS.find(seq => data.startsWith(seq, i)) !== undefined ? "end"
      : undefined;
    if (rowEdge && rl) {
      const seq = (rowEdge === "start" ? ROW_HOME_SEQS : ROW_END_SEQS).find(s => data.startsWith(s, i))!;
      const line = rl.line ?? "";
      const winCols = Math.max(24, env.columns - 1);
      const textWidth = Math.max(1, Math.max(24, winCols) - 6);
      const cur = typeof rl.cursor === "number" ? rl.cursor : line.length;
      const expanded = line.split(MULTILINE_SENTINEL).join("\n");
      rl.cursor = rowBoundaryOffset(expanded, cur, textWidth, rowEdge);
      i += seq.length;
      continue;
    }

    const combo = matchCursorCombo(data, i);
    if (combo) { out += combo[1]; i += combo[0].length; continue; }
    // Up/Down between the box's visual rows (textarea feel) for any MULTI-ROW draft;
    // at the top/bottom edge a soft-wrapped one-liner falls through to history recall,
    // but a genuine multi-line draft swallows the key (the "↓ cuts text" fix).
    if ((data.startsWith("\u001b[", i) || data.startsWith("\u001bO", i)) && (data[i + 2] === "A" || data[i + 2] === "B")) {
      const dir = data[i + 2] === "A" ? "up" : "down";
      const line = rl?.line ?? "";
      if (shouldBoxVerticalNav(line, { slashMatchCount: env.slashMatchCount, historyPanelOpen: env.historyPanelOpen }) && rl) {
        const winCols = Math.max(24, env.columns - 1);
        const textWidth = Math.max(1, Math.max(24, winCols) - 6);
        const cur = typeof rl.cursor === "number" ? rl.cursor : line.length;
        const action = boxVerticalNavAction(line.split(MULTILINE_SENTINEL).join("\n"), line, cur, textWidth, dir);
        if (action.kind === "move") { rl.cursor = action.cursor; i += 3; continue; }
        if (action.kind === "swallow") { i += 3; continue; } // keep the multi-line draft intact
      }
      out += data.slice(i, i + 3); i += 3; continue;
    }
    // Un-bracketed multi-line paste guard: some terminals/multiplexers (a raw X11
    // primary-selection middle-click paste, certain SSH clients, or a tmux binding
    // that omits `-p`) deliver a multi-line paste as ONE stdin chunk WITHOUT the
    // bracketed-paste markers this filter otherwise relies on (PASTE_START/PASTE_END
    // above). Outside an active bracketed paste, readline treats every bare `\r`/`\n`
    // as Enter — so an un-bracketed 3-line paste submitted line 1 immediately, mid-
    // composition, and left the rest to leak in as separate prompts (the "붙여넣기가
    // 잘 안됨" bug: works for single-line/bracketed paste, corrupts multi-line paste
    // when the terminal doesn't negotiate DECSET 2004). A genuine Enter keypress is
    // always the LAST byte of its chunk — raw mode delivers one keystroke per read —
    // so a linebreak with MORE data after it in the SAME synchronous chunk can only be
    // a paste (or a scripted multi-line feed); fold it to the sentinel instead of
    // submitting, matching the bracketed-paste contract (review the whole block, then
    // press Enter once to submit). A trailing linebreak (nothing after it) keeps the
    // existing behavior below — including the opt-in lone-LF Shift+Enter rule.
    const bareBreakLen = data.startsWith("\r\n", i) ? 2 : (data[i] === "\r" || data[i] === "\n") ? 1 : 0;
    if (bareBreakLen > 0 && i + bareBreakLen < data.length) { out += MULTILINE_SENTINEL; i += bareBreakLen; continue; }
    if (env.loneLfShiftEnter && data[i] === "\n") { out += MULTILINE_SENTINEL; i += 1; continue; } // lone LF = Shift+Enter (opt-in)

    // Ctrl+L (form feed): the prompt redraw hotkey, handled on the process.stdin keypress
    // listener — never forward it to readline as a literal char.
    if (data[i] === "\u000c") { i += 1; continue; }
    out += data[i]; i += 1;
  }
  return { out, drop: false };
}

// ── Paste-merge idle gate (large-paste truncation fix) ───────────────────────────
/** Default idle window for the bracketed-paste merge fallback, in ms. */
export const PASTE_MERGE_IDLE_MS = 250;

/** Decide the paste-merge fallback when the `201~` end-marker may have been dropped.
 *
 *  A multi-line bracketed paste is buffered line-by-line and only flushed as ONE
 *  message once paste-end arrives. Terminals occasionally drop the end-marker, so
 *  `launch.ts` also arms an idle fallback. The OLD fallback was a single fixed
 *  250ms timer measured from the FIRST line — a large paste streaming in over more
 *  than 250ms tripped it mid-paste and got truncated (the rest leaked as separate
 *  prompts). This is idle-based instead: `idleMs` is the gap since the LAST buffered
 *  line, so a steadily-arriving paste keeps resetting the clock and is never cut;
 *  the fallback fires only after the stream has genuinely gone quiet.
 *
 *  Returns `fire: true` when the idle gap has reached the threshold (flush now), else
 *  `waitMs` = how long to wait before re-checking. Pure, so the timing policy is
 *  unit-testable without a live readline/PTY. */
export function pasteIdleDecision(
  idleMs: number,
  thresholdMs: number = PASTE_MERGE_IDLE_MS,
): { fire: boolean; waitMs: number } {
  if (idleMs >= thresholdMs) return { fire: true, waitMs: 0 };
  return { fire: false, waitMs: thresholdMs - idleMs };
}