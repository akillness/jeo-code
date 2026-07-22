import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createLspRenameTool } from "../src/agent/lsp-rename-tool";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-lsprename-"));
}

async function fixture(): Promise<string> {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "a.ts"), 'export function greet(name: string): string {\n  return "hi " + name;\n}\n');
  await fs.writeFile(path.join(cwd, "b.ts"), 'import { greet } from "./a";\nconsole.log(greet("world"));\ngreet("again");\n');
  return cwd;
}

test("lsp_rename renames a symbol across every file that references it (apply defaults true)", async () => {
  const cwd = await fixture();
  const tool = createLspRenameTool();
  const res = await tool({ file: "a.ts", line: 1, symbol: "greet", new_name: "salute" }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("Renamed 4 occurrence(s) across 2 file(s)");

  const a = await fs.readFile(path.join(cwd, "a.ts"), "utf-8");
  const b = await fs.readFile(path.join(cwd, "b.ts"), "utf-8");
  expect(a).toContain("function salute(");
  expect(a).not.toContain("greet");
  expect(b).toContain("import { salute } from \"./a\"");
  expect(b).toContain("salute(\"world\")");
  expect(b).toContain("salute(\"again\")");
  expect(b).not.toContain("greet");
});

test("lsp_rename apply:false previews without writing any file", async () => {
  const cwd = await fixture();
  const tool = createLspRenameTool();
  const res = await tool({ file: "a.ts", line: 1, symbol: "greet", new_name: "salute", apply: false }, cwd);
  expect(res.success).toBe(true);
  expect(res.output).toContain("Preview");
  expect(res.output).toContain("4 occurrence(s)");

  const a = await fs.readFile(path.join(cwd, "a.ts"), "utf-8");
  const b = await fs.readFile(path.join(cwd, "b.ts"), "utf-8");
  expect(a).toContain("greet");
  expect(b).toContain("greet");
});

test("lsp_rename rejects an invalid new_name", async () => {
  const cwd = await fixture();
  const tool = createLspRenameTool();
  const res = await tool({ file: "a.ts", line: 1, symbol: "greet", new_name: "not-an-identifier" }, cwd);
  expect(res.success).toBe(false);
  expect(res.error).toContain("valid identifier");
});

test("lsp_rename requires file, line, and new_name", async () => {
  const cwd = await fixture();
  const tool = createLspRenameTool();
  expect((await tool({ line: 1, new_name: "x" }, cwd)).success).toBe(false);
  expect((await tool({ file: "a.ts", new_name: "x" }, cwd)).success).toBe(false);
  expect((await tool({ file: "a.ts", line: 1 }, cwd)).success).toBe(false);
});

test("lsp_rename refuses to rename at a non-renameable position", async () => {
  const cwd = await tmpDir();
  await fs.writeFile(path.join(cwd, "a.ts"), "const x = 1;\n");
  const tool = createLspRenameTool();
  // Position the selector on the numeric literal, not an identifier.
  const res = await tool({ file: "a.ts", line: 1, symbol: "1", new_name: "y" }, cwd);
  expect(res.success).toBe(false);
  expect(res.error).toContain("Cannot rename");
});
test("lsp_rename does not commit a rename after its signal is aborted", async () => {
  const cwd = await fixture();
  const controller = new AbortController();
  controller.abort();

  const result = await createLspRenameTool()(
    { file: "a.ts", line: 1, symbol: "greet", new_name: "salute" },
    cwd,
    undefined,
    controller.signal,
  );

  expect(result.success).toBe(false);
  expect(result.error).toContain("Operation cancelled");
  expect(await fs.readFile(path.join(cwd, "a.ts"), "utf-8")).toContain("function greet(");
  expect(await fs.readFile(path.join(cwd, "b.ts"), "utf-8")).toContain("greet");
});
