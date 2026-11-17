#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "./db.ts";
import { appendEvent } from "./events.ts";
import { indexDir } from "./indexer.ts";
import { runMcpServer } from "./mcp.ts";
import { impact, search, stats, whatCalls, whereDefined, whoCalls } from "./query.ts";

const HELP = `jeo-mem <build|index|reindex|who-calls|what-calls|where-defined|impact|scope|query|status|stats|mcp> [arg] [--root DIR] [--db FILE] [--limit N] [--strict] [--full]`;

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
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--strict") flags.strict = "1";
    else if (a === "--full") flags.full = "1";
    else if (a === "--json") flags.json = "1";
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
    else pos.push(a);
  }
  const [cmd, ...rest] = pos;
  const arg = rest.join(" ");
  const root = resolve(flags.root ?? ".");
  const dbPath = resolveDbPath(root, flags.db);
  const limit = Number(flags.limit ?? 5);
  const strict = flags.strict === "1";
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return out(HELP), 0;

  if (cmd === "mcp") {
    const db = openDb(dbPath);
    await runMcpServer(db, root);
    return 0;
  }

  const db = openDb(dbPath);
  const j = (o: unknown) => out(JSON.stringify(o));
  const ensureIndexed = () => {
    try { indexDir(db, root); } catch { /* best-effort incremental refresh */ }
  };
  try {
    switch (cmd) {
      case "build":
      case "index":
      case "reindex": {
        const rebuild = cmd === "reindex" || flags.full === "1";
        const s = indexDir(db, root, { rebuild });
        const eventsFile = join(root, ".jeo", "events.jsonl");
        appendEvent(eventsFile, "index_done", root, { ...s, db: dbPath });
        j(s);
        return 0;
      }
      case "who-calls":
        ensureIndexed();
        whoCalls(db, arg, { limit, strict }).forEach(j);
        return 0;
      case "what-calls":
        ensureIndexed();
        whatCalls(db, arg, { limit, strict }).forEach(j);
        return 0;
      case "where-defined":
        ensureIndexed();
        whereDefined(db, arg, limit).forEach(j);
        return 0;
      case "impact":
        ensureIndexed();
        j(impact(db, arg, Number(flags.depth ?? 3), limit * 4, strict));
        return 0;
      case "query":
      case "search":
        ensureIndexed();
        search(db, arg, limit).forEach(j);
        return 0;
      case "scope": {
        ensureIndexed();
        const hits = search(db, arg, limit);
        j({ meta: { task: arg, hits: hits.length, preview: "none" } });
        hits.forEach(j);
        return 0;
      }
      case "status":
      case "stats":
        j(stats(db));
        return 0;
      default:
        out(HELP);
        return 1;
    }
  } finally {
    db.close();
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
