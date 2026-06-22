#!/usr/bin/env bun
import { dispatch } from "./cli/runner";
import { restoreTerminalState } from "./util/terminal-restore";
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
const fatal = (err: unknown): never => {
  restoreTerminalState();
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
  fatal(err);
}
