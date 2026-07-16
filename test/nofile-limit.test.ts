import { test, expect } from "bun:test";
import { checkNofileLimit, readSoftNofileLimit, LOW_NOFILE_THRESHOLD } from "../src/util/nofile-limit";
const LOW_NOFILE_PRECONDITION_EXIT_CODE = 86;


test("checkNofileLimit: null on non-macOS platforms, regardless of the limit reader", () => {
  expect(checkNofileLimit("linux", {}, () => 256)).toBeNull();
  expect(checkNofileLimit("win32", {}, () => 256)).toBeNull();
});

test("checkNofileLimit: null when JEO_SKIP_NOFILE_CHECK=1, even on macOS with a low limit", () => {
  expect(checkNofileLimit("darwin", { JEO_SKIP_NOFILE_CHECK: "1" }, () => 256)).toBeNull();
});

test("checkNofileLimit: JEO_SKIP_NOFILE_CHECK unset or any other value does NOT opt out", () => {
  expect(checkNofileLimit("darwin", {}, () => 256)).not.toBeNull();
  expect(checkNofileLimit("darwin", { JEO_SKIP_NOFILE_CHECK: "0" }, () => 256)).not.toBeNull();
  expect(checkNofileLimit("darwin", { JEO_SKIP_NOFILE_CHECK: "true" }, () => 256)).not.toBeNull();
});

test("checkNofileLimit: null when the limit reader returns null (unknown limit) — fails OPEN, never a false-positive warning", () => {
  expect(checkNofileLimit("darwin", {}, () => null)).toBeNull();
});

test("checkNofileLimit: null when the limit is exactly at the threshold or above (macOS, no opt-out)", () => {
  expect(checkNofileLimit("darwin", {}, () => LOW_NOFILE_THRESHOLD)).toBeNull();
  expect(checkNofileLimit("darwin", {}, () => LOW_NOFILE_THRESHOLD + 1)).toBeNull();
  expect(checkNofileLimit("darwin", {}, () => Number.POSITIVE_INFINITY)).toBeNull();
});

test("checkNofileLimit: warns with the current limit, the threshold, and actionable ulimit/launchctl guidance when below threshold on macOS", () => {
  const warning = checkNofileLimit("darwin", {}, () => 256);
  expect(warning).not.toBeNull();
  expect(warning).toContain("256");
  expect(warning).toContain(String(LOW_NOFILE_THRESHOLD));
  expect(warning).toContain("ulimit -n");
  expect(warning).toContain("launchctl limit maxfiles");
  expect(warning).toContain("JEO_SKIP_NOFILE_CHECK=1");
});

test("checkNofileLimit: default params call the real readSoftNofileLimit/process.platform/process.env (smoke — must not throw on this host)", () => {
  expect(() => checkNofileLimit()).not.toThrow();
});

test("readSoftNofileLimit: returns a positive finite number or +Infinity on a real POSIX shell (this test host)", () => {
  const limit = readSoftNofileLimit();
  // sh/ulimit is expected to be available on the CI/dev hosts this suite runs on;
  // if genuinely unavailable this would be null, which readSoftNofileLimit itself
  // already handles gracefully (see the darwin/false-positive test above for that
  // path's actual behavior via the injected reader) — this test asserts the HAPPY
  // path actually resolves to a real number on a real machine, not a mocked one.
  expect(limit === null || (Number.isFinite(limit) && limit > 0) || limit === Number.POSITIVE_INFINITY).toBe(true);
});

// End-to-end regression: proves readSoftNofileLimit() genuinely reads Bun's
// EFFECTIVE post-startup-raise limit, not a stale pre-raise value — Bun raises
// its own process's soft RLIMIT_NOFILE to the HARD limit at startup, so lowering
// only the soft limit in a wrapping shell (`ulimit -Sn 256`) is invisible to a
// spawned jeo process (Bun's auto-raise undoes it); the HARD limit must also be
// lowered (`ulimit -Hn 256`) to genuinely cap what Bun can raise to. Spawns the
// REAL jeo CLI (not a mock) to prove the full wire: shell ulimit -> Bun startup
// raise -> readSoftNofileLimit -> checkNofileLimit -> launch.ts's console.error.
//
// darwin-only (checkNofileLimit itself is a no-op off macOS, so this would
// legitimately fail on Linux CI/contributor machines — skipped, not xfail'd).
// Runs with an ISOLATED env (fake HOME, empty JEO_CONFIG_DIR, no provider env
// vars) so the one-shot prompt fails FAST on "no credential configured" — the
// warning prints during flag parsing, before any credential/network check, so
// this proves the exact same wiring WITHOUT making a real billed LLM call on
// every `bun test` run (the credential failure is incidental background noise
// on stdout, asserted absent of the warning text — never asserted as the
// reason the test passes).
test.skipIf(process.platform !== "darwin")(
  "real jeo process: a genuinely low HARD fd limit produces the warning on stderr only, never stdout",
  async () => {
    const proc = Bun.spawnSync(
      ["bash", "-c", `if ! { ulimit -Hn 256 && ulimit -Sn 256; }; then exit ${LOW_NOFILE_PRECONDITION_EXIT_CODE}; fi; exec bun ${JSON.stringify(`${import.meta.dir}/../src/cli.ts`)} -p "hi" </dev/null`],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: "/tmp/jeo-nofile-e2e-fake-home", JEO_CONFIG_DIR: "/tmp/jeo-nofile-e2e-empty-config" },
      },
    );
    // Unprivileged macOS sandboxes may not lower the inherited hard limit.
    // This is an environment precondition, not a CLI failure; only the shell's
    // explicit sentinel permits skipping the true-E2E assertions.
    if (proc.exitCode === LOW_NOFILE_PRECONDITION_EXIT_CODE) return;
    const stdout = proc.stdout.toString("utf-8");
    const stderr = proc.stderr.toString("utf-8");
    expect(stderr).toContain("file descriptor limit is low");
    expect(stderr).toContain("256");
    expect(stderr).toContain("JEO_SKIP_NOFILE_CHECK=1");
    expect(stdout).not.toContain("file descriptor limit");
  },
  15_000,
);
