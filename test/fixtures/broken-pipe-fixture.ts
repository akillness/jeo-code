// Fixture spawned by test/broken-pipe.test.ts as a REAL child process. Mirrors
// src/cli.ts's exact fatal-handler wiring (same imports, same isBrokenPipeError
// gate, same exit codes) but forces enough stdout volume (3.2MB across 64KB
// writes) to GUARANTEE a write lands after a closed-reader pipe tears down —
// jeo's actual --help output (~8KB) fits the OS pipe buffer in one atomic write
// and empirically never loses the race against a reader's process-startup
// latency (measured 0/10 across `| true` and `| head -c 0`), so this fixture
// is the only deterministic way to exercise the process-level handler.
import { isBrokenPipeError, BROKEN_PIPE_EXIT_CODE } from "../../src/util/broken-pipe";

const fatal = (err: unknown): never => {
  if (isBrokenPipeError(err)) process.exit(BROKEN_PIPE_EXIT_CODE);
  process.stderr.write(`error: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
};
process.on("uncaughtException", fatal);

const chunk = "x".repeat(65536);
for (let i = 0; i < 50; i++) {
  process.stdout.write(chunk);
}
