// Self-contained git-backed REPL slash handlers. Each returns the exact line
// array the inline handler used to `console.log`, so the git side effects and
// their guard rails stay verifiable against a throwaway repo without driving the
// whole launch REPL. State comes in explicitly (cwd) — no closure capture.

/**
 * `/undo` — revert the most recent commit, but ONLY when jeo made it (the
 * `[jeo] auto-commit:` message prefix). Refuses to touch human commits or
 * non-git trees. Performs the `git reset --hard HEAD~1` as a side effect and
 * returns the status lines to print.
 */
export function handleUndoSlash(cwd: string): string[] {
  try {
    const logRes = Bun.spawnSync(["git", "log", "-1", "--pretty=%B"], { cwd, stdout: "pipe", stderr: "ignore" });
    if (logRes.exitCode !== 0) {
      return ["! undo failed: could not read git log (not a git repo?)"];
    }
    const msg = logRes.stdout.toString().trim();
    if (!msg.startsWith("[jeo] auto-commit:")) {
      return ["! the last commit was not made by jeo (no '[jeo] auto-commit:' prefix). Use git manually to revert."];
    }
    const resetRes = Bun.spawnSync(["git", "reset", "--hard", "HEAD~1"], { cwd, stdout: "pipe", stderr: "pipe" });
    if (resetRes.exitCode === 0) {
      return ["(undid the last jeo auto-commit and restored the working tree)"];
    }
    return [`! undo failed: ${resetRes.stderr.toString().trim()}`];
  } catch (err) {
    return [`! undo failed: ${(err as Error).message}`];
  }
}
