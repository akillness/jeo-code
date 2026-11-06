import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
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
