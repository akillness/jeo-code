import type { Database } from "bun:sqlite";
import { dirname, join, normalize } from "node:path";

export type Conf = "local" | "import" | "name";
const MAX_AMBIGUOUS = 5;
const EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".rs"];

export interface RebuildEdgesOptions {
  full?: boolean;
}

interface FileRow { id: number; path: string; digest: string }
interface EdgeFileStateRow { file_id: number; path: string; digest: string; def_names: string }
interface Imp { file_id: number; spec: string; imported: string; local: string; reexport: number }
interface Ref { src_id: number; name: string; kind: string; recv: string; file_id: number }
interface Def { id: number; file_id: number; name: string; kind: string }

const PARAM_BATCH = 400;
const EDGE_INSERT_BATCH = 200;
const EDGE_STATE_DDL = `CREATE TABLE IF NOT EXISTS code_edge_file_state (
  file_id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  digest TEXT NOT NULL,
  def_names TEXT NOT NULL
)`;

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function runInTx(db: Database, fn: () => void): void {
  if (db.inTransaction) fn();
  else db.transaction(fn)();
}

function resolveImportSpec(
  fromPath: string,
  spec: string,
  pathToId: ReadonlyMap<string, number>,
): number | null {
  if (fromPath.endsWith(".py")) {
    const dotMatch = /^(\.+)(.*)$/.exec(spec);
    if (dotMatch) {
      let dir = dirname(fromPath);
      for (let up = 1; up < dotMatch[1]!.length; up++) dir = dirname(dir);
      const tail = dotMatch[2] ? dotMatch[2]!.replace(/\./g, "/") : "";
      const base = tail ? normalize(join(dir, tail)) : normalize(dir);
      for (const t of [base + ".py", join(base, "__init__.py")]) {
        const id = pathToId.get(t);
        if (id !== undefined) return id;
      }
      return null;
    }
    const modBase = normalize(spec.replace(/\./g, "/"));
    for (const t of [modBase + ".py", join(modBase, "__init__.py")]) {
      const id = pathToId.get(t);
      if (id !== undefined) return id;
    }
    return null;
  }
  if (!spec.startsWith(".")) return null; // external package / alias: unresolved on purpose
  const base = normalize(join(dirname(fromPath), spec));
  const stripped = base.replace(/\.(m|c)?jsx?$/, "");
  const tries = [base, ...EXTS.map((e) => stripped + e), ...EXTS.map((e) => join(base, `index${e}`))];
  for (const t of tries) {
    const id = pathToId.get(t);
    if (id !== undefined) return id;
  }
  return null;
}

function insertEdgesBatched(db: Database, rows: readonly [number, number, string, Conf][]): void {
  if (rows.length === 0) return;
  const fullPlaceholders = new Array(EDGE_INSERT_BATCH).fill("(?,?,?,?)").join(",");
  const fullStmt = rows.length >= EDGE_INSERT_BATCH
    ? db.prepare(`INSERT INTO code_edges(src_id,dst_id,kind,conf) VALUES ${fullPlaceholders}`)
    : null;

  for (let i = 0; i < rows.length; i += EDGE_INSERT_BATCH) {
    const end = Math.min(i + EDGE_INSERT_BATCH, rows.length);
    const count = end - i;
    const params: (number | string)[] = new Array(count * 4);
    let p = 0;
    for (let j = i; j < end; j++) {
      const r = rows[j]!;
      params[p++] = r[0];
      params[p++] = r[1];
      params[p++] = r[2];
      params[p++] = r[3];
    }
    if (count === EDGE_INSERT_BATCH && fullStmt) {
      fullStmt.run(...params);
    } else {
      const ph = new Array(count).fill("(?,?,?,?)").join(",");
      db.prepare(`INSERT INTO code_edges(src_id,dst_id,kind,conf) VALUES ${ph}`).run(...params);
    }
  }
}

/**
 * Edges are DERIVED (cheap to update incrementally, never stale after partial reindex).
 * Precision order: same-file ('local') and import-bound ('import', follows re-exports) beat
 * name-only guesses ('name', capped at 5 candidates). Names imported from external packages or
 * unresolvable specifiers produce NO edge instead of a false match.
 */
export function rebuildEdges(db: Database, opts: RebuildEdgesOptions = {}): void {
  runInTx(db, () => {
    const files = db.query("SELECT id, path, digest FROM code_files").all() as FileRow[];
    if (files.length === 0) {
      db.exec("DELETE FROM code_edges");
      db.exec(EDGE_STATE_DDL);
      db.exec("DELETE FROM code_edge_file_state");
      return;
    }

    let prevStates: EdgeFileStateRow[] = [];
    let needFull = Boolean(opts.full);
    try {
      prevStates = db.query("SELECT file_id, path, digest, def_names FROM code_edge_file_state").all() as EdgeFileStateRow[];
    } catch {
      db.exec(EDGE_STATE_DDL);
      needFull = true;
    }

    if (!needFull && prevStates.length === 0) {
      needFull = true;
    }
    if (!needFull) {
      const hasEdges = db.query("SELECT 1 FROM code_edges LIMIT 1").get() !== null;
      if (!hasEdges) {
        const hasRefsOrImps =
          db.query("SELECT 1 FROM code_refs LIMIT 1").get() !== null ||
          db.query("SELECT 1 FROM code_imports LIMIT 1").get() !== null;
        if (hasRefsOrImps) needFull = true;
      }
    }

    if (!needFull) {
      const ranIncremental = tryIncrementalUpdate(db, files, prevStates);
      if (ranIncremental) return;
    }

    fullRebuildEdges(db, files);
  });
}

function tryIncrementalUpdate(
  db: Database,
  files: readonly FileRow[],
  prevStates: readonly EdgeFileStateRow[],
): boolean {
  const prevById = new Map<number, EdgeFileStateRow>();
  for (const s of prevStates) prevById.set(s.file_id, s);

  const currById = new Map<number, FileRow>();
  for (const f of files) currById.set(f.id, f);

  const addedFiles: FileRow[] = [];
  const changedFiles: FileRow[] = [];
  const removedStates: EdgeFileStateRow[] = [];

  for (const f of files) {
    const prev = prevById.get(f.id);
    if (!prev) {
      addedFiles.push(f);
    } else if (prev.path !== f.path) {
      // Row ID reused after deletion/re-insert
      removedStates.push(prev);
      addedFiles.push(f);
    } else if (prev.digest !== f.digest) {
      changedFiles.push(f);
    }
  }

  for (const s of prevStates) {
    if (!currById.has(s.file_id)) removedStates.push(s);
  }

  if (addedFiles.length === 0 && changedFiles.length === 0 && removedStates.length === 0) {
    return true;
  }

  if (addedFiles.length + changedFiles.length >= files.length * 0.5 && files.length > 20) {
    return false;
  }

  const affectedNames = new Set<string>();
  for (const s of removedStates) {
    try {
      const names = JSON.parse(s.def_names) as string[];
      if (!Array.isArray(names)) return false;
      for (const n of names) affectedNames.add(n);
    } catch {
      return false;
    }
  }
  for (const f of changedFiles) {
    const prev = prevById.get(f.id);
    if (!prev) return false;
    try {
      const names = JSON.parse(prev.def_names) as string[];
      if (!Array.isArray(names)) return false;
      for (const n of names) affectedNames.add(n);
    } catch {
      return false;
    }
  }

  const addedAndChangedIds = [...addedFiles.map((f) => f.id), ...changedFiles.map((f) => f.id)];
  const newDefNamesByFile = new Map<number, string[]>();
  for (const batch of chunkArray(addedAndChangedIds, PARAM_BATCH)) {
    const ph = batch.map(() => "?").join(",");
    const rows = db
      .query(`SELECT DISTINCT file_id, name FROM code_nodes WHERE kind <> 'module' AND file_id IN (${ph})`)
      .all(...batch) as { file_id: number; name: string }[];
    for (const r of rows) {
      (newDefNamesByFile.get(r.file_id) ?? newDefNamesByFile.set(r.file_id, []).get(r.file_id)!).push(r.name);
      affectedNames.add(r.name);
    }
  }

  const pathToId = new Map<string, number>();
  const idToPath = new Map<number, string>();
  for (const f of files) {
    pathToId.set(f.path, f.id);
    idToPath.set(f.id, f.path);
  }

  const pathToIdWithRemoved = new Map(pathToId);
  const affectedTargetSet = new Set<number>(addedAndChangedIds);
  for (const s of removedStates) {
    const removedMarker = -s.file_id;
    if (!pathToIdWithRemoved.has(s.path)) {
      pathToIdWithRemoved.set(s.path, removedMarker);
    }
    affectedTargetSet.add(s.file_id);
    affectedTargetSet.add(removedMarker);
  }

  const dirtyFileIds = new Set<number>(addedAndChangedIds);

  const imps = db.query("SELECT file_id, spec, imported, local, reexport FROM code_imports").all() as Imp[];
  const resolvedCurrent = new Map<Imp, number | null>();
  const reexports = new Map<number, Imp[]>();
  const byLocalDirty = new Map<number, Map<string, Imp>>();
  const reexportSourcesByTarget = new Map<number, Set<number>>();
  const importSourcesByTarget = new Map<number, Set<number>>();

  for (const i of imps) {
    const fromPath = idToPath.get(i.file_id) ?? "";
    const curTarget = resolveImportSpec(fromPath, i.spec, pathToId);
    resolvedCurrent.set(i, curTarget);
    if (i.reexport) {
      (reexports.get(i.file_id) ?? reexports.set(i.file_id, []).get(i.file_id)!).push(i);
    }

    const oldTarget = removedStates.length > 0 ? resolveImportSpec(fromPath, i.spec, pathToIdWithRemoved) : curTarget;
    for (const t of curTarget === oldTarget ? [curTarget] : [curTarget, oldTarget]) {
      if (t == null) continue;
      const map = i.reexport ? reexportSourcesByTarget : importSourcesByTarget;
      (map.get(t) ?? map.set(t, new Set()).get(t)!).add(i.file_id);
    }
  }

  // Propagate up to 4 hops through re-exports + 1 hop through direct imports
  let frontier = new Set<number>(affectedTargetSet);
  const affectedReexportTargets = new Set<number>(affectedTargetSet);
  for (let hop = 0; hop < 4 && frontier.size > 0; hop++) {
    const nextFrontier = new Set<number>();
    for (const t of frontier) {
      for (const srcFileId of reexportSourcesByTarget.get(t) ?? []) {
        if (currById.has(srcFileId)) dirtyFileIds.add(srcFileId);
        if (!affectedReexportTargets.has(srcFileId)) {
          affectedReexportTargets.add(srcFileId);
          nextFrontier.add(srcFileId);
        }
      }
    }
    frontier = nextFrontier;
  }
  for (const t of affectedReexportTargets) {
    for (const srcFileId of importSourcesByTarget.get(t) ?? []) {
      if (currById.has(srcFileId)) dirtyFileIds.add(srcFileId);
    }
  }

  if (affectedNames.size > 0) {
    for (const batch of chunkArray([...affectedNames], PARAM_BATCH)) {
      const ph = batch.map(() => "?").join(",");
      const refFiles = db
        .query(`SELECT DISTINCT n.file_id FROM code_refs r JOIN code_nodes n ON n.id = r.src_id WHERE r.name IN (${ph})`)
        .all(...batch) as { file_id: number }[];
      for (const r of refFiles) dirtyFileIds.add(r.file_id);
    }
  }

  if (dirtyFileIds.size >= files.length * 0.5 && files.length > 20) {
    return false;
  }

  if (dirtyFileIds.size > 0) {
    const dirtyList = [...dirtyFileIds];
    const dirtyRefs: Ref[] = [];
    const moduleOf = new Map<number, number>();

    for (const batch of chunkArray(dirtyList, PARAM_BATCH)) {
      const ph = batch.map(() => "?").join(",");
      const refs = db
        .query(
          `SELECT r.src_id, r.name, r.kind, r.recv, n.file_id FROM code_refs r JOIN code_nodes n ON n.id = r.src_id WHERE n.file_id IN (${ph})`,
        )
        .all(...batch) as Ref[];
      dirtyRefs.push(...refs);

      const mods = db
        .query(`SELECT id, file_id FROM code_nodes WHERE kind = 'module' AND file_id IN (${ph})`)
        .all(...batch) as { id: number; file_id: number }[];
      for (const m of mods) moduleOf.set(m.file_id, m.id);
    }

    const dirtyImports: Imp[] = [];
    const neededNames = new Set<string>();
    const reexportQueue: number[] = [];
    const seenReexportTargets = new Set<number>();

    for (const i of imps) {
      if (!dirtyFileIds.has(i.file_id) || i.reexport) continue;
      dirtyImports.push(i);
      (byLocalDirty.get(i.file_id) ?? byLocalDirty.set(i.file_id, new Map()).get(i.file_id)!).set(i.local, i);
      neededNames.add(i.imported === "default" || i.imported === "*" ? i.local : i.imported);
      const t = resolvedCurrent.get(i);
      if (t != null && !seenReexportTargets.has(t)) {
        seenReexportTargets.add(t);
        reexportQueue.push(t);
      }
    }
    for (const r of dirtyRefs) neededNames.add(r.name);

    // Collect any renamed re-export symbols up to 4 hops from dirty import targets
    let hopQueue = reexportQueue;
    for (let depth = 0; depth < 4 && hopQueue.length > 0; depth++) {
      const nextHop: number[] = [];
      for (const fileId of hopQueue) {
        for (const rx of reexports.get(fileId) ?? []) {
          if (rx.imported !== "*") neededNames.add(rx.imported);
          const t = resolvedCurrent.get(rx);
          if (t != null && !seenReexportTargets.has(t)) {
            seenReexportTargets.add(t);
            nextHop.push(t);
          }
        }
      }
      hopQueue = nextHop;
    }

    const defsByName = new Map<string, Def[]>();
    const defsByFileName = new Map<string, Def[]>();
    for (const batch of chunkArray([...neededNames], PARAM_BATCH)) {
      const ph = batch.map(() => "?").join(",");
      const defs = db
        .query(`SELECT id, file_id, name, kind FROM code_nodes WHERE kind <> 'module' AND name IN (${ph})`)
        .all(...batch) as Def[];
      for (const d of defs) {
        (defsByName.get(d.name) ?? defsByName.set(d.name, []).get(d.name)!).push(d);
        const k = `${d.file_id}|${d.name}`;
        (defsByFileName.get(k) ?? defsByFileName.set(k, []).get(k)!).push(d);
      }
    }

    const resolveDef = (fileId: number, name: string, depth = 0): Def[] => {
      const direct = defsByFileName.get(`${fileId}|${name}`);
      if (direct?.length) return direct;
      if (depth >= 4) return [];
      for (const r of reexports.get(fileId) ?? []) {
        const target = resolvedCurrent.get(r);
        if (target == null) continue;
        if (r.imported === "*") {
          const d = resolveDef(target, name, depth + 1);
          if (d.length) return d;
        } else if (r.local === name) {
          const d = resolveDef(target, r.imported, depth + 1);
          if (d.length) return d;
        }
      }
      return [];
    };

    const seen = new Set<string>();
    const rows: [number, number, string, Conf][] = [];
    const add = (src: number, ds: Def[], kind: string, conf: Conf) => {
      for (const d of ds) {
        if (d.id === src) continue;
        const k = `${src}|${d.id}|${kind}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push([src, d.id, kind, conf]);
      }
    };

    for (const i of dirtyImports) {
      if (i.imported === "*") continue;
      const target = resolvedCurrent.get(i);
      const mod = moduleOf.get(i.file_id);
      if (target == null || mod === undefined) continue;
      add(mod, resolveDef(target, i.imported === "default" ? i.local : i.imported), "imports", "import");
    }

    for (const r of dirtyRefs) {
      const ctx = byLocalDirty.get(r.file_id);
      const sameFile = defsByFileName.get(`${r.file_id}|${r.name}`) ?? [];
      if (r.recv === "this") {
        if (sameFile.length) { add(r.src_id, sameFile, r.kind, "local"); continue; }
      } else if (r.recv && r.recv !== "#") {
        const ns = ctx?.get(r.recv);
        if (ns && ns.imported === "*") {
          const t = resolvedCurrent.get(ns);
          if (t != null) add(r.src_id, resolveDef(t, r.name), r.kind, "import");
          continue;
        }
      } else if (!r.recv) {
        const imp = ctx?.get(r.name);
        if (imp) {
          const t = resolvedCurrent.get(imp);
          if (t != null) {
            add(r.src_id, resolveDef(t, imp.imported === "default" || imp.imported === "*" ? imp.local : imp.imported), r.kind, "import");
          }
          continue;
        }
        if (sameFile.length) { add(r.src_id, sameFile, r.kind, "local"); continue; }
      }
      const cands = defsByName.get(r.name) ?? [];
      if (cands.length > 0 && cands.length <= MAX_AMBIGUOUS) add(r.src_id, cands, r.kind, "name");
    }

    for (const batch of chunkArray(dirtyList, PARAM_BATCH)) {
      const ph = batch.map(() => "?").join(",");
      db.prepare(`DELETE FROM code_edges WHERE src_id IN (SELECT id FROM code_nodes WHERE file_id IN (${ph}))`).run(...batch);
    }
    insertEdgesBatched(db, rows);
  }

  const deletedOnlyIds = removedStates.map((s) => s.file_id).filter((id) => !currById.has(id));
  for (const batch of chunkArray(deletedOnlyIds, PARAM_BATCH)) {
    const ph = batch.map(() => "?").join(",");
    db.prepare(`DELETE FROM code_edge_file_state WHERE file_id IN (${ph})`).run(...batch);
  }

  const upsertState = db.prepare(
    `INSERT INTO code_edge_file_state(file_id, path, digest, def_names) VALUES (?,?,?,?)
     ON CONFLICT(file_id) DO UPDATE SET path=excluded.path, digest=excluded.digest, def_names=excluded.def_names`,
  );
  for (const f of addedFiles) {
    upsertState.run(f.id, f.path, f.digest, JSON.stringify(newDefNamesByFile.get(f.id) ?? []));
  }
  for (const f of changedFiles) {
    upsertState.run(f.id, f.path, f.digest, JSON.stringify(newDefNamesByFile.get(f.id) ?? []));
  }

  return true;
}

function fullRebuildEdges(db: Database, files: readonly FileRow[]): void {
  const pathToId = new Map(files.map((f) => [f.path, f.id]));
  const idToPath = new Map(files.map((f) => [f.id, f.path]));
  const defs = db.query("SELECT id, file_id, name, kind FROM code_nodes").all() as Def[];
  const defsByName = new Map<string, Def[]>();
  const defsByFileName = new Map<string, Def[]>();
  const defNamesByFile = new Map<number, Set<string>>();
  const moduleOf = new Map<number, number>();
  for (const d of defs) {
    if (d.kind === "module") { moduleOf.set(d.file_id, d.id); continue; }
    (defsByName.get(d.name) ?? defsByName.set(d.name, []).get(d.name)!).push(d);
    const k = `${d.file_id}|${d.name}`;
    (defsByFileName.get(k) ?? defsByFileName.set(k, []).get(k)!).push(d);
    (defNamesByFile.get(d.file_id) ?? defNamesByFile.set(d.file_id, new Set()).get(d.file_id)!).add(d.name);
  }

  const imps = db.query("SELECT file_id, spec, imported, local, reexport FROM code_imports").all() as Imp[];
  const byLocal = new Map<number, Map<string, Imp>>();
  const reexports = new Map<number, Imp[]>();
  const resolved = new Map<Imp, number | null>();
  for (const i of imps) {
    resolved.set(i, resolveImportSpec(idToPath.get(i.file_id) ?? "", i.spec, pathToId));
    if (i.reexport) (reexports.get(i.file_id) ?? reexports.set(i.file_id, []).get(i.file_id)!).push(i);
    else (byLocal.get(i.file_id) ?? byLocal.set(i.file_id, new Map()).get(i.file_id)!).set(i.local, i);
  }

  /** Definition of `name` exported from file (follows `export {x} from` / `export *` up to 4 hops). */
  const resolveDef = (fileId: number, name: string, depth = 0): Def[] => {
    const direct = defsByFileName.get(`${fileId}|${name}`);
    if (direct?.length) return direct;
    if (depth >= 4) return [];
    for (const r of reexports.get(fileId) ?? []) {
      const target = resolved.get(r);
      if (target == null) continue;
      if (r.imported === "*") { const d = resolveDef(target, name, depth + 1); if (d.length) return d; }
      else if (r.local === name) { const d = resolveDef(target, r.imported, depth + 1); if (d.length) return d; }
    }
    return [];
  };

  const seen = new Set<string>();
  const rows: [number, number, string, Conf][] = [];
  const add = (src: number, ds: Def[], kind: string, conf: Conf) => {
    for (const d of ds) {
      if (d.id === src) continue;
      const k = `${src}|${d.id}|${kind}`;
      if (seen.has(k)) continue;
      seen.add(k); rows.push([src, d.id, kind, conf]);
    }
  };

  // module-level import edges
  for (const i of imps) {
    if (i.reexport || i.imported === "*") continue;
    const target = resolved.get(i);
    const mod = moduleOf.get(i.file_id);
    if (target == null || mod === undefined) continue;
    add(mod, resolveDef(target, i.imported === "default" ? i.local : i.imported), "imports", "import");
  }

  const refs = db.query(`SELECT r.src_id, r.name, r.kind, r.recv, n.file_id FROM code_refs r JOIN code_nodes n ON n.id = r.src_id`).all() as Ref[];
  for (const r of refs) {
    const ctx = byLocal.get(r.file_id);
    const sameFile = defsByFileName.get(`${r.file_id}|${r.name}`) ?? [];
    if (r.recv === "this") {
      if (sameFile.length) { add(r.src_id, sameFile, r.kind, "local"); continue; }
    } else if (r.recv && r.recv !== "#") {
      const ns = ctx?.get(r.recv);
      if (ns && ns.imported === "*") {
        const t = resolved.get(ns);
        if (t != null) add(r.src_id, resolveDef(t, r.name), r.kind, "import");
        continue; // namespace member of an external module: no edge
      }
    } else if (!r.recv) {
      const imp = ctx?.get(r.name);
      if (imp) {
        const t = resolved.get(imp);
        if (t != null) add(r.src_id, resolveDef(t, imp.imported === "default" || imp.imported === "*" ? imp.local : imp.imported), r.kind, "import");
        continue; // imported binding: resolved precisely or not at all
      }
      if (sameFile.length) { add(r.src_id, sameFile, r.kind, "local"); continue; }
    }
    const cands = defsByName.get(r.name) ?? [];
    if (cands.length > 0 && cands.length <= MAX_AMBIGUOUS) add(r.src_id, cands, r.kind, "name");
  }

  db.exec("DELETE FROM code_edges");
  insertEdgesBatched(db, rows);

  db.exec(EDGE_STATE_DDL);
  db.exec("DELETE FROM code_edge_file_state");
  const insState = db.prepare("INSERT INTO code_edge_file_state(file_id, path, digest, def_names) VALUES (?,?,?,?)");
  for (const f of files) {
    const names = defNamesByFile.get(f.id);
    insState.run(f.id, f.path, f.digest, names ? JSON.stringify([...names]) : "[]");
  }
}
