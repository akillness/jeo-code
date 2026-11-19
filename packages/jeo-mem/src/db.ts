import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
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

export interface OpenDbOptions {
  /** Allow falling back to `:memory:` when a read-only or inaccessible path cannot be opened. */
  readOnly?: boolean;
}

function initDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
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
  } catch (err) {
    try { db.close(); } catch {}
    throw err;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return String(err ?? "");
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && (typeof err.code === "string" || typeof err.code === "number")) {
    return String(err.code);
  }
  return "";
}

function isCorruptSqliteError(err: unknown): boolean {
  if (isReadOnlySqliteError(err)) return false;
  const msg = errorMessage(err);
  const code = errorCode(err);
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") return true;
  // Never misclassify POSIX filesystem errors (e.g. EACCES on a path containing "corrupt") as DB corruption.
  if (code.startsWith("E")) return false;
  return /malformed|not a database|corrupt/i.test(msg);
}

function isReadOnlySqliteError(err: unknown): boolean {
  const msg = errorMessage(err);
  const code = errorCode(err);
  return (
    code === "EROFS" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "SQLITE_READONLY" ||
    code === "SQLITE_CANTOPEN" ||
    /readonly|read-only|unable to open|permission denied/i.test(msg)
  );
}

function backupCorruptDb(path: string): void {
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  for (const suffix of ["", "-wal", "-shm"] as const) {
    const src = `${path}${suffix}`;
    if (!existsSync(src)) continue;
    let dest = `${path}.corrupt.${stamp}${suffix}`;
    let counter = 1;
    while (existsSync(dest)) {
      dest = `${path}.corrupt.${stamp}-${counter}${suffix}`;
      counter++;
    }
    try {
      renameSync(src, dest);
    } catch (err) {
      if (errorCode(err) !== "ENOENT") {
        throw err;
      }
    }
  }
}

function wrapOpenDbError(path: string, err: unknown): Error {
  const code = errorCode(err);
  const msg = errorMessage(err);
  const detail = code ? `${code}: ${msg}` : msg;
  return new Error(`Failed to open writable jeo-mem database at "${path}" (${detail})`, { cause: err });
}

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii");

function hasInvalidSqliteHeader(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return false;
    const buf = Buffer.alloc(SQLITE_HEADER.length);
    const fd = openSync(path, "r");
    try {
      const read = readSync(fd, buf, 0, buf.length, 0);
      return read < SQLITE_HEADER.length || !buf.equals(SQLITE_HEADER);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function openDb(path: string, options?: OpenDbOptions): Database {
  if (path === ":memory:") return initDb(path);
  try {
    // Move non-SQLite corrupt DB + -wal/-shm sidecars BEFORE SQLite opens the path:
    // on Linux, opening a non-database file with PRAGMA journal_mode=WAL + close()
    // can unlink the companion -wal/-shm files before catch-time backup runs.
    if (hasInvalidSqliteHeader(path)) {
      backupCorruptDb(path);
    }
    return initDb(path);
  } catch (err) {
    if (isCorruptSqliteError(err)) {
      try {
        backupCorruptDb(path);
        return initDb(path);
      } catch (retryErr) {
        if (isReadOnlySqliteError(retryErr)) {
          if (options?.readOnly !== false) return initDb(":memory:");
          throw wrapOpenDbError(path, retryErr);
        }
        throw retryErr;
      }
    }
    if (isReadOnlySqliteError(err)) {
      if (options?.readOnly !== false) return initDb(":memory:");
      throw wrapOpenDbError(path, err);
    }
    throw err;
  }
}
