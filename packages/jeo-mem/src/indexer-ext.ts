import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { rebuildEdges } from "./edges.ts";
import { extLang, extractExtScript, isExtScript } from "./extract-ext.ts";
import type { IndexStats } from "./indexer.ts";

const IGNORE_DIRS: Record<string, true> = {
  node_modules: true,
  dist: true,
  ".git": true,
  ".jeo": true,
  ".jeopi": true,
  ".mex": true,
  coverage: true,
  build: true,
  "graphify-out": true,
  "llm-wiki": true,
  Library: true,
  gen: true,
  target: true,
  __pycache__: true,
};

const MAX_FILE_BYTES = 1_000_000;

const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.<>]/g, " ")
    .toLowerCase();

interface ExistingFileRow {
  id: number;
  path: string;
  digest: string;
  mtime: number;
}

interface IdRow {
  id: number;
}

export function resolveExtDbPath(dbPath: string): string {
  if (dbPath === ":memory:") return ":memory:";
  if (basename(dbPath) === "jeo.db") {
    const dir = dirname(dbPath);
    return dir === "." && !dbPath.startsWith("./") && !dbPath.startsWith(".\\")
      ? "jeo-ext.db"
      : join(dir, "jeo-ext.db");
  }
  return dbPath.replace(/(\.[^./\\]+)?$/, (ext) => `-ext${ext || ".db"}`);
}

function* walkExt(root: string, dir = root): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    if (e.name.startsWith(".") && e.isDirectory() && e.name !== ".") continue;
    if (e.isDirectory()) {
      if (!IGNORE_DIRS[e.name]) yield* walkExt(root, join(dir, e.name));
    } else if (e.isFile() && isExtScript(e.name)) {
      yield join(dir, e.name);
    }
  }
}

export function indexExtDir(db: Database, root: string, opts: { rebuild?: boolean } = {}): IndexStats {
  const t0 = performance.now();
  const st: IndexStats = { scanned: 0, added: 0, changed: 0, removed: 0, unchanged: 0, ms: 0 };

  if (opts.rebuild) {
    db.exec("DELETE FROM code_nodes_fts; DELETE FROM code_chunks_fts; DELETE FROM code_files;");
  }

  const existing = new Map<string, ExistingFileRow>();
  for (const r of db.query<ExistingFileRow, []>("SELECT id, path, digest, mtime FROM code_files").all()) {
    existing.set(r.path, r);
  }

  const delFts = db.prepare("DELETE FROM code_nodes_fts WHERE rowid IN (SELECT id FROM code_nodes WHERE file_id = ?)");
  const delChunkFts = db.prepare("DELETE FROM code_chunks_fts WHERE rowid IN (SELECT id FROM code_chunks WHERE file_id = ?)");
  const delNodes = db.prepare("DELETE FROM code_nodes WHERE file_id = ?");
  const delChunks = db.prepare("DELETE FROM code_chunks WHERE file_id = ?");
  const delImps = db.prepare("DELETE FROM code_imports WHERE file_id = ?");
  const delFile = db.prepare("DELETE FROM code_files WHERE id = ?");
  const insFile = db.prepare<IdRow, [string, string, string, number, string]>(
    "INSERT INTO code_files(path, lang, digest, mtime, indexed_at) VALUES (?,?,?,?,?) RETURNING id",
  );
  const updFile = db.prepare("UPDATE code_files SET digest=?, mtime=?, indexed_at=? WHERE id=?");
  const insNode = db.prepare<IdRow, [number, string, string, number, number, number]>(
    "INSERT INTO code_nodes(file_id,name,kind,start_line,end_line,exported) VALUES (?,?,?,?,?,?) RETURNING id",
  );
  const insRef = db.prepare("INSERT INTO code_refs(src_id,name,kind,recv) VALUES (?,?,?,?)");
  const insImp = db.prepare("INSERT INTO code_imports(file_id,spec,imported,local,reexport) VALUES (?,?,?,?,?)");
  const insNodeFts = db.prepare("INSERT INTO code_nodes_fts(rowid,name,words) VALUES (?,?,?)");
  const clearFile = (id: number) => {
    delFts.run(id);
    delChunkFts.run(id);
  };

  const entries = [...walkExt(root)].map((abs) => ({ rel: relative(root, abs), abs }));

  const work = db.transaction(() => {
    const seen = new Set<string>();
    for (const { rel, abs } of entries) {
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      seen.add(rel);
      st.scanned++;
      if (stat.size > MAX_FILE_BYTES) continue;
      const mtime = Math.floor(stat.mtimeMs);
      const prev = existing.get(rel);
      if (prev && prev.mtime === mtime) {
        st.unchanged++;
        continue;
      }
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (text.slice(0, 4096).includes("\0")) continue;
      const digest = Bun.hash(text).toString(36);
      if (prev && prev.digest === digest) {
        updFile.run(digest, mtime, new Date().toISOString(), prev.id);
        st.unchanged++;
        continue;
      }
      let fileId: number;
      if (prev) {
        clearFile(prev.id);
        delNodes.run(prev.id);
        delChunks.run(prev.id);
        delImps.run(prev.id);
        updFile.run(digest, mtime, new Date().toISOString(), prev.id);
        fileId = prev.id;
        st.changed++;
      } else {
        const inserted = insFile.get(rel, extLang(rel), digest, mtime, new Date().toISOString());
        if (!inserted) continue;
        fileId = inserted.id;
        st.added++;
      }
      try {
        const ex = extractExtScript(rel, text);
        for (const imp of ex.imports) {
          insImp.run(fileId, imp.spec, imp.imported, imp.local, imp.reexport ? 1 : 0);
        }
        for (const n of ex.nodes) {
          const insertedNode = insNode.get(fileId, n.name, n.kind, n.startLine, n.endLine, n.exported ? 1 : 0);
          if (!insertedNode) continue;
          if (n.kind !== "module") insNodeFts.run(insertedNode.id, n.name, words(n.name));
          for (const r of n.refs) insRef.run(insertedNode.id, r.name, r.kind, r.recv);
        }
      } catch {
        clearFile(fileId);
        delNodes.run(fileId);
        delChunks.run(fileId);
        delImps.run(fileId);
      }
    }
    for (const [path, r] of existing) {
      if (!seen.has(path)) {
        clearFile(r.id);
        delFile.run(r.id);
        st.removed++;
      }
    }
    const needsEdges =
      Boolean(opts.rebuild) ||
      st.added > 0 ||
      st.changed > 0 ||
      st.removed > 0 ||
      (db.query("SELECT 1 FROM code_edges LIMIT 1").get() === null &&
        db.query("SELECT 1 FROM code_refs LIMIT 1").get() !== null);
    if (needsEdges) rebuildEdges(db);
  });

  work();
  st.ms = +(performance.now() - t0).toFixed(1);
  return st;
}
