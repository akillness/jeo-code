#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "./db.ts";
import { appendEvent } from "./events.ts";
import { indexDir } from "./indexer.ts";
import { indexExtDir, resolveExtDbPath } from "./indexer-ext.ts";
import { isUnsafeDbRoot, runMcpServer } from "./mcp.ts";
import { multiImpact, multiSearch, multiStats, multiWhatCalls, multiWhereDefined, multiWhoCalls } from "./query-multi.ts";

const HELP = `jeo-mem <build|index|reindex|who-calls|what-calls|where-defined|impact|scope|query|status|stats|mcp> [arg] [--root|--repo DIR] [--db FILE] [-g GLOB] [--limit N] [--depth N] [--strict] [--full] [--json]`;

function resolveDbPath(root: string, explicit?: string): string {
  if (explicit) return explicit;
  const dbDirFile = join(root, ".jeo", "db", "jeo.db");
  const memDirFile = join(root, ".jeo", "mem", "jeo.db");
  if (existsSync(dbDirFile)) return dbDirFile;
  if (existsSync(memDirFile)) return memDirFile;
  return dbDirFile;
}

export async function runCli(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const flags: Record<string, string> = {};
  const globs: string[] = [];
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--strict") flags.strict = "1";
    else if (a === "--full") flags.full = "1";
    else if (a === "--json") flags.json = "1";
    else if (a === "--rerank") flags.rerank = "1";
    else if (a === "--no-rerank") flags.rerank = "0";
    else if (a === "-g" || a === "--glob") globs.push(argv[++i] ?? "");
    else if (a.startsWith("-g=")) globs.push(a.slice(3));
    else if (a.startsWith("--glob=")) globs.push(a.slice(7));
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = argv[++i] ?? "";
    }
    else pos.push(a);
  }
  const [cmd, ...rest] = pos;
  const arg = rest.join(" ");
  const explicitRepoOrRoot = flags.repo || flags.root;
  const root = resolve(explicitRepoOrRoot ?? ".");
  const dbPath = resolveDbPath(root, flags.db);
  const extDbPath = resolveExtDbPath(dbPath);
  const limit = Number(flags.limit ?? 5);
  const strict = flags.strict === "1";
  const depth = Number(flags.depth ?? 3);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return out(HELP), 0;

  if (cmd === "mcp") {
    await runMcpServer({
      defaultRoot: explicitRepoOrRoot ? root : undefined,
      explicitDb: flags.db,
    });
    return 0;
  }

  if (!flags.db && isUnsafeDbRoot(root) && !existsSync(dbPath)) {
    console.error(`Refusing to initialize .jeo/db/jeo.db at ${root}; pass --repo <project> or --db <file>`);
    return 1;
  }

  if ((cmd === "status" || cmd === "stats") && !existsSync(dbPath) && !existsSync(extDbPath) && dbPath !== ":memory:") {
    out(JSON.stringify({ repo: root, db: dbPath, exists: false, files: 0, nodes: 0, edges: 0, chunks: 0 }));
    return 0;
  }

  const isBuildCmd = cmd === "build" || cmd === "index" || cmd === "reindex";
  const db = openDb(dbPath, isBuildCmd ? { readOnly: false } : undefined);
  let extDb: Database | null = null;
  const j = (o: unknown) => out(JSON.stringify(o));
  const emitRows = <T,>(rows: T[]) => {
    if (flags.json === "1") out(JSON.stringify(rows));
    else rows.forEach(j);
  };
  try {
    extDb = isBuildCmd || existsSync(extDbPath) ? openDb(extDbPath, isBuildCmd ? { readOnly: false } : undefined) : null;
    const dbs = extDb ? [db, extDb] : [db];
    const ensureIndexed = () => {
      try { indexDir(db, root, { wikiRoot: flags["wiki-root"] || undefined }); } catch { /* best-effort incremental refresh */ }
      if (extDb) {
        try { indexExtDir(extDb, root); } catch { /* best-effort incremental refresh */ }
      }
    };
    switch (cmd) {
      case "build":
      case "index":
      case "reindex": {
        const rebuild = cmd === "reindex" || flags.full === "1";
        const s = indexDir(db, root, { rebuild, wikiRoot: flags["wiki-root"] || undefined });
        const extS = extDb ? indexExtDir(extDb, root, { rebuild }) : undefined;
        const eventsFile = join(root, ".jeo", "events.jsonl");
        appendEvent(eventsFile, "index_done", root, { ...s, db: dbPath, ...(extS ? { ext: extS, extDb: extDbPath } : {}) });
        j({ repo: root, db: dbPath, ...(extDb ? { extDb: extDbPath } : {}), ...s, ...multiStats(db, extDb), ...(extS ? { extIndexed: extS } : {}) });
        return 0;
      }
      case "who-calls":
        ensureIndexed();
        emitRows(multiWhoCalls(dbs, arg, { limit, strict }));
        return 0;
      case "what-calls":
        ensureIndexed();
        emitRows(multiWhatCalls(dbs, arg, { limit, strict }));
        return 0;
      case "where-defined":
        ensureIndexed();
        emitRows(multiWhereDefined(dbs, arg, limit));
        return 0;
      case "impact":
        ensureIndexed();
        j(multiImpact(dbs, arg, depth, limit * 4, strict));
        return 0;
      case "query":
      case "search":
        ensureIndexed();
        emitRows(multiSearch(dbs, arg, limit, globs.length > 0 ? globs : undefined));
        return 0;
      case "scope": {
        ensureIndexed();
        const hits = multiSearch(dbs, arg, limit, globs.length > 0 ? globs : undefined);
        j({ meta: { task: arg, hits: hits.length, preview: "none" } });
        hits.forEach(j);
        return 0;
      }
      case "status":
      case "stats":
        j({ repo: root, db: dbPath, ...(extDb ? { extDb: extDbPath } : {}), ...multiStats(db, extDb) });
        return 0;
      default:
        out(HELP);
        return 1;
    }
  } finally {
    db.close();
    try { extDb?.close(); } catch {}
  }
}

if (import.meta.main) {
  runCli(Bun.argv.slice(2)).then(code => {
    if (code !== 0) process.exit(code);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
