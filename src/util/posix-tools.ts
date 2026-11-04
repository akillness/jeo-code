/**
 * POSIX tool resolution for Windows hosts.
 *
 * `Bun.spawn(["bash"|"grep"|"find", …])` resolves from PATH, where Windows
 * ships imposters ahead of Git for Windows:
 *  - `C:\Windows\System32\bash.exe` launches WSL — Windows paths
 *    (`C:\Users\…`) do not exist inside it and caller env vars are dropped.
 *  - `C:\Windows\System32\find.exe` is the legacy DOS FIND (substring
 *    filter), not POSIX find.
 *
 * Resolve to real Git for Windows binaries instead, with an env override.
 * Non-Windows platforms pass the bare name through unchanged.
 */
import { existsSync } from "node:fs";
import path from "node:path";

export type PosixTool = "bash" | "grep" | "find";

export interface ResolveOptions {
  /** Platform override for tests (default: process.platform). */
  readonly platform?: NodeJS.Platform;
  /** Env override for tests (default: process.env). */
  readonly env?: Record<string, string | undefined>;
  /** File-existence probe override for tests (default: fs.existsSync). */
  readonly exists?: (p: string) => boolean;
}

/** Candidate absolute paths for a tool, in preference order. */
export function candidatePaths(
  tool: PosixTool,
  env: Record<string, string | undefined>
): string[] {
  const override = env[`JOC_${tool.toUpperCase()}_PATH`];
  const roots = [
    env["ProgramFiles"] && path.join(env["ProgramFiles"], "Git"),
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Git"),
    env["LOCALAPPDATA"] && path.join(env["LOCALAPPDATA"], "Programs", "Git"),
  ].filter((r): r is string => Boolean(r));
  // bash lives in both bin/ and usr/bin/; grep/find only in usr/bin/.
  const subdirs = tool === "bash" ? ["bin", path.join("usr", "bin")] : [path.join("usr", "bin")];
  return [
    ...(override ? [override] : []),
    ...roots.flatMap(root => subdirs.map(sub => path.join(root, sub, `${tool}.exe`))),
  ];
}

const cache = new Map<PosixTool, string>();

/**
 * Resolve `tool` to a Unix-semantics executable. Returns an absolute Git
 * for Windows path when found, otherwise the bare name (PATH fallback).
 */
export function resolvePosixTool(tool: PosixTool, opts: ResolveOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return tool;
  const injected = opts.env || opts.exists;
  if (!injected) {
    const hit = cache.get(tool);
    if (hit) return hit;
  }
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const found = candidatePaths(tool, env).find(c => exists(c)) ?? tool;
  if (!injected) cache.set(tool, found);
  return found;
}
