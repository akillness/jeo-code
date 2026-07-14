/**
 * A downstream pipe reader that exits early (e.g. `jeo --help | head -c 10`, or a
 * background socket peer vanishing mid-write) makes the NEXT stdout/stderr write
 * throw EPIPE from an async tick where no user try/catch is in scope — the
 * process-level `uncaughtException`/`unhandledRejection` net in cli.ts then treats
 * it as a genuine fatal error and dumps a raw stack/message. Under Bun a non-TTY
 * stdout is an fs stream over a pipe fd, so this is reachable any time jeo's output
 * is piped into a command that stops reading (`| head`, `| true`, a closed socket).
 *
 * `isBrokenPipeError` lets the process-level handler distinguish this class from a
 * REAL fatal so it can exit quietly instead of dumping. 141 = 128 + SIGPIPE, matching
 * what a shell reports for a SIGPIPE-killed producer in a `foo | head` pipeline —
 * consistent with what the reader side of the SAME pipeline already sees.
 */
export const BROKEN_PIPE_EXIT_CODE = 141;

export function isBrokenPipeError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}
