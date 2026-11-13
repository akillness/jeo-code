/**
 * Process-group-safe shell spawn for background jobs and monitors.
 *
 * A bare `bash -c <command>` is its own process-group leader (`detached`), but the
 * moment that shell is reaped its PGID becomes reusable by an unrelated process. Any
 * later `kill(-pgid)` could then hit a stranger's group. So on POSIX the registries
 * never signal a group whose leader has been reaped, and the user's command runs as
 * a CHILD of a small "lease holder" shell that stays alive — keeping the PGID pinned
 * (the kernel never reuses a pid/pgid while a group member, zombies included, exists)
 * — until the registry explicitly `release()`s it:
 *
 *   - exit status travels through a private status file (stdout/stderr EOF cannot carry
 *     it, and a descendant holding those pipes would delay it indefinitely; Bun's extra
 *     stdio pipes are unreliable on Linux, so no fd beyond 0-2 is used);
 *   - the holder closes its own stdout/stderr first, so only real descendants keep
 *     the output pipes open;
 *   - release is "stdin closed"; the holder only reads it after the command exits, so a
 *     registry that dies does NOT clean up a still-running command (same as before the lease).
 *
 * `killGroup()` is the only place a group signal is sent. It refuses once the holder
 * is gone or released (`"unpinned"`), so callers report an unconfirmed termination
 * instead of signalling a possibly reused PGID. A delivered SIGKILL reaches every
 * member of the pinned group atomically; descendants that left the group (`setsid`)
 * are not reachable and show up as output pipes that stay open; a descendant that left
 * the group AND closed both pipes is undetectable, so EOF alone never proves it ended.
 *
 * Residual window (cannot be closed from JS): the holder dying — only by an external
 * or in-command group/SIGKILL — and its pid wrapping around before the exit event
 * reaches this process.
 *
 * Windows has no process groups here: `killGroup()` is `"unsupported"` and callers
 * must keep the job unresolved.
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import { resolvePosixTool } from "../util/posix-tools";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";

export interface ShellReader {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

export type GroupKill = "delivered" | "unpinned" | "unsupported" | { error: unknown };

export interface LeasedShell {
  readonly stdout: ShellReader;
  readonly stderr: ShellReader;
  /** The command's exit code; `null` when the lease holder ended without reporting one. */
  readonly exit: Promise<number | null>;
  /** Settles once the OS process owning the group (or the direct shell) is reaped. */
  readonly reaped: Promise<void>;
  /** SIGKILL the pinned group; never signals an unpinned or released group. */
  killGroup(): GroupKill;
  /** Best-effort single-process kill; proves nothing about descendants. */
  killDirect(): void;
  /** Let the holder exit. After this, `killGroup()` reports `"unpinned"`. */
  release(): void;
  /** Free pipe handles after the process is reaped. */
  dispose(): void;
}

/** Resolve true if `promise` settles within `ms`, else false. */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// $1 = command, $2 = status file, $3 = caller's BASH_ENV. fd0 is the release pipe and never reaches the
// command. The holder's own stderr goes to /dev/null (its "Killed" job notices are not command output) and
// BASH_ENV is withheld from the holder itself, so a startup file runs once, inside the command's shell.
const HOLDER_SCRIPT = [
  "exec 9>&2 2>/dev/null",
  'if [ -n "$3" ]; then export BASH_ENV="$3"; fi',
  'bash -c "$1" bash 0</dev/null 2>&9 9>&-',
  "c=$?",
  "exec 1>&- 9>&-",
  "printf '%s\\n' \"$c\" > \"$2\" || exit \"$c\"", // unreportable: end the lease instead of waiting forever
  "read -r _",
  'exit "$c"',
].join("\n");

const STATUS_POLL_MIN_MS = 5;
const STATUS_POLL_MAX_MS = 50;

/** Optional environment is the caller's captured effective environment, not a deferred inheritance. */
export function spawnLeasedShell(command: string, cwd: string, env?: Readonly<Record<string, string>>): LeasedShell {
  return process.platform === "win32" ? spawnDirect(command, cwd, env) : spawnLeased(command, cwd, env);
}

function spawnDirect(command: string, cwd: string, env?: Readonly<Record<string, string>>): LeasedShell {
  const proc = Bun.spawn([resolvePosixTool("bash"), "-c", command], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout.getReader();
  const stderr = proc.stderr.getReader();
  const reaped = proc.exited.then(() => undefined);
  return {
    stdout, stderr,
    exit: proc.exited,
    reaped,
    killGroup: () => "unsupported",
    killDirect: () => { try { proc.kill(9); } catch { /* best effort only */ } },
    release: () => {},
    dispose: () => { void stdout.cancel().catch(() => {}); void stderr.cancel().catch(() => {}); },
  };
}

function spawnLeased(command: string, cwd: string, environment?: Readonly<Record<string, string>>): LeasedShell {
  // node:child_process reports a bad cwd inconsistently across Bun versions (an 'error' event on
  // some, a holder that exits 127 on others); check up front so start() fails like Bun.spawn did.
  if (!fs.statSync(cwd).isDirectory()) throw new Error(`ENOTDIR: not a directory, stat '${cwd}'`);
  const leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "jeo-lease-"));
  const statusFile = path.join(leaseDir, "status");
  const cleanup = () => { try { fs.rmSync(leaseDir, { recursive: true, force: true }); } catch { /* best effort only */ } };
  const { BASH_ENV: userBashEnv, ...env } = environment ?? process.env;
  let child: cp.ChildProcess;
  try {
    child = cp.spawn("bash", ["-c", HOLDER_SCRIPT, "bash", command, statusFile, userBashEnv ?? ""], {
      cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) { cleanup(); throw error; }
  child.on("error", () => {});
  if (child.pid === undefined) { cleanup(); throw new Error('Executable not found in $PATH: "bash"'); }
  const pid = child.pid;
  const stdin = child.stdin!;
  stdin.on("error", () => {});

  let gone = false;
  let released = false;
  let delivered = false;
  const reaped = new Promise<void>(resolve => {
    child.once("exit", () => { gone = true; resolve(); });
    child.once("error", () => { gone = true; resolve(); });
  });

  const readStatus = (): number | null => {
    try {
      const match = /^(\d{1,3})\n$/.exec(fs.readFileSync(statusFile, "utf8"));
      return match ? Number(match[1]) : null;
    } catch { return null; }
  };
  // Poll with backoff: no fd beyond 0-2 and no fs.watch, both unreliable on Bun/Linux. The holder
  // writes the file only after the command exits and stays alive until released, so a reported
  // status always comes from a pinned group; none by the time the holder is reaped means a lost lease.
  const exit = new Promise<number | null>(resolve => {
    let delay = STATUS_POLL_MIN_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (code: number | null) => { clearTimeout(timer); resolve(code); };
    const tick = () => {
      const code = readStatus();
      if (code !== null) return settle(code);
      if (gone) return settle(null);
      delay = Math.min(delay * 2, STATUS_POLL_MAX_MS);
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    void reaped.then(() => { clearTimeout(timer); tick(); });
  });

  const reader = (stream: Readable): ShellReader => {
    const web = Readable.toWeb(stream).getReader();
    return { read: () => web.read(), cancel: () => web.cancel() };
  };
  const stdout = reader(child.stdout!);
  const stderr = reader(child.stderr!);

  return {
    stdout, stderr, exit, reaped,
    killGroup(): GroupKill {
      if (delivered) return "delivered"; // the whole group already holds SIGKILL
      if (gone || released || child.exitCode !== null || child.signalCode !== null) return "unpinned";
      try { process.kill(-pid, "SIGKILL"); delivered = true; return "delivered"; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "unpinned" : { error }; }
    },
    killDirect() { try { child.kill("SIGKILL"); } catch { /* best effort only */ } },
    release() { released = true; stdin.end(); },
    dispose() {
      void stdout.cancel().catch(() => {});
      void stderr.cancel().catch(() => {});
      stdin.destroy();
      cleanup();
    },
  };
}
