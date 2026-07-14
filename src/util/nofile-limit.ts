import { jeoEnv } from "./env";

/** Below this soft `ulimit -n`, file watching, the browser tool, image/attachment
 * workflows, and broad repo scans (`grep`/`glob`/`ast_grep` across a large tree)
 * risk opaque downstream EMFILE ("too many open files") failures on macOS — whose
 * default per-process soft limit (256, sometimes 1024) is far below Linux's typical
 * 1024-65536 default. This mirrors macOS's own `launchctl`/`ulimit` guidance
 * threshold, not an arbitrary jeo-specific number. */
export const LOW_NOFILE_THRESHOLD = 4096;

/** Read the CURRENT process's EFFECTIVE `RLIMIT_NOFILE` via `ulimit -n` (POSIX
 * shells expose no other portable way to read this from Bun/Node — there is no
 * `getrlimit` binding in either runtime). Bun raises its own process's soft limit
 * to the hard limit at startup (documented behavior, capped at 1_048_576), so a
 * spawned `sh -c "ulimit -n"` child inherits that ALREADY-RAISED value, not
 * whatever a wrapping shell's `ulimit -n` set before launching jeo — this reads
 * the value that ACTUALLY governs the process's file-descriptor budget, which is
 * arguably more useful than the pre-raise shell setting: it only reads low when
 * even Bun's own auto-raise stayed low, meaning the HARD limit itself (verifiable
 * with the shell's own `ulimit -Hn`) is the real ceiling. Returns `null` when the
 * value can't be determined (non-POSIX shell, `ulimit` unavailable, or a parse
 * failure) so the caller can fail OPEN (never warn on an unknown limit — a
 * false-positive warning on every launch would be worse than the rare missed true
 * positive). */
export function readSoftNofileLimit(): number | null {
  try {
    const result = Bun.spawnSync(["sh", "-c", "ulimit -n"]);
    if (result.exitCode !== 0) return null;
    const text = result.stdout.toString("utf-8").trim();
    // A "unlimited" soft limit reports as the literal string "unlimited" on some
    // shells — that's the OPPOSITE of the low-limit problem this check exists for.
    if (text === "unlimited") return Number.POSITIVE_INFINITY;
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Startup preflight: on macOS only (BSD's low default is the specific pain point;
 * Linux distros vary too widely in their own defaults/conventions to assume the
 * same fix applies), warn once when the EFFECTIVE file-descriptor limit (see
 * `readSoftNofileLimit`'s doc comment for what "effective" means once Bun's own
 * startup auto-raise is accounted for) is below `LOW_NOFILE_THRESHOLD`.
 * `JEO_SKIP_NOFILE_CHECK=1` opts out entirely. Returns the warning text (never
 * throws, never exits) so callers choose how/whether to print it — `null` when no
 * warning applies (limit is fine, platform isn't macOS, opted out, or the limit
 * couldn't be determined). */
export function checkNofileLimit(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  readLimit: () => number | null = readSoftNofileLimit,
): string | null {
  if (platform !== "darwin") return null;
  if (jeoEnv("SKIP_NOFILE_CHECK", env) === "1") return null;
  const limit = readLimit();
  if (limit === null || limit >= LOW_NOFILE_THRESHOLD) return null;
  return (
    `warning: file descriptor limit is low (${limit}, recommended >= ${LOW_NOFILE_THRESHOLD}). ` +
    "File watching, the browser tool, and broad repo scans may fail with \"too many open files\". Raise it with:\n" +
    "  ulimit -n 4096\n" +
    "  sudo launchctl limit maxfiles 4096 65536\n" +
    "(avoid huge values like 2147483646 — macOS commonly rejects or clamps them). " +
    "Set JEO_SKIP_NOFILE_CHECK=1 to silence this check."
  );
}
