import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// PERSIST_MARK_KQ7F

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");

/** Spawn the real REPL with the given stdin content, then close stdin (EOF).
 *  Returns the exit code, or "timeout" if the process never exited.
 *
 *  stdout/stderr are drained concurrently: a child that fills (and then blocks
 *  on) an unread output pipe would never reach exit, so an undrained pipe could
 *  itself masquerade as the very hang this test guards against. */
async function runReplWithStdin(stdinContent: string, timeoutMs: number): Promise<number | "timeout"> {
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
  const drained = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const result = await Promise.race([
    proc.exited,
    new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), timeoutMs)),
  ]);
  if (result === "timeout") proc.kill();
  await drained;
  await fs.rm(dir, { recursive: true, force: true });
  return result;
}

// Regression: under Bun a pending `rl.question` never settles once stdin closes,
// so the while(true) REPL loop hung FOREVER on Ctrl-D / exhausted piped input —
// `echo "..." | joc` never returned. EOF must now behave like /exit.
//
// Budgets are deliberately generous: each case is a fresh `bun run` of the whole
// CLI module graph, and under full-suite load (130+ files, concurrent tmux/TUI
// tests) cold startup competes hard for CPU. In isolation the product exits in
// well under a second; the wide inner budget keeps a contended-but-correct exit
// from being misread as the (regressed) forever-hang, which is what a tight 20s
// inner timeout did under load.
test("launch REPL exits on immediate stdin EOF instead of hanging forever", async () => {
  const code = await runReplWithStdin("", 45_000);
  expect(code).not.toBe("timeout");
}, 55_000);

test("launch REPL drains piped commands then exits at EOF", async () => {
  // /clear is handled synchronously without a model call; after it the pipe is
  // exhausted and the next prompt must see EOF and exit, not wait forever.
  const code = await runReplWithStdin("/clear\n", 45_000);
  expect(code).not.toBe("timeout");
}, 55_000);
