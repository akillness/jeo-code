/**
 * Host-side workspace fingerprint. The engine brackets bash/computer calls with two snapshots and
 * counts the call as a mutation only when they differ (workspaceSnapshotChanged). Failures and caps
 * are reported as `ok:false`, which always counts as a mutation (safe side).
 *
 * Entry strings folded into an order-independent digest:
 * - directory: `d:<rel>` (presence only; directory mtimes are ignored so creating an excluded
 *   child such as `.jeo/` or `node_modules/` never counts)
 * - file/link/other: `<f|l|o>:<rel>:<size>:<mtimeNs>:<ctimeNs>:<ino>` from lstat (never followed)
 *   - link: `:t<readlink target>`
 *   - regular file with mtime >= anchor - racyWindowMs: `:h<wyhash(content)>` (racy-clean guard
 *     against coarse timestamps; the after-snapshot reuses the before-snapshot's anchor)
 *   - FIFO/socket/device: stat only, never opened
 */
import * as fs from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import type { BigIntStats, Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface WorkspaceSnapshotLimits {
  /** Max fingerprinted entries (files+dirs+links) before giving up (counts as a mutation). */
  maxEntries: number;
  /** Wall-clock budget per snapshot (ms). */
  maxMs: number;
  /** Files with mtime within this window of the snapshot start are content-hashed too. */
  racyWindowMs: number;
  /** Per-file and per-snapshot byte caps for racy content hashing. */
  racyMaxFileBytes: number;
  racyMaxTotalBytes: number;
}

export const WORKSPACE_SNAPSHOT_LIMITS: Readonly<WorkspaceSnapshotLimits> = Object.freeze({
  maxEntries: 50_000,
  maxMs: 2_000,
  racyWindowMs: 2_000,
  racyMaxFileBytes: 1024 * 1024,
  racyMaxTotalBytes: 8 * 1024 * 1024,
});

/** Directory NAMES skipped at any depth (A2): exactly these three. */
export const WORKSPACE_SNAPSHOT_EXCLUDED_DIRS: ReadonlySet<string> = new Set([".git", ".jeo", "node_modules"]);

export type WorkspaceSnapshot =
  | {
      ok: true; digest: bigint; entries: number; elapsedMs: number; startedAtMs: number;
      /** Relative path -> entry fingerprint, so a mismatch can name WHICH paths changed
       *  (`snapshotChangedPaths`). Optional so hand-built snapshots and mocks stay valid. */
      paths?: ReadonlyMap<string, bigint>;
    }
  | { ok: false; reason: "error" | "cap"; detail: string };

/** `racySinceMs`: anchor for the racy content-hash predicate. The engine passes the BEFORE snapshot's
 *  `startedAtMs` to the AFTER snapshot so both sides hash exactly the same set of unchanged files. */
export type WorkspaceSnapshotter = (cwd: string, racySinceMs?: number) => Promise<WorkspaceSnapshot>;

type Failure = Extract<WorkspaceSnapshot, { ok: false }>;

/** Carries the first failure out of the concurrent walk. */
class SnapshotStop extends Error {
  constructor(readonly result: Failure) { super(result.detail); }
}

const CONCURRENCY = 64;
const DIGEST_MASK = 0xffff_ffff_ffff_ffffn;
/** Never follow a link swapped in after lstat, and never block on a FIFO swapped in after lstat. */
const RACY_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** A child removed mid-walk: skipped, since a real deletion still changes the digest. */
const vanished = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};
const stop = (reason: Failure["reason"], detail: string): never => { throw new SnapshotStop({ ok: false, reason, detail }); };

async function chunked<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += CONCURRENCY) await Promise.all(items.slice(i, i + CONCURRENCY).map(run));
}

interface Dir { rel: string; abs: string }
interface Leaf extends Dir { dirent: Dirent }

export async function snapshotWorkspace(
  cwd: string,
  limits: WorkspaceSnapshotLimits = WORKSPACE_SNAPSHOT_LIMITS,
  racySinceMs?: number,
): Promise<WorkspaceSnapshot> {
  const startedAtMs = Date.now();
  const startedAt = performance.now();
  const anchorMs = racySinceMs !== undefined && Number.isFinite(racySinceMs) ? racySinceMs : startedAtMs;
  const racyThresholdNs = BigInt(Math.floor(anchorMs - limits.racyWindowMs)) * 1_000_000n;
  let digest = 0n;
  let entries = 0;
  let racyBytes = 0;

  const paths = new Map<string, bigint>();
  const record = (entry: string, rel: string): void => {
    const hash = BigInt(Bun.hash.wyhash(entry));
    digest = (digest + hash) & DIGEST_MASK;
    paths.set(rel, hash);
  };
  const checkCaps = (): void => {
    if (entries > limits.maxEntries) stop("cap", `workspace has more than ${limits.maxEntries} entries`);
    if (performance.now() - startedAt > limits.maxMs) stop("cap", `workspace snapshot exceeded ${limits.maxMs} ms`);
  };

  /** Bounded read of a regular file's content; `null` when it vanished before it could be read. */
  const racyHash = async (leaf: Leaf, stat: BigIntStats): Promise<bigint | null> => {
    const size = Number(stat.size);
    if (size > limits.racyMaxFileBytes) stop("error", `racy file too large: ${leaf.rel} (${size} bytes)`);
    racyBytes += size;
    if (racyBytes > limits.racyMaxTotalBytes) stop("error", `racy files too large: more than ${limits.racyMaxTotalBytes} bytes`);
    let handle: FileHandle;
    try { handle = await fs.open(leaf.abs, RACY_OPEN_FLAGS); }
    catch (error) { if (vanished(error)) return null; return stop("error", `cannot open ${leaf.rel}: ${errorMessage(error)}`); }
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) stop("error", `file changed during workspace snapshot: ${leaf.rel}`);
      // One spare byte detects growth after lstat without reading past the cap.
      const buffer = new Uint8Array(size + 1);
      let read = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
        if (read > size) stop("error", `file changed during workspace snapshot: ${leaf.rel}`);
      }
      return Bun.hash.wyhash(buffer.subarray(0, read));
    } finally {
      await handle.close().catch(() => {});
    }
  };

  const fingerprint = async (leaf: Leaf, queue: Dir[]): Promise<void> => {
    let stat: BigIntStats;
    try { stat = await fs.lstat(leaf.abs, { bigint: true }); }
    catch (error) {
      if (vanished(error)) { entries -= 1; return; }
      return stop("error", `cannot stat ${leaf.rel}: ${errorMessage(error)}`);
    }
    if (stat.isDirectory()) {
      // Unreported or raced dirent type: a real directory is never fingerprinted by metadata.
      if (WORKSPACE_SNAPSHOT_EXCLUDED_DIRS.has(leaf.dirent.name)) { entries -= 1; return; }
      record(`d:${leaf.rel}`, leaf.rel);
      queue.push(leaf);
      return;
    }
    const kind = stat.isSymbolicLink() ? "l" : stat.isFile() ? "f" : "o";
    let entry = `${kind}:${leaf.rel}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`;
    if (kind === "l") {
      try { entry += `:t${await fs.readlink(leaf.abs)}`; }
      catch (error) {
        if (vanished(error)) { entries -= 1; return; }
        return stop("error", `cannot read link ${leaf.rel}: ${errorMessage(error)}`);
      }
    } else if (kind === "f" && leaf.dirent.isFile() && stat.mtimeNs >= racyThresholdNs) {
      const hash = await racyHash(leaf, stat);
      if (hash === null) { entries -= 1; return; }
      entry += `:h${hash}`;
    }
    record(entry, leaf.rel);
  };

  const list = async (dir: Dir, next: Dir[], leaves: Leaf[]): Promise<void> => {
    let dirents: Dirent[];
    try { dirents = await fs.readdir(dir.abs, { withFileTypes: true }); }
    catch (error) {
      if (dir.rel !== "" && vanished(error)) return;
      return stop("error", `cannot read directory ${dir.rel || "."}: ${errorMessage(error)}`);
    }
    for (const dirent of dirents) {
      const rel = dir.rel ? `${dir.rel}/${dirent.name}` : dirent.name;
      const child: Leaf = { rel, abs: path.join(dir.abs, dirent.name), dirent };
      if (dirent.isDirectory()) {
        if (WORKSPACE_SNAPSHOT_EXCLUDED_DIRS.has(dirent.name)) continue;
        entries += 1;
        record(`d:${rel}`, rel);
        next.push(child);
      } else {
        entries += 1;
        leaves.push(child);
      }
    }
    checkCaps();
  };

  try {
    let root: BigIntStats;
    try { root = await fs.stat(cwd, { bigint: true }); }
    catch (error) { return { ok: false, reason: "error", detail: `cannot stat workspace root: ${errorMessage(error)}` }; }
    if (!root.isDirectory()) return { ok: false, reason: "error", detail: "workspace root is not a directory" };

    let level: Dir[] = [{ rel: "", abs: cwd }];
    while (level.length) {
      const next: Dir[] = [];
      for (let i = 0; i < level.length; i += CONCURRENCY) {
        const leaves: Leaf[] = [];
        await Promise.all(level.slice(i, i + CONCURRENCY).map(dir => list(dir, next, leaves)));
        await chunked(leaves, leaf => fingerprint(leaf, next));
        checkCaps();
      }
      level = next;
    }
    return { ok: true, digest, entries, elapsedMs: performance.now() - startedAt, startedAtMs, paths };
  } catch (error) {
    if (error instanceof SnapshotStop) return error.result;
    return { ok: false, reason: "error", detail: errorMessage(error) };
  }
}

/** Production default: default limits, forwards the racy anchor. */
export const defaultWorkspaceSnapshotter: WorkspaceSnapshotter = (cwd, since) => snapshotWorkspace(cwd, WORKSPACE_SNAPSHOT_LIMITS, since);

/** Pure: true when either side failed, or digest/entry count differ. */
export function workspaceSnapshotChanged(before: WorkspaceSnapshot, after: WorkspaceSnapshot): boolean {
  if (!before.ok || !after.ok) return true;
  return before.digest !== after.digest || before.entries !== after.entries;
}

/** Result of comparing two snapshots path by path (sorted, relative to the workspace root). */
export interface SnapshotPathChange {
  added: string[];
  removed: string[];
  modified: string[];
}

/**
 * Paths that differ between two successful snapshots. Null when either side cannot say (a failed
 * snapshot, or a hand-built one without a per-path map) — callers then fall back to the bare
 * digest verdict. Directories are reported by name too; their mtimes are not fingerprinted.
 */
export function snapshotChangedPaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): SnapshotPathChange | null {
  if (!before.ok || !after.ok || !before.paths || !after.paths) return null;
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [rel, hash] of after.paths) {
    const prev = before.paths.get(rel);
    if (prev === undefined) added.push(rel);
    else if (prev !== hash) modified.push(rel);
  }
  for (const rel of before.paths.keys()) if (!after.paths.has(rel)) removed.push(rel);
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}

/** `modified a/b.json; added c.txt (+3 more)` — at most `limit` paths, for notices and gate messages. */
export function formatSnapshotChange(change: SnapshotPathChange, limit = 5): string {
  const items = [
    ...change.modified.map(p => `modified ${p}`),
    ...change.added.map(p => `added ${p}`),
    ...change.removed.map(p => `removed ${p}`),
  ];
  if (items.length === 0) return "no path-level difference";
  const shown = items.slice(0, limit).join("; ");
  return items.length > limit ? `${shown} (+${items.length - limit} more)` : shown;
}

const realOrResolved = (target: string): string => {
  try { return realpathSync(target); } catch { return path.resolve(target); }
};

function accountHomedir(): string {
  try { return os.userInfo().homedir; } catch { return os.homedir(); }
}

function defaultScratchRoots(cwd: string): string[] {
  // `os.homedir()` / `os.tmpdir()` follow $HOME / $TMPDIR, so the account's real home is listed too.
  return [os.homedir(), accountHomedir(), path.parse(path.resolve(cwd)).root, os.tmpdir(), "/tmp", "/var/tmp"];
}

/**
 * True when `cwd` IS a shared scratch root — `$HOME`, the filesystem root, or a system temp directory —
 * rather than a directory inside one. Those roots are written by unrelated processes (daemon heartbeats,
 * logs, other agents), are often too large or partly unreadable to snapshot, and hold no project whose
 * verifier could ever run, so a snapshot diff there cannot be attributed to one shell call. A project
 * directory nested under them (a `mkdtemp` dir, `~/work/app`) is NOT a scratch root and stays gated.
 */
export function isSharedScratchRoot(cwd: string, roots: readonly string[] = defaultScratchRoots(cwd)): boolean {
  const here = realOrResolved(cwd);
  return roots.some(root => realOrResolved(root) === here);
}
