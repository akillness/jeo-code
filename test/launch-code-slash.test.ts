import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  handleViewSlash,
  handleDiffSlash,
  handleFindSlash,
  handleSearchSlash,
} from "../src/commands/launch/code-slash";
import { getTheme } from "../src/tui/components/themes";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jeo-codeslash-"));
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

test("handleViewSlash: bare /view prints usage", async () => {
  const lines = await handleViewSlash("/view", tmpDir());
  expect(lines).toEqual(["Usage: /view <file> [start-end]   (e.g. /view src/cli.ts 1-40)"]);
});

test("handleViewSlash: missing file reports a read error", async () => {
  const dir = tmpDir();
  const lines = await handleViewSlash("/view nope.ts", dir);
  expect(lines.length).toBe(1);
  expect(lines[0]).toStartWith("! cannot read nope.ts:");
});

test("handleViewSlash: invalid range is rejected before reading content", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.ts"), "const x = 1;\nconst y = 2;\n");
  const lines = await handleViewSlash("/view a.ts notarange", dir);
  expect(lines).toEqual(["Invalid range 'notarange'. Use start-end | start- | start."]);
});

test("handleViewSlash: renders an existing file with a header and its content", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.ts"), "const x = 1;\nconst y = 2;\nconst z = 3;\n");
  const lines = (await handleViewSlash("/view a.ts", dir)).map(stripAnsi);
  expect(lines[0]).toContain("a.ts");
  expect(lines[0]).toContain("lines 1-4");

  expect(lines.join("\n")).toContain("const x = 1;");
  expect(lines.join("\n")).toContain("const z = 3;");
});

test("handleViewSlash: honors a line range", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.ts"), "L1\nL2\nL3\nL4\n");
  const body = (await handleViewSlash("/view a.ts 2-3", dir)).slice(1).map(stripAnsi).join("\n");
  expect(body).toContain("L2");
  expect(body).toContain("L3");
  expect(body).not.toContain("L1");
  expect(body).not.toContain("L4");
});

test("handleDiffSlash: non-git directory reports the failure", async () => {
  const dir = tmpDir();
  const lines = (await handleDiffSlash("/diff", dir, getTheme(undefined))).map(stripAnsi);
  expect(lines.length).toBe(1);
  expect(lines[0]).toStartWith("! git diff failed:");
});

test("handleDiffSlash: clean git repo reports no unstaged changes", async () => {
  const dir = tmpDir();
  const run = (...a: string[]) => Bun.spawnSync(a, { cwd: dir, stdout: "pipe", stderr: "pipe" });
  run("git", "init", "-q");
  run("git", "config", "user.email", "t@t.t");
  run("git", "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "f.txt"), "hello\n");
  run("git", "add", "-A");
  run("git", "commit", "-qm", "init");
  const lines = (await handleDiffSlash("/diff", dir, getTheme(undefined))).map(stripAnsi);
  expect(lines).toEqual(["(no unstaged changes)"]);
});

test("handleDiffSlash: shows unstaged edits with a diff header", async () => {
  const dir = tmpDir();
  const run = (...a: string[]) => Bun.spawnSync(a, { cwd: dir, stdout: "pipe", stderr: "pipe" });
  run("git", "init", "-q");
  run("git", "config", "user.email", "t@t.t");
  run("git", "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "f.txt"), "hello\n");
  run("git", "add", "-A");
  run("git", "commit", "-qm", "init");
  fs.writeFileSync(path.join(dir, "f.txt"), "hello world\n");
  const text = (await handleDiffSlash("/diff", dir, getTheme(undefined))).map(stripAnsi).join("\n");
  expect(text).toContain("git diff");
  expect(text).toContain("hello world");
});

test("handleFindSlash: bare /find prints usage", async () => {
  const lines = await handleFindSlash("/find", tmpDir());
  expect(lines).toEqual(["Usage: /find <glob>   (e.g. /find src/**/*.ts)"]);
});

test("handleFindSlash: lists files matching a glob", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "alpha.ts"), "x");
  fs.writeFileSync(path.join(dir, "beta.md"), "y");
  const lines = (await handleFindSlash("/find *.ts", dir)).map(stripAnsi);
  expect(lines[0]).toContain("find files matching '*.ts'");
  const body = lines.slice(1).join("\n");
  expect(body).toContain("alpha.ts");
  expect(body).not.toContain("beta.md");
});

test("handleSearchSlash: bare /search prints usage", async () => {
  const lines = await handleSearchSlash("/search", tmpDir());
  expect(lines).toEqual(["Usage: /search <pattern> [glob]   (e.g. /search resolveProvider src/**/*.ts)"]);
});

test("handleSearchSlash: finds a matching pattern", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "code.ts"), "export function findMe() { return 42; }\n");
  const lines = (await handleSearchSlash("/search findMe", dir)).map(stripAnsi);
  expect(lines[0]).toContain("search pattern 'findMe'");
  expect(lines.slice(1).join("\n")).toContain("findMe");
});
