import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describeSnapshotTarget, snapshotTarget, snapshotTargetLabel } from "../src/agent/snapshot-target";

/**
 * `snapshotTarget` decides WHICH directory the done gate's before/after bracket measures for one bash call from a
 * shared scratch cwd. Every row below uses a real mkdtemp tree and an explicit `scratchRoots` list (never the real
 * $HOME or temp dir). A wrong answer measures the wrong tree in production: either an edit made through a scratch
 * cwd stays invisible to the gate, or an unmeasurable/unrelated tree is walked and blamed on the call.
 */

let root: string;
let savedCdpath: string | undefined;
const dirs: string[] = [];

/** realpath'd so assertions compare against exactly what the implementation resolves (macOS /var -> /private/var). */
async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** Drops a project marker into `dir`: without one a nested target is not a project and is never bracketed. */
const mark = async (dir: string, marker = "package.json"): Promise<string> => {
  await fs.writeFile(path.join(dir, marker), "{}");
  return dir;
};

/** A directory under `root` with NO marker anywhere on the way down, for the marker-less cases. */
const mkBare = async (...parts: string[]): Promise<string> => {
  const dir = path.join(root, ...parts);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

/** Every segment of the path is a project (carries a marker), so a `cd` that stops at any of them is a target. */
const mk = async (...parts: string[]): Promise<string> => {
  const dir = await mkBare(...parts);
  for (let i = 1; i <= parts.length; i++) await mark(path.join(root, ...parts.slice(0, i)));
  return dir;
};

/** Single-quoted so an unusual TMPDIR character can never change how the command parses. */
const q = (p: string): string => `'${p}'`;

const bash = (cwd: string, args: Record<string, unknown> | undefined, roots: readonly string[] | undefined = [root]) =>
  snapshotTarget(cwd, "bash", args, roots);

beforeEach(async () => {
  // A CDPATH inherited from the developer's shell would silently turn every relative `cd` below into "ambiguous".
  savedCdpath = process.env.CDPATH;
  delete process.env.CDPATH;
  root = await tmpDir("jeo-snapshot-target-");
});

afterEach(async () => {
  if (savedCdpath === undefined) delete process.env.CDPATH;
  else process.env.CDPATH = savedCdpath;
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

// --- a leading literal `cd` is followed ---

for (const row of [
  { name: "no cd at all", command: "ls -la", expected: "" },
  { name: "cd terminated by &&", command: "cd nested && make", expected: "nested" },
  { name: "cd terminated by ;", command: "cd nested; make", expected: "nested" },
  { name: "cd terminated by a newline", command: "cd nested\nmake", expected: "nested" },
  { name: "cd terminated by a CRLF newline", command: "cd nested\r\nmake", expected: "nested" },
  { name: "leading whitespace and a tab around the path", command: "  cd\tnested  && make", expected: "nested" },
  { name: "no space before &&", command: "cd nested&& make", expected: "nested" },
  { name: "a ./ relative path", command: "cd ./nested && make", expected: "nested" },
  { name: "a trailing slash", command: "cd nested/ && make", expected: "nested" },
  { name: "a multi-segment path resolves to its project root", command: "cd nested/deep && make", expected: "nested" },
  { name: "a single-quoted path", command: "cd 'nested' && make", expected: "nested" },
  { name: "a double-quoted path", command: 'cd "nested" && make', expected: "nested" },
  { name: "a single-quoted path containing a space", command: "cd 'with space' && make", expected: "with space" },
  { name: "a double-quoted path containing a space", command: 'cd "with space" && make', expected: "with space" },
  { name: "a single-quoted path whose text looks like an expansion", command: "cd '$LIT' && make", expected: "$LIT" },
]) {
  test(`snapshotTarget: ${row.name} -> ${row.expected === "" ? "cwd itself" : "the project root (absolute)"}`, async () => {
    await mk("nested", "deep");
    await mk("with space");
    await mk("$LIT");
    expect(bash(root, { command: row.command })).toBe(row.expected === "" ? root : path.join(root, row.expected));
  });
}

test("snapshotTarget: cd . stays in the scratch cwd, so there is no nested target", () => {
  // Returning an absolute alias of the cwd would make the engine bracket the very tree it must not measure.
  expect(bash(root, { command: "cd . && make" })).toBe(root);
});

test("snapshotTarget: cd chains are followed hop by hop to the last existing directory", async () => {
  // Sibling projects, so the directory the chain ENDS in is told apart from every directory it passed through.
  const a = await mk("a");
  await mk("b");
  await mk("c");
  expect(bash(root, { command: "cd a && cd ../b && make" })).toBe(path.join(root, "b"));
  expect(bash(root, { command: "cd a; cd ../c\nmake" })).toBe(path.join(root, "c"));
  // The second hop resolves against the first: from the scratch root `../b` would leave it and not exist.
  expect(bash(root, { command: "cd ../b && make" })).toBe(root);
  // A hop that cannot be followed stops the chain at the last good directory, not at the cwd.
  expect(bash(root, { command: "cd a && cd missing && make" })).toBe(a);
  expect(bash(root, { command: "cd a && cd $X && make" })).toBe(a);
  expect(bash(root, { command: "cd a && make && cd ../b" })).toBe(a);
});

test("snapshotTarget: at most 8 leading cd hops are followed", async () => {
  const names = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);
  for (const name of names) await mk(name);
  // Ten sibling projects visited in turn: the 8th is where the chain stops, the 9th and 10th are never reached.
  const command = `${names.map((name, i) => (i === 0 ? `cd ${name}` : `cd ../${name}`)).join(" && ")} && make`;
  expect(bash(root, { command })).toBe(path.join(root, "p8"));
});

test("snapshotTarget: the command may arrive as `cmd` instead of `command`", async () => {
  await mk("nested");
  expect(bash(root, { cmd: "cd nested && make" })).toBe(path.join(root, "nested"));
});

// --- the bash tool's own cwd / subdir arguments ---

test("snapshotTarget: args.subdir names the run directory", async () => {
  await mk("sub");
  expect(bash(root, { command: "make", subdir: "sub" })).toBe(path.join(root, "sub"));
});

test("snapshotTarget: args.cwd names the run directory, resolved against the cwd", async () => {
  await mk("one");
  await mk("two");
  expect(bash(root, { command: "make", cwd: "one" })).toBe(path.join(root, "one"));
  expect(bash(root, { command: "make", cwd: path.join(root, "two") })).toBe(path.join(root, "two"));
});

test("snapshotTarget: args.cwd beats args.subdir, and an empty args.cwd does not fall through to it", async () => {
  // Mirrors the bash handler: `typeof a.cwd === "string" ? a.cwd : a.subdir`, then `subdir ? resolve : cwd`.
  await mk("one");
  await mk("two");
  expect(bash(root, { command: "make", cwd: "one", subdir: "two" })).toBe(path.join(root, "one"));
  expect(bash(root, { command: "make", cwd: "", subdir: "two" })).toBe(root);
  expect(bash(root, { command: "make", cwd: 42, subdir: "two" })).toBe(path.join(root, "two"));
});

test("snapshotTarget: a cd inside the command is followed from the args.cwd / args.subdir directory", async () => {
  await mk("proj");
  await mk("other");
  expect(bash(root, { command: "cd ../other && make", cwd: "proj" })).toBe(path.join(root, "other"));
  expect(bash(root, { command: "cd ../other && make", subdir: "proj" })).toBe(path.join(root, "other"));
  // The same `cd ../other` from the scratch root itself leaves it and does not exist: proof the base really moved.
  expect(bash(root, { command: "cd ../other && make" })).toBe(root);
});

test("snapshotTarget: a run directory that does not exist or is a file means no nested target", async () => {
  await mk("real");
  await fs.writeFile(path.join(root, "afile"), "x");
  expect(bash(root, { command: "cd real && make", cwd: "ghost" })).toBe(root);
  expect(bash(root, { command: "make", subdir: "ghost" })).toBe(root);
  expect(bash(root, { command: "make", cwd: "afile" })).toBe(root);
});

// --- hops that are not modelled stop the chain ---

test("snapshotTarget: a cd into a nonexistent path or a file is no target", async () => {
  await fs.writeFile(path.join(root, "afile"), "x");
  expect(bash(root, { command: "cd ghost && make" })).toBe(root);
  expect(bash(root, { command: "cd afile && make" })).toBe(root);
});

for (const row of [
  { name: "a variable", command: "cd $X && make" },
  { name: "a braced variable", command: "cd ${X} && make" },
  { name: "a glob", command: "cd * && make" },
  { name: "a character-class glob", command: "cd [a]* && make" },
  { name: "a brace expansion", command: "cd {a,b} && make" },
  { name: "a double-quoted variable", command: 'cd "$X" && make' },
  { name: "a double-quoted backtick substitution", command: 'cd "`pwd`" && make' },
  { name: "a double-quoted backslash escape", command: 'cd "a\\ b" && make' },
  { name: "a command substitution", command: "cd $(pwd)/a && make" },
  { name: "a backslash-escaped space", command: "cd dir\\ with && make" },
  { name: "an unquoted path with a space", command: "cd dir with && make" },
  { name: "~user", command: "cd ~root && make" },
  { name: "~user with a path", command: "cd ~root/x && make" },
  { name: "|| (the cd is conditional on what ran before)", command: "cd a || cd b" },
  { name: "|| followed by &&", command: "cd a || cd b && make" },
  { name: "a pipe", command: "cd a | cat" },
  { name: "a pipe followed by &&", command: "cd a | cat && make" },
  { name: "a subshell (the cd does not leave it)", command: "(cd a && make)" },
  { name: "a brace group", command: "{ cd a && make; }" },
  { name: "a backgrounded cd", command: "cd a & make" },
  { name: "a cd with no terminator", command: "cd a" },
  { name: "a cd with a trailing redirect", command: "cd a > out && make" },
  { name: "cd with an option", command: "cd -P a && make" },
  { name: "cd --", command: "cd -- a && make" },
  { name: "cd -", command: "cd - && make" },
  { name: "a bare cd", command: "cd && make" },
  { name: "a cd that is not the first command", command: "make && cd a && make" },
  { name: "a cd after an assignment", command: "X=1 cd a && make" },
]) {
  test(`snapshotTarget: ${row.name} is not followed (no nested target)`, async () => {
    // Real directories named like the unparsed forms: a parser that loosened its whitelist would walk into them.
    for (const name of ["a", "b", "$X", "*", "{X}", "[a]*", "{a,b}", "dir", "dir with", "a b", "~root", "-P", "--"]) {
      await mk(name);
    }
    // Positive control on the same tree: the failure below is the form, not the fixture.
    expect(bash(root, { command: "cd a && make" })).toBe(path.join(root, "a"));
    expect(bash(root, { command: row.command })).toBe(root);
  });
}

// --- the scratch-root / ancestor guard ---

test("snapshotTarget: a target that is itself a scratch root is skipped", async () => {
  const inner = await mk("inner");
  await mk("project");
  // `inner` is a registered scratch root: bracketing it would blame the call for what unrelated processes write there.
  expect(bash(root, { command: "cd inner && make" }, [root, inner])).toBe(root);
  // Control: with only `root` registered, the same hop is a real nested target.
  expect(bash(root, { command: "cd inner && make" }, [root])).toBe(inner);
  // A sibling of the registered root is still followed.
  expect(bash(root, { command: "cd project && make" }, [root, inner])).toBe(path.join(root, "project"));
});

test("snapshotTarget: a target that is a symlink to a scratch root is skipped", async () => {
  await fs.symlink(root, path.join(root, "alias"));
  expect(bash(root, { command: "cd alias && make" })).toBe(root);
  // Control: a symlink to a real project directory is followed, and the bracketed root is its REAL location.
  await mk("real");
  await fs.symlink(path.join(root, "real"), path.join(root, "link"));
  expect(bash(root, { command: "cd link && make" })).toBe(path.join(root, "real"));
});

test("snapshotTarget: a target that is an ancestor of a scratch root is skipped", async () => {
  const outer = await tmpDir("jeo-snapshot-target-outer-");
  const home = path.join(outer, "home");
  const cwd = path.join(home, "scratch");
  const sibling = path.join(outer, "sibling");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(sibling);
  await mark(sibling);
  // `cd ..` reaches `home`, which CONTAINS the scratch root: walking it is the tree that made the root unmeasurable.
  expect(snapshotTarget(cwd, "bash", { command: "cd .. && ls" }, [cwd])).toBe(cwd);
  expect(snapshotTarget(cwd, "bash", { command: "cd ../.. && ls" }, [cwd])).toBe(cwd);
  expect(snapshotTarget(cwd, "bash", { command: "cd / && ls" }, [cwd])).toBe(cwd);
  // An ancestor of ANOTHER registered root counts too, not only of the cwd.
  const other = path.join(sibling, "other-root");
  await fs.mkdir(other);
  expect(snapshotTarget(cwd, "bash", { command: `cd ${q(sibling)} && ls` }, [cwd, other])).toBe(cwd);
  // Control: the same sibling is a perfectly good target when no registered root lives under it.
  expect(snapshotTarget(cwd, "bash", { command: `cd ${q(sibling)} && ls` }, [cwd])).toBe(sibling);
});

test("snapshotTarget: with default roots a fresh dir under the temp dir is followed but / is not", async () => {
  // Default roots include os.tmpdir(): the cwd IS one, a child is a project, and / contains every default root.
  const tmp = os.tmpdir();
  const child = await tmpDir("jeo-snapshot-target-default-");
  await mark(child);
  expect(path.dirname(child)).toBe(await fs.realpath(tmp)); // premise: the child sits directly under the temp root
  expect(snapshotTarget(tmp, "bash", { command: `cd ${q(path.basename(child))} && make` })).toBe(child);
  expect(snapshotTarget(tmp, "bash", { command: "cd / && ls" })).toBe(tmp);
  expect(snapshotTarget(tmp, "bash", { command: "ls" })).toBe(tmp);
});

// --- non-scratch cwd and non-bash tools never retarget ---

test("snapshotTarget: a non-scratch cwd always returns cwd and never follows a target outside it", async () => {
  const project = await mk("project");
  await mk("project", "sub");
  const elsewhere = await tmpDir("jeo-snapshot-target-elsewhere-");
  // `project` is not in [root]: the bracket measures the project itself, exactly as before this feature existed.
  expect(bash(project, { command: `cd ${q(elsewhere)} && make` })).toBe(project);
  expect(bash(project, { command: "cd sub && make" })).toBe(project);
  expect(bash(project, { command: "make", subdir: "sub" })).toBe(project);
  expect(bash(project, { command: "make", cwd: elsewhere })).toBe(project);
});

for (const tool of ["computer", "edit", "write", "read"]) {
  test(`snapshotTarget: the ${tool} tool is never retargeted`, async () => {
    await mk("nested");
    expect(snapshotTarget(root, tool, { command: "cd nested && make", subdir: "nested", cwd: "nested" }, [root])).toBe(root);
  });
}

// --- ~ and CDPATH ---

test("snapshotTarget: ~ and ~/x resolve against args.env.HOME", async () => {
  const home = await tmpDir("jeo-snapshot-target-home-");
  await mark(home);
  await fs.mkdir(path.join(home, "proj"));
  await mark(path.join(home, "proj"));
  const env = { HOME: home };
  // The outermost marked directory is the project: `~` itself holds a marker here, so `~/proj` brackets all of `~`.
  expect(bash(root, { command: "cd ~/proj && make", env })).toBe(home);
  expect(bash(root, { command: "cd ~ && make", env })).toBe(home);
  // HOME itself registered as a scratch root: `cd ~` is skipped, the project beneath it is not.
  expect(bash(root, { command: "cd ~ && make", env }, [root, home])).toBe(root);
  expect(bash(root, { command: "cd ~/proj && make", env }, [root, home])).toBe(path.join(home, "proj"));
  // A home without that directory is no target.
  expect(bash(root, { command: "cd ~/ghost && make", env })).toBe(root);
});

test("snapshotTarget: ~name is another account's home, never HOME joined with name", async () => {
  // With HOME = <home>, a parser that sliced the `~` off `~proj` would land in <home>/proj instead of giving up.
  const home = await tmpDir("jeo-snapshot-target-home-");
  await fs.mkdir(path.join(home, "proj", "sub"), { recursive: true });
  await mark(path.join(home, "proj"));
  await fs.mkdir(path.join(home, "root"));
  const env = { HOME: home };
  expect(bash(root, { command: "cd ~/proj && make", env })).toBe(path.join(home, "proj")); // control: ~/x expands
  expect(bash(root, { command: "cd ~proj && make", env })).toBe(root);
  expect(bash(root, { command: "cd ~proj/sub && make", env })).toBe(root);
  expect(bash(root, { command: "cd ~root && make", env })).toBe(root);
});

test("snapshotTarget: a quoted ~ is a literal directory name, never the home directory", async () => {
  const home = await tmpDir("jeo-snapshot-target-home-");
  await fs.mkdir(path.join(home, "lit"));
  await mark(path.join(home, "lit"));
  await mkBare("~", "lit");
  await mark(path.join(root, "~", "lit"));
  const env = { HOME: home };
  expect(bash(root, { command: "cd '~/lit' && make", env })).toBe(path.join(root, "~", "lit"));
  expect(bash(root, { command: 'cd "~/lit" && make', env })).toBe(path.join(root, "~", "lit"));
  // Control: an unquoted ~ expands.
  expect(bash(root, { command: "cd ~/lit && make", env })).toBe(path.join(home, "lit"));
});

test("snapshotTarget: a relative cd is ambiguous when CDPATH is set", async () => {
  await mk("nested");
  await mk("elsewhere", "nested");
  process.env.CDPATH = path.join(root, "elsewhere");
  // bash would search CDPATH first and may land in a different `nested`: do not guess.
  expect(bash(root, { command: "cd nested && make" })).toBe(root);
  expect(bash(root, { command: "cd 'nested' && make" })).toBe(root);
  // `args.subdir` is resolved by the tool itself, not by `cd`, so CDPATH does not apply to it.
  expect(bash(root, { command: "make", subdir: "nested" })).toBe(path.join(root, "nested"));
  // Explicitly-anchored forms bypass CDPATH in bash, so they stay resolvable.
  expect(bash(root, { command: "cd ./nested && make" })).toBe(path.join(root, "nested"));
  expect(bash(root, { command: `cd ${q(path.join(root, "nested"))} && make` })).toBe(path.join(root, "nested"));
  // The CDPATH the bash tool will actually pass (args.env) overrides the process one, in both directions.
  expect(bash(root, { command: "cd nested && make", env: { CDPATH: "" } })).toBe(path.join(root, "nested"));
  delete process.env.CDPATH;
  expect(bash(root, { command: "cd nested && make", env: { CDPATH: "/somewhere" } })).toBe(root);
  expect(bash(root, { command: "cd nested && make" })).toBe(path.join(root, "nested"));
});

// --- never throws ---

test("snapshotTarget: garbage and undefined arguments fall back to cwd without throwing", async () => {
  await mk("nested");
  const hostile = new Proxy({}, { get() { throw new Error("hostile getter"); } });
  const unusable: Array<Record<string, unknown> | undefined> = [
    undefined,
    {},
    { command: undefined },
    { command: null },
    { command: 42 },
    { command: { toString() { throw new Error("hostile toString"); } } },
    { command: "make", cwd: {}, subdir: [] },
    { command: "make", cwd: "\0" },
    { command: "cd \0 && make" },
    hostile as Record<string, unknown>,
  ];
  for (const args of unusable) expect(bash(root, args)).toBe(root);
  // A malformed env never poisons a hop that does not consult it.
  for (const env of [null, "HOME=/x", [], 7]) {
    expect(bash(root, { command: "cd nested && make", env })).toBe(path.join(root, "nested"));
  }
  // A hostile cwd or scratch-root list collapses to "no nested target" as well.
  expect(snapshotTarget("\0bad", "bash", { command: "cd nested && make" }, ["\0bad"])).toBe("\0bad");
  expect(snapshotTarget(root, "bash", { command: "cd nested && make" }, null as unknown as string[])).toBe(root);
});

test("snapshotTarget: a cwd that does not exist is returned unchanged", () => {
  const ghost = path.join(root, "ghost");
  expect(snapshotTarget(ghost, "bash", { command: "cd nested && make" }, [ghost])).toBe(ghost);
});

// --- describeSnapshotTarget ---

test("describeSnapshotTarget: relative inside the cwd, the fixed <outside cwd> token otherwise", () => {
  expect(describeSnapshotTarget("/w/scratch", "/w/scratch/app")).toBe("app");
  expect(describeSnapshotTarget("/w/scratch", "/w/scratch/app/deep")).toBe(path.join("app", "deep"));
  // Outside: a sibling, the parent, an unrelated tree, and a sibling that merely shares the cwd's name as a prefix.
  // An absolute path outside the workspace never reaches the transcript, whatever it is called.
  expect(describeSnapshotTarget("/w/scratch", "/w/other")).toBe("<outside cwd>");
  expect(describeSnapshotTarget("/w/scratch", "/w")).toBe("<outside cwd>");
  expect(describeSnapshotTarget("/w/scratch", "/elsewhere/app")).toBe("<outside cwd>");
  expect(describeSnapshotTarget("/w/scratch", "/w/scratch-two/app")).toBe("<outside cwd>");
  // The cwd itself is not "inside" it: it is never a nested target, and must not become an empty string.
  expect(describeSnapshotTarget("/w/scratch", "/w/scratch")).toBe("<outside cwd>");
  // A directory literally named `..x` is inside, not an escape.
  expect(describeSnapshotTarget("/w/scratch", "/w/scratch/..x")).toBe("..x");
});

test("snapshotTargetLabel: relative inside the cwd, only the basename outside it", () => {
  expect(snapshotTargetLabel("/w/scratch", "/w/scratch/app")).toBe("app");
  expect(snapshotTargetLabel("/w/scratch", "/w/scratch/app/deep")).toBe(path.join("app", "deep"));
  expect(snapshotTargetLabel("/w/scratch", "/home/me/secret-project")).toBe("secret-project");
  expect(snapshotTargetLabel("/w/scratch", "/w/scratch-two/app")).toBe("app");
});

// --- a nested target must be a PROJECT: it, or an ancestor below the scratch root, holds a marker ---

test("snapshotTarget: a directory with no project marker anywhere on the way up is no target", async () => {
  const bare = await mkBare("bare", "deeper");
  await mk("proj");
  // Positive control on the same tree: a marked sibling is followed, so the bare result is the missing marker alone.
  expect(bash(root, { command: "cd proj && make" })).toBe(path.join(root, "proj"));
  expect(bash(root, { command: "cd bare && make" })).toBe(root);
  expect(bash(root, { command: "cd bare/deeper && make" })).toBe(root);
  expect(bash(root, { command: "make", subdir: "bare" })).toBe(root);
  expect(bash(root, { command: "make", cwd: bare })).toBe(root);
  // A file that merely looks project-ish is not a marker.
  await fs.writeFile(path.join(bare, "README.md"), "x");
  await fs.writeFile(path.join(bare, "package.json.bak"), "x");
  expect(bash(root, { command: "cd bare/deeper && make" })).toBe(root);
});

for (const marker of [
  ".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py", "Makefile", "pom.xml",
  "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "deno.json", "CMakeLists.txt", ".jeo",
]) {
  test(`snapshotTarget: a ${marker} marks the target as a project`, async () => {
    const dir = await mkBare("p");
    expect(bash(root, { command: "cd p && make" })).toBe(root); // premise: bare until the marker exists
    // `.git` and `.jeo` are directories in real projects; the others are files. Both shapes count.
    if (marker === ".git" || marker === ".jeo") await fs.mkdir(path.join(dir, marker));
    else await fs.writeFile(path.join(dir, marker), "x");
    expect(bash(root, { command: "cd p && make" })).toBe(dir);
  });
}

test("snapshotTarget: a marker on an ANCESTOR of the target makes it a project, and the marker root is bracketed", async () => {
  const lib = await mkBare("proj", "src", "lib");
  expect(bash(root, { command: "cd proj/src/lib && make" })).toBe(root); // premise: bare so far
  const proj = await mark(path.join(root, "proj"), "Cargo.toml");
  // Whatever directory inside the project the command is aimed at, the bracket covers the whole project.
  expect(bash(root, { command: "cd proj/src && make" })).toBe(proj);
  expect(bash(root, { command: "cd proj/src/lib && make" })).toBe(proj);
  expect(bash(root, { command: "make", subdir: "proj/src" })).toBe(proj);
  expect(bash(root, { command: "make", cwd: lib })).toBe(proj);
  expect(bash(root, { command: "cd proj && make" })).toBe(proj);
});

test("snapshotTarget: with a marker only at proj, `cd proj/pkg` brackets proj so a write to ../src is inside it", async () => {
  const pkg = await mkBare("proj", "pkg");
  await mkBare("proj", "src");
  const proj = await mark(path.join(root, "proj"));
  expect(bash(root, { command: "cd proj/pkg && echo X > ../src/a.ts" })).toBe(proj);
  expect(bash(root, { command: "echo X > ../src/a.ts", cwd: pkg })).toBe(proj);
});

test("snapshotTarget: the OUTERMOST marker wins when proj and proj/pkg both have one", async () => {
  await mk("proj", "pkg"); // markers in proj AND proj/pkg
  expect(bash(root, { command: "cd proj/pkg && make" })).toBe(path.join(root, "proj"));
  // Also across an unmarked level in between: deep (marked) / mid (bare) / leaf (marked) is all one project, rooted at deep.
  await mkBare("deep", "mid", "leaf");
  await mark(path.join(root, "deep"));
  await mark(path.join(root, "deep", "mid", "leaf"));
  expect(bash(root, { command: "cd deep/mid/leaf && make" })).toBe(path.join(root, "deep"));
});

test("snapshotTarget: an outermost marker root that CONTAINS a scratch root is skipped, the same project without that marker is not", async () => {
  const outer = await tmpDir("jeo-snapshot-target-outer-");
  const cwd = path.join(outer, "home", "scratch");
  const pkg = path.join(outer, "sibling", "pkg");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(pkg, { recursive: true });
  await mark(pkg);
  // `pkg` is marked, and so is nothing above it: the project is `pkg` itself and is a fine target.
  expect(snapshotTarget(cwd, "bash", { command: `cd ${q(pkg)} && make` }, [cwd])).toBe(pkg);
  // A .git in `outer` makes the OUTERMOST marker root `outer`, which contains the scratch cwd: as unmeasurable as the root.
  await mark(outer, ".git");
  expect(snapshotTarget(cwd, "bash", { command: `cd ${q(pkg)} && make` }, [cwd])).toBe(cwd);
});

test("snapshotTarget: the marker climb is bounded: found 11 levels up, not 12", async () => {
  const segments = Array.from({ length: 12 }, (_, i) => `d${i + 1}`);
  await mkBare("proj", ...segments);
  const proj = await mark(path.join(root, "proj"));
  // The target is 11 levels below the marked project: the climb (12 directories, target included) still reaches it.
  const near = path.join(proj, ...segments.slice(0, 11));
  const far = path.join(proj, ...segments.slice(0, 12));
  expect(bash(root, { command: `cd ${q(near)} && make` })).toBe(proj);
  // 12 levels below it and the search gives up: no marker found means no target, never an unbounded walk.
  expect(bash(root, { command: `cd ${q(far)} && make` })).toBe(root);
  // The outermost marker is outermost WITHIN the window: a nearer marker is found, the one beyond the window is not.
  const d3 = await mark(path.join(proj, ...segments.slice(0, 3)));
  expect(bash(root, { command: `cd ${q(far)} && make` })).toBe(d3);
  expect(bash(root, { command: `cd ${q(near)} && make` })).toBe(proj);
});

test("snapshotTarget: a marker only ABOVE a scratch root is not honored", async () => {
  const outer = await tmpDir("jeo-snapshot-target-outer-");
  await mark(outer, ".git"); // the project that happens to contain the scratch dir
  const scratch = path.join(outer, "scratch");
  const bare = path.join(scratch, "bare");
  await fs.mkdir(bare, { recursive: true });
  // The climb from `bare` stops at the scratch root before it can see outer/.git.
  expect(snapshotTarget(scratch, "bash", { command: "cd bare && make" }, [scratch])).toBe(scratch);
  // A marker placed IN the scratch root itself (a stray package.json in $HOME) does not promote its children either.
  await mark(scratch);
  expect(snapshotTarget(scratch, "bash", { command: "cd bare && make" }, [scratch])).toBe(scratch);
  // Control: a marker below the scratch root does.
  await mark(bare);
  expect(snapshotTarget(scratch, "bash", { command: "cd bare && make" }, [scratch])).toBe(bare);
});

test("snapshotTarget: every registered scratch root stops the marker climb, even one that holds a marker", async () => {
  // `home` is registered as a scratch root alongside the cwd: its own marker must not promote a bare child of it.
  const home = await tmpDir("jeo-snapshot-target-home-");
  await mark(home);
  const bare = path.join(home, "bare");
  await fs.mkdir(bare);
  expect(bash(root, { command: `cd ${q(bare)} && make` }, [root, home])).toBe(root);
  // Control: with only `root` registered, home (not a scratch root) is itself a marked ancestor and promotes `bare`.
  expect(bash(root, { command: `cd ${q(bare)} && make` }, [root])).toBe(home);
});

test("snapshotTarget: with default roots a marker-less child of the temp dir is no target", async () => {
  const tmp = os.tmpdir();
  const child = await tmpDir("jeo-snapshot-target-default-");
  const name = path.basename(child);
  expect(snapshotTarget(tmp, "bash", { command: `cd ${q(name)} && make` })).toBe(tmp);
  await mark(child);
  expect(snapshotTarget(tmp, "bash", { command: `cd ${q(name)} && make` })).toBe(child);
});

test("snapshotTarget: the marker climb follows a symlinked target to its real location", async () => {
  // `link` lives in the scratch root, but the directory it points at sits inside a project elsewhere. Judged by the
  // spelling the model typed, the climb would hit the scratch root and give up; judged by where it really is, it is a project.
  const project = await tmpDir("jeo-snapshot-target-linked-project-");
  await mark(project, "go.mod");
  const src = path.join(project, "src");
  await fs.mkdir(src);
  const bareTree = await tmpDir("jeo-snapshot-target-linked-bare-");
  const bare = path.join(bareTree, "src");
  await fs.mkdir(bare);
  await fs.symlink(src, path.join(root, "link"));
  await fs.symlink(bare, path.join(root, "barelink"));
  expect(bash(root, { command: "cd link && make" })).toBe(project);
  // Control: the same shape over a tree with no marker anywhere is still no target.
  expect(bash(root, { command: "cd barelink && make" })).toBe(root);
});
