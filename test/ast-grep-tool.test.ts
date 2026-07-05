import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAstGrepTool } from "../src/agent/ast-grep-tool";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-astgrep-"));
}

test("ast_grep requires a non-empty pattern", async () => {
  const tool = createAstGrepTool();
  const res = await tool({ paths: ["*.ts"] }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("pattern");
});

test("ast_grep requires a non-empty paths argument", async () => {
  const tool = createAstGrepTool();
  const res = await tool({ pattern: "console.log($$$)" }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("paths");
});

test("ast_grep reports a pattern parse error clearly", async () => {
  const tool = createAstGrepTool();
  const res = await tool({ pattern: "a(); b();", paths: ["*.ts"] }, await tmpDir());
  expect(res.success).toBe(false);
  expect(res.error).toContain("pattern error");
});

test("ast_grep finds structural matches across multiple files in a directory", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "a.ts"), 'console.log("a");\nconsole.log("a", "b");\n');
  await fs.writeFile(path.join(cwd, "b.ts"), 'console.error("skip");\n');
  await fs.mkdir(path.join(cwd, "sub"));
  await fs.writeFile(path.join(cwd, "sub", "c.ts"), 'console.log(1, 2, 3);\n');

  const tool = createAstGrepTool();
  const res = await tool({ pattern: "console.log($$$ARGS)", paths: ["."] }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("3 match(es) in 2 file(s)");
  expect(res.output).toContain("a.ts:1");
  expect(res.output).toContain("a.ts:2");
  expect(res.output).toContain(path.join("sub", "c.ts") + ":1");
  expect(res.output).not.toContain("b.ts");
});

test("ast_grep reports zero matches without erroring", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "a.ts"), "const x = 1;\n");
  const tool = createAstGrepTool();
  const res = await tool({ pattern: "console.log($$$)", paths: ["a.ts"] }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("0 matches");
});

test("ast_grep skips non-TS/JS files and reports when nothing matched the glob", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "notes.md"), "console.log(1);\n");
  const tool = createAstGrepTool();
  const res = await tool({ pattern: "console.log($$$)", paths: ["*.md"] }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("No TypeScript/JavaScript files matched");
});
