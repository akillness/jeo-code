import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { searchTool } from "../src/agent/tools";

// Field bug: a repo whose .gitignore contains `.*` (ignore dotfiles — extremely common)
// made `search` return "No matches found." for text that existed, because `.*` became a
// grep --exclude that matches the `./`-prefixed traversal paths and excluded every file.
test("searchTool: finds nested content even when .gitignore has a `.*` (and bare `*`) glob", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-search-gi-"));
  try {
    await fs.writeFile(path.join(dir, ".gitignore"), ".*\n*\nnode_modules/\n*.log\n");
    await fs.mkdir(path.join(dir, "sub", "deep"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "deep", "target.ts"), "export const UNIQUE_TOKEN_XYZ = 1;\n");

    // Default glob ("*") — the exact case a model that omits globPattern hits.
    const r = await searchTool("UNIQUE_TOKEN_XYZ", "*", dir, false, {});
    expect(r.success).toBe(true);
    expect(r.output).toContain("UNIQUE_TOKEN_XYZ");
    expect(r.output).toContain("target.ts");
    expect(r.output).not.toBe("No matches found.");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("searchTool: still excludes real ignored dirs (node_modules) and .log files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-search-gi2-"));
  try {
    await fs.writeFile(path.join(dir, ".gitignore"), ".*\nnode_modules/\n*.log\n");
    await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(dir, "node_modules", "pkg", "index.ts"), "const NEEDLE_TOKEN = 1;\n");
    await fs.writeFile(path.join(dir, "keep.ts"), "const NEEDLE_TOKEN = 2;\n");
    await fs.writeFile(path.join(dir, "noisy.log"), "NEEDLE_TOKEN in a log\n");

    const r = await searchTool("NEEDLE_TOKEN", "*", dir, false, {});
    expect(r.output).toContain("keep.ts");
    expect(r.output).not.toContain("node_modules");
    expect(r.output).not.toContain("noisy.log");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
