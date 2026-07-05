import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAstEditTool } from "../src/agent/ast-edit-tool";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-astedit-"));
}

test("ast_edit requires pattern, replacement, and paths", async () => {
  const tool = createAstEditTool();
  const cwd = await tmpDir();
  expect((await tool({ paths: ["a.ts"], replacement: "x" }, cwd)).success).toBe(false);
  expect((await tool({ pattern: "$A", paths: ["a.ts"] }, cwd)).success).toBe(false);
  expect((await tool({ pattern: "$A", replacement: "x" }, cwd)).success).toBe(false);
});

test("ast_edit rewrites captures into the replacement template across matches in one file", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "a.ts"), 'cb && cb();\nmaybeFn && maybeFn();\nother && somethingElse();\n');

  const tool = createAstEditTool();
  const res = await tool({ pattern: "$A && $A()", replacement: "$A?.()", paths: ["a.ts"] }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("2 replacement(s)");

  const after = await fs.readFile(path.join(cwd, "a.ts"), "utf-8");
  expect(after).toContain("cb?.();");
  expect(after).toContain("maybeFn?.();");
  expect(after).toContain("other && somethingElse();"); // untouched — different operands
});

test("ast_edit with an empty replacement deletes the matched span", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "a.ts"), 'console.log("debug: x");\nconst y = 1;\n');

  const tool = createAstEditTool();
  const res = await tool({ pattern: "console.log($$$)", replacement: "", paths: ["a.ts"] }, cwd);
  expect(res.success).toBe(true);

  const after = await fs.readFile(path.join(cwd, "a.ts"), "utf-8");
  expect(after).not.toContain("console.log");
  expect(after).toContain("const y = 1;");
});

test("ast_edit rewrites multi-capture argument lists ($$$ARGS)", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "a.ts"), "foo(1, 2, 3);\n");

  const tool = createAstEditTool();
  const res = await tool({ pattern: "foo($$$ARGS)", replacement: "bar($$$ARGS)", paths: ["a.ts"] }, cwd);
  expect(res.success).toBe(true);

  const after = await fs.readFile(path.join(cwd, "a.ts"), "utf-8");
  expect(after).toContain("bar(1, 2, 3);");
});

test("ast_edit reports zero replacements without erroring when nothing matches", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "a.ts"), "const x = 1;\n");
  const tool = createAstEditTool();
  const res = await tool({ pattern: "console.log($$$)", replacement: "", paths: ["a.ts"] }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("nothing rewritten");
});

test("ast_edit operates across multiple files under a directory path", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "a.ts"), 'console.log("a");\n');
  await fs.writeFile(path.join(cwd, "b.ts"), 'console.log("b");\n');

  const tool = createAstEditTool();
  const res = await tool({ pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)", paths: ["."] }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("2 replacement(s) across 2 file(s)");

  expect(await fs.readFile(path.join(cwd, "a.ts"), "utf-8")).toContain('logger.info("a")');
  expect(await fs.readFile(path.join(cwd, "b.ts"), "utf-8")).toContain('logger.info("b")');
});
