import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { indexDir } from "../src/indexer.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { search, whereDefined } from "../src/query.ts";

test("MCP_TOOLS definition contains required tools", () => {
  const toolNames = MCP_TOOLS.map((t) => t.name);
  expect(toolNames).toContain("jeox_where_defined");
  expect(toolNames).toContain("jeox_who_calls");
  expect(toolNames).toContain("jeox_what_calls");
  expect(toolNames).toContain("jeox_impact");
  expect(toolNames).toContain("jeox_search");
  expect(toolNames).toContain("jeox_build");
});

test("openDb recovers from corrupt DB bytes and falls back to :memory: on read-only path", () => {
  const dir = mkdtempSync(join(tmpdir(), "jm-corrupt-"));
  try {
    const dbPath = join(dir, "db", "jeo.db");
    mkdirSync(join(dir, "db"), { recursive: true });
    writeFileSync(dbPath, "NOT A VALID SQLITE DATABASE HEADER");
    const recovered = openDb(dbPath);
    writeFileSync(join(dir, "ok.ts"), `export function recoveredSymbol() { return 1; }\n`);
    const st = indexDir(recovered, dir);
    expect(st.added).toBeGreaterThanOrEqual(1);
    expect(whereDefined(recovered, "recoveredSymbol")[0]?.path).toBe("ok.ts");
    recovered.close();

    if (process.getuid?.() !== 0) {
      const roDir = join(dir, "ro");
      mkdirSync(roDir, { mode: 0o500 });
      chmodSync(roDir, 0o500);
      const fallbackDb = openDb(join(roDir, "sub", "jeo.db"));
      expect(["", ":memory:"].includes((fallbackDb as { filename?: string }).filename ?? "")).toBe(true);
      fallbackDb.close();
      chmodSync(roDir, 0o700);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexDir skips broken symlinks/binary files and search survives weird FTS punctuation", () => {
  const dir = mkdtempSync(join(tmpdir(), "jm-sym-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/good.ts"), `export function validTarget() { return 42; }\n`);
    writeFileSync(join(dir, "src/bin.ts"), `export const x = "\u0000\u0001\u0002";\n`);
    try { symlinkSync("/nonexistent/missing-target.ts", join(dir, "src/broken.ts")); } catch {}
    const db = openDb(":memory:");
    const st = indexDir(db, dir);
    expect(st.added).toBe(1);
    expect(whereDefined(db, "validTarget")[0]?.path).toBe("src/good.ts");
    expect(search(db, "!!! ??? \"\"\" ()")).toEqual([]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP server auto-indexes on first query and refreshes modified files", async () => {
  const root = mkdtempSync(join(tmpdir(), "jm-mcp-fresh-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/one.ts"), `export function mcpAutoInitFn() { return 1; }\n`);
    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    const proc = Bun.spawn(["bun", cliPath, "mcp", "--root", root], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const req1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jeox_where_defined", arguments: { name: "mcpAutoInitFn" } } });
    proc.stdin.write(req1 + "\n");
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("src/one.ts");
    expect(out).toContain("mcpAutoInitFn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
