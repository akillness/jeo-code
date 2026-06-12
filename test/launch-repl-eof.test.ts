import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");

/** Spawn the real REPL with the given stdin content, then close stdin (EOF).
 *  Returns the exit code (or "timeout") plus the captured stdout.
 *
 *  stdout/stderr are drained concurrently: a child that fills (then blocks on)
 *  an unread output pipe would never reach exit, so an undrained pipe could
 *  itself masquerade as the very hang this test guards against. */
async function runReplWithStdin(
  stdinContent: string,
  timeoutMs: number,
): Promise<{ code: number | "timeout"; stdout: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-repl-eof-"));
  const proc = Bun.spawn([process.execPath, CLI, "--no-tui", "--no-session", "--no-skills"], {
    cwd: dir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  proc.stdin.write(stdinContent);
  proc.stdin.end();
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const result = await Promise.race([
    proc.exited,
    new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), timeoutMs)),
  ]);
  if (result === "timeout") proc.kill();
  const stdout = await stdoutPromise;
  await stderrPromise;
  await fs.rm(dir, { recursive: true, force: true });
  return { code: result, stdout };
}

// Regression: under Bun a pending `rl.question` never settles once stdin closes,
// so the while(true) REPL loop hung FOREVER on Ctrl-D / exhausted piped input —
// `echo "..." | jeo` never returned. EOF must now behave like /exit.
test("launch REPL exits on immediate stdin EOF instead of hanging forever", async () => {
  const { code } = await runReplWithStdin("", 25_000);
  expect(code).not.toBe("timeout");
}, 35_000);

// Regression: a one-shot control slash command (e.g. `echo "/clear" | jeo`) must
// be handled synchronously — reset history and exit at EOF — and must NEVER be
// forwarded to the model as a literal prompt (which both wasted a call and could
// hang the loop). Asserting the absence of any `[step ` line proves no agent
// turn ran; the `(history cleared)` line proves the command actually took effect.
test("launch REPL drains piped commands then exits at EOF", async () => {
  const { code, stdout } = await runReplWithStdin("/clear\n", 25_000);
  expect(code).not.toBe("timeout");
  expect(stdout).toContain("(history cleared)");
  expect(stdout).not.toContain("[step ");
}, 35_000);
