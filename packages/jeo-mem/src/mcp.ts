import type { Database } from "bun:sqlite";
import { existsSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { openDb } from "./db.ts";
import { indexDir } from "./indexer.ts";
import { hasIndexedFiles, impact, search, stats, whatCalls, whereDefined, whoCalls } from "./query.ts";

const REPO_PROP = {
  type: "string",
  description: "Optional repository root path (defaults to --repo/--root, JEOX_REPO, or cwd)",
} as const;

export const MCP_TOOLS = [
  {
    name: "jeox_where_defined",
    description: "Look up where a symbol (function, class, interface, type, etc.) is defined.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name" },
        limit: { type: "integer", default: 5 },
        repo: REPO_PROP,
      },
      required: ["name"],
    },
  },
  {
    name: "jeox_who_calls",
    description: "Look up functions, methods, or modules that call, import, or extend the given symbol.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name" },
        limit: { type: "integer", default: 5 },
        strict: { type: "boolean", default: false, description: "Filter out ambiguous name-only guesses" },
        repo: REPO_PROP,
      },
      required: ["name"],
    },
  },
  {
    name: "jeox_what_calls",
    description: "Look up functions or symbols called by the given caller symbol.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Caller symbol name" },
        limit: { type: "integer", default: 5 },
        strict: { type: "boolean", default: false, description: "Filter out ambiguous name-only guesses" },
        repo: REPO_PROP,
      },
      required: ["name"],
    },
  },
  {
    name: "jeox_impact",
    description: "Reverse dependency closure: find files, tests, and symbols affected by modifying target symbol or file.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Symbol name or relative file path" },
        name: { type: "string", description: "Alias for target symbol name or path" },
        depth: { type: "integer", default: 3 },
        limit: { type: "integer", default: 20 },
        strict: { type: "boolean", default: false },
        repo: REPO_PROP,
      },
    },
  },
  {
    name: "jeox_search",
    description: "BM25 full-text search across indexed symbols and markdown documentation chunks.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        q: { type: "string", description: "Alias for query" },
        globs: { type: "array", items: { type: "string" }, description: "Optional path glob filters (supports !negation)" },
        limit: { type: "integer", default: 5 },
        repo: REPO_PROP,
      },
    },
  },
  {
    name: "jeox_build",
    description: "Incremental build/reindex of the code graph and search database.",
    inputSchema: {
      type: "object",
      properties: {
        rebuild: { type: "boolean", default: false, description: "Full rebuild if true" },
        repo: REPO_PROP,
      },
    },
  },
  {
    name: "jeox_status",
    description: "Return counts of indexed files, code nodes, edges, and markdown chunks for the repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO_PROP,
      },
    },
  },
];

export interface McpServerOptions {
  defaultRoot?: string;
  explicitDb?: string;
}

const MAX_MCP_DB_CACHE = 4;
const DEFAULT_SYNC_STALENESS_MS = 15_000;
const WATCH_IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".jeo",
  ".jeopi",
  ".mex",
  "coverage",
  "build",
  "graphify-out",
  "llm-wiki",
  "Library",
  "gen",
  "target",
  "__pycache__",
]);

interface RepoCacheEntry {
  db: Database;
  root: string;
  dbPath: string;
  lastSyncAt: number;
  dirty: boolean;
  watcher: FSWatcher | null;
  watcherActive: boolean;
}

interface RepoContext {
  db: Database;
  root: string;
  lastSyncAt: number;
  dirty: boolean;
  watcherActive: boolean;
  setLastSyncAt: (ts: number) => void;
  setDirty: (dirty: boolean) => void;
}

function getSyncStalenessMs(): number {
  const raw = process.env.JEOX_SYNC_TTL_MS ?? process.env.JEO_DB_REFRESH_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_SYNC_STALENESS_MS;
}

function readLastIndexedAt(db: Database): number {
  try {
    if (!hasIndexedFiles(db)) return 0;
    const row = db.query("SELECT MAX(indexed_at) AS ts FROM code_files").get() as { ts: string | null } | null;
    if (!row?.ts) return 0;
    const parsed = Date.parse(row.ts);
    return Number.isFinite(parsed) && parsed <= Date.now() ? parsed : 0;
  } catch {
    return 0;
  }
}

function isIgnoredWatchPath(filename: string | Buffer | null): boolean {
  if (!filename) return false;
  const str = typeof filename === "string" ? filename : filename.toString("utf8");
  for (const part of str.split(/[/\\]/)) {
    if (WATCH_IGNORE_DIRS.has(part)) return true;
  }
  return false;
}

function attachRepoWatcher(entry: RepoCacheEntry): void {
  if (!existsSync(entry.root)) return;
  try {
    const watcher = watch(entry.root, { recursive: true }, (_eventType, filename) => {
      if (isIgnoredWatchPath(filename)) return;
      entry.dirty = true;
    });
    watcher.on("error", () => {
      entry.watcherActive = false;
      if (entry.watcher === watcher) entry.watcher = null;
      try { watcher.close(); } catch {}
    });
    watcher.unref?.();
    entry.watcher = watcher;
    entry.watcherActive = true;
  } catch {
    entry.watcher = null;
    entry.watcherActive = false;
  }
}

function closeRepoEntry(entry: RepoCacheEntry, closeDb: boolean): void {
  entry.watcherActive = false;
  if (entry.watcher) {
    try { entry.watcher.close(); } catch {}
    entry.watcher = null;
  }
  if (closeDb) {
    try { entry.db.close(); } catch {}
  }
}
export function isUnsafeDbRoot(dir: string): boolean {
  const resolved = resolve(dir);
  let realTarget = resolved;
  try { realTarget = realpathSync(resolved); } catch {}
  const home = resolve(homedir());
  let realHome = home;
  try { realHome = realpathSync(home); } catch {}
  if (resolved === home || realTarget === realHome) return true;
  if (resolved === parse(resolved).root || realTarget === parse(realTarget).root) return true;
  return false;
}

function resolveRepoDbPath(repoRoot: string, explicitDb?: string): string {
  if (explicitDb) return explicitDb;
  const dbDirFile = join(repoRoot, ".jeo", "db", "jeo.db");
  const memDirFile = join(repoRoot, ".jeo", "mem", "jeo.db");
  if (existsSync(dbDirFile)) return dbDirFile;
  if (existsSync(memDirFile)) return memDirFile;
  return dbDirFile;
}

export async function runMcpServer(dbOrOpts: Database | McpServerOptions, rootArg?: string): Promise<void> {
  const isLegacySingleDb = typeof (dbOrOpts as Database)?.query === "function";
  const singleDb = isLegacySingleDb ? (dbOrOpts as Database) : null;
  const serverOpts: McpServerOptions = isLegacySingleDb ? { defaultRoot: rootArg } : (dbOrOpts as McpServerOptions);

  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  const reply = (id: unknown, result?: unknown, error?: { code: number; message: string }) => {
    const payload = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result };
    process.stdout.write(JSON.stringify(payload) + "\n");
  };

  const dbCache = new Map<string, RepoCacheEntry>();

  const toRepoContext = (entry: RepoCacheEntry): RepoContext => ({
    db: entry.db,
    root: entry.root,
    lastSyncAt: entry.lastSyncAt,
    dirty: entry.dirty,
    watcherActive: entry.watcherActive,
    setLastSyncAt: (ts: number) => { entry.lastSyncAt = ts; },
    setDirty: (dirty: boolean) => { entry.dirty = dirty; },
  });

  const getRepoContext = (rawRepo?: unknown): RepoContext => {
    if (singleDb) {
      let cached = dbCache.get("__single__");
      if (!cached) {
        const root = resolve(rootArg ?? process.cwd());
        const lastSyncAt = readLastIndexedAt(singleDb);
        const stalenessMs = getSyncStalenessMs();
        cached = {
          db: singleDb,
          root,
          dbPath: ":single:",
          lastSyncAt,
          dirty: lastSyncAt === 0 || Date.now() - lastSyncAt >= stalenessMs,
          watcher: null,
          watcherActive: false,
        };
        if (rootArg) attachRepoWatcher(cached);
        dbCache.set("__single__", cached);
      }
      return toRepoContext(cached);
    }

    const raw =
      (typeof rawRepo === "string" && rawRepo.trim())
        ? rawRepo.trim()
        : (serverOpts.defaultRoot || process.env.JEOX_REPO || process.cwd());
    const repoPath = resolve(raw);
    const dbPath = resolveRepoDbPath(repoPath, serverOpts.explicitDb);
    if (!serverOpts.explicitDb && isUnsafeDbRoot(repoPath) && !existsSync(dbPath)) {
      throw new Error(`Refusing to initialize .jeo/db/jeo.db at ${repoPath}; pass 'repo' argument or --repo <project>`);
    }

    let entry = dbCache.get(repoPath);
    if (entry && dbPath !== ":memory:" && !existsSync(entry.dbPath)) {
      closeRepoEntry(entry, true);
      dbCache.delete(repoPath);
      entry = undefined;
    }
    if (entry) {
      dbCache.delete(repoPath);
      dbCache.set(repoPath, entry);
    } else {
      if (dbCache.size >= MAX_MCP_DB_CACHE) {
        const oldestKey = dbCache.keys().next().value;
        if (oldestKey !== undefined) {
          const oldest = dbCache.get(oldestKey);
          dbCache.delete(oldestKey);
          if (oldest) closeRepoEntry(oldest, true);
        }
      }
      const db = openDb(dbPath);
      const lastSyncAt = readLastIndexedAt(db);
      const stalenessMs = getSyncStalenessMs();
      entry = {
        db,
        root: repoPath,
        dbPath,
        lastSyncAt,
        dirty: lastSyncAt === 0 || Date.now() - lastSyncAt >= stalenessMs,
        watcher: null,
        watcherActive: false,
      };
      attachRepoWatcher(entry);
      dbCache.set(repoPath, entry);
    }
    return toRepoContext(entry);
  };

  const ensureFresh = (ctx: RepoContext, force = false) => {
    try {
      if (!force && hasIndexedFiles(ctx.db)) {
        const stalenessMs = getSyncStalenessMs();
        if (Date.now() - ctx.lastSyncAt < stalenessMs) return;
        if (ctx.watcherActive && !ctx.dirty) {
          ctx.setLastSyncAt(Date.now());
          return;
        }
      }
      indexDir(ctx.db, ctx.root);
      ctx.setLastSyncAt(Date.now());
      ctx.setDirty(false);
    } catch { /* best-effort: keep serving last known index */ }
  };
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let req: any;
      try {
        req = JSON.parse(trimmed);
      } catch {
        reply(null, undefined, { code: -32700, message: "Parse error" });
        continue;
      }

      const { id, method, params } = req;
      if (method === "initialize") {
        reply(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "jeo-mem", version: "0.2.0" },
        });
      } else if (method === "tools/list") {
        reply(id, { tools: MCP_TOOLS });
      } else if (method === "tools/call") {
        const toolName = params?.name;
        const args = (params?.arguments ?? {}) as Record<string, any>;
        try {
          const ctx = getRepoContext(args.repo);
          let content: unknown;
          switch (toolName) {
            case "jeox_where_defined":
            case "where_defined":
              ensureFresh(ctx);
              content = whereDefined(ctx.db, String(args.name ?? ""), Number(args.limit ?? 5));
              break;
            case "jeox_who_calls":
            case "who_calls":
              ensureFresh(ctx);
              content = whoCalls(ctx.db, String(args.name ?? ""), { limit: Number(args.limit ?? 5), strict: !!args.strict });
              break;
            case "jeox_what_calls":
            case "what_calls":
              ensureFresh(ctx);
              content = whatCalls(ctx.db, String(args.name ?? ""), { limit: Number(args.limit ?? 5), strict: !!args.strict });
              break;
            case "jeox_impact":
            case "impact":
              ensureFresh(ctx);
              content = impact(ctx.db, String(args.target ?? args.name ?? ""), Number(args.depth ?? 3), Number(args.limit ?? 20), !!args.strict);
              break;
            case "jeox_search":
            case "search":
            case "query": {
              ensureFresh(ctx);
              const qText = String(args.query ?? args.q ?? "");
              const globs = Array.isArray(args.globs) ? args.globs.map(String) : undefined;
              content = search(ctx.db, qText, Number(args.limit ?? 5), globs);
              break;
            }
            case "jeox_build":
            case "build":
            case "index":
              content = indexDir(ctx.db, ctx.root, { rebuild: !!args.rebuild });
              ctx.setLastSyncAt(Date.now());
              ctx.setDirty(false);
              break;
            case "jeox_status":
            case "status":
            case "stats":
              content = { repo: ctx.root, db: resolveRepoDbPath(ctx.root, serverOpts.explicitDb), ...stats(ctx.db) };
              break;
            default:
              reply(id, undefined, { code: -32601, message: `Unknown tool: ${toolName}` });
              continue;
          }
          reply(id, {
            content: [{ type: "text", text: JSON.stringify(content, null, 2) }],
          });
        } catch (err: any) {
          reply(id, undefined, { code: -32603, message: err?.message || String(err) });
        }
      } else if (method && method.startsWith("notifications/")) {
        // Ignore notifications
      } else {
        reply(id, undefined, { code: -32601, message: `Method not found: ${method}` });
      }
    }
  } finally {
    for (const [key, entry] of dbCache) {
      closeRepoEntry(entry, !singleDb && key !== "__single__");
    }
    dbCache.clear();
  }
}
