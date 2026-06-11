import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readTool, editTool, writeTool } from "../src/agent/tools";

// gjc-inherited file-freshness guard (plan/gjc-inheritance.md B7 + B3.5):
// edits against content the agent has not seen are rejected ONCE with the
// current content re-presented (recovery), and SEARCH mismatches carry an
// excerpt so a failed edit costs one retry instead of a read round-trip.

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-fresh-"));
}

test("edit after external change is rejected with current content, then retry passes", async () => {
  const dir = await tmp();
  const file = path.join(dir, "a.ts");
  await fs.writeFile(file, "const a = 1;\nconst b = 2;\n");
  await readTool("a.ts", undefined, dir);
  // External actor (formatter / concurrent agent) rewrites the file with a different size.
  await new Promise(r => setTimeout(r, 5));
  await fs.writeFile(file, "const a = 100;\nconst b = 2;\n");

  const rejected = await editTool("a.ts", "≔1\nconst a = 42;", dir);
  expect(rejected.success).toBe(false);
  expect(rejected.error).toContain("changed on disk since you last read it");
  expect(rejected.error).toMatch(/1[a-z0-9]{2}\|const a = 100;/); // recovery: current content shown

  // The rejection refreshed the snapshot — the immediate retry succeeds.
  const retry = await editTool("a.ts", "≔1\nconst a = 42;", dir);
  expect(retry.success).toBe(true);
  expect(await fs.readFile(file, "utf-8")).toBe("const a = 42;\nconst b = 2;\n");
  await fs.rm(dir, { recursive: true, force: true });
});

test("write after external change is rejected once (clobber protection)", async () => {
  const dir = await tmp();
  const file = path.join(dir, "w.txt");
  await fs.writeFile(file, "v1");
  await readTool("w.txt", undefined, dir);
  await new Promise(r => setTimeout(r, 5));
  await fs.writeFile(file, "v2-external-longer");

  const rejected = await writeTool("w.txt", "agent-version", dir);
  expect(rejected.success).toBe(false);
  expect(rejected.error).toContain("changed on disk");
  const retry = await writeTool("w.txt", "agent-version", dir);
  expect(retry.success).toBe(true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("edit without a prior read is not guarded (back-compat)", async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, "free.ts"), "x\ny\n");
  const res = await editTool("free.ts", "≔1\nz", dir);
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
