import { test, expect, afterEach } from "bun:test";
import { restoreTerminalState, resetTerminalRestoreLatch } from "../src/util/terminal-restore";

type Stdin = NodeJS.ReadStream & { isRaw?: boolean; setRawMode?(r: boolean): void };

function withStdio(
  stdin: Partial<Stdin> & { isTTY?: boolean },
  stdoutIsTTY: boolean,
  run: () => void,
): void {
  const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const realStdoutTTY = process.stdout.isTTY;
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  (process.stdout as { isTTY?: boolean }).isTTY = stdoutIsTTY;
  try {
    run();
  } finally {
    if (realStdin) Object.defineProperty(process, "stdin", realStdin);
    (process.stdout as { isTTY?: boolean }).isTTY = realStdoutTTY;
  }
}

afterEach(() => resetTerminalRestoreLatch());

test("disables raw mode when stdin is a raw TTY", () => {
  const calls: boolean[] = [];
  withStdio(
    { isTTY: true, isRaw: true, setRawMode: (r: boolean) => calls.push(r) },
    false,
    () => restoreTerminalState(),
  );
  expect(calls).toEqual([false]);
});

test("leaves raw mode alone when stdin was never raw", () => {
  const calls: boolean[] = [];
  withStdio(
    { isTTY: true, isRaw: false, setRawMode: (r: boolean) => calls.push(r) },
    false,
    () => restoreTerminalState(),
  );
  expect(calls).toEqual([]);
});

test("is idempotent across a single process lifetime", () => {
  const calls: boolean[] = [];
  withStdio(
    { isTTY: true, isRaw: true, setRawMode: (r: boolean) => calls.push(r) },
    false,
    () => {
      restoreTerminalState();
      restoreTerminalState();
    },
  );
  expect(calls).toEqual([false]); // second call short-circuits on the latch
});

test("survives a missing setRawMode without throwing", () => {
  expect(() =>
    withStdio({ isTTY: true, isRaw: true }, false, () => restoreTerminalState()),
  ).not.toThrow();
});
