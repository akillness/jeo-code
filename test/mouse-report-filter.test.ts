import { test, expect } from "bun:test";
import { matchMouseReport, stripMouseReports, queuePromptInputChunk, type PromptInputQueue } from "../src/commands/launch";

// `jeo --tmux` enables tmux `mouse on`; a click/scroll can still deliver a mouse-report
// escape to stdin even though jeo never requests mouse mode. Without filtering, the
// report's payload bytes were typed straight into the prompt (the "값 입력" corruption).

test("matchMouseReport measures an X10 (1000) report: ESC[M + 3 bytes", () => {
  // ESC [ M then button=' ' x='!' y='!' (the bytes that leaked into the box)
  const seq = "\u001b[M !!";
  expect(matchMouseReport(seq, 0)).toBe(seq.length); // 6
  expect(matchMouseReport("x" + seq, 0)).toBe(0);    // only at a sequence start
  expect(matchMouseReport("x" + seq, 1)).toBe(seq.length);
});

test("matchMouseReport measures an SGR (1006) press and release: ESC[<b;x;y(M|m)", () => {
  expect(matchMouseReport("\u001b[<0;33;14M", 0)).toBe("\u001b[<0;33;14M".length);
  expect(matchMouseReport("\u001b[<0;33;14m", 0)).toBe("\u001b[<0;33;14m".length);
});

test("matchMouseReport consumes an unterminated SGR tail (split across chunks)", () => {
  const tail = "\u001b[<0;33;1"; // terminator landed in the next chunk
  expect(matchMouseReport(tail, 0)).toBe(tail.length);
});

test("matchMouseReport returns 0 for non-mouse input", () => {
  expect(matchMouseReport("hello", 0)).toBe(0);
  expect(matchMouseReport("\u001b[200~", 0)).toBe(0); // paste start, not mouse
  expect(matchMouseReport("\u001b[A", 0)).toBe(0);    // arrow up, not mouse
});

test("stripMouseReports removes reports but keeps surrounding text", () => {
  expect(stripMouseReports("ab\u001b[M !!cd")).toBe("abcd");
  expect(stripMouseReports("\u001b[<0;1;1Mhi\u001b[<0;1;1m")).toBe("hi");
  expect(stripMouseReports("plain text")).toBe("plain text");
});

test("live-turn drain (queuePromptInputChunk) never injects mouse payload bytes", () => {
  const q: PromptInputQueue = { pendingLines: [], partial: "", pastedLines: [], inPaste: false };
  // A wheel/click report buffered mid-turn must not leave '[M' / digits in the draft.
  queuePromptInputChunk(q, "hi\u001b[M !!\u001b[<0;9;4Mthere");
  expect(q.partial).toBe("hithere");
});
// tmux runs `jeo --tmux` with `mouse on`, so a real session can deliver a continuous
// FLOOD of mouse-report escapes to stdin while idle. The filter must consume them with
// zero accumulation — otherwise the prompt queue (and the bun process RSS) would grow
// unboundedly under tmux, the slowdown this guards against.
test("mouse-report flood leaves the prompt queue bounded (no tmux memory growth)", () => {
  const q: PromptInputQueue = { pendingLines: [], partial: "", pastedLines: [], inPaste: false };
  for (let i = 0; i < 100_000; i++) {
    queuePromptInputChunk(q, `\u001b[<35;${(i % 200) + 1};${(i % 50) + 1}M`); // SGR mouse move
  }
  expect(q.partial).toBe("");
  expect(q.pendingLines.length).toBe(0);
  expect(q.pastedLines.length).toBe(0);
  // A single real keystroke after the flood still lands cleanly.
  queuePromptInputChunk(q, "x");
  expect(q.partial).toBe("x");
});
