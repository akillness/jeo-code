import * as path from "node:path";
import * as fs from "node:fs";
import { type LaunchFlags } from "./flags";

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}

function tmuxSafeNamePart(input: string, max = 32): string {
  const safe = input.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "value";
  if (safe.length <= max) return safe;
  return `${safe.slice(0, Math.max(1, max - 7))}-${hashString(input)}`;
}

function tmuxRuntimeSuffix(flags: LaunchFlags): string {
  const parts: string[] = [];
  if (flags.provider) parts.push(`provider-${flags.provider}`);
  if (flags.model) parts.push(`model-${tmuxSafeNamePart(flags.model)}`);
  else if (flags.modelRole) parts.push(flags.modelRole);
  if (flags.thinking) parts.push(`think-${flags.thinking}`);
  // Only an EXPLICIT --max-steps cap names the session; the dynamic default (0) adds nothing.
  if (flags.maxSteps > 0) parts.push(`steps-${flags.maxSteps}`);
  if (parts.length === 0) return "";
  const joined = parts.join("-");
  const suffix = joined.length <= 72 ? joined : `${joined.slice(0, 65)}-${hashString(joined)}`;
  return `-${suffix}`;
}

/**
 * Base tmux session name for `jeo --tmux`. Keyed on the working DIRECTORY (not just the
 * git branch) so two different projects/worktrees on the same branch (e.g. `main`)
 * never share a base. {@link uniqueTmuxSessionName} then makes each concurrent invocation
 * fully independent, so a second `jeo --tmux` never attaches to (and mirrors) the first.
 */
export function tmuxSessionName(cwd: string, branch: string, flags: LaunchFlags): string {
  const dirTag = `${tmuxSafeNamePart(path.basename(cwd) || "root", 16)}-${hashString(cwd)}`;
  const base = branch ? `jeo-${branch}-${dirTag}` : `jeo-${dirTag}`;
  return base + tmuxRuntimeSuffix(flags);
}

/**
 * Count uncommitted git entries for the `⑂ <branch> ?N` footer dirty flag (gjc parity).
 * One `git status --porcelain` spawn per CALL; callers invoke it once per turn start, not
 * per render. Returns undefined when not a repo / git absent / clean.
 */
export function gitDirtyCount(cwd: string): number | undefined {
  try {
    const res = Bun.spawnSync(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "ignore" });
    if (res.exitCode !== 0) return undefined;
    const n = res.stdout.toString().split("\n").filter(l => l.trim().length > 0).length;
    return n || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Allocate + create an INDEPENDENT tmux session from a base name. Each separate,
 * concurrent `jeo --tmux` invocation gets its OWN session instead of attaching to (and
 * mirroring) one another process already created: try `base`, then `base-2`, `base-3`, …
 * The create itself is the guard, so this is race-safe — two processes starting at the
 * same instant can't both win `base`. `tryCreate` must attempt to create the named session
 * and return `"ok"` (created — it's ours), `"taken"` (name already live / lost the race →
 * try the next suffix), or `"error:<msg>"` (a real failure → abort). Sessions die with
 * their jeo process, so a sequential re-run reuses the clean base; only live overlap is
 * suffixed.
 */
export type TmuxCreateResult = "ok" | "taken" | `error:${string}`;
export function allocateTmuxSession(
  base: string,
  tryCreate: (name: string) => TmuxCreateResult,
): { name: string } | { error: string } {
  for (let n = 1; n <= 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const result = tryCreate(candidate);
    if (result === "ok") return { name: candidate };
    if (result === "taken") continue;
    return { error: result.slice("error:".length) };
  }
  return { error: `could not allocate a free tmux session name for ${base} (1000 already live?)` };
}
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}




/**
 * True when `jeo --tmux` runs INSIDE an existing tmux session and should enable
 * session-scoped mouse mode for the CURRENT session: no jeo-owned session is created
 * on this path, so without `mouse on` tmux ignores the wheel entirely and the
 * mid-turn scrollback (ledger lines flushed above the live frame) is unreachable.
 * Skipped for jeo-spawned sessions (JEO_TMUX_LAUNCHED=1 — the creator already set
 * it) and when JEO_TMUX_MOUSE=0 opts out.
 */
export function shouldEnableCurrentTmuxMouse(env: Record<string, string | undefined>): boolean {
  return !!env.TMUX
    && (env.JEO_TMUX_LAUNCHED ?? env.JEO_TMUX_LAUNCHED) !== "1"
    && (env.JEO_TMUX_MOUSE ?? env.JEO_TMUX_MOUSE) !== "0";
}

/**
 * The runnable command for the INNER `jeo launch` a `--tmux` session executes.
 * Pure — testable. Three runtime shapes:
 *  - compiled standalone binary: `argv[1]` is a Bun VIRTUAL path (`/$bunfs/…`)
 *    that does not exist on disk; the binary itself (`execPath`) is the
 *    entrypoint. Passing the virtual path made the inner command crash on
 *    spawn, so `tmux new-session` died instantly and the follow-up attach
 *    failed with "can't find session".
 *  - source run (`bun src/cli.ts`): re-run the script through the runtime.
 *  - anything else (a shim/binary path on disk): run it directly.
 */
export function tmuxLaunchCommand(argv1: string | undefined, execPath: string, cwd: string): string[] {
  const entrypoint = argv1 ?? "";
  if (entrypoint === "" || entrypoint.startsWith("/$bunfs/") || entrypoint.startsWith("B:\\~BUN\\")) {
    return [execPath];
  }
  const resolved = path.isAbsolute(entrypoint) ? entrypoint : path.resolve(cwd, entrypoint);
  if (/\.(ts|js|mjs)$/.test(entrypoint)) return [execPath, resolved];
  return [resolved];
}

/** One tmux configuration step applied to a jeo-owned session after creation. */
export interface TmuxProfileCommand {
  description: string;
  args: string[];
}

/**
 * gjc-parity tmux profile for jeo-OWNED sessions (mirrors gjc's
 * `buildGjcTmuxProfileCommands`). Applied right after `new-session`, before attach:
 *  - `mouse on` (session-scoped): wheel-up enters copy-mode over the REAL pane
 *    history — this is what makes the mid-turn scrollback (ledger lines flushed
 *    above the inline live frame) reachable with the mouse wheel. Wheel-down at
 *    the bottom drops back out. `JEO_TMUX_MOUSE=0` opts out.
 *  - ownership/identity markers (`@jeo-profile`, `@jeo-branch`, `@jeo-project`):
 *    lets tooling tell jeo-owned sessions apart from user sessions (gjc parity
 *    with `@gjc-*`). Never applied to foreign sessions.
 *  - `set-clipboard on` + a readable copy-mode `mode-style`: text selected while
 *    wheel-scrolled back is visibly highlighted and lands on the system clipboard
 *    (OSC52). `JEO_TMUX_PROFILE=0` opts out of these cosmetic extras while keeping
 *    mouse + markers.
 */
export function tmuxProfileCommands(
  target: string,
  env: Record<string, string | undefined>,
  meta: { branch?: string; project?: string } = {},
): TmuxProfileCommand[] {
  const t = `=${target}:`;
  const commands: TmuxProfileCommand[] = [];
  if ((env.JEO_TMUX_MOUSE ?? env.JEO_TMUX_MOUSE) !== "0") {
    commands.push({
      description: "enable tmux mouse scrolling (wheel-up → copy-mode over real history)",
      args: ["set-option", "-t", t, "mouse", "on"],
    });
  }
  commands.push({
    description: "mark jeo tmux ownership",
    args: ["set-option", "-t", t, "@jeo-profile", "1"],
  });
  if (meta.branch) {
    commands.push({
      description: "record jeo branch identity",
      args: ["set-option", "-t", t, "@jeo-branch", meta.branch],
    });
  }
  if (meta.project) {
    commands.push({
      description: "record jeo project identity",
      args: ["set-option", "-t", t, "@jeo-project", meta.project],
    });
  }
  if ((env.JEO_TMUX_PROFILE ?? env.JEO_TMUX_PROFILE) !== "0") {
    commands.push(
      {
        description: "enable tmux clipboard integration",
        args: ["set-option", "-t", t, "set-clipboard", "on"],
      },
      {
        description: "make copy-mode selection readable",
        args: ["set-window-option", "-t", t, "mode-style", "fg=colour231,bg=colour60"],
      },
    );
  }
  return commands;
}

/**
 * Resolve a git worktree path (gjc `--worktree <path>` parity). If the path
 * already exists it is reused as-is; otherwise a new worktree is created on a
 * branch derived from the path basename. Returns the absolute worktree path.
 */
export function resolveWorktree(cwd: string, wt: string): string {
  const abs = path.isAbsolute(wt) ? wt : path.resolve(cwd, wt);
  if (fs.existsSync(abs)) return abs;
  if (!Bun.which("git")) {
    console.error("error: --worktree requires git on PATH");
    process.exit(1);
  }
  const branch = (path.basename(abs).replace(/[^a-zA-Z0-9_-]/g, "-") || "jeo-wt");
  const withBranch = Bun.spawnSync(["git", "worktree", "add", "-b", branch, abs], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (withBranch.exitCode !== 0) {
    // Branch may already exist; retry attaching the existing branch.
    const plain = Bun.spawnSync(["git", "worktree", "add", abs], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (plain.exitCode !== 0) {
      console.error(
        `error: failed to create git worktree at ${abs}: ${withBranch.stderr.toString().trim()}`,
      );
      process.exit(1);
    }
  }
  return abs;
}
