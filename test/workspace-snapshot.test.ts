import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  WORKSPACE_SNAPSHOT_EXCLUDED_DIRS,
  WORKSPACE_SNAPSHOT_LIMITS,
  defaultWorkspaceSnapshotter,
  formatSnapshotChange,
  isSharedScratchRoot,
  snapshotChangedPaths,
  snapshotWorkspace,
  workspaceSnapshotChanged,
  type SnapshotPathChange,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotLimits,
} from "../src/agent/workspace-snapshot";

let dir: string;
let outside: string;
/** Directories chmod'ed by `deny`, restored (in reverse) by afterEach so the temp tree can be deleted. */
const lockedPaths: string[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-workspace-snapshot-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-workspace-snapshot-outside-"));
});

afterEach(async () => {
  setSystemTime();
  // Reverse order: an outer directory must be listable again before the inner one can be reached.
  for (const target of lockedPaths.splice(0).reverse()) await fs.chmod(target, 0o700).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

type OkSnapshot = Extract<WorkspaceSnapshot, { ok: true }>;

async function snap(since?: number): Promise<OkSnapshot> {
  const result = await snapshotWorkspace(dir, WORKSPACE_SNAPSHOT_LIMITS, since);
  if (!result.ok) throw new Error(`snapshot failed: ${result.reason}: ${result.detail}`);
  return result;
}

const write = async (rel: string, content: string): Promise<void> => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), content);
};

/** Sets mtime/atime of a workspace file to `ms` (epoch milliseconds). */
const setMtime = (rel: string, ms: number): Promise<void> => fs.utimes(path.join(dir, rel), ms / 1000, ms / 1000);

// ---- helpers for the degraded-snapshot tests ----------------------------------------------------

const DIGEST_MASK = 0xffff_ffff_ffff_ffffn;
/** chmod-based cases cannot work on Windows, and root ignores mode bits. */
const noChmod = process.platform === "win32" || process.getuid?.() === 0;

/** Per-entry fingerprint exactly as the walk records it, for pinning `d:` markers. */
const entryHash = (entry: string): bigint => BigInt(Bun.hash.wyhash(entry));

/** The `u:` marker the walk records for an unlistable directory: the directory's own lstat identity. Call it with the
 *  directory in the state the snapshot saw (it lstats the live path). */
async function unreadableHash(rel: string): Promise<bigint> {
  const stat = await fs.lstat(path.join(dir, rel), { bigint: true });
  return entryHash(`u:${rel}:${stat.mode}:${stat.ctimeNs}:${stat.ino}`);
}

/** The digest is the masked sum of the per-path map; a marker that stacked on its `d:` entry would break it. */
function pathSum(snapshot: OkSnapshot): bigint {
  if (!snapshot.paths) throw new Error("ok snapshot has no per-path map");
  let sum = 0n;
  for (const hash of snapshot.paths.values()) sum = (sum + hash) & DIGEST_MASK;
  return sum;
}

/** Like `snap`, with some limits overridden. */
async function snapWith(limits: Partial<WorkspaceSnapshotLimits>, since?: number): Promise<OkSnapshot> {
  const result = await snapshotWorkspace(dir, { ...WORKSPACE_SNAPSHOT_LIMITS, ...limits }, since);
  if (!result.ok) throw new Error(`snapshot failed: ${result.reason}: ${result.detail}`);
  return result;
}

/** chmod 000. Recorded BEFORE the chmod so afterEach restores it even if the test throws; deny an inner path before its parent. */
async function deny(target: string): Promise<void> {
  lockedPaths.push(target);
  await fs.chmod(target, 0o000);
}

/** Freezes the clock. Files stamped just before it are inside the racy window with no wall-clock dependence. */
function freeze(): number {
  const base = Date.now();
  setSystemTime(base);
  return base;
}
const writeFresh = async (rel: string, content: string, base: number): Promise<void> => {
  await write(rel, content);
  await setMtime(rel, base - 100);
};
/** A file a minute old: outside the racy window, so it is stat-fingerprinted only. */
const writeOld = async (rel: string, content: string): Promise<void> => {
  await write(rel, content);
  await setMtime(rel, Date.now() - 60_000);
};

/** Runs `body` with `fs.open` intercepted: `beforeOpen` runs once, right before the real open of `target`, i.e. after
 *  the walk's lstat saw the file. That window is where every racy-hash failure mode lives. */
async function interceptOpen<T>(target: string, beforeOpen: () => Promise<void>, body: () => Promise<T>): Promise<T> {
  const realOpen = fs.open as unknown as (...args: unknown[]) => Promise<unknown>;
  let fired = false;
  const spy = spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
    if (!fired && String(file) === target) { fired = true; await beforeOpen(); }
    return realOpen(file, ...rest);
  }) as unknown as typeof fs.open);
  try {
    const result = await body();
    expect(fired).toBe(true); // a silent no-op hook would make the test below vacuous
    return result;
  } finally {
    spy.mockRestore();
  }
}

/** Runs `body` with `fs[method]` of exactly `target` failing with an errno `code`; every other path reaches the real call. */
async function failFs<T>(method: "readdir" | "lstat", target: string, code: string, body: () => Promise<T>): Promise<T> {
  const real = fs[method] as unknown as (...args: unknown[]) => Promise<unknown>;
  const spy = spyOn(fs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>, method).mockImplementation(async (file, ...rest) => {
    if (String(file) === target) throw Object.assign(new Error(`${code}: injected ${method} failure`), { code });
    return real(file, ...rest);
  });
  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}

test("same-size rewrite in the same tick changes the snapshot", async () => {
  await write("a.txt", "aaaa");
  const before = await snap();
  await write("a.txt", "bbbb");
  const after = await snap(before.startedAtMs);
  expect(workspaceSnapshotChanged(before, after)).toBe(true);
});

// Snapshot start times come from a frozen system clock (setSystemTime) so the bracket is exact; file
// mtimes stay real filesystem values. No wall-clock waiting is involved.
test("racy anchor: an unchanged recently-modified file does not flip the digest across a bracket", async () => {
  const base = Date.now();
  await write("recent.txt", "same content");
  await setMtime("recent.txt", base - 1990);
  setSystemTime(base);
  const before = await snap();
  setSystemTime(base + 50);
  const after = await snap(before.startedAtMs);
  expect(before.startedAtMs).toBe(base);
  expect(after.startedAtMs).toBe(base + 50);
  expect(workspaceSnapshotChanged(before, after)).toBe(false);
  // Control: without the shared anchor the later after-snapshot drops the file from the racy set
  // (mtime base-1990 < (base+50)-2000) and flips the digest. The anchor is what prevents that.
  const unanchored = await snap();
  expect(unanchored.digest).not.toBe(before.digest);
});

test("racy anchor: a same-size rewrite inside the bracket is detected", async () => {
  const base = Date.now();
  await write("recent.txt", "content-one");
  await setMtime("recent.txt", base - 1990);
  setSystemTime(base);
  const before = await snap();
  await write("recent.txt", "content-two");
  setSystemTime(base + 50);
  const after = await snap(before.startedAtMs);
  expect(workspaceSnapshotChanged(before, after)).toBe(true);
});

test("an untouched workspace snapshots identically, and renames, deletes and empty dirs count", async () => {
  await write("src/a.ts", "export const a = 1;\n");
  await write("src/deep/b.ts", "export const b = 2;\n");
  await fs.mkdir(path.join(dir, "empty"));
  const first = await snap();
  const second = await snap(first.startedAtMs);
  expect(workspaceSnapshotChanged(first, second)).toBe(false);
  expect(second.entries).toBe(first.entries);
  expect(first.entries).toBe(5); // src, src/a.ts, src/deep, src/deep/b.ts, empty
  expect(first.degraded).toBe(0); // always set on an ok snapshot, 0 when nothing degraded

  await fs.rename(path.join(dir, "src/a.ts"), path.join(dir, "src/c.ts"));
  const renamed = await snap(first.startedAtMs);
  expect(workspaceSnapshotChanged(first, renamed)).toBe(true);

  await fs.rm(path.join(dir, "src/deep/b.ts"));
  const deleted = await snap(first.startedAtMs);
  expect(workspaceSnapshotChanged(renamed, deleted)).toBe(true);

  await fs.rmdir(path.join(dir, "empty"));
  const removedDir = await snap(first.startedAtMs);
  expect(workspaceSnapshotChanged(deleted, removedDir)).toBe(true);
});

test("excluded directories at any depth do not change the snapshot", async () => {
  expect([...WORKSPACE_SNAPSHOT_EXCLUDED_DIRS].sort()).toEqual([".git", ".jeo", "node_modules"]);
  // Every non-excluded parent exists before the first snapshot; only excluded dirs are created later.
  await fs.mkdir(path.join(dir, "sub", "deeper"), { recursive: true });
  await fs.mkdir(path.join(dir, ".git"));
  await fs.mkdir(path.join(dir, ".jeo"));
  await write("sub/kept.txt", "kept");
  const before = await snap();

  await write(".jeo/state/x.json", "{}");
  await write(".git/index.lock", "lock");
  await write("node_modules/pkg/index.js", "module.exports = 1;");
  await write("sub/node_modules/y.js", "y");
  await write("sub/deeper/.jeo/artifacts/out.txt", "artifact");
  await write("sub/deeper/.git/HEAD", "ref: refs/heads/main");
  const after = await snap(before.startedAtMs);
  expect(workspaceSnapshotChanged(before, after)).toBe(false);
  expect(after.entries).toBe(before.entries);

  // Exclusions match directory names only: a `.git` FILE (worktree pointer) is a normal file.
  await fs.rm(path.join(dir, "sub/deeper/.git"), { recursive: true });
  const withoutNestedGit = await snap(before.startedAtMs);
  await write("sub/deeper/.git", "gitdir: ../../.git/worktrees/x");
  const worktreePointer = await snap(before.startedAtMs);
  expect(workspaceSnapshotChanged(withoutNestedGit, worktreePointer)).toBe(true);
});

test("gitignored files such as .env still count", async () => {
  await write(".gitignore", ".env\n");
  const empty = await snap();
  await write(".env", "TOKEN=one");
  const created = await snap(empty.startedAtMs);
  expect(workspaceSnapshotChanged(empty, created)).toBe(true);
  await write(".env", "TOKEN=two");
  const rewritten = await snap(empty.startedAtMs);
  expect(workspaceSnapshotChanged(created, rewritten)).toBe(true);
});

test("a symlink is recorded, not followed", async () => {
  await fs.writeFile(path.join(outside, "target.txt"), "outside-one");
  await fs.mkdir(path.join(outside, "tree"));
  await fs.writeFile(path.join(outside, "tree", "inner.txt"), "inner");
  await fs.symlink(path.join(outside, "target.txt"), path.join(dir, "file-link"));
  await fs.symlink(path.join(outside, "tree"), path.join(dir, "dir-link"));
  const before = await snap();
  expect(before.entries).toBe(2); // two links; the linked tree is never walked

  await fs.writeFile(path.join(outside, "target.txt"), "outside-two-longer");
  await fs.writeFile(path.join(outside, "tree", "inner.txt"), "inner-changed");
  await fs.writeFile(path.join(outside, "tree", "added.txt"), "added");
  const after = await snap(before.startedAtMs);
  expect(workspaceSnapshotChanged(before, after)).toBe(false);

  // A symlink named like an excluded directory is recorded as a link, never skipped or walked.
  await fs.symlink(path.join(outside, "tree"), path.join(dir, "node_modules"));
  const linkedExcluded = await snap(before.startedAtMs);
  expect(workspaceSnapshotChanged(after, linkedExcluded)).toBe(true);
  expect(linkedExcluded.entries).toBe(3);
});

test("a symlink's target change is detected without following it", async () => {
  // Dangling targets prove the link is read, not followed (following would fail with ENOENT).
  await fs.symlink("missing-one", path.join(dir, "link"));
  const before = await snap();
  await fs.rm(path.join(dir, "link"));
  await fs.symlink("missing-two", path.join(dir, "link"));
  const after = await snap(before.startedAtMs);
  expect(workspaceSnapshotChanged(before, after)).toBe(true);
});

test.skipIf(process.platform === "win32")("a FIFO in the workspace is never read", async () => {
  // Fresh mtime puts the FIFO inside the racy window; opening it for reading would block forever.
  const made = Bun.spawnSync(["mkfifo", path.join(dir, "pipe")]);
  expect(made.exitCode).toBe(0);
  await write("regular.txt", "regular");
  const before = await snap();
  expect(before.entries).toBe(2);
  expect(before.elapsedMs).toBeLessThan(WORKSPACE_SNAPSHOT_LIMITS.maxMs / 4);
  const after = await snap(before.startedAtMs);
  expect(workspaceSnapshotChanged(before, after)).toBe(false);
}, 5_000);

test("defaultWorkspaceSnapshotter forwards the racy anchor", async () => {
  await write("fresh.txt", "fresh content");
  const future = Date.now() + 10_000;
  const viaDefault = await defaultWorkspaceSnapshotter(dir, future);
  const explicit = await snapshotWorkspace(dir, WORKSPACE_SNAPSHOT_LIMITS, future);
  const unanchored = await snapshotWorkspace(dir);
  if (!viaDefault.ok || !explicit.ok || !unanchored.ok) throw new Error("snapshot failed");
  expect(viaDefault.digest).toBe(explicit.digest);
  // A future anchor drops the fresh file from the racy set; the unanchored snapshot hashes it.
  expect(viaDefault.digest).not.toBe(unanchored.digest);
  expect(explicit.digest).not.toBe(unanchored.digest);
});

test("over-cap returns reason cap", async () => {
  await write("one.txt", "1");
  await write("two.txt", "2");
  const capped = await snapshotWorkspace(dir, { ...WORKSPACE_SNAPSHOT_LIMITS, maxEntries: 1 });
  expect(capped).toMatchObject({ ok: false, reason: "cap" });
  const timedOut = await snapshotWorkspace(dir, { ...WORKSPACE_SNAPSHOT_LIMITS, maxMs: -1 });
  expect(timedOut).toMatchObject({ ok: false, reason: "cap" });
  const atCap = await snapshotWorkspace(dir, { ...WORKSPACE_SNAPSHOT_LIMITS, maxEntries: 2 });
  expect(atCap).toMatchObject({ ok: true, entries: 2 });
});

test("a fresh file over the racy byte caps degrades to a stat-only entry; an old one is stat-only regardless", async () => {
  const base = freeze();
  await writeFresh("a.bin", "x".repeat(64), base);
  await writeFresh("b.bin", "y".repeat(64), base);
  const hashed = await snap();
  expect(hashed).toMatchObject({ degraded: 0, entries: 2 });

  // Per-file cap: both files exceed 16 bytes. The snapshot survives and the entries lose their content hash.
  const perFile = await snapWith({ racyMaxFileBytes: 16 });
  expect(perFile).toMatchObject({ ok: true, degraded: 2, entries: 2 });
  expect(perFile.paths?.get("a.bin")).not.toBe(hashed.paths?.get("a.bin"));
  expect(perFile.paths?.get("b.bin")).not.toBe(hashed.paths?.get("b.bin"));

  // Total cap, first-fit in path order: a.bin (64) fits under 100, b.bin would reach 128 and degrades.
  const total = await snapWith({ racyMaxTotalBytes: 100 });
  expect(total).toMatchObject({ ok: true, degraded: 1, entries: 2 });
  expect(total.paths?.get("a.bin")).toBe(hashed.paths?.get("a.bin"));
  expect(total.paths?.get("b.bin")).not.toBe(hashed.paths?.get("b.bin"));

  // Old files are never racy: the caps do not touch them at all.
  await setMtime("a.bin", base - 60_000);
  await setMtime("b.bin", base - 60_000);
  const old = await snapWith({ racyMaxFileBytes: 16, racyMaxTotalBytes: 16 });
  expect(old).toMatchObject({ ok: true, degraded: 0, entries: 2 });
  expect(old.digest).toBe((await snap()).digest);
});

test("missing root returns reason error", async () => {
  expect(await snapshotWorkspace(path.join(dir, "does-not-exist"))).toMatchObject({ ok: false, reason: "error" });
  await write("plain.txt", "not a directory");
  expect(await snapshotWorkspace(path.join(dir, "plain.txt"))).toMatchObject({ ok: false, reason: "error" });
});

// ---------------------------------------------------------------------------------------------
// Degraded snapshots: an unlistable directory or an unhashable racy file costs fidelity for that one
// entry; the snapshot stays ok:true and `degraded` counts it. Roots, caps and unknown errors still fail.
// ---------------------------------------------------------------------------------------------

test.skipIf(noChmod)("an unreadable subdirectory degrades to a u: marker instead of failing the snapshot", async () => {
  await writeOld("locked/secret.txt", "secret");
  await writeOld("open.txt", "open");
  const listable = await snap();
  expect(listable).toMatchObject({ degraded: 0, entries: 3 });
  expect(listable.paths?.get("locked")).toBe(entryHash("d:locked"));

  await deny(path.join(dir, "locked"));
  const result = await snap();
  expect(result).toMatchObject({ ok: true, degraded: 1, entries: 2 });
  expect(pathKeys(result)).toEqual(["locked", "open.txt"]); // the children are skipped, not listed
  expect(result.paths?.get("locked")).toBe(await unreadableHash("locked"));
  expect(result.paths?.get("locked")).not.toBe(listable.paths?.get("locked"));
  // The marker REPLACED the `d:` entry: digest stays the plain sum of the map instead of counting both.
  expect(result.digest).toBe(pathSum(result));
  expect(listable.digest).toBe(pathSum(listable));
});

test.skipIf(noChmod)("an unreadable directory is stable between snapshots; becoming listable and then gaining a child each flip it", async () => {
  await writeOld("locked/secret.txt", "secret");
  const locked = path.join(dir, "locked");
  await deny(locked);
  const first = await snap();
  const second = await snap(first.startedAtMs);
  expect(first.degraded).toBe(1);
  expect(second.degraded).toBe(1);
  expect(workspaceSnapshotChanged(first, second)).toBe(false);
  expect(snapshotChangedPaths(first, second)).toEqual({ added: [], removed: [], modified: [] });

  await fs.chmod(locked, 0o755);
  const listable = await snap(first.startedAtMs);
  expect(listable.degraded).toBe(0);
  expect(workspaceSnapshotChanged(first, listable)).toBe(true);
  expect(snapshotChangedPaths(first, listable)).toEqual({ added: ["locked/secret.txt"], removed: [], modified: ["locked"] });

  await writeOld("locked/new.txt", "new");
  const grown = await snap(first.startedAtMs);
  expect(workspaceSnapshotChanged(listable, grown)).toBe(true);
  expect(snapshotChangedPaths(listable, grown)).toEqual({ added: ["locked/new.txt"], removed: [], modified: [] });
});

test.skipIf(noChmod)("an unreadable ROOT still fails the snapshot, though the same directory degrades as a child", async () => {
  await writeOld("sub/file.txt", "file");
  const sub = path.join(dir, "sub");
  await deny(sub);
  expect(await snapshotWorkspace(sub)).toMatchObject({ ok: false, reason: "error" });
  expect(await snapshotWorkspace(dir)).toMatchObject({ ok: true, degraded: 1 });

  await fs.chmod(sub, 0o755); // control: the failure above was the mode bits, nothing else
  expect(await snapshotWorkspace(sub)).toMatchObject({ ok: true, degraded: 0, entries: 1 });
});

test.skipIf(noChmod)("nested unreadable directories degrade once, at the outermost one, and are stable", async () => {
  await writeOld("a/top.txt", "top");
  await writeOld("a/b/inner/x.txt", "x");
  await writeOld("a/b/c/deep.txt", "deep");
  await deny(path.join(dir, "a/b/c")); // inner first: once `a/b` is denied `a/b/c` cannot be reached
  await deny(path.join(dir, "a/b"));
  const first = await snap();
  expect(first).toMatchObject({ ok: true, degraded: 1, entries: 3 });
  expect(pathKeys(first)).toEqual(["a", "a/b", "a/top.txt"]); // the walk never reaches c, inner or deep.txt
  expect(first.paths?.get("a/b")).toBe(await unreadableHash("a/b"));
  const second = await snap(first.startedAtMs);
  expect(second.degraded).toBe(1);
  expect(workspaceSnapshotChanged(first, second)).toBe(false);

  // Unlocking the outer directory exposes the inner one: still exactly one degraded entry, one level down.
  await fs.chmod(path.join(dir, "a/b"), 0o755);
  const deeper = await snap(first.startedAtMs);
  expect(deeper.degraded).toBe(1);
  expect(workspaceSnapshotChanged(first, deeper)).toBe(true);
  expect(pathKeys(deeper)).toEqual(["a", "a/b", "a/b/c", "a/b/inner", "a/b/inner/x.txt", "a/top.txt"]);
  expect(deeper.paths?.get("a/b")).toBe(entryHash("d:a/b"));
  expect(deeper.paths?.get("a/b/c")).toBe(await unreadableHash("a/b/c"));
});

// Guards the same-user bypass: chmod open, write, chmod shut leaves the mode EXACTLY as it was, so only
// the directory's own ctime in the marker can tell. The snapshot must flip and name the directory.
test.skipIf(noChmod)("chmod-open, write, chmod-shut inside an unreadable directory flips the snapshot and names the directory", async () => {
  await writeOld("locked/old.txt", "old");
  await writeOld("keep.txt", "keep");
  const locked = path.join(dir, "locked");
  await deny(locked);
  const modeBefore = (await fs.lstat(locked)).mode;
  const before = await snap();
  const control = await snap(before.startedAtMs);
  expect(workspaceSnapshotChanged(before, control)).toBe(false); // untouched: stable

  await fs.chmod(locked, 0o700);
  await fs.writeFile(path.join(locked, "new.ts"), "X");
  await fs.chmod(locked, 0o000);
  expect((await fs.lstat(locked)).mode).toBe(modeBefore); // the mode alone cannot show it
  const after = await snap(before.startedAtMs);
  expect(after).toMatchObject({ ok: true, degraded: 1, entries: 2 });
  expect(workspaceSnapshotChanged(before, after)).toBe(true);
  expect(snapshotChangedPaths(before, after)).toEqual({ added: [], removed: [], modified: ["locked"] });
});

// Guards the timestamp half of the marker on its own: a write+execute-only directory takes entries with no
// chmod at all, and creating or removing one updates the directory's ctime.
test.skipIf(noChmod)("creating and removing a child in a write+execute-only directory flips the marker without any chmod", async () => {
  const wx = path.join(dir, "wx");
  await fs.mkdir(wx);
  lockedPaths.push(wx);
  await fs.chmod(wx, 0o300);
  const before = await snap();
  expect(before).toMatchObject({ degraded: 1, entries: 1 });

  await fs.writeFile(path.join(wx, "new.ts"), "X");
  const created = await snap(before.startedAtMs);
  expect(created.degraded).toBe(1);
  expect(snapshotChangedPaths(before, created)).toEqual({ added: [], removed: [], modified: ["wx"] });

  await fs.rm(path.join(wx, "new.ts"));
  const removed = await snap(before.startedAtMs);
  expect(workspaceSnapshotChanged(created, removed)).toBe(true);
  expect(snapshotChangedPaths(created, removed)).toEqual({ added: [], removed: [], modified: ["wx"] });
});

// Guards the readdir error taxonomy without depending on mode bits (so it also runs as root and on
// Windows): permission codes degrade, vanished-directory codes skip, anything else fails the snapshot.
const READDIR_FAILURES = [
  { code: "EACCES", outcome: "degrades to a u: marker" },
  { code: "EPERM", outcome: "degrades to a u: marker" },
  { code: "ENOENT", outcome: "is skipped as a vanished directory" },
  { code: "ENOTDIR", outcome: "is skipped as a vanished directory" },
  { code: "EIO", outcome: "fails the snapshot" },
  { code: "ELOOP", outcome: "fails the snapshot" },
  { code: "EMFILE", outcome: "fails the snapshot" },
] as const;

for (const { code, outcome } of READDIR_FAILURES) {
  test(`readdir ${code} on a subdirectory ${outcome}`, async () => {
    await writeOld("sub/inner.txt", "inner");
    await writeOld("other.txt", "other");
    const result = await failFs("readdir", path.join(dir, "sub"), code, () => snapshotWorkspace(dir));
    if (outcome === "fails the snapshot") {
      expect(result).toMatchObject({ ok: false, reason: "error" });
      return;
    }
    if (!result.ok) throw new Error(`snapshot failed: ${result.reason}: ${result.detail}`);
    expect(pathKeys(result)).toEqual(["other.txt", "sub"]); // sub/inner.txt is never listed
    if (outcome === "degrades to a u: marker") {
      expect(result.degraded).toBe(1);
      expect(result.paths?.get("sub")).toBe(await unreadableHash("sub"));
    } else {
      expect(result.degraded).toBe(0);
      expect(result.paths?.get("sub")).toBe(entryHash("d:sub")); // a vanished dir stays recorded: a real deletion must still show
    }
  });
}

// Guards the marker's own lstat, which runs only after a permission-denied listing (injected too, so these
// need no mode bits): a directory that vanished in between is skipped; any other lstat error is a failure.
const MARKER_LSTAT_FAILURES = [
  { code: "ENOENT", skips: true },
  { code: "ENOTDIR", skips: true },
  { code: "EACCES", skips: false },
  { code: "EPERM", skips: false },
  { code: "EIO", skips: false },
  { code: "EMFILE", skips: false },
] as const;

for (const { code, skips } of MARKER_LSTAT_FAILURES) {
  test(`lstat ${code} on a directory whose listing was denied ${skips ? "skips the directory" : "fails the snapshot"}`, async () => {
    await writeOld("sub/inner.txt", "inner");
    await writeOld("other.txt", "other");
    const sub = path.join(dir, "sub");
    const result = await failFs("readdir", sub, "EACCES", () => failFs("lstat", sub, code, () => snapshotWorkspace(dir)));
    if (!skips) {
      expect(result).toMatchObject({ ok: false, reason: "error" });
      return;
    }
    if (!result.ok) throw new Error(`snapshot failed: ${result.reason}: ${result.detail}`);
    expect(result.degraded).toBe(0); // nothing was recorded for it, so nothing degraded
    expect(pathKeys(result)).toEqual(["other.txt", "sub"]);
    expect(result.paths?.get("sub")).toBe(entryHash("d:sub")); // the parent's listing entry stays: a real deletion must still show
  });
}

test("a fresh file over the default byte caps degrades instead of failing, and an append is still attributed", async () => {
  const base = freeze();
  await writeFresh("big.bin", "x".repeat(2 * 1024 * 1024), base);
  await writeFresh("small.txt", "small", base);
  const before = await snap();
  expect(before).toMatchObject({ ok: true, degraded: 1, entries: 2 }); // only big.bin: small.txt is within the caps
  const again = await snap(before.startedAtMs);
  expect(again.degraded).toBe(1);
  expect(again.digest).toBe(before.digest);
  expect(workspaceSnapshotChanged(before, again)).toBe(false);

  await fs.appendFile(path.join(dir, "big.bin"), "y");
  const after = await snap(before.startedAtMs);
  expect(workspaceSnapshotChanged(before, after)).toBe(true);
  expect(snapshotChangedPaths(before, after)).toEqual({ added: [], removed: [], modified: ["big.bin"] });
});

test("racy total-budget first-fit hashes the same files on every snapshot of an unchanged tree", async () => {
  const base = freeze();
  const sizes = { "a.txt": 10, "b.txt": 20, "c.txt": 5, "d.txt": 20, "e.txt": 5 };
  for (const [rel, size] of Object.entries(sizes)) await writeFresh(rel, "x".repeat(size), base);
  const full = await snap();
  expect(full.degraded).toBe(0);

  // Budget 25, path order, first-fit: a(10) fits; b would reach 30 and degrades; c reaches 15 and e 20 and fit; d would reach 40
  // and degrades. A stop-at-first-miss budget would also degrade c and e (4 degraded), so this pins first-fit.
  const limits = { racyMaxTotalBytes: 25 };
  const first = await snapWith(limits);
  expect(first.degraded).toBe(2);
  for (const rel of ["a.txt", "c.txt", "e.txt"]) expect(first.paths?.get(rel)).toBe(full.paths?.get(rel));
  for (const rel of ["b.txt", "d.txt"]) expect(first.paths?.get(rel)).not.toBe(full.paths?.get(rel));
  for (let i = 0; i < 5; i++) {
    const again = await snapWith(limits, first.startedAtMs);
    expect(again.degraded).toBe(2);
    expect(again.digest).toBe(first.digest);
    expect(workspaceSnapshotChanged(first, again)).toBe(false);
  }
});

test.skipIf(noChmod)("a fresh file that cannot be opened degrades only that file and stays stable", async () => {
  const base = freeze();
  await writeFresh("open.txt", "readable", base);
  await writeFresh("secret.txt", "unreadable", base);
  const secret = path.join(dir, "secret.txt");
  await deny(secret);
  const first = await snap();
  expect(first).toMatchObject({ ok: true, degraded: 1, entries: 2 }); // open.txt is still hashed
  const second = await snap(first.startedAtMs);
  expect(second.degraded).toBe(1);
  expect(second.digest).toBe(first.digest);
  expect(workspaceSnapshotChanged(first, second)).toBe(false);

  await fs.chmod(secret, 0o644); // ctime moves and the file is hashable again: only it shows as modified
  const readable = await snap(first.startedAtMs);
  expect(readable.degraded).toBe(0);
  expect(snapshotChangedPaths(first, readable)).toEqual({ added: [], removed: [], modified: ["secret.txt"] });
});

// Racy-hash failure modes that happen between the walk's lstat and the open/read. Injected by running
// the mutation inside an fs.open hook, so each one is deterministic.
test("a racy file that vanishes before it is opened is dropped, not degraded", async () => {
  const base = freeze();
  await writeFresh("keep.txt", "keep", base);
  await writeFresh("vanish.txt", "vanish", base);
  const target = path.join(dir, "vanish.txt");
  const during = await interceptOpen(target, () => fs.unlink(target), () => snap());
  expect(during).toMatchObject({ ok: true, degraded: 0, entries: 1 });
  expect(pathKeys(during)).toEqual(["keep.txt"]);
  expect(workspaceSnapshotChanged(during, await snap(during.startedAtMs))).toBe(false);
});

const RACY_SWAPS: { name: string; swap: (target: string) => Promise<void> }[] = [
  { name: "grows between lstat and read", swap: target => fs.appendFile(target, " and more") },
  {
    name: "is replaced by another inode between lstat and open",
    swap: async target => {
      // Same size as the original, so only the inode check can notice (a size mismatch would trip the growth check).
      // Created while the original still exists, so the inode numbers cannot be recycled into a match.
      const replacement = path.join(outside, "replacement.txt");
      await fs.writeFile(replacement, "z".repeat((await fs.stat(target)).size));
      await fs.rename(replacement, target);
    },
  },
];

for (const { name, swap } of RACY_SWAPS) {
  test(`a racy file that ${name} degrades to a stat-only entry without failing the snapshot`, async () => {
    const base = freeze();
    await writeFresh("keep.txt", "keep", base);
    await writeFresh("moving.txt", "moving", base);
    const target = path.join(dir, "moving.txt");
    const result = await interceptOpen(target, () => swap(target), () => snap());
    expect(result).toMatchObject({ ok: true, degraded: 1, entries: 2 });
  });
}

test("degraded entries never mask a cap failure", async () => {
  const base = freeze();
  await writeFresh("big.bin", "x".repeat(64), base);
  await write("one.txt", "1");
  await write("two.txt", "2");
  const limits = { racyMaxFileBytes: 16 };
  expect(await snapWith({ ...limits, maxEntries: 3 })).toMatchObject({ degraded: 1, entries: 3 }); // at the cap: still ok
  expect(await snapshotWorkspace(dir, { ...WORKSPACE_SNAPSHOT_LIMITS, ...limits, maxEntries: 2 })).toMatchObject({ ok: false, reason: "cap" });
  expect(await snapshotWorkspace(dir, { ...WORKSPACE_SNAPSHOT_LIMITS, ...limits, maxMs: -1 })).toMatchObject({ ok: false, reason: "cap" });
});

// Guards: the time budget also bounds the post-walk hashing pass. performance.now is shifted inside the
// open hook (after the walk and the pre-hash cap check passed), so no wall-clock waiting is involved.
test("the time cap is enforced while racy files are being hashed", async () => {
  const base = freeze();
  await writeFresh("fresh.txt", "fresh", base);
  const target = path.join(dir, "fresh.txt");
  let shiftMs = 0;
  const realNow = performance.now.bind(performance);
  const clock = spyOn(performance, "now").mockImplementation(() => realNow() + shiftMs);
  try {
    const result = await interceptOpen(target, async () => { shiftMs = 60_000; }, () => snapshotWorkspace(dir));
    expect(result).toMatchObject({ ok: false, reason: "cap" });
  } finally {
    clock.mockRestore();
  }
  expect(await snap()).toMatchObject({ ok: true, degraded: 0, entries: 1 }); // control: the same tree is fine on the real clock
});

test("a deleted non-racy file changes the snapshot and is attributed as removed", async () => {
  await writeOld("keep.txt", "keep");
  await writeOld("gone.txt", "gone");
  const before = await snap();
  expect(before).toMatchObject({ degraded: 0, entries: 2 });
  await fs.rm(path.join(dir, "gone.txt"));
  const after = await snap(before.startedAtMs);
  expect(after).toMatchObject({ degraded: 0, entries: 1 });
  expect(workspaceSnapshotChanged(before, after)).toBe(true);
  expect(snapshotChangedPaths(before, after)).toEqual({ added: [], removed: ["gone.txt"], modified: [] });
});

test("workspaceSnapshotChanged is true when either side failed", () => {
  const ok: WorkspaceSnapshot = { ok: true, digest: 42n, entries: 3, elapsedMs: 1, startedAtMs: 1 };
  const failed: WorkspaceSnapshot = { ok: false, reason: "error", detail: "boom" };
  const capped: WorkspaceSnapshot = { ok: false, reason: "cap", detail: "too many" };
  expect(workspaceSnapshotChanged(ok, failed)).toBe(true);
  expect(workspaceSnapshotChanged(failed, ok)).toBe(true);
  expect(workspaceSnapshotChanged(capped, capped)).toBe(true);
  expect(workspaceSnapshotChanged(ok, { ...ok, elapsedMs: 9, startedAtMs: 9 })).toBe(false);
  expect(workspaceSnapshotChanged(ok, { ...ok, digest: 43n })).toBe(true);
  expect(workspaceSnapshotChanged(ok, { ...ok, entries: 4 })).toBe(true);
});

// ---------------------------------------------------------------------------------------------
// Per-path attribution: snapshotChangedPaths / formatSnapshotChange / isSharedScratchRoot.
// ---------------------------------------------------------------------------------------------

const NO_CHANGE: SnapshotPathChange = { added: [], removed: [], modified: [] };

/** Sorted keys of a real snapshot's per-path map; throws when the snapshot carries none. */
function pathKeys(snapshot: OkSnapshot): string[] {
  if (!snapshot.paths) throw new Error("ok snapshot has no per-path map");
  return [...snapshot.paths.keys()].sort();
}

/** Hand-built ok snapshot. digest/entries are deliberately constant: only the per-path map differs. */
const handBuilt = (paths: Record<string, bigint>): OkSnapshot => ({
  ok: true,
  digest: 0n,
  entries: Object.keys(paths).length,
  elapsedMs: 0,
  startedAtMs: 0,
  paths: new Map(Object.entries(paths)),
});

// Guards: the per-path attribution itself. A digest-only snapshot could say "something changed" but
// never name the file; the gate message and the shared-scratch heuristics both need the exact path.
test("snapshotChangedPaths names a modify, an add, a remove and a directory add by exact relative path", async () => {
  await write("keep/same.txt", "same");
  await write("keep/edit.txt", "before");
  await write("gone.txt", "gone");
  await write("top.txt", "top");
  const before = await snap();

  await write("keep/edit.txt", "after!");
  await fs.rm(path.join(dir, "gone.txt"));
  await write("keep/added.txt", "new");
  await write("fresh/inner/leaf.txt", "leaf");
  const after = await snap(before.startedAtMs);

  // Sorted per bucket. `keep` (its mtime moved because an entry was added) and the untouched files
  // are absent: only fingerprinted entries are reported, and directories by name alone.
  expect(snapshotChangedPaths(before, after)).toEqual({
    added: ["fresh", "fresh/inner", "fresh/inner/leaf.txt", "keep/added.txt"],
    removed: ["gone.txt"],
    modified: ["keep/edit.txt"],
  });
  // Reverse direction swaps added/removed and keeps the modify.
  expect(snapshotChangedPaths(after, before)).toEqual({
    added: ["gone.txt"],
    removed: ["fresh", "fresh/inner", "fresh/inner/leaf.txt", "keep/added.txt"],
    modified: ["keep/edit.txt"],
  });
});

// Guards: an empty directory added on its own is still a reported path (directories are keyed too).
test("snapshotChangedPaths reports an empty directory add and remove, and nothing for a quiet workspace", async () => {
  await write("a.txt", "a");
  const before = await snap();
  await fs.mkdir(path.join(dir, "emptydir"));
  const withDir = await snap(before.startedAtMs);
  expect(snapshotChangedPaths(before, withDir)).toEqual({ added: ["emptydir"], removed: [], modified: [] });
  await fs.rmdir(path.join(dir, "emptydir"));
  const withoutDir = await snap(before.startedAtMs);
  expect(snapshotChangedPaths(withDir, withoutDir)).toEqual({ added: [], removed: ["emptydir"], modified: [] });
  expect(snapshotChangedPaths(before, withoutDir)).toEqual(NO_CHANGE);
});

// Guards: no spurious paths. Also pins the shape of the map: relative `/`-separated keys, directories
// keyed by their own path, no root entry, one key per counted entry, excluded dirs absent.
test("an untouched workspace yields all-empty lists and a per-path map keyed by relative path", async () => {
  await write("src/a.ts", "export const a = 1;\n");
  await write("src/deep/b.ts", "export const b = 2;\n");
  await write(".gitignore", ".env\n");
  await fs.mkdir(path.join(dir, "empty"));
  await fs.symlink("missing-target", path.join(dir, "link"));
  await write("node_modules/pkg/index.js", "module.exports = 1;");
  await write("src/.jeo/y.json", "{}");
  await fs.mkdir(path.join(dir, ".git"));

  const first = await snap();
  const second = await snap(first.startedAtMs);
  expect(snapshotChangedPaths(first, second)).toEqual(NO_CHANGE);
  expect(workspaceSnapshotChanged(first, second)).toBe(false);
  expect(pathKeys(first)).toEqual(
    [".gitignore", "empty", "link", "src", "src/a.ts", "src/deep", "src/deep/b.ts"].sort(),
  );
  expect(first.paths?.size).toBe(first.entries);
});

// Guards: the exclusion rule survives the per-path map. Writes under .git/.jeo/node_modules at any
// depth must not be attributed to a command, while a real edit next to them still is.
test("writes under .git, .jeo and node_modules never appear in the path diff", async () => {
  await write("sub/kept.txt", "kept");
  const before = await snap();

  await write(".git/index.lock", "lock");
  await write(".jeo/state/x.json", "{}");
  await write("node_modules/pkg/index.js", "module.exports = 1;");
  await write("sub/node_modules/y.js", "y");
  await write("sub/.git/HEAD", "ref: refs/heads/main");
  await write("sub/.jeo/artifacts/out.txt", "artifact");
  const onlyExcluded = await snap(before.startedAtMs);
  expect(snapshotChangedPaths(before, onlyExcluded)).toEqual(NO_CHANGE);
  expect(workspaceSnapshotChanged(before, onlyExcluded)).toBe(false);

  await write("sub/kept.txt", "kept-and-edited");
  const withRealEdit = await snap(before.startedAtMs);
  expect(snapshotChangedPaths(before, withRealEdit)).toEqual({ added: [], removed: [], modified: ["sub/kept.txt"] });
  const segments = pathKeys(withRealEdit).flatMap(key => key.split("/"));
  expect(segments.filter(segment => WORKSPACE_SNAPSHOT_EXCLUDED_DIRS.has(segment))).toEqual([]);
});

// Guards: buckets come out sorted regardless of walk order (readdir order and the 64-way concurrent
// walk are unspecified), and the diff reads only the per-path map, never digest/entries.
test("snapshotChangedPaths sorts every bucket and classifies by per-path fingerprint alone", () => {
  // Insertion order is deliberately reverse-sorted within each bucket; digest/entries are identical.
  const before = handBuilt({ "zz/mod": 1n, "aa/mod": 1n, same: 7n, "zz/rem": 1n, "aa/rem": 1n });
  const after = handBuilt({ "zz/mod": 2n, "aa/mod": 2n, same: 7n, "zz/add": 1n, "aa/add": 1n });
  expect(snapshotChangedPaths(before, after)).toEqual({
    added: ["aa/add", "zz/add"],
    removed: ["aa/rem", "zz/rem"],
    modified: ["aa/mod", "zz/mod"],
  });
  expect(snapshotChangedPaths(before, before)).toEqual(NO_CHANGE);
});

// Guards: the verdict and the diff may never disagree. A "changed" verdict with an empty diff would
// make the gate message say nothing; an unchanged verdict with a non-empty diff would blame a command
// for nothing. Detection of a chmod-only change depends on filesystem timestamp granularity (ctime may
// share a tick with the file's creation), so that row only requires agreement, not detection.
interface Mutation {
  name: string;
  seed: () => Promise<void>;
  mutate: () => Promise<void>;
  expected: SnapshotPathChange;
  detectionOptional?: boolean;
}

const MUTATIONS: Mutation[] = [
  {
    name: "no mutation",
    seed: () => write("a.txt", "aaaa"),
    mutate: async () => {},
    expected: NO_CHANGE,
  },
  {
    name: "same-size rewrite",
    seed: async () => { await write("a.txt", "aaaa"); await write("b.txt", "bbbb"); },
    mutate: () => write("a.txt", "cccc"),
    expected: { added: [], removed: [], modified: ["a.txt"] },
  },
  {
    name: "chmod only",
    seed: () => write("a.txt", "aaaa"),
    mutate: () => fs.chmod(path.join(dir, "a.txt"), 0o600),
    expected: { added: [], removed: [], modified: ["a.txt"] },
    detectionOptional: true,
  },
  {
    name: "symlink retarget",
    seed: () => fs.symlink("missing-one", path.join(dir, "link")),
    mutate: async () => {
      await fs.rm(path.join(dir, "link"));
      await fs.symlink("missing-two", path.join(dir, "link"));
    },
    expected: { added: [], removed: [], modified: ["link"] },
  },
  {
    name: "file rename",
    seed: () => write("old.txt", "payload"),
    mutate: () => fs.rename(path.join(dir, "old.txt"), path.join(dir, "new.txt")),
    expected: { added: ["new.txt"], removed: ["old.txt"], modified: [] },
  },
  {
    name: "directory rename",
    seed: () => write("d/f.txt", "payload"),
    mutate: () => fs.rename(path.join(dir, "d"), path.join(dir, "e")),
    expected: { added: ["e", "e/f.txt"], removed: ["d", "d/f.txt"], modified: [] },
  },
  {
    name: "delete",
    seed: async () => { await write("gone.txt", "gone"); await write("keep.txt", "keep"); },
    mutate: () => fs.rm(path.join(dir, "gone.txt")),
    expected: { added: [], removed: ["gone.txt"], modified: [] },
  },
  {
    name: "file replaced by a directory of the same name",
    seed: () => write("x", "file"),
    mutate: async () => {
      await fs.rm(path.join(dir, "x"));
      await fs.mkdir(path.join(dir, "x"));
    },
    expected: { added: [], removed: [], modified: ["x"] },
  },
  {
    name: "same basename in two directories, only one edited",
    seed: async () => { await write("one/same.txt", "same"); await write("two/same.txt", "same"); },
    mutate: () => write("two/same.txt", "diff"),
    expected: { added: [], removed: [], modified: ["two/same.txt"] },
  },
];

for (const row of MUTATIONS) {
  test(`verdict and path diff agree: ${row.name}`, async () => {
    await row.seed();
    const before = await snap();
    await row.mutate();
    const after = await snap(before.startedAtMs);

    const change = snapshotChangedPaths(before, after);
    if (!change) throw new Error("real snapshots must carry per-path maps");
    const changed = workspaceSnapshotChanged(before, after);

    expect(changed).toBe(Object.values(change).some(list => list.length > 0)); // the invariant: verdict <=> non-empty diff
    if (row.detectionOptional && !changed) {
      expect(change).toEqual(NO_CHANGE);
    } else {
      expect(change).toEqual(row.expected);
      expect(changed).toBe(Object.values(row.expected).some(list => list.length > 0));
    }
  });
}

// Guards: a failed or map-less side must read as "cannot say" (null), never as "nothing changed".
// Also pins that an empty workspace is a valid baseline (its map is an empty Map, not absent).
test("snapshotChangedPaths returns null when either side failed or carries no per-path map", async () => {
  await write("a.txt", "a");
  const ok = await snap();
  const failed: WorkspaceSnapshot = { ok: false, reason: "error", detail: "boom" };
  const capped: WorkspaceSnapshot = { ok: false, reason: "cap", detail: "too many" };
  const noPaths: WorkspaceSnapshot = { ok: true, digest: 1n, entries: 1, elapsedMs: 0, startedAtMs: 0 };

  expect(snapshotChangedPaths(failed, ok)).toBeNull();
  expect(snapshotChangedPaths(ok, failed)).toBeNull();
  expect(snapshotChangedPaths(capped, ok)).toBeNull();
  expect(snapshotChangedPaths(failed, capped)).toBeNull();
  expect(snapshotChangedPaths(noPaths, ok)).toBeNull();
  expect(snapshotChangedPaths(ok, noPaths)).toBeNull();
  expect(snapshotChangedPaths(noPaths, noPaths)).toBeNull();
  expect(snapshotChangedPaths(ok, ok)).toEqual(NO_CHANGE); // control: both sides usable

  await fs.rm(path.join(dir, "a.txt"));
  const empty = await snap(ok.startedAtMs);
  expect(empty.paths).toBeInstanceOf(Map);
  expect(empty.paths?.size).toBe(0);
  expect(snapshotChangedPaths(empty, ok)).toEqual({ added: ["a.txt"], removed: [], modified: [] });
  expect(snapshotChangedPaths(ok, empty)).toEqual({ added: [], removed: ["a.txt"], modified: [] });
});

// Guards: bucket order (modified, added, removed) and the exact "+N more" count around the limit.
test("formatSnapshotChange orders modified, added, removed regardless of field order", () => {
  const change: SnapshotPathChange = { removed: ["r1"], added: ["a1", "a2"], modified: ["src/deep/m1.ts"] };
  expect(formatSnapshotChange(change)).toBe("modified src/deep/m1.ts; added a1; added a2; removed r1");
});

test("formatSnapshotChange truncates with an exact (+N more) count at limit-1, limit and limit+1", () => {
  const change: SnapshotPathChange = { modified: ["m1"], added: ["a1", "a2"], removed: ["r1"] }; // 4 items
  expect(formatSnapshotChange(change, 5)).toBe("modified m1; added a1; added a2; removed r1"); // 4 = limit-1
  expect(formatSnapshotChange(change, 4)).toBe("modified m1; added a1; added a2; removed r1"); // 4 = limit
  expect(formatSnapshotChange(change, 3)).toBe("modified m1; added a1; added a2 (+1 more)"); // 4 = limit+1
  expect(formatSnapshotChange(change, 2)).toBe("modified m1; added a1 (+2 more)");
  expect(formatSnapshotChange(change, 1)).toBe("modified m1 (+3 more)");
});

test("formatSnapshotChange defaults to a limit of 5 and drops from the end of the list", () => {
  const at = (n: number): SnapshotPathChange => ({ modified: [], removed: [], added: Array.from({ length: n }, (_, i) => `f${i + 1}`) });
  expect(formatSnapshotChange(at(4))).toBe("added f1; added f2; added f3; added f4");
  expect(formatSnapshotChange(at(5))).toBe("added f1; added f2; added f3; added f4; added f5");
  expect(formatSnapshotChange(at(6))).toBe("added f1; added f2; added f3; added f4; added f5 (+1 more)");
  expect(formatSnapshotChange(at(12))).toBe("added f1; added f2; added f3; added f4; added f5 (+7 more)");
});

test("formatSnapshotChange says so when there is no path-level difference", () => {
  expect(formatSnapshotChange(NO_CHANGE)).toBe("no path-level difference");
  expect(formatSnapshotChange(NO_CHANGE, 1)).toBe("no path-level difference");
});

// Guards: the two pure helpers compose on real snapshots into the text the gate message embeds.
test("a real snapshot pair formats into the exact notice text", async () => {
  await write("a.txt", "one");
  await write("b.txt", "two");
  const before = await snap();
  await write("a.txt", "one!");
  await write("c.txt", "three");
  await fs.rm(path.join(dir, "b.txt"));
  const after = await snap(before.startedAtMs);
  const change = snapshotChangedPaths(before, after);
  if (!change) throw new Error("real snapshots must carry per-path maps");
  expect(formatSnapshotChange(change)).toBe("modified a.txt; added c.txt; removed b.txt");
});

// ---- isSharedScratchRoot ----------------------------------------------------------------------

// Guards: every spelling of a scratch root is recognised after realpath. On macOS os.tmpdir() lives
// under /var/folders while shells use /tmp, so the conventional dirs are checked independently.
test("isSharedScratchRoot: the system temp dir is shared however it is spelled", async () => {
  const tmp = os.tmpdir();
  const link = path.join(outside, "tmp-link");
  await fs.symlink(tmp, link, "dir");
  try {
    expect(isSharedScratchRoot(tmp)).toBe(true);
    expect(isSharedScratchRoot(await fs.realpath(tmp))).toBe(true);
    expect(isSharedScratchRoot(tmp + path.sep)).toBe(true);
    expect(isSharedScratchRoot(link)).toBe(true);
    expect(isSharedScratchRoot("/tmp")).toBe(true);
    expect(isSharedScratchRoot("/var/tmp")).toBe(true);
  } finally {
    await fs.unlink(link);
  }
});

test("isSharedScratchRoot: $HOME and the filesystem root are shared, also through a symlink", async () => {
  const root = path.parse(path.resolve(dir)).root;
  const link = path.join(outside, "home-link");
  await fs.symlink(os.homedir(), link, "dir");
  try {
    expect(isSharedScratchRoot(os.homedir())).toBe(true);
    expect(isSharedScratchRoot(root)).toBe(true);
    expect(isSharedScratchRoot(link)).toBe(true);
  } finally {
    await fs.unlink(link);
  }
});

// Guards: equality, not containment. `dir` is a fresh mkdtemp inside the temp dir -- the exact shape
// of a real project under a scratch root -- and must stay gated, as must symlinks that lead to it.
test("isSharedScratchRoot: a project directory nested inside a scratch root is not shared", async () => {
  expect(isSharedScratchRoot(dir)).toBe(false);
  await fs.mkdir(path.join(dir, "pkg", "app"), { recursive: true });
  expect(isSharedScratchRoot(path.join(dir, "pkg", "app"))).toBe(false);
  const link = path.join(outside, "dir-link");
  await fs.symlink(dir, link, "dir");
  try {
    expect(isSharedScratchRoot(link)).toBe(false);
  } finally {
    await fs.unlink(link);
  }
});

// Guards: same equality rule for $HOME, hermetically. os.homedir() ignores a runtime $HOME change
// under Bun, so a temp dir stands in for home through the `roots` argument.
test("isSharedScratchRoot: a subdirectory of a home-like root, or a symlink to it, is not shared", async () => {
  const home = path.join(outside, "home");
  const project = path.join(home, "work", "app");
  await fs.mkdir(project, { recursive: true });
  const projectLink = path.join(outside, "project-link");
  const homeLink = path.join(outside, "home-link");
  await fs.symlink(project, projectLink, "dir");
  await fs.symlink(home, homeLink, "dir");
  try {
    expect(isSharedScratchRoot(home, [home])).toBe(true);
    expect(isSharedScratchRoot(project, [home])).toBe(false);
    expect(isSharedScratchRoot(projectLink, [home])).toBe(false);
    expect(isSharedScratchRoot(homeLink, [home])).toBe(true); // a link TO the root is the root
    expect(isSharedScratchRoot(home, [homeLink])).toBe(true); // a root given as a link resolves too
  } finally {
    await fs.unlink(projectLink);
    await fs.unlink(homeLink);
  }
});

// Guards: the default roots use equality against the REAL $HOME. Read-only; skipped when this checkout
// does not live under $HOME (CI).
const checkoutDir = import.meta.dir;
const checkoutUnderHome = ((): boolean => {
  try {
    const home = realpathSync(os.homedir());
    const here = realpathSync(checkoutDir);
    return here !== home && here.startsWith(home + path.sep);
  } catch {
    return false;
  }
})();

test.skipIf(!checkoutUnderHome)("isSharedScratchRoot: with the default roots, a directory inside the real $HOME is not shared", async () => {
  expect(isSharedScratchRoot(checkoutDir)).toBe(false);
  const link = path.join(outside, "checkout-link");
  await fs.symlink(checkoutDir, link, "dir");
  try {
    expect(isSharedScratchRoot(link)).toBe(false);
  } finally {
    await fs.unlink(link);
  }
});

// Guards: `roots` REPLACES the defaults (no silent merge) and every listed root is matched exactly.
test("isSharedScratchRoot: a custom roots list replaces the defaults", async () => {
  const link = path.join(outside, "dir-link");
  await fs.symlink(dir, link, "dir");
  try {
    expect(isSharedScratchRoot(dir, [dir])).toBe(true);
    expect(isSharedScratchRoot(os.tmpdir(), [dir])).toBe(false); // default tmp root not merged in
    expect(isSharedScratchRoot(os.homedir(), [dir])).toBe(false); // default home root not merged in
    expect(isSharedScratchRoot(os.tmpdir(), [])).toBe(false);
    expect(isSharedScratchRoot(dir, [os.tmpdir()])).toBe(false); // a root matches itself, not its children
    expect(isSharedScratchRoot(dir, [link])).toBe(true); // roots are realpath'd like cwd
    expect(isSharedScratchRoot(dir, ["/no/such/root", dir])).toBe(true); // any listed root may match
  } finally {
    await fs.unlink(link);
  }
});

// Guards: callers pass arbitrary cwd strings; resolution failures must degrade to the normalized
// spelling, never throw (ENOENT, ELOOP, invalid-argument).
test("isSharedScratchRoot: an unresolvable cwd never throws and falls back to its normalized spelling", async () => {
  const ghost = path.join(dir, "ghost");
  expect(isSharedScratchRoot(ghost)).toBe(false);
  expect(isSharedScratchRoot(path.join(ghost, "deeper", "still"))).toBe(false);
  // Fallback is path.resolve: a missing dir listed as a root matches itself in any spelling, not its children.
  expect(isSharedScratchRoot(ghost, [ghost])).toBe(true);
  expect(isSharedScratchRoot(`${ghost}${path.sep}x${path.sep}..`, [ghost])).toBe(true);
  expect(isSharedScratchRoot(path.join(ghost, "x"), [ghost])).toBe(false);

  const dangling = path.join(dir, "dangling");
  await fs.symlink(path.join(dir, "nowhere"), dangling);
  const loopA = path.join(dir, "loop-a");
  const loopB = path.join(dir, "loop-b");
  await fs.symlink(loopB, loopA);
  await fs.symlink(loopA, loopB);
  expect(isSharedScratchRoot(dangling)).toBe(false);
  expect(isSharedScratchRoot(loopA)).toBe(false);
  expect(isSharedScratchRoot("bad\0path")).toBe(false);
});
