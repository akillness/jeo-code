#!/usr/bin/env bun
import { dispatch } from "./cli/runner";

const APP_NAME = "joc";
const VERSION = "0.1.0";
const MIN_BUN_VERSION = "1.3.14";

if (typeof Bun !== "undefined" && Bun.semver?.order(Bun.version, MIN_BUN_VERSION) < 0) {
  process.stderr.write(
    `error: Bun >= ${MIN_BUN_VERSION} required (found v${Bun.version}). Upgrade: bun upgrade\n`,
  );
  process.exit(1);
}
process.title = APP_NAME;

try {
  const code = await dispatch(process.argv.slice(2), { appName: APP_NAME, version: VERSION });
  if (code !== 0) process.exit(code);
} catch (err) {
  // Service-readiness: never surface a raw stack trace to users; clean error + non-zero exit.
  process.stderr.write(`error: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
}
