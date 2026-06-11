import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.resolve(import.meta.dir, "../src/cli.ts");

/** Spawn the real REPL with the given stdin content, then close stdin (EOF).
 *  Returns the exit code, or "timeout" if the process never exited. */
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
  const result = await Promise.race([
    proc.exited,
    new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), timeoutMs)),
  ]);
  if (result === "timeout") proc.kill();
  await fs.rm(dir, { recursive: true, force: true });
  return result;
}

// Regression: under Bun a pending `rl.question` never settles once stdin closes,
// so the while(true) REPL loop hung FOREVER on Ctrl-D / exhausted piped input —
// `echo "..." | joc` never returned. EOF must now behave like /exit.
test("launch REPL exits on immediate stdin EOF instead of hanging forever", async () => {
  const code = await runReplWithStdin("", 20_000);
  expect(code).not.toBe("timeout");
}, 30_000);

test("launch REPL drains piped commands then exits at EOF", async () => {
  // /clear is handled synchronously without a model call; after it the pipe is
  // exhausted and the next prompt must see EOF and exit, not wait forever.
  const code = await runReplWithStdin("/clear\n", 20_000);
  expect(code).not.toBe("timeout");
}, 30_000);
