import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DDL, SCHEMA_VERSION } from "./schema.ts";

const LEGACY_NON_JEO_MEM_DDL = `
DROP TRIGGER IF EXISTS chunks_ai;
DROP TRIGGER IF EXISTS chunks_ad;
DROP TABLE IF EXISTS chunks_fts;
DROP TABLE IF EXISTS edges;
DROP TABLE IF EXISTS symbols;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS files_state;
`;

function pruneLegacyForeignTables(db: Database): void {
  const row = db
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('symbols','edges','chunks','files_state','chunks_fts') LIMIT 1")
    .get();
  if (row) {
    db.exec(LEGACY_NON_JEO_MEM_DDL);
  }
}

function initDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=5000;" +
      (path !== ":memory:" ? " PRAGMA cache_size=-16000; PRAGMA mmap_size=67108864;" : ""),
  );
  pruneLegacyForeignTables(db);
  for (const stmt of DDL) db.exec(stmt);

  const row = db.query("SELECT MAX(version) AS v FROM schema_versions").get() as { v: number | null };
  if ((row.v ?? 0) < SCHEMA_VERSION) {
    db.query("INSERT INTO schema_versions(version, applied_at) VALUES (?, ?)").run(
      SCHEMA_VERSION,
      new Date().toISOString(),
    );
  }
  return db;
}

function isCorruptSqliteError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "");
  const code = String((err as { code?: unknown })?.code ?? "");
  return (
    code === "SQLITE_CORRUPT" ||
    code === "SQLITE_NOTADB" ||
    /malformed|not a database|corrupt/i.test(msg)
  );
}

function isReadOnlySqliteError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "");
  const code = String((err as { code?: unknown })?.code ?? "");
  return (
    code === "EROFS" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "SQLITE_READONLY" ||
    code === "SQLITE_CANTOPEN" ||
    /readonly|read-only|unable to open|permission denied/i.test(msg)
  );
}

export function openDb(path: string): Database {
  if (path === ":memory:") return initDb(path);
  try {
    return initDb(path);
  } catch (err) {
    if (isCorruptSqliteError(err)) {
      try {
        rmSync(path, { force: true });
        rmSync(`${path}-wal`, { force: true });
        rmSync(`${path}-shm`, { force: true });
        return initDb(path);
      } catch (retryErr) {
        if (isReadOnlySqliteError(retryErr)) return initDb(":memory:");
        throw retryErr;
      }
    }
    if (isReadOnlySqliteError(err)) {
      return initDb(":memory:");
    }
    throw err;
  }
}
