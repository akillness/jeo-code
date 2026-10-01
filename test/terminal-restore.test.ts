import { test, expect, afterEach } from "bun:test";
import { restoreTerminalState, resetTerminalRestoreLatch } from "../src/util/terminal-restore";
import { overrideProperty } from "./stdio-override";

type Stdin = NodeJS.ReadStream & { isRaw?: boolean; setRawMode?(r: boolean): void };

function withStdio(
  stdin: Partial<Stdin> & { isTTY?: boolean },
  stdoutIsTTY: boolean,
  run: () => void,
): void {
  // Both swaps happen INSIDE the try: if the second one throws, the first is still
  // undone — a stranded fake stdin (no `.on`) would break every later test file.
  const restores: Array<() => void> = [];
  try {
    restores.push(overrideProperty(process, "stdin", stdin));
    restores.push(overrideProperty(process.stdout, "isTTY", stdoutIsTTY));
    run();
  } finally {
    for (const restore of restores.reverse()) restore();
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
