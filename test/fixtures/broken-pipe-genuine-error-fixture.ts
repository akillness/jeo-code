// Control fixture for test/broken-pipe.test.ts: a genuine (non-EPIPE) uncaught
// exception through the SAME fatal-handler shape as src/cli.ts and
// broken-pipe-fixture.ts — proves the isBrokenPipeError gate never swallows a
// real crash (must still dump + exit 1, not silently exit 141).
import { isBrokenPipeError, BROKEN_PIPE_EXIT_CODE } from "../../src/util/broken-pipe";

const fatal = (err: unknown): never => {
  if (isBrokenPipeError(err)) process.exit(BROKEN_PIPE_EXIT_CODE);
  process.stderr.write(`error: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
};
process.on("uncaughtException", fatal);

throw new Error("genuine failure, not a pipe issue");
