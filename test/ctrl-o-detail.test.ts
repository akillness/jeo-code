import { test, expect } from "bun:test";
import { createInFlightAbortHarness, PASTE_START } from "../src/commands/launch";

const fakeStdin = () => ({
  isTTY: true,
  isRaw: false,
  setRawMode(_raw: boolean) {},
  resume() {},
  on() {},
  off() {},
});

test("mid-turn Ctrl+O (\\u000f) fires onDetailKey instead of being swallowed into buffered input", () => {
  let detail = 0;
  const buffered: string[] = [];
  const h = createInFlightAbortHarness({
    captureEsc: true,
    stdin: fakeStdin(),
    onDetailKey: () => { detail++; },
    onBufferedInput: chunk => buffered.push(chunk),
  });
  try {
    h.handleData("\u000f");
    expect(detail).toBe(1);
    expect(buffered).toEqual([]); // the byte must NOT leak into the next prompt
    expect(h.controller.signal.aborted).toBe(false); // and must not cancel the run
  } finally {
    h.dispose();
  }
});

test("\\u000f embedded in data or paste is DATA, never the detail view", () => {
  let detail = 0;
  const buffered: string[] = [];
  let pasting = false;
  const h = createInFlightAbortHarness({
    captureEsc: true,
    stdin: fakeStdin(),
    onDetailKey: () => { detail++; },
    onBufferedInput: chunk => buffered.push(chunk),
    pasteActive: () => pasting,
  });
  try {
    h.handleData("ab\u000fcd"); // embedded in a typed/streamed chunk
    h.handleData(PASTE_START + "x\u000fy"); // paste marker chunk
    pasting = true;
    h.handleData("\u000f"); // mid-paste chunk: exact byte but still paste DATA
    expect(detail).toBe(0);
    expect(buffered).toEqual(["ab\u000fcd", PASTE_START + "x\u000fy", "\u000f"]);
  } finally {
    h.dispose();
  }
});

test("without an onDetailKey hook a lone \\u000f stays inert (no abort, no buffer)", () => {
  const buffered: string[] = [];
  const h = createInFlightAbortHarness({
    captureEsc: true,
    stdin: fakeStdin(),
    onBufferedInput: chunk => buffered.push(chunk),
  });
  try {
    h.handleData("\u000f");
    expect(h.controller.signal.aborted).toBe(false);
    expect(buffered).toEqual([]);
  } finally {
    h.dispose();
  }
});
