import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readTool, editTool, writeTool } from "../src/agent/tools";

// gjc-inherited blind-edit guard (plan/gjc-inheritance.md B7 + B3.5):
// a blind (no-anchor) line-range edit against content the agent has never
// read this session is rejected once (read-first enforced), and SEARCH
// mismatches carry an excerpt so a failed edit costs one retry instead of a
// read round-trip. NOTE: writes/edits are NOT rejected just because the file
// changed on disk since the last read — the agent's write always wins
// (2026-07: stale-read clobber guard removed per explicit user direction).

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-fresh-"));
}

test("edit after external change on disk overwrites it (no clobber guard)", async () => {
  const dir = await tmp();
  const file = path.join(dir, "a.ts");
  await fs.writeFile(file, "const a = 1;\nconst b = 2;\n");
  await readTool("a.ts", undefined, dir);
  // External actor (formatter / concurrent agent) rewrites the file with a different size.
  await new Promise(r => setTimeout(r, 5));
  await fs.writeFile(file, "const a = 100;\nconst b = 2;\n");

  const applied = await editTool("a.ts", "≔1\nconst a = 42;", dir);
  expect(applied.success).toBe(true);
  expect(await fs.readFile(file, "utf-8")).toBe("const a = 42;\nconst b = 2;\n");
  await fs.rm(dir, { recursive: true, force: true });
});

test("write after external change on disk overwrites it (no clobber guard)", async () => {
  const dir = await tmp();
  const file = path.join(dir, "w.txt");
  await fs.writeFile(file, "v1");
  await readTool("w.txt", undefined, dir);
  await new Promise(r => setTimeout(r, 5));
  await fs.writeFile(file, "v2-external-longer");

  const applied = await writeTool("w.txt", "agent-version", dir);
  expect(applied.success).toBe(true);
  expect(await fs.readFile(file, "utf-8")).toBe("agent-version");
  await fs.rm(dir, { recursive: true, force: true });
});

test("edit against an existing, never-read file is rejected (read-first enforced)", async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, "free.ts"), "x\ny\n");
  const res = await editTool("free.ts", "≔1\nz", dir);
  expect(res.success).toBe(false);
  expect(res.error).toContain("no prior read this session");
  // Reading it first clears the guard.
  await readTool("free.ts", undefined, dir);
  const retry = await editTool("free.ts", "≔1\nz", dir);
  expect(retry.success).toBe(true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("write creating a brand-new file is not guarded (nothing to have read)", async () => {
  const dir = await tmp();
  const res = await writeTool("brand-new.ts", "hello", dir);
  expect(res.success).toBe(true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("agent's own edit/write does not trip the guard on the next edit", async () => {
  const dir = await tmp();
  const file = path.join(dir, "self.ts");
  await fs.writeFile(file, "one\ntwo\nthree\n");
  await readTool("self.ts", undefined, dir);
  expect((await editTool("self.ts", "≔1\nONE", dir)).success).toBe(true);
  // No re-read between the agent's own edits — must still pass.
  expect((await editTool("self.ts", "≔2\nTWO", dir)).success).toBe(true);
  expect(await fs.readFile(file, "utf-8")).toBe("ONE\nTWO\nthree\n");
  await fs.rm(dir, { recursive: true, force: true });
});

test("SEARCH mismatch re-presents current content near the anchor (one-retry recovery)", async () => {
  const dir = await tmp();
  const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  await fs.writeFile(path.join(dir, "s.ts"), body.replace("line 20", "function target() { real(); }"));
  await readTool("s.ts", undefined, dir);
  const res = await editTool(
    "s.ts",
    "<<<<<<< SEARCH\nfunction target() { WRONG(); }\n=======\nfunction target() { fixed(); }\n>>>>>>>",
    dir,
  );
  expect(res.success).toBe(false);
  expect(res.error).toContain("Current content near the target");
  expect(res.error).toMatch(/20[a-z0-9]{2}\|function target\(\) \{ real\(\); \}/); // anchored excerpt
  await fs.rm(dir, { recursive: true, force: true });
});
