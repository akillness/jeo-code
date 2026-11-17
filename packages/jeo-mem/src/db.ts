import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DDL, SCHEMA_VERSION } from "./schema.ts";

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=5000;" +
      (path !== ":memory:" ? " PRAGMA cache_size=-16000; PRAGMA mmap_size=67108864;" : ""),
  );
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
