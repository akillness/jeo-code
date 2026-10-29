import { expect, test } from "bun:test";
import { createInFlightAbortHarness, isPasteLikeInputChunk, PASTE_START } from "../src/commands/launch/input";

for (const [name, chunk, expected] of [
  ["unbracketed text batch", "local pasted prompt", true],
  ["multibyte text batch", "한🙂", true],
  ["ANSI-colored pasted batch", "\u001b[31mhello\u001b[0m", true],
  ["single Unicode keystroke", "🙂", false],
  ["terminal arrow report", "\u001b[A", false],
  ["single key with terminal controls", "\u001b[31mx\u001b[0m", false],
] as const) {
  test(`paste provenance classifies ${name}`, () => {
    expect(isPasteLikeInputChunk(chunk)).toBe(expected);
  });
}

test("after a turn is aborted, emergency input stays isolated and raw Ctrl-C still exits", () => {
  const controller = new AbortController();
  const emergency: string[] = [];
  const ordinary: string[] = [];
  let exits = 0;
  const harness = createInFlightAbortHarness({
    controller, captureEsc: true,
    stdin: { isTTY: true, isRaw: true, on() {}, off() {} },
    onBufferedInput: chunk => ordinary.push(chunk),
    onBufferedInputAfterAbort: chunk => emergency.push(chunk),
    onHardExit: () => { exits++; },
  });
  try {
    controller.abort();
    harness.handleData("/discord control off\r");
    harness.handleData(`${PASTE_START}\u0003`);
    expect(ordinary).toEqual([]);
    expect(emergency).toEqual(["/discord control off\r", `${PASTE_START}\u0003`]);
    expect(exits).toBe(0);
    harness.handleData("\u0003");
    expect(exits).toBe(1);
  } finally { harness.dispose(); }
});
