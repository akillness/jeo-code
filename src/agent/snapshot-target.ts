/**
 * Which directory the engine's before/after workspace snapshot should measure for ONE shell call.
 *
 * A shared scratch cwd ($HOME, `/`, a system temp dir) is never bracketed itself: unrelated processes write there, so
 * a digest change cannot be blamed on the call. But a model often sits in such a cwd and edits a real project
 * through it (`cd ~/work/app && sed -i …`, or a bash `cwd`/`subdir` argument), and that edit would otherwise be
 * invisible to the done gate. This resolves the PROJECT the call is aimed at (the outermost directory with a project
 * marker above the target, so `cd app/pkg && echo X > ../src/a.ts` measures `app`) so the bracket can measure it.
 *
 * Everything here fails SAFE: an unresolvable, nonexistent, scratch, marker-less or ambiguous target means "no nested
 * target" (the caller keeps today's scratch skip), and nothing throws.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSharedScratchRoot } from "./workspace-snapshot";

/** Leading `cd a && cd b; …` hops followed at most this far; anything beyond is simply not modelled. */
const MAX_CD_HOPS = 8;

/** How far above a target the project-marker search climbs before giving up. */
const MAX_MARKER_LEVELS = 12;

/**
 * Files/dirs whose presence says "this is a project". A nested target is bracketed only when it (or an ancestor below
 * the scratch root) has one: `cd ~/.cache && ls` or `cd /var/log && tail x` is ambient state, not a project, and a
 * bracket there measures unrelated churn (or hits the entry cap) instead of the call's own writes. The OUTERMOST such
 * ancestor is the bracketed root, because a write anywhere in the project (`../src/a.ts`) belongs to the same project.
 */
const PROJECT_MARKERS: readonly string[] = [
  ".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py", "Makefile", "pom.xml",
  "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "deno.json", "CMakeLists.txt", ".jeo",
];

/**
 * A leading literal `cd <path>` terminated by `&&`, `;` or a newline. The path is single-quoted, double-quoted
 * without expansion characters, or a bare token drawn from a whitelist (so `$`, backticks, globs, braces, escapes
 * and `||`/`|`/`&` never parse): when it does not match, the hop is not modelled rather than guessed.
 */
const CD_HOP =
  /^\s*cd[ \t]+(?:'([^']*)'|"([^"$`\\]*)"|([A-Za-z0-9_./~@%+:,][A-Za-z0-9_./~@%+:,-]*))[ \t]*(?:&&|;|\r?\n)/;

const realOrResolved = (target: string): string => {
  try { return realpathSync(target); } catch { return path.resolve(target); }
};

const isDirectory = (target: string): boolean => {
  try { return statSync(target).isDirectory(); } catch { return false; }
};

const accountHomedir = (): string => {
  try { return os.userInfo().homedir; } catch { return os.homedir(); }
};

/** True when `child` is `parent` or lies inside it (both already resolved). */
const within = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
};

/** The roots the climb must not enter and a bracketed root must not cover: the cwd plus the declared/default roots. */
function scratchRootList(cwd: string, scratchRoots: readonly string[] | undefined): string[] {
  return scratchRoots
    ? [cwd, ...scratchRoots]
    : [cwd, os.homedir(), accountHomedir(), os.tmpdir(), "/tmp", "/var/tmp"];
}

/**
 * True when `target` is a scratch root or CONTAINS one (`/Users` above `$HOME`, `/` above everything). Bracketing an
 * ancestor of a scratch root walks the very tree that made the root unmeasurable (a read-only `cd .. && ls` would hit
 * the entry cap and count as a mutation), so it is skipped exactly like the root itself.
 */
function coversScratchRoot(target: string, roots: readonly string[]): boolean {
  const here = realOrResolved(target);
  return roots.some(root => within(here, realOrResolved(root)));
}

/**
 * The OUTERMOST ancestor-or-self of `target` holding a project marker, or null. The climb stops BEFORE any scratch
 * root (a `package.json` in `$HOME` must not turn every directory under it into a project) and at the filesystem
 * root, and is bounded to MAX_MARKER_LEVELS. Outermost, not nearest: the deepest directory of a project (`app/pkg`,
 * `/opt/homebrew/var/log`) sees only part of what a command can write, and a bracket on a log directory blames the call
 * for its ambient writers; the project root is where an edit anywhere in the tree shows up.
 */
function projectRoot(target: string, roots: readonly string[]): string | null {
  let current = realOrResolved(target);
  let root: string | null = null;
  for (let level = 0; level < MAX_MARKER_LEVELS; level++) {
    const parent = path.dirname(current);
    if (parent === current || isSharedScratchRoot(current, roots)) break;
    if (PROJECT_MARKERS.some(marker => existsSync(path.join(current, marker)))) root = current;
    current = parent;
  }
  return root;
}

/** The `a.env` map bash receives, reduced to the string entries the tool actually forwards. */
function envValue(args: Record<string, any> | undefined, key: string): string | undefined {
  const env = args?.env;
  const own = env && typeof env === "object" && !Array.isArray(env) ? env[key] : undefined;
  return typeof own === "string" ? own : process.env[key];
}

/**
 * One `cd` hop from `dir`. Null when the hop cannot be resolved with certainty: `~user`, a relative path under a
 * set `CDPATH` (bash would search elsewhere), or a target that is not an existing directory.
 */
function applyHop(dir: string, raw: string, quoted: boolean, args: Record<string, any> | undefined): string | null {
  let target = raw;
  if (!quoted && raw.startsWith("~")) {
    if (raw !== "~" && !raw.startsWith("~/")) return null;
    const home = envValue(args, "HOME") || os.homedir();
    target = path.join(home, raw.slice(1));
  } else if (
    !path.isAbsolute(raw) && !/^\.\.?(?:\/|$)/.test(raw) && (envValue(args, "CDPATH") ?? "") !== ""
  ) {
    return null;
  }
  const next = path.resolve(dir, target);
  return isDirectory(next) ? next : null;
}

/**
 * The directory the snapshot bracket should measure for this ONE call.
 *
 * - Default: `cwd`, unchanged. A non-scratch cwd always brackets itself (targets outside it are not followed), and
 *   so does every tool other than `bash`.
 * - `bash` from a shared scratch cwd: resolve the effective run dir from `args.cwd ?? args.subdir` (the same
 *   precedence the bash tool uses), then follow a LEADING literal `cd <path> &&` / `cd <path>;` chain from there.
 *   The last existing directory reached is the TARGET; the bracketed directory is its project root (outermost
 *   ancestor-or-self with a marker), unless that root is a scratch root or contains one.
 *
 * Returns `cwd` itself (same string) when there is no nested target; any other return value is the absolute real path
 * of the project root the caller should measure instead. A directory the command creates itself does not exist yet
 * and so yields no target — an accepted gap, since guessing a path that may never exist would measure the wrong
 * tree. A target with no project marker (see PROJECT_MARKERS) is not a project either, and is treated like no target.
 */
export function snapshotTarget(
  cwd: string,
  tool: string,
  args: Record<string, any> | undefined,
  scratchRoots?: readonly string[],
): string {
  try {
    if (tool !== "bash" || !isSharedScratchRoot(cwd, scratchRoots)) return cwd;
    const sub = typeof args?.cwd === "string" ? args.cwd : typeof args?.subdir === "string" ? args.subdir : "";
    let dir = sub ? path.resolve(cwd, sub) : cwd;
    // The bash tool spawns in this directory; if it is missing the call fails before touching anything.
    if (!isDirectory(dir)) return cwd;
    let rest = String(args?.command ?? args?.cmd ?? "");
    for (let hop = 0; hop < MAX_CD_HOPS; hop++) {
      const m = CD_HOP.exec(rest);
      if (!m) break;
      const next = applyHop(dir, m[1] ?? m[2] ?? m[3], m[3] === undefined, args);
      if (next === null) break;
      dir = next;
      rest = rest.slice(m[0].length);
    }
    const roots = scratchRootList(cwd, scratchRoots);
    const root = projectRoot(dir, roots);
    // The climb never enters a scratch root, but a marker above one (`/var/.git` over `/var/tmp`) still yields a
    // root that covers it: that is as unmeasurable as the scratch root itself.
    if (root === null || isSharedScratchRoot(root, roots) || coversScratchRoot(root, roots)) return cwd;
    return root;
  } catch {
    return cwd;
  }
}

/**
 * The form persisted as `workspace.target`: relative to `cwd` when the target lies inside it, else the fixed token
 * `<outside cwd>` — an absolute path outside the workspace has no business in a transcript. Compared by real path, so
 * a cwd reached through a symlink (macOS `/tmp`) still counts as containing its own subdirectories.
 */
export function describeSnapshotTarget(cwd: string, target: string): string {
  const base = realOrResolved(cwd);
  const real = realOrResolved(target);
  const rel = path.relative(base, real);
  return rel !== "" && within(base, real) ? rel : "<outside cwd>";
}

/** Human-facing name for notices: the relative path inside `cwd`, otherwise only the directory's basename. */
export function snapshotTargetLabel(cwd: string, target: string): string {
  const base = realOrResolved(cwd);
  const real = realOrResolved(target);
  const rel = path.relative(base, real);
  return rel !== "" && within(base, real) ? rel : path.basename(real);
}
