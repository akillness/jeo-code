import { test, expect } from "bun:test";
import { isBrokenPipeError, BROKEN_PIPE_EXIT_CODE } from "../src/util/broken-pipe";

test("isBrokenPipeError: matches a real EPIPE error object (code === 'EPIPE')", () => {
  const err = Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });
  expect(isBrokenPipeError(err)).toBe(true);
});

test("isBrokenPipeError: matches ERR_STREAM_DESTROYED (Node/Bun stream torn down mid-write)", () => {
  const err = Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" });
  expect(isBrokenPipeError(err)).toBe(true);
});

test("isBrokenPipeError: false for an unrelated error code", () => {
  const err = Object.assign(new Error("boom"), { code: "ENOENT" });
  expect(isBrokenPipeError(err)).toBe(false);
});

test("isBrokenPipeError: false for a plain Error with no .code at all", () => {
  expect(isBrokenPipeError(new Error("boom"))).toBe(false);
});

test("isBrokenPipeError: false for non-object/null/undefined inputs (never throws)", () => {
  expect(isBrokenPipeError(null)).toBe(false);
  expect(isBrokenPipeError(undefined)).toBe(false);
  expect(isBrokenPipeError("EPIPE")).toBe(false);
  expect(isBrokenPipeError(42)).toBe(false);
});

test("BROKEN_PIPE_EXIT_CODE is 141 (128 + SIGPIPE), matching the shell's own SIGPIPE exit code", () => {
  expect(BROKEN_PIPE_EXIT_CODE).toBe(141);
});

// End-to-end regression: spawns a REAL child process (test/fixtures/broken-pipe-fixture.ts,
// which imports the actual isBrokenPipeError/BROKEN_PIPE_EXIT_CODE from src/util/broken-pipe
// and mirrors src/cli.ts's exact fatal-handler wiring) piped into `true` — a reader that
// exits without reading a single byte, forcing EPIPE on the fixture's very first write.
// `${PIPESTATUS[0]}` (NOT `$?`, which would report `true`'s exit code) captures the
// fixture process's own exit status. This proves the process-level uncaughtException
// wiring for real, not just the pure isBrokenPipeError predicate tested above — the
// fixture exists because jeo's actual --help output (~8KB) reliably fits the OS pipe
// buffer's single atomic write and never loses this race (measured 0/10 empirically).
test("real child process: EPIPE on a broken-pipe write exits quietly with exactly 141, no raw dump", async () => {
  const fixturePath = `${import.meta.dir}/fixtures/broken-pipe-fixture.ts`;
  const proc = Bun.spawn(
    ["bash", "-c", `bun ${JSON.stringify(fixturePath)} | true; echo "EXIT=${"$"}{PIPESTATUS[0]}"`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  expect(stdout).toContain("EXIT=141");
  expect(stderr).toBe("");
});

// Sanity control: a non-broken-pipe fatal (genuine uncaught exception) must still
// dump the error and exit 1 — the EPIPE gate must never swallow a real crash.
// Uses a static fixture (never written at test time — tests must not mutate the
// working tree) sharing the same fatal-handler shape as the fixture above.
test("real child process: a genuine (non-EPIPE) uncaught exception still dumps and exits 1", async () => {
  const fixturePath = `${import.meta.dir}/fixtures/broken-pipe-genuine-error-fixture.ts`;
  const proc = Bun.spawn(["bun", fixturePath], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  expect(exitCode).toBe(1);
  expect(stderr).toContain("genuine failure, not a pipe issue");
});
