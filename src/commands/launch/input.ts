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
 *  partial stays editable, and control bytes (incl. any stray ESC from copied ANSI
 *  text) are dropped instead of being interpreted as keystrokes. */
function feedPasteBody(state: PromptInputQueue, body: string): boolean {
  if (!body) return false;
  let accepted = false;
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
  return /^[/$]/.test(t) ? "command" : "steer";
}
