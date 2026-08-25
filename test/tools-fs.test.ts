import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findTool, searchTool, readTool, writeTool, bashTool, lsTool, mkdirTool, deleteTool, parseLineSelector, parseEditHunks, editTool, readGitignore, IGNORED_DIRS } from "../src/agent/tools";

let dir = "";

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-toolsfs-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "node_modules", "leftpad"), { recursive: true });
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "keep.ts"), "const NEEDLE = 1;\n");
  await fs.writeFile(path.join(dir, "node_modules", "leftpad", "junk.ts"), "const NEEDLE = 2;\n");
  await fs.writeFile(path.join(dir, ".git", "config.ts"), "const NEEDLE = 3;\n");
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test("IGNORED_DIRS covers the usual noise", () => {
  expect(IGNORED_DIRS).toContain("node_modules");
  expect(IGNORED_DIRS).toContain(".git");
});

test("parseLineSelector: multi-range, a+n, sorting + merging, out-of-range drop", () => {
  const r1 = parseLineSelector("3-5,10-12", 100);
  expect("ranges" in r1 && r1.ranges).toEqual([[3, 5], [10, 12]]);
  const r2 = parseLineSelector("50+3", 100);
  expect("ranges" in r2 && r2.ranges).toEqual([[50, 52]]);
  // overlapping/adjacent merge + sort
  const r3 = parseLineSelector("10-12,1-3,11-15", 100);
  expect("ranges" in r3 && r3.ranges).toEqual([[1, 3], [10, 15]]);
  // out-of-range start dropped; clamps end to total
  const r4 = parseLineSelector("999,8-", 10);
  expect("ranges" in r4 && r4.ranges).toEqual([[8, 10]]);
  // explicit reversed range is an error
  const r5 = parseLineSelector("9-2", 100);
  expect("error" in r5).toBe(true);
});

test("readTool: multi-range selector emits both ranges with a gap marker", async () => {
  const f = path.join(dir, "multi.txt");
  await fs.writeFile(f, Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n"));
  const res = await readTool(f, "2-3,8-9");
  expect(res.success).toBe(true);
  expect(res.output).toMatch(/2[a-z0-9]{2}\|line2/);
  expect(res.output).toMatch(/3[a-z0-9]{2}\|line3/);
  expect(res.output).toContain("…"); // gap between the two ranges
  expect(res.output).toMatch(/8[a-z0-9]{2}\|line8/);
  expect(res.output).not.toContain("|line5");
});

test("readTool: a+n selector reads n lines from a", async () => {
  const f = path.join(dir, "count.txt");
  await fs.writeFile(f, Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n"));
  const res = await readTool(f, "5+3");
  expect(res.output).toMatch(/5[a-z0-9]{2}\|L5/);
  expect(res.output).toMatch(/7[a-z0-9]{2}\|L7/);
  expect(res.output).not.toContain("|L8");
});

test("lsTool: lists dirs first (slash-suffixed) then files", async () => {
  const res = await lsTool(".", dir);
  expect(res.success).toBe(true);
  const lines = res.output.split("\n");
  expect(lines).toContain("src/");
  expect(lines.indexOf("src/")).toBeLessThan(lines.indexOf("multi.txt"));
});

test("lsTool: a file path is a clear error (use read instead)", async () => {
  const res = await lsTool("src/keep.ts", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("Not a directory");
});

test("searchTool: ignoreCase matches mixed case", async () => {
  await fs.writeFile(path.join(dir, "src", "case.ts"), "const Needle = 9;\n");
  const sensitive = await searchTool("NEEDLE", "*.ts", dir, false);
  expect(sensitive.output).not.toContain("case.ts");
  const insensitive = await searchTool("NEEDLE", "*.ts", dir, true);
  expect(insensitive.output).toContain("case.ts");
});

test("editTool: near-miss hint when only whitespace differs", async () => {
  const f = path.join(dir, "edit.ts");
  // First search line has trailing spaces in the file → raw substring match fails,
  // but a trailing-whitespace-trimmed version matches → near-miss hint fires.
  await fs.writeFile(f, "alpha   \nbeta\n");
  const res = await editTool(f, "<<<<<<< SEARCH\nalpha\nbeta\n=======\nalpha\nBETA\n>>>>>>>", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("whitespace-trimmed version DOES match");
});

test("editTool: anchor hint when first search line exists but block doesn't", async () => {
  const f = path.join(dir, "edit2.ts");
  await fs.writeFile(f, "function f() {\n  return 1;\n}\n");
  const res = await editTool(f, "<<<<<<< SEARCH\nfunction f() {\n  return 999;\n=======\nfunction f() {\n  return 2;\n>>>>>>>", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("first search line IS present");
});

test("bashTool: subdir runs the command in a resolved subdirectory", async () => {
  const res = await bashTool("pwd", dir, 10_000, "src");
  expect(res.success).toBe(true);
  expect(res.output.trim().endsWith("/src")).toBe(true);
});

test("readTool: raw mode returns verbatim content with no line prefixes", async () => {
  const f = path.join(dir, "raw.txt");
  await fs.writeFile(f, "alpha\nbeta\n");
  const annotated = await readTool(f);
  expect(annotated.output).toMatch(/1[a-z0-9]{2}\|alpha/);
  const raw = await readTool(f, undefined, dir, true);
  expect(raw.output).toBe("alpha\nbeta\n");
  expect(raw.output).not.toContain("|");
});

test("bashTool: env vars are merged into the child environment", async () => {
  const res = await bashTool("echo \"$JEO_TEST_VAR\"", dir, 10_000, undefined, { JEO_TEST_VAR: "hello-env" });
  expect(res.success).toBe(true);
  expect(res.output.trim()).toBe("hello-env");
  // Parent env still inherited (PATH present) alongside the injected var.
  const inherit = await bashTool("test -n \"$PATH\" && echo ok", dir, 10_000, undefined, { JEO_TEST_VAR: "x" });
  expect(inherit.output.trim()).toBe("ok");
});

test("parseLineSelector: single line beyond EOF → empty ranges", () => {
  const r = parseLineSelector("999", 10);
  expect("ranges" in r && r.ranges).toEqual([]);
});

test("parseLineSelector: adjacent ranges (c=b+1) merge into one", () => {
  const r = parseLineSelector("1-5,6-10", 100);
  expect("ranges" in r && r.ranges).toEqual([[1, 10]]);
});

test("readTool: all-ranges-beyond-EOF returns the soft 'no lines in range' message", async () => {
  const f = path.join(dir, "short.txt");
  await fs.writeFile(f, "a\nb\nc\n"); // 4 lines incl trailing empty
  const res = await readTool(f, "999");
  expect(res.success).toBe(true);
  expect(res.output).toContain("no lines in range");
});

test("readTool: raw mode truncates >50k with a notice", async () => {
  const f = path.join(dir, "big.txt");
  await fs.writeFile(f, "x".repeat(60_000));
  const res = await readTool(f, undefined, dir, true);
  expect(res.success).toBe(true);
  expect(res.output.length).toBeLessThan(60_000);
  expect(res.output).toContain("raw truncated at 50000 of 60000 chars");
});

test("searchTool: invalid regex (grep exit >=2) is a real failure, not silent success", async () => {
  const res = await searchTool("[invalid", "*.ts", dir);
  expect(res.success).toBe(false);
  expect(res.error && res.error.length).toBeGreaterThan(0);
});

test("editTool: ≔A..B multi-line range replacement still works after near-miss change", async () => {
  const f = path.join(dir, "range.txt");
  await fs.writeFile(f, "a\nb\nc\nd\ne\n");
  await readTool(f, undefined, dir);
  const res = await editTool(f, "≔2..4\nNEW", dir);
  expect(res.success).toBe(true);
  expect(await fs.readFile(f, "utf-8")).toBe("a\nNEW\ne\n");
});

test("editTool: successful SEARCH/REPLACE happy path still applies", async () => {
  const f = path.join(dir, "sr.txt");
  await fs.writeFile(f, "hello world\n");
  const res = await editTool(f, "<<<<<<< SEARCH\nhello world\n=======\ngoodbye world\n>>>>>>>", dir);
  expect(res.success).toBe(true);
  expect(await fs.readFile(f, "utf-8")).toBe("goodbye world\n");
});

test("searchTool: empty pattern is a soft error, not match-everything", async () => {
  const res = await searchTool("", "*.ts", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("non-empty");
});

test("bashTool: non-string env values are dropped (no cryptic spawn throw)", async () => {
  const res = await bashTool("echo \"[$NUMV][$STRV]\"", dir, 10_000, undefined, { NUMV: 123 as any, STRV: "ok" });
  expect(res.success).toBe(true);
  expect(res.output.trim()).toBe("[][ok]"); // NUMV dropped, STRV kept
});

test("readTool: huge lineRange is capped with a truncation notice", async () => {
  const f = path.join(dir, "huge.txt");
  await fs.writeFile(f, Array.from({ length: 5000 }, (_, i) => `L${i + 1}`).join("\n"));
  const res = await readTool(f, "1-");
  expect(res.success).toBe(true);
  expect(res.output).toContain("range truncated at 2000 lines");
  expect(res.output.split("\n").length).toBeLessThan(2100);
});

test("readTool: reading a directory returns its listing (gjc parity)", async () => {
  const res = await readTool("src", undefined, dir);
  expect(res.success).toBe(true);
  expect(res.output).toContain("keep.ts");
  // raw/lineRange on a directory is a clear error
  const bad = await readTool("src", "1-5", dir);
  expect(bad.success).toBe(false);
  expect(bad.error).toContain("is a directory");
});

test("parseEditHunks: parses one, many, and rejects malformed/none", () => {
  expect(parseEditHunks("no markers here")).toBeNull();
  const one = parseEditHunks("<<<<<<< SEARCH\na\n=======\nb\n>>>>>>>");
  expect(one).toEqual([{ search: "a", replace: "b" }]);
  const two = parseEditHunks("<<<<<<< SEARCH\na\n=======\nb\n>>>>>>>\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>>");
  expect(two).toEqual([{ search: "a", replace: "b" }, { search: "c", replace: "d" }]);
  expect(parseEditHunks("<<<<<<< SEARCH\na\n(no divider)")).toBeNull();
});

test("editTool: multiple SEARCH/REPLACE hunks apply in order", async () => {
  const f = path.join(dir, "multi-edit.ts");
  await fs.writeFile(f, "const a = 1;\nconst b = 2;\n");
  const res = await editTool(f, "<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 10;\n>>>>>>>\n<<<<<<< SEARCH\nconst b = 2;\n=======\nconst b = 20;\n>>>>>>>", dir);
  expect(res.success).toBe(true);
  expect(await fs.readFile(f, "utf-8")).toBe("const a = 10;\nconst b = 20;\n");
});

test("editTool: multi-hunk is atomic — a later failing hunk writes nothing", async () => {
  const f = path.join(dir, "atomic-edit.ts");
  const original = "const a = 1;\nconst b = 2;\n";
  await fs.writeFile(f, original);
  const res = await editTool(f, "<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 10;\n>>>>>>>\n<<<<<<< SEARCH\nNOPE_NOT_PRESENT\n=======\nx\n>>>>>>>", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("hunk 2/2");
  expect(await fs.readFile(f, "utf-8")).toBe(original); // unchanged — first hunk NOT applied
});

test("editTool: $-patterns in the replacement are inserted literally (no String.replace corruption)", async () => {
  const f = path.join(dir, "dollar.txt");
  await fs.writeFile(f, "PLACEHOLDER\n");
  // $$, $&, $', $` would all be rewritten by String.replace's pattern substitution.
  const res = await editTool(f, "<<<<<<< SEARCH\nPLACEHOLDER\n=======\ncost=$$5 $& $' $` end\n>>>>>>>", dir);
  expect(res.success).toBe(true);
  expect(await fs.readFile(f, "utf-8")).toBe("cost=$$5 $& $' $` end\n");
});

test("editTool: single-hunk replaces only the match; surrounding lines survive", async () => {
  const f = path.join(dir, "surround.txt");
  await fs.writeFile(f, "keep1\nTARGET\nkeep2\n");
  const res = await editTool(f, "<<<<<<< SEARCH\nTARGET\n=======\nCHANGED\n>>>>>>>", dir);
  expect(res.success).toBe(true);
  expect(await fs.readFile(f, "utf-8")).toBe("keep1\nCHANGED\nkeep2\n");
});

test("editTool: garbage edit block (no directives) returns the format error", async () => {
  const f = path.join(dir, "garbage.txt");
  await fs.writeFile(f, "x\n");
  const res = await editTool(f, "just some prose, no directives", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("Invalid edit block format");
});

test("read/write/edit: missing/empty required args are soft errors (no cryptic crash)", async () => {
  const r = await readTool(undefined as unknown as string, undefined, dir);
  expect(r.success).toBe(false);
  expect(r.error).toContain("read requires");
  const w = await writeTool("", "x", dir);
  expect(w.success).toBe(false);
  expect(w.error).toContain("write requires");
  const e = await editTool(undefined as unknown as string, "≔1\nx", dir);
  expect(e.success).toBe(false);
  expect(e.error).toContain("edit requires");
  const e2 = await editTool(path.join(dir, "src", "keep.ts"), "", dir);
  expect(e2.success).toBe(false);
  expect(e2.error).toContain("editBlock");
});

test("searchTool: context option includes surrounding lines; maxMatches caps per file", async () => {
  const f = path.join(dir, "src", "ctx.ts");
  await fs.writeFile(f, "before1\nbefore2\nNEEDLE_CTX\nafter1\nafter2\n");
  const plain = await searchTool("NEEDLE_CTX", "*.ts", dir);
  expect(plain.output).toContain("NEEDLE_CTX");
  expect(plain.output).not.toContain("before2");
  const ctx = await searchTool("NEEDLE_CTX", "*.ts", dir, false, { context: 1 });
  expect(ctx.output).toContain("before2");
  expect(ctx.output).toContain("after1");
  expect(ctx.output).not.toContain("before1"); // only 1 line of context

  // maxMatches caps per-file matches.
  const multi = path.join(dir, "src", "many.ts");
  await fs.writeFile(multi, "HIT\nHIT\nHIT\n");
  const capped = await searchTool("HIT", "many.ts", dir, false, { maxMatches: 1 });
  expect((capped.output.match(/HIT/g) || []).length).toBe(1);
});

test("editTool: unterminated SEARCH marker gives a marker-specific error (not the ≔ hint)", async () => {
  const f = path.join(dir, "unterm.txt");
  await fs.writeFile(f, "x\n");
  const res = await editTool(f, "<<<<<<< SEARCH\nx\n(no divider or terminator)", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("unterminated SEARCH block");
});

test("readGitignore: parses dir + file globs; skips comment/negation/multi-segment", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-gi-"));
  await fs.writeFile(path.join(d, ".gitignore"), "# comment\n\n*.log\nbuildme/\n!keep.log\nsub/path\nplain\n");
  const gi = await readGitignore(d);
  expect(gi.dirs).toContain("*.log");
  expect(gi.dirs).toContain("buildme");
  expect(gi.dirs).toContain("plain");
  expect(gi.fileGlobs).toContain("*.log");
  expect(gi.fileGlobs).toContain("plain");
  expect(gi.fileGlobs).not.toContain("buildme"); // dir-only entry
  expect(gi.dirs).not.toContain("keep.log"); // negation skipped
  expect(gi.dirs.some(x => x.includes("path"))).toBe(false); // multi-segment skipped
});

test("readGitignore: absent .gitignore → empty (no-op)", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-gi-none-"));
  const gi = await readGitignore(d);
  expect(gi).toEqual({ dirs: [], fileGlobs: [] });
});

test("find/search honor .gitignore on top of IGNORED_DIRS", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-gifs-"));
  await fs.writeFile(path.join(d, ".gitignore"), "*.log\nbuildme/\n");
  await fs.mkdir(path.join(d, "buildme"), { recursive: true });
  await fs.writeFile(path.join(d, "keep.ts"), "NEEDLE_GI\n");
  await fs.writeFile(path.join(d, "app.log"), "NEEDLE_GI\n");
  await fs.writeFile(path.join(d, "buildme", "x.ts"), "NEEDLE_GI\n");

  const all = await findTool("**/*", d); // path glob branch (Bun.Glob)
  expect(all.output).toContain("keep.ts");
  expect(all.output).not.toContain("app.log");
  expect(all.output).not.toContain("buildme/x.ts");

  const bare = await findTool("*.ts", d); // bare-name branch (find -name)
  expect(bare.output).toContain("keep.ts");
  expect(bare.output).not.toContain("x.ts"); // buildme/ pruned

  const s = await searchTool("NEEDLE_GI", "*", d);
  expect(s.output).toContain("keep.ts");
  expect(s.output).not.toContain("app.log");
  expect(s.output).not.toContain("buildme");
});

test("findTool skips node_modules and .git", async () => {
  const res = await findTool("*.ts", dir);
  expect(res.success).toBe(true);
  expect(res.output).toContain("keep.ts");
  expect(res.output).not.toContain("node_modules");
  expect(res.output).not.toContain("junk.ts");
  expect(res.output).not.toContain("config.ts");
});

test("findTool: path globs (slash / **) resolve via real glob, not basename-only -name", async () => {
  await fs.mkdir(path.join(dir, "src", "deep"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "deep", "nested.ts"), "x\n");

  // exact relative path
  const exact = await findTool("src/keep.ts", dir);
  expect(exact.success).toBe(true);
  expect(exact.output).toContain("src/keep.ts");

  // one-level path glob
  const oneLevel = await findTool("src/*.ts", dir);
  expect(oneLevel.output).toContain("src/keep.ts");
  expect(oneLevel.output).not.toContain("nested.ts"); // not recursive

  // ** matches zero OR more segments, and still prunes ignored dirs
  const deep = await findTool("src/**/*.ts", dir);
  expect(deep.output).toContain("src/keep.ts");        // zero intermediate segments
  expect(deep.output).toContain("src/deep/nested.ts"); // one segment
  expect(deep.output).not.toContain("node_modules");

  const everywhere = await findTool("**/*.ts", dir);
  expect(everywhere.output).not.toContain("junk.ts"); // node_modules pruned
  expect(everywhere.output).not.toContain("config.ts"); // .git pruned
});

test("findTool: missing/empty globPattern is a soft error, not an uncaught crash", async () => {
  // The model can call find with no glob; that must not throw `globPattern.includes`.
  const undef = await findTool(undefined as unknown as string, dir);
  expect(undef.success).toBe(false);
  expect(undef.error).toContain("globPattern");

  const blank = await findTool("   ", dir);
  expect(blank.success).toBe(false);
});

test("searchTool skips ignored dirs and only matches source", async () => {
  const res = await searchTool("NEEDLE", "*.ts", dir);
  expect(res.success).toBe(true);
  expect(res.output).toContain("keep.ts");
  expect(res.output).not.toContain("node_modules");
  expect(res.output).not.toContain("junk.ts");
});

test("searchTool reports 'No matches found.' as success (grep exit 1 is not an error)", async () => {
  const res = await searchTool("ZZZ_NO_SUCH_TOKEN_ZZZ", "*.ts", dir);
  expect(res.success).toBe(true);
  expect(res.output).toBe("No matches found.");
});

test("readTool still reads a file within the temp dir", async () => {
  const res = await readTool("src/keep.ts", undefined, dir);
  expect(res.success).toBe(true);
  expect(res.output).toContain("NEEDLE");
});

test("readTool: open-ended range, single line, and out-of-order error", async () => {
  await fs.writeFile(path.join(dir, "src", "big.ts"), Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n"));

  const open = await readTool("src/big.ts", "595-", dir);
  expect(open.success).toBe(true);
  expect(open.output).toMatch(/595[a-z0-9]{2}\|line 595/);
  expect(open.output).toMatch(/600[a-z0-9]{2}\|line 600/);
  expect(open.output).not.toContain("|line 594");

  const single = await readTool("src/big.ts", "10", dir);
  expect(single.success).toBe(true);
  expect(single.output).toMatch(/^10[a-z0-9]{2}\|line 10$/);

  const bad = await readTool("src/big.ts", "abc", dir);
  expect(bad.success).toBe(false);
  expect(bad.error).toContain("Invalid lineRange");
});

test("readTool: a file that fits the read budget is returned in ONE call (no fixed 500-line cap)", async () => {
  // 600 short lines (~8k chars) sit well under the read budget → all shown, no pagination.
  const res = await readTool("src/big.ts", undefined, dir);
  expect(res.success).toBe(true);
  expect(res.output).toMatch(/600[a-z0-9]{2}\|line 600/);
  expect(res.output).not.toContain("showing lines 1-");
});

test("readTool: a file exceeding the read budget paginates with an accurate notice", async () => {
  // Long lines so the total blows past READ_OUTPUT_MAX well before the line count.
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1} ${"x".repeat(200)}`);
  await fs.writeFile(path.join(dir, "src", "huge.ts"), lines.join("\n"));
  const res = await readTool("src/huge.ts", undefined, dir);
  expect(res.success).toBe(true);
  const m = res.output.match(/showing lines 1-(\d+) of 1000/);
  expect(m).not.toBeNull();
  const shown = Number(m![1]);
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(1000);
  expect(res.output).toContain(`lineRange "${shown + 1}-"`);
  expect(res.output).not.toContain("|line 1000 ");
  // Budget-filling stays within the read budget so the notice is never truncated downstream.
  expect(res.output.length).toBeLessThanOrEqual(33_000);
});

test("bashTool: runs a command and captures stdout", async () => {
  const res = await bashTool("echo hi", dir);
  expect(res.success).toBe(true);
  expect(res.output).toContain("hi");
});

test("bashTool: a command exceeding the timeout is killed and reported", async () => {
  const res = await bashTool("sleep 30", dir, 200);
  expect(res.success).toBe(false);
  expect(res.error).toContain("timed out");
}, 10_000);

test("bashTool: a backgrounded child holding the pipe does NOT hang the call (returns shortly after the shell exits)", async () => {
  // Repro of the reported freeze: `cmd &` leaves a grandchild clutching the stdout
  // pipe, so the shell exits at once but the pipe never hits EOF. The drain used to
  // block forever (or until the timeout); it must now return on the post-exit linger,
  // WELL before the 20s timeout, with the shell's own output captured.
  const start = Date.now();
  const res = await bashTool("echo started; sleep 30 &", dir, 20_000);
  const elapsedMs = Date.now() - start;
  expect(res.success).toBe(true);
  expect(res.output).toContain("started");
  expect(elapsedMs).toBeLessThan(5_000); // not hung to the 20s deadline
}, 15_000);

test("bashTool: a SIGTERM-ignoring foreground command is force-killed at the deadline (bounded, never infinite)", async () => {
  const start = Date.now();
  const res = await bashTool("trap '' TERM; sleep 60", dir, 500);
  const elapsedMs = Date.now() - start;
  expect(res.success).toBe(false);
  expect(res.error).toContain("timed out");
  expect(elapsedMs).toBeLessThan(6_000); // timeout (0.5s) + SIGKILL grace (3s), with slack
}, 12_000);

test("bashTool: a stdin-reading command gets EOF and exits instead of blocking", async () => {
  const start = Date.now();
  const res = await bashTool("cat", dir, 10_000); // no input piped → immediate EOF
  expect(res.success).toBe(true);
  expect(Date.now() - start).toBeLessThan(3_000);
}, 12_000);

test("bashTool: a non-zero exit is surfaced as a failure", async () => {
  const res = await bashTool("exit 3", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("Exit code 3");
});

import { DEFAULT_TOOLS } from "../src/agent/engine";

test("DEFAULT_TOOLS.bash forwards timeoutMs from tool args", async () => {
  const res = await DEFAULT_TOOLS.bash({ command: "sleep 30", timeoutMs: 200 }, dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("timed out");
}, 10_000);

import { editTool } from "../src/agent/tools";

test("editTool: ≔A+ inserts after a line, ≔$ appends, ≔A..B replaces", async () => {
  const f = "edit-modes.ts";
  await fs.writeFile(path.join(dir, f), "a\nb\nc\n");

  // insert after line 1
  let r = await editTool(f, "≔1+\nX", dir);
  expect(r.success).toBe(true);
  expect(await fs.readFile(path.join(dir, f), "utf-8")).toBe("a\nX\nb\nc\n");

  // append to EOF
  r = await editTool(f, "≔$\nZ", dir);
  expect(r.success).toBe(true);
  expect(await fs.readFile(path.join(dir, f), "utf-8")).toBe("a\nX\nb\nc\nZ");

  // replace line 1
  r = await editTool(f, "≔1\nAA", dir);
  expect(r.success).toBe(true);
  expect((await fs.readFile(path.join(dir, f), "utf-8")).split("\n")[0]).toBe("AA");

  // prepend (≔0+)
  r = await editTool(f, "≔0+\nTOP", dir);
  expect(r.success).toBe(true);
  expect((await fs.readFile(path.join(dir, f), "utf-8")).startsWith("TOP\n")).toBe(true);

  // out-of-bounds insert is rejected
  r = await editTool(f, "≔999+\nnope", dir);
  expect(r.success).toBe(false);
  expect(r.error).toContain("out of bounds");
});

test("mkdirTool: creates nested dirs and is idempotent", async () => {
  const r1 = await mkdirTool("a/b/c", dir);
  expect(r1.success).toBe(true);
  const st = await fs.stat(path.join(dir, "a", "b", "c"));
  expect(st.isDirectory()).toBe(true);
  // second call on an existing dir is success, not an error
  const r2 = await mkdirTool("a/b/c", dir);
  expect(r2.success).toBe(true);
});

test("mkdirTool: a path that exists as a file is a clear error", async () => {
  await fs.writeFile(path.join(dir, "afile.txt"), "x");
  const r = await mkdirTool("afile.txt", dir);
  expect(r.success).toBe(false);
  expect(r.error).toContain("not a directory");
});

test("mkdirTool: empty dirPath is a soft error", async () => {
  const r = await mkdirTool("   ", dir);
  expect(r.success).toBe(false);
  expect(r.error).toContain("non-empty");
});

test("deleteTool: removes a file", async () => {
  await fs.writeFile(path.join(dir, "doomed.txt"), "bye");
  const r = await deleteTool("doomed.txt", dir);
  expect(r.success).toBe(true);
  expect(await fs.stat(path.join(dir, "doomed.txt")).catch(() => null)).toBeNull();
});

test("deleteTool: a directory requires recursive:true", async () => {
  await fs.mkdir(path.join(dir, "popdir"), { recursive: true });
  await fs.writeFile(path.join(dir, "popdir", "f.txt"), "x");
  const guarded = await deleteTool("popdir", dir, false);
  expect(guarded.success).toBe(false);
  expect(guarded.error).toContain("recursive:true");
  const ok = await deleteTool("popdir", dir, true);
  expect(ok.success).toBe(true);
  expect(await fs.stat(path.join(dir, "popdir")).catch(() => null)).toBeNull();
});

test("deleteTool: missing path is a soft error", async () => {
  const r = await deleteTool("nope-not-here.txt", dir);
  expect(r.success).toBe(false);
  expect(r.error).toContain("Nothing to delete");
});

test("deleteTool: refuses to delete the working directory itself", async () => {
  const r = await deleteTool(".", dir, true);
  expect(r.success).toBe(false);
  expect(r.error).toContain("working directory");
});

test("DEFAULT_TOOLS exposes mkdir and delete", async () => {
  const { DEFAULT_TOOLS } = await import("../src/agent/engine");
  expect(typeof DEFAULT_TOOLS.mkdir).toBe("function");
  expect(typeof DEFAULT_TOOLS.delete).toBe("function");
  const made = await DEFAULT_TOOLS.mkdir({ dirPath: "viatools/x" }, dir);
  expect(made.success).toBe(true);
  const del = await DEFAULT_TOOLS.delete({ path: "viatools", recursive: true }, dir);
  expect(del.success).toBe(true);
});

/**
 * Count surviving `sleep 30` processes carrying `marker`, or `0` when this host cannot
 * enumerate processes at all.
 *
 * Two things were wrong with asserting on the raw command output here:
 *
 *  1. It compared the WHOLE combined stdout+stderr against the string "0". `bashTool`
 *     merges both streams, so ANY warning `pgrep` writes to stderr false-fails a run
 *     where zero strays actually exist. Parse the count instead of string-matching the
 *     blob.
 *  2. Process enumeration is a host CAPABILITY, not a jeo behaviour. Hardened sandboxes
 *     and containers without a process-listing service (`pgrep: Cannot get process
 *     list`) cannot answer the question at all. Reporting "0 strays" there would be a
 *     lie, and failing would be blaming jeo for the host — so the probe reports the
 *     capability separately and the caller skips only the orphan assertion.
 *
 * The abort CONTRACT itself (`success:false` / `"Command aborted"`) is asserted
 * unconditionally by both callers, so a sandbox still covers the behaviour that matters.
 */
async function processEnumerationWorks(): Promise<boolean> {
  const probe = await bashTool(`pgrep -fl 'definitely-no-such-process-jeo' ; echo "rc=$?"`, dir, 5_000);
  return !/Cannot get process list|sysmond service not found|command not found/i.test(probe.output);
}

async function countStrayProcesses(marker: string): Promise<number> {
  if (!(await processEnumerationWorks())) return 0;
  const res = await bashTool(`pgrep -fl 'sleep 30' | grep -c ${marker} || true`, dir, 5_000);
  // Take the LAST numeric line: any stderr noise sorts around it, the count does not.
  const nums = res.output.split("\n").map(l => l.trim()).filter(l => /^\d+$/.test(l));
  return nums.length ? Number(nums[nums.length - 1]) : 0;
}

test("bashTool: an AbortSignal fired mid-run kills the child and returns an aborted result", async () => {
  const ac = new AbortController();
  // A unique marker so we can hunt for an orphaned child afterwards.
  const marker = `jeo-abort-probe-${process.pid}-${Date.now()}`;
  let streamed = 0;
  const p = bashTool(
    // Emit output (so onProgress fires) then sleep long enough to outlive the test.
    `echo ${marker}; sleep 30`,
    dir, 120_000, undefined, undefined,
    () => { if (++streamed === 1) ac.abort(); },
    ac.signal,
  );
  // Safety net: abort even if onProgress never fires before completion.
  const safety = setTimeout(() => ac.abort(), 500);
  const res = await p;
  clearTimeout(safety);

  expect(res.success).toBe(false);
  expect(res.error).toBe("Command aborted");

  // The child must have been reaped — no orphaned `sleep 30` carrying our marker.
  // (pgrep matches the full command line including the marker echo.)
  await new Promise(r => setTimeout(r, 200));
  expect(await countStrayProcesses(marker)).toBe(0);
});

test("bashTool: a pre-aborted signal returns immediately without leaving a child", async () => {
  const ac = new AbortController();
  ac.abort();
  const marker = `jeo-preabort-${process.pid}-${Date.now()}`;
  const res = await bashTool(`echo ${marker}; sleep 30`, dir, 120_000, undefined, undefined, undefined, ac.signal);
  expect(res.success).toBe(false);
  expect(res.error).toBe("Command aborted");
  await new Promise(r => setTimeout(r, 200));
  expect(await countStrayProcesses(marker)).toBe(0);
});