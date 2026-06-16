import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadInputHistory, appendInputHistory, inputHistoryPath } from "../src/agent/input-history";

const dirs: string[] = [];
async function tmpCwd(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "jeo-inhist-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

test("load is empty for a workspace with no history file", async () => {
  const cwd = await tmpCwd();
  expect(loadInputHistory(cwd)).toEqual([]);
});

test("append then load returns prompts NEWEST-FIRST (readline order)", async () => {
  const cwd = await tmpCwd();
  appendInputHistory(cwd, "first query");
  appendInputHistory(cwd, "second query");
  appendInputHistory(cwd, "third query");
  expect(loadInputHistory(cwd)).toEqual(["third query", "second query", "first query"]);
  // file is oldest→newest on disk
  expect(await readFile(inputHistoryPath(cwd), "utf-8")).toBe("first query\nsecond query\nthird query\n");
});

test("load de-duplicates, keeping the newest occurrence", async () => {
  const cwd = await tmpCwd();
  appendInputHistory(cwd, "alpha");
  appendInputHistory(cwd, "bravo");
  appendInputHistory(cwd, "alpha"); // alpha used again
  expect(loadInputHistory(cwd)).toEqual(["alpha", "bravo"]);
});

test("append skips blanks, multi-line pastes, the immediate duplicate, and over-long lines", async () => {
  const cwd = await tmpCwd();
  appendInputHistory(cwd, "keep me");
  appendInputHistory(cwd, "   ");            // blank
  appendInputHistory(cwd, "line1\nline2");   // multi-line paste
  appendInputHistory(cwd, "keep me");        // consecutive dup
  appendInputHistory(cwd, "x".repeat(5000)); // over-long
  expect(loadInputHistory(cwd)).toEqual(["keep me"]);
});

test("load honors its limit (newest n) and the file is capped on append", async () => {
  const cwd = await tmpCwd();
  for (let i = 0; i < 12; i++) appendInputHistory(cwd, `q${i}`, 5); // cap file to 5
  // file kept only the last 5 (q7..q11)
  const onDisk = (await readFile(inputHistoryPath(cwd), "utf-8")).trim().split("\n");
  expect(onDisk).toEqual(["q7", "q8", "q9", "q10", "q11"]);
  // load limit applies on top, newest-first
  expect(loadInputHistory(cwd, 2)).toEqual(["q11", "q10"]);
});
