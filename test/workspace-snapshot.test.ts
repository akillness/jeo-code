import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  WORKSPACE_SNAPSHOT_EXCLUDED_DIRS,
  WORKSPACE_SNAPSHOT_LIMITS,
  defaultWorkspaceSnapshotter,
  snapshotWorkspace,
  workspaceSnapshotChanged,
  type WorkspaceSnapshot,
} from "../src/agent/workspace-snapshot";

let dir: string;
let outside: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-workspace-snapshot-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-workspace-snapshot-outside-"));
});

afterEach(async () => {
  setSystemTime();
  await fs.chmod(path.join(dir, "locked"), 0o700).catch(() => {});
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

test("a fresh file over the racy byte caps returns reason error; an old one is stat-only", async () => {
  await write("big.bin", "x".repeat(64));
  const tooBig = await snapshotWorkspace(dir, { ...WORKSPACE_SNAPSHOT_LIMITS, racyMaxFileBytes: 16 });
  expect(tooBig).toMatchObject({ ok: false, reason: "error" });
  await write("big2.bin", "y".repeat(64));
  const tooMuch = await snapshotWorkspace(dir, { ...WORKSPACE_SNAPSHOT_LIMITS, racyMaxTotalBytes: 100 });
  expect(tooMuch).toMatchObject({ ok: false, reason: "error" });
  await setMtime("big.bin", Date.now() - 60_000);
  await setMtime("big2.bin", Date.now() - 60_000);
  const old = await snapshotWorkspace(dir, { ...WORKSPACE_SNAPSHOT_LIMITS, racyMaxFileBytes: 16, racyMaxTotalBytes: 16 });
  expect(old).toMatchObject({ ok: true, entries: 2 });
});

test("missing root returns reason error", async () => {
  expect(await snapshotWorkspace(path.join(dir, "does-not-exist"))).toMatchObject({ ok: false, reason: "error" });
  await write("plain.txt", "not a directory");
  expect(await snapshotWorkspace(path.join(dir, "plain.txt"))).toMatchObject({ ok: false, reason: "error" });
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable subdirectory returns reason error", async () => {
  await write("locked/secret.txt", "secret");
  await fs.chmod(path.join(dir, "locked"), 0o000);
  expect(await snapshotWorkspace(dir)).toMatchObject({ ok: false, reason: "error" });
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
