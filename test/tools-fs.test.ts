import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findTool, searchTool, readTool, bashTool, IGNORED_DIRS } from "../src/agent/tools";

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
