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
import { constants } from "node:fs";
import type { BigIntStats, Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
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
  | { ok: true; digest: bigint; entries: number; elapsedMs: number; startedAtMs: number }
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

  const record = (entry: string): void => { digest = (digest + Bun.hash.wyhash(entry)) & DIGEST_MASK; };
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
      record(`d:${leaf.rel}`);
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
    record(entry);
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
        record(`d:${rel}`);
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
    return { ok: true, digest, entries, elapsedMs: performance.now() - startedAt, startedAtMs };
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
