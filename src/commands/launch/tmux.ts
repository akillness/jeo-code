import * as path from "node:path";
import * as fs from "node:fs";
import { type LaunchFlags } from "./flags";
import { tmuxCopyCommand } from "../../tui/clipboard";
import { jeoEnv } from "../../util/env";

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
  // Trim a trailing dash from the truncated head so a boundary landing right
  // after a `-` doesn't produce an ugly `name--<hash>` (double dash). The head
  // is guaranteed non-empty and to start with an alnum (safe is trimmed).
  const head = safe.slice(0, Math.max(1, max - 7)).replace(/-+$/, "") || safe.slice(0, 1);
  return `${head}-${hashString(input)}`;
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

/** Caller-terminal dimensions for a detached `tmux new-session` (gjc launch-tmux parity #1376). */
export interface TmuxTerminalSize {
  columns: number;
  rows: number;
}

function normalizeTmuxDimension(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Resolve the caller terminal's size so a detached `tmux new-session` is created at
 * the REAL terminal dimensions instead of tmux's 80x24 detached default. Without this
 * the inner jeo renders its first frames (banner, status footer) at 80 columns, and
 * that mis-wrapped output stays wrong in the pane scrollback even after the attach
 * resizes the window. Returns undefined when stdout is not a TTY or either dimension
 * is unknown/invalid — callers then omit sizing and let tmux use its default.
 */
export function callerTmuxTerminalSize(
  out: { isTTY?: boolean; columns?: number; rows?: number } = process.stdout,
): TmuxTerminalSize | undefined {
  if (!out.isTTY) return undefined;
  const columns = normalizeTmuxDimension(out.columns);
  const rows = normalizeTmuxDimension(out.rows);
  return columns !== undefined && rows !== undefined ? { columns, rows } : undefined;
}

/** `-x/-y` args for `new-session`; empty when the size is unknown. */
export function tmuxNewSessionSizeArgs(size: TmuxTerminalSize | undefined): string[] {
  return size ? ["-x", String(size.columns), "-y", String(size.rows)] : [];
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
    && env.JEO_TMUX_LAUNCHED !== "1"
    && env.JEO_TMUX_MOUSE !== "0";
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
  deps: { platform?: NodeJS.Platform; which?: (bin: string) => string | null } = {},
): TmuxProfileCommand[] {
  const t = `=${target}:`;
  const commands: TmuxProfileCommand[] = [];
  if (env.JEO_TMUX_MOUSE !== "0") {
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
  if (env.JEO_TMUX_PROFILE !== "0") {
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
    // Pipe the copy-mode selection straight to the SYSTEM clipboard tool
    // (pbcopy / wl-copy / xclip / xsel). With `mouse on`, a mouse drag-select
    // releases into copy-mode and `copy-command` lands it on the OS clipboard —
    // so a tmux drag-select copies for `cmd+v` even where the outer terminal
    // doesn't honor OSC 52. Skipped when no clipboard tool is on PATH.
    const copyCmd = tmuxCopyCommand(deps.platform ?? process.platform, deps.which ?? ((bin: string) => Bun.which(bin)));
    if (copyCmd) {
      commands.push({
        description: "pipe copy-mode selection to the system clipboard",
        args: ["set-option", "-t", t, "copy-command", copyCmd],
      });
    }
  }

  return commands;
}

/**
 * Clipboard set-options for the CURRENT (foreign) tmux session that the in-session
 * `jeo --tmux` path turns `mouse on` for. Enabling the mouse re-routes a plain
 * drag into copy-mode, so without these a drag-select no longer lands anywhere:
 *  - `set-clipboard on` lets the copy-mode selection reach the outer terminal via OSC52;
 *  - `copy-command` pipes that selection straight to the local clipboard tool
 *    (pbcopy / wl-copy / xclip / xsel / clip), so a drag-select copies for `cmd+v`
 *    even where OSC52 is not honored.
 * Applied WITHOUT `-t` (the current session only — never -g, so the user's other
 * sessions are untouched). `JEO_TMUX_PROFILE=0` opts out; `copy-command` is skipped
 * when no clipboard tool is on PATH. This is the in-session analogue of the
 * clipboard block in {@link tmuxProfileCommands} for jeo-owned sessions.
 */
export function currentTmuxClipboardCommands(
  env: Record<string, string | undefined>,
  deps: { platform?: NodeJS.Platform; which?: (bin: string) => string | null } = {},
): TmuxProfileCommand[] {
  if (env.JEO_TMUX_PROFILE === "0") return [];
  const commands: TmuxProfileCommand[] = [
    {
      description: "enable tmux clipboard integration",
      args: ["set-option", "set-clipboard", "on"],
    },
  ];
  const copyCmd = tmuxCopyCommand(deps.platform ?? process.platform, deps.which ?? ((bin: string) => Bun.which(bin)));
  if (copyCmd) {
    commands.push({
      description: "pipe copy-mode selection to the system clipboard",
      args: ["set-option", "copy-command", copyCmd],
    });
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
/**
 * Ownership / idle metadata for one tmux session, parsed from `tmux list-sessions`.
 * Backs {@link reapStaleTmuxSessions}, the sweep that closes the orphaned-session
 * leak (detached, long-idle `jeo launch` REPLs each pin tens of MB and pile up
 * across days — the "jeo/bun 프로세스가 쌓여 메모리가 점점 커진다" report).
 */
export interface TmuxSessionInfo {
  name: string;
  /** A client is currently attached (someone is viewing it). */
  attached: boolean;
  /** Last-activity time, epoch SECONDS (tmux #{session_activity}). */
  activitySec: number;
  /** The @jeo-profile marker is set ⇒ jeo created/owns this session. */
  jeoOwned: boolean;
}

/** Stable, tab-separated `tmux list-sessions -F` format the reaper parses. */
export const TMUX_REAP_LIST_FORMAT =
  "#{session_name}\t#{session_attached}\t#{session_activity}\t#{@jeo-profile}";

/** Parse {@link TMUX_REAP_LIST_FORMAT} output into structured per-session info. */
export function parseTmuxSessionList(raw: string): TmuxSessionInfo[] {
  const out: TmuxSessionInfo[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [name, attached, activity, jeo] = line.split("\t");
    if (!name) continue;
    const activitySec = Number(activity);
    out.push({
      name,
      attached: attached === "1",
      activitySec: Number.isFinite(activitySec) ? activitySec : 0,
      jeoOwned: jeo === "1",
    });
  }
  return out;
}

/**
 * Pure selector: which jeo-owned tmux sessions are safe to reap. A session is
 * stale when jeo owns it (the @jeo-profile marker), NO client is attached, and it
 * has been idle longer than `idleMs`. Sessions in `keep` (e.g. the one we are about
 * to attach) are never selected. The interactive REPL persists its transcript to
 * `.jeo/sessions/` and is resumable with `--resume`, so reaping an abandoned,
 * unattached, idle REPL discards only its in-memory live view.
 */
export function selectReapableTmuxSessions(
  sessions: TmuxSessionInfo[],
  opts: { nowSec: number; idleMs: number; keep?: Iterable<string> },
): string[] {
  const keep = new Set(opts.keep ?? []);
  const idleSec = opts.idleMs / 1000;
  return sessions
    .filter(s =>
      s.jeoOwned &&
      !s.attached &&
      !keep.has(s.name) &&
      opts.nowSec - s.activitySec >= idleSec,
    )
    .map(s => s.name);
}

/** Session reaping is on unless JEO_TMUX_REAP=0. */
export function tmuxReapEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return jeoEnv("TMUX_REAP", env) !== "0";
}

/** Idle threshold before an unattached jeo session is reaped (default 6h). 0 reaps every idle one; invalid → default. */
export function tmuxReapIdleMs(env: Record<string, string | undefined> = process.env): number {
  const DEFAULT = 6 * 60 * 60 * 1000;
  const raw = jeoEnv("TMUX_REAP_IDLE_MS", env);
  if (raw == null) return DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT;
}

export interface TmuxReapDeps {
  /** Raw `tmux list-sessions` output (TMUX_REAP_LIST_FORMAT), or null on failure. */
  list?: () => string | null;
  /** Kill one session by name. */
  kill?: (name: string) => void;
  /** Epoch-ms clock (injectable for tests). */
  now?: () => number;
  env?: Record<string, string | undefined>;
}

/**
 * Best-effort sweep of orphaned jeo tmux sessions. Each detached, long-idle
 * `jeo launch` REPL holds tens of MB forever, so over days dozens accumulate and
 * aggregate RSS climbs monotonically. This reaps the jeo-owned sessions with no
 * client attached that have outlived the idle TTL — never the freshly created
 * session(s) in `keep`. Returns the reaped session names. Opt out: JEO_TMUX_REAP=0.
 */
export function reapStaleTmuxSessions(
  tmuxBin: string,
  keep: Iterable<string> = [],
  deps: TmuxReapDeps = {},
): string[] {
  const env = deps.env ?? process.env;
  if (!tmuxReapEnabled(env)) return [];
  const now = deps.now ?? Date.now;
  const list = deps.list ?? ((): string | null => {
    try {
      const res = Bun.spawnSync([tmuxBin, "list-sessions", "-F", TMUX_REAP_LIST_FORMAT], {
        stdout: "pipe",
        stderr: "ignore",
      });
      return res.exitCode === 0 ? res.stdout.toString() : null;
    } catch {
      return null;
    }
  });
  const raw = list();
  if (!raw) return [];
  const reapable = selectReapableTmuxSessions(parseTmuxSessionList(raw), {
    nowSec: Math.floor(now() / 1000),
    idleMs: tmuxReapIdleMs(env),
    keep,
  });
  if (reapable.length === 0) return [];
  const kill = deps.kill ?? ((name: string): void => {
    try {
      Bun.spawnSync([tmuxBin, "kill-session", "-t", `=${name}`], { stdout: "ignore", stderr: "ignore" });
    } catch {
      /* best-effort: the session may have died on its own between list and kill */
    }
  });
  const reaped: string[] = [];
  for (const name of reapable) {
    kill(name);
    reaped.push(name);
  }
  return reaped;
}