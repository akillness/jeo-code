import { writeSync } from "node:fs";

// Restoring the terminal on an ABNORMAL exit (uncaught exception, unhandled
// rejection, fatal error) is what keeps the user's shell usable afterwards. The
// failure mode this guards against: a background `fetch()` stream rejects after a
// turn ends, Bun reports it as an unhandled rejection and tears the process down
// WITHOUT running the readline cleanup — leaving stdin in raw mode and bracketed
// paste enabled, so the shell echoes nothing and never submits a line (the
// "prints an error and then input is dead" bug).
//
// `process.stdout.write` is async/buffered and is NOT guaranteed to flush from an
// `exit` handler or a crashing tick, so the escape sequences are emitted with the
// SYNCHRONOUS `writeSync(1, …)` — the only reliable way to hand the terminal back
// in a sane line-discipline before the process disappears. `setRawMode(false)` is
// a synchronous ioctl and is safe to call in the same context.

type RawCapableStdin = NodeJS.ReadStream & { isRaw?: boolean; setRawMode?(raw: boolean): void };

let restored = false;

/**
 * Synchronously return the terminal to cooked input, a visible cursor, and
 * bracketed-paste OFF. Idempotent and safe to call from crash/exit paths.
 */
export function restoreTerminalState(): void {
  if (restored) return;
  restored = true;
  const stdin = process.stdin as RawCapableStdin;
  try {
    if (stdin.isTTY && stdin.isRaw && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
  } catch { /* terminal already gone */ }
  try {
    // \x1b[?2004l = disable bracketed paste, \x1b[?25h = show cursor.
    if (process.stdout.isTTY) writeSync(1, "\x1b[?2004l\x1b[?25h");
  } catch { /* terminal already gone */ }
}

/** Test-only: reset the idempotency latch so a fresh restore can be observed. */
export function resetTerminalRestoreLatch(): void {
  restored = false;
}
