import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createLspTool } from "../src/agent/lsp-tool";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-lsp-"));
}

async function fixture(): Promise<string> {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "a.ts"), 'export function greet(name: string): string {\n  return "hi " + name;\n}\n');
  await fs.writeFile(path.join(cwd, "b.ts"), 'import { greet } from "./a";\nconsole.log(greet("world"));\ngreet("again");\n');
  return cwd;
}

test("lsp definition resolves a cross-file symbol to its declaration", async () => {
  const cwd = await fixture();
  const tool = createLspTool();
  const res = await tool({ action: "definition", file: "b.ts", line: 2, symbol: "greet" }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("a.ts:1");
  expect(res.output).toContain("export function greet");
});

test("lsp references finds every occurrence across files", async () => {
  const cwd = await fixture();
  const tool = createLspTool();
  const res = await tool({ action: "references", file: "a.ts", line: 1, symbol: "greet" }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("4 reference(s)");
  expect(res.output).toContain("a.ts:1");
  expect(res.output).toContain("b.ts:1");
  expect(res.output).toContain("b.ts:2");
  expect(res.output).toContain("b.ts:3");
});

test("lsp hover reports the resolved type signature", async () => {
  const cwd = await fixture();
  const tool = createLspTool();
  const res = await tool({ action: "hover", file: "b.ts", line: 2, symbol: "greet" }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("greet");
  expect(res.output).toContain("string");
});

test("lsp symbols lists top-level declarations in a file", async () => {
  const cwd = await fixture();
  const tool = createLspTool();
  const res = await tool({ action: "symbols", file: "a.ts" }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("greet");
});

test("lsp diagnostics reports a real type error", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "bad.ts"), 'const x: number = "oops";\n');
  const tool = createLspTool();
  const res = await tool({ action: "diagnostics", file: "bad.ts" }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("bad.ts:1");
  expect(res.output.toLowerCase()).toContain("not assignable");
});

test("lsp diagnostics reports zero diagnostics for a clean file", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "good.ts"), "const x: number = 1;\n");
  const tool = createLspTool();
  const res = await tool({ action: "diagnostics", file: "good.ts" }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("0 diagnostics");
});

test("lsp diagnostics with '*' scans every TS/JS file in the project", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "good.ts"), "const x: number = 1;\n");
  await fs.writeFile(path.join(cwd, "bad.ts"), 'const y: number = "oops";\n');
  const tool = createLspTool();
  const res = await tool({ action: "diagnostics", file: "*" }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("bad.ts:1");
});

test("lsp requires file/line and rejects an out-of-range line clearly", async () => {
  const cwd = await fixture();
  const tool = createLspTool();
  const missingFile = await tool({ action: "definition", line: 1 }, cwd);
  expect(missingFile.success).toBe(false);
  expect(missingFile.error).toContain("file");

  const badLine = await tool({ action: "definition", file: "a.ts", line: 999 }, cwd);
  expect(badLine.success).toBe(false);
  expect(badLine.error).toContain("out of range");
});

test("lsp rejects an unknown action", async () => {
  const cwd = await fixture();
  const tool = createLspTool();
  const res = await tool({ action: "bogus" }, cwd);
  expect(res.success).toBe(false);
  expect(res.error).toContain("Unknown lsp action");
});
