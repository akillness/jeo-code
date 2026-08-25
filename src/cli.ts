#!/usr/bin/env bun
import { dispatch } from "./cli/runner";
import { restoreTerminalState } from "./util/terminal-restore";
import { isBrokenPipeError, BROKEN_PIPE_EXIT_CODE } from "./util/broken-pipe";
import { writeCrashLog } from "./util/crash-log";
import pkg from "../package.json";

const APP_NAME = "jeo";
// Single source of truth: package.json. A hardcoded copy here drifted from the
// published version (`jeo update` compares the local version against the registry).
const VERSION = pkg.version;
const MIN_BUN_VERSION = "1.3.14";

if (typeof Bun !== "undefined" && Bun.semver?.order(Bun.version, MIN_BUN_VERSION) < 0) {
  process.stderr.write(
    `error: Bun >= ${MIN_BUN_VERSION} required (found v${Bun.version}). Upgrade: bun upgrade\n`,
  );
  process.exit(1);
}
process.title = APP_NAME;

// Last-resort crash net: a background `fetch()` socket error (or any stray
// rejection/throw) can tear the process down outside the try/catch below, AFTER
// the REPL has put stdin in raw mode + enabled bracketed paste. Without this the
// shell is left mute ("error printed, then input is dead"). Restore the terminal
// SYNCHRONOUSLY, print one clean line, and exit non-zero — never a raw stack dump.
//
// A downstream pipe reader that stops early (`jeo --help | head`, a vanished
// socket peer) makes the NEXT stdout/stderr write throw EPIPE from an async tick
// outside any user try/catch — that is NOT a real fatal, so it exits quietly
// (matching the shell's own SIGPIPE exit code) instead of dumping the raw error.
//
// gjc PR #3051 parity: a genuine fatal also gets a best-effort, synchronous,
// owner-only, bounded crash-log entry (secrets redacted) under jeo's config
// dir BEFORE the clean stderr line — writeCrashLog() never throws, so it can
// never mask the original error.
const fatal = (err: unknown): never => {
  restoreTerminalState();
  if (isBrokenPipeError(err)) process.exit(BROKEN_PIPE_EXIT_CODE);
  writeCrashLog(err);
  const msg = (err as Error)?.message ?? String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

try {
  const code = await dispatch(process.argv.slice(2), { appName: APP_NAME, version: VERSION });
  if (code !== 0) process.exit(code);
} catch (err) {
  // Service-readiness: never surface a raw stack trace to users; clean error + non-zero exit.
  restoreTerminalState();
  if (isBrokenPipeError(err)) process.exit(BROKEN_PIPE_EXIT_CODE);
  process.stderr.write(`error: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
}
