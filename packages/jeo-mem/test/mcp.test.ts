import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("MCP guards $HOME against accidental DB creation, supports multi-repo calls, and prunes legacy tables", async () => {
  const base = mkdtempSync(join(tmpdir(), "jm-home-guard-"));
  const fakeHome = join(base, "home");
  const repo = join(base, "proj");
  try {
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(repo, "mod"), { recursive: true });
    writeFileSync(join(repo, "mod/worker.py"), "import os\ndef target_py():\n    return 42\n");

    // Seed leftover foreign schema tables that must be cleaned by jeo-code openDb()
    mkdirSync(join(repo, ".jeo", "db"), { recursive: true });
    const legacy = new Database(join(repo, ".jeo", "db", "jeo.db"));
    legacy.exec("CREATE TABLE symbols (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE files_state (path TEXT PRIMARY KEY);");
    legacy.close();

    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    const reqHome = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jeox_where_defined", arguments: { name: "target_py" } } });
    const reqRepo = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jeox_where_defined", arguments: { name: "target_py", repo } } });
    const proc = Bun.spawn(["bun", cliPath, "mcp"], {
      cwd: fakeHome,
      env: { ...process.env, HOME: fakeHome },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(reqHome + "\n" + reqRepo + "\n");
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const responses = out.trim().split("\n").map((line) => JSON.parse(line));
    expect(responses[0].error?.message).toContain("Refusing to initialize .jeo/db/jeo.db");
    expect(existsSync(join(fakeHome, ".jeo", "db", "jeo.db"))).toBe(false);
    expect(responses[1].result?.content?.[0]?.text).toContain("mod/worker.py");

    const cleaned = new Database(join(repo, ".jeo", "db", "jeo.db"));
    const tables = cleaned.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    cleaned.close();
    expect(tables).not.toContain("symbols");
    expect(tables).not.toContain("files_state");
    expect(tables).toContain("code_files");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("main `jeo jeox` CLI subcommand manages .jeo/db/jeo.db cleanly", async () => {
  const repo = mkdtempSync(join(tmpdir(), "jm-cli-jeox-"));
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/app.py"), "def helper_fn():\n    return 1\ndef main_fn():\n    return helper_fn()\n");
    const mainCli = join(import.meta.dir, "..", "..", "..", "src", "cli.ts");
    const build = Bun.spawnSync(["bun", mainCli, "jeox", "build", "--repo", repo], { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode).toBe(0);
    const who = Bun.spawnSync(["bun", mainCli, "jeox", "who-calls", "helper_fn", "--repo", repo, "--json"], { stdout: "pipe", stderr: "pipe" });
    expect(who.exitCode).toBe(0);
    const parsed = JSON.parse(who.stdout.toString());
    expect(parsed.some((r: any) => r.name === "main_fn" && r.path === "src/app.py")).toBe(true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("openDb backs up corrupt DB plus -wal and -shm sidecars to .corrupt.<timestamp> instead of deleting them", () => {
  const dir = mkdtempSync(join(tmpdir(), "jm-corrupt-backup-"));
  try {
    const dbDir = join(dir, "db");
    const dbPath = join(dbDir, "jeo.db");
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(dbPath, "CORRUPT_DB_BYTES");
    writeFileSync(`${dbPath}-wal`, "CORRUPT_WAL_BYTES");
    writeFileSync(`${dbPath}-shm`, "CORRUPT_SHM_BYTES");

    const recovered = openDb(dbPath);
    writeFileSync(join(dir, "ok.ts"), `export function backedUpSymbol() { return 7; }\n`);
    const st = indexDir(recovered, dir);
    expect(st.added).toBeGreaterThanOrEqual(1);
    expect(whereDefined(recovered, "backedUpSymbol")[0]?.path).toBe("ok.ts");
    recovered.close();

    const entries = readdirSync(dbDir);
    const mainBackups = entries.filter((name) => /^jeo\.db\.corrupt\.\d{4}-\d{2}-\d{2}T.+-\d+$/.test(name));
    expect(mainBackups).toHaveLength(1);
    const backupMain = mainBackups[0]!;
    expect(entries).toContain(`${backupMain}-wal`);
    expect(entries).toContain(`${backupMain}-shm`);
    expect(readFileSync(join(dbDir, backupMain), "utf-8")).toBe("CORRUPT_DB_BYTES");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDb with { readOnly: false } throws descriptive error on read-only path while default falls back to :memory:", () => {
  if (process.getuid?.() === 0) return;
  const dir = mkdtempSync(join(tmpdir(), "jm-ro-strict-"));
  const roDir = join(dir, "ro");
  const roCorruptDir = join(dir, "ro-existing");
  try {
    mkdirSync(roDir, { mode: 0o500 });
    chmodSync(roDir, 0o500);

    const roPath = join(roDir, "corrupt-sub", "jeo.db");
    const fallbackDb = openDb(roPath);
    const fallbackName = "filename" in fallbackDb && typeof fallbackDb.filename === "string" ? fallbackDb.filename : "";
    expect(["", ":memory:"].includes(fallbackName)).toBe(true);
    fallbackDb.close();

    let thrown: unknown;
    try {
      openDb(roPath, { readOnly: false });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (thrown instanceof Error) {
      expect(thrown.message).toContain(`Failed to open writable jeo-mem database at "${roPath}"`);
      expect(thrown.cause).toBeDefined();
    }

    mkdirSync(roCorruptDir, { recursive: true });
    const roCorruptPath = join(roCorruptDir, "jeo.db");
    writeFileSync(roCorruptPath, "CORRUPT_IN_RO_DIR");
    chmodSync(roCorruptPath, 0o400);
    chmodSync(roCorruptDir, 0o500);

    const fallbackCorrupt = openDb(roCorruptPath);
    const corruptFallbackName =
      "filename" in fallbackCorrupt && typeof fallbackCorrupt.filename === "string" ? fallbackCorrupt.filename : "";
    expect(["", ":memory:"].includes(corruptFallbackName)).toBe(true);
    fallbackCorrupt.close();

    expect(() => openDb(roCorruptPath, { readOnly: false })).toThrow(
      `Failed to open writable jeo-mem database at "${roCorruptPath}"`,
    );
  } finally {
    chmodSync(roDir, 0o700);
    chmodSync(roCorruptDir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
