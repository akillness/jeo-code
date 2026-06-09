import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findTool, searchTool, readTool, bashTool, lsTool, parseLineSelector, editTool, IGNORED_DIRS } from "../src/agent/tools";

let dir = "";

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "joc-toolsfs-"));
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
  expect(res.output).toContain("2|line2");
  expect(res.output).toContain("3|line3");
  expect(res.output).toContain("…"); // gap between the two ranges
  expect(res.output).toContain("8|line8");
  expect(res.output).not.toContain("5|line5");
});

test("readTool: a+n selector reads n lines from a", async () => {
  const f = path.join(dir, "count.txt");
  await fs.writeFile(f, Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n"));
  const res = await readTool(f, "5+3");
  expect(res.output).toContain("5|L5");
  expect(res.output).toContain("7|L7");
  expect(res.output).not.toContain("8|L8");
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
  expect(annotated.output).toContain("1|alpha");
  const raw = await readTool(f, undefined, dir, true);
  expect(raw.output).toBe("alpha\nbeta\n");
  expect(raw.output).not.toContain("|");
});

test("bashTool: env vars are merged into the child environment", async () => {
  const res = await bashTool("echo \"$JOC_TEST_VAR\"", dir, 10_000, undefined, { JOC_TEST_VAR: "hello-env" });
  expect(res.success).toBe(true);
  expect(res.output.trim()).toBe("hello-env");
  // Parent env still inherited (PATH present) alongside the injected var.
  const inherit = await bashTool("test -n \"$PATH\" && echo ok", dir, 10_000, undefined, { JOC_TEST_VAR: "x" });
  expect(inherit.output.trim()).toBe("ok");
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
  expect(open.output).toContain("595|line 595");
  expect(open.output).toContain("600|line 600");
  expect(open.output).not.toContain("594|");

  const single = await readTool("src/big.ts", "10", dir);
  expect(single.success).toBe(true);
  expect(single.output).toBe("10|line 10");

  const bad = await readTool("src/big.ts", "abc", dir);
  expect(bad.success).toBe(false);
  expect(bad.error).toContain("Invalid lineRange");
});

test("readTool: appends a truncation notice past 500 lines", async () => {
  const res = await readTool("src/big.ts", undefined, dir);
  expect(res.success).toBe(true);
  expect(res.output).toContain("showing lines 1-500 of 600");
  expect(res.output).toContain('lineRange "501-"');
  expect(res.output).not.toContain("501|line 501");
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
