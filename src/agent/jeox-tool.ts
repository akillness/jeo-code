/**
 * `jeox` tool — code graph & FTS5 search (mex/zvec core extraction via jeo-mem).
 * Provides fast symbol definitions, callers, callees, reverse impact analysis,
 * and token-optimized search/scope.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  openDb,
  resolveExtDbPath,
  indexDir,
  indexExtDir,
  hasIndexedFiles,
  multiWhereDefined,
  multiWhoCalls,
  multiWhatCalls,
  multiImpact,
  multiSearch,
  multiStats,
} from "../../packages/jeo-mem/src/index";
import { jeoEnv } from "../util/env";
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";

export const JEOX_TOOL_PROTOCOL_LINE =
  `jeox {action, name?, target?, query?, limit?, strict?, depth?, rebuild?, rerank?} — code graph & search DB. ` +
  `Actions: "who-calls" (callers/importers), "what-calls" (callees), "where-defined" (definitions), ` +
  `"impact" (reverse dependency closure: files, tests, symbols), "search" (BM25 search), "scope" (task manifest), ` +
  `"build" (refresh index), "status" (counts).`;

const QEV_CIRCUIT_COOLDOWN_MS = 15_000;
let qevRerankDownUntil = 0;

async function rerankHitsWithQev<T extends { type?: string; path?: string; label?: string }>(
  query: string,
  hits: T[],
  explicitRerank?: boolean,
): Promise<T[]> {
  const enabled = explicitRerank === true || (explicitRerank !== false && process.env.JEOX_JEV_RERANK === "1");
  if (!enabled || hits.length <= 1) return hits;
  const overrideUrl = process.env.JEOX_QEV_URL?.trim();
  if (!overrideUrl && process.env.NODE_ENV !== "test" && Date.now() < qevRerankDownUntil) return hits;
  const endpoint = overrideUrl || "http://127.0.0.1:8017/v1/systemone";
  const capped = hits.slice(0, 12);
  const state: Record<string, string> = { query };
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (let i = 0; i < capped.length; i++) {
    const h = capped[i]!;
    const key = `cand_${i}`;
    state[key] = `${h.type ?? ""} ${h.path ?? ""}: ${h.label ?? ""}`.slice(0, 200);
    questions[`relevant::${i}`] = {
      type: "noul",
      instructions: `Is candidate ${key} directly relevant to the query?`,
    };
  }
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, model: "qev-0.8b-text-Q8_0", questions }),
      signal: AbortSignal.timeout(500),
    });
    if (!resp.ok) {
      if (!overrideUrl && process.env.NODE_ENV !== "test") qevRerankDownUntil = Date.now() + QEV_CIRCUIT_COOLDOWN_MS;
      return hits;
    }
    qevRerankDownUntil = 0;
    const payload = (await resp.json()) as { answers?: Record<string, { noul?: number }> };
    const answers = payload?.answers;
    if (!answers || typeof answers !== "object") return hits;
    const total = capped.length;
    const scored = capped.map((item, idx) => {
      const bm25Norm = total > 1 ? 1 - idx / (total - 1) : 1;
      const rawNoul = answers[`relevant::${idx}`]?.noul;
      const noulProb = typeof rawNoul === "number" && Number.isFinite(rawNoul) ? rawNoul : bm25Norm;
      return { item, idx, score: 0.45 * bm25Norm + 0.55 * noulProb };
    });
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return [...scored.map((s) => s.item), ...hits.slice(12)];
  } catch {
    if (!overrideUrl && process.env.NODE_ENV !== "test") qevRerankDownUntil = Date.now() + QEV_CIRCUIT_COOLDOWN_MS;
    return hits;
  }
}

const DEFAULT_REFRESH_TTL_MS = 3_000;

interface DbEntry {
  db: ReturnType<typeof openDb>;
  dbPath: string;
  extDb: ReturnType<typeof openDb> | null;
  extDbPath: string;
  isMemory: boolean;
  lastSyncAt: number;
  dirty: boolean;
}

/** Per-cwd bounded LRU DB + freshness cache — avoids re-opening on every tool call without leaking FDs. */
const MAX_DB_CACHE = 4;
const dbCache = new Map<string, DbEntry>();

function refreshTtlMs(): number {
  const raw = Number(jeoEnv("DB_REFRESH_MS") ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_REFRESH_TTL_MS;
}

export function markJeoxDirty(cwd: string): void {
  const entry = dbCache.get(path.resolve(cwd));
  if (entry) entry.dirty = true;
}

function getFreshDb(cwd: string, opts: { sync?: boolean } = {}): DbEntry {
  const key = path.resolve(cwd);
  const dbPath = path.join(key, ".jeo", "db", "jeo.db");
  const extDbPath = resolveExtDbPath(dbPath);
  let entry = dbCache.get(key);
  if (entry) {
    const extFilename = (entry.extDb as { filename?: string } | null)?.filename ?? "";
    const extIsMemory = extFilename === "" || extFilename === ":memory:";
    const dbMissing = !entry.isMemory && !fs.existsSync(entry.dbPath);
    const extMissing = entry.extDb !== null && !extIsMemory && !fs.existsSync(entry.extDbPath);
    if (dbMissing || extMissing) {
      try { entry.db.close(); } catch {}
      try { entry.extDb?.close(); } catch {}
      dbCache.delete(key);
      entry = undefined;
    } else {
      // Touch LRU position
      dbCache.delete(key);
      dbCache.set(key, entry);
    }
  }
  if (!entry) {
    const db = openDb(dbPath);
    let extDb: ReturnType<typeof openDb> | null = null;
    try {
      extDb = openDb(extDbPath);
    } catch {
      extDb = null;
    }
    const filename = (db as { filename?: string }).filename ?? "";
    const isMemory = filename === "" || filename === ":memory:";
    if (dbCache.size >= MAX_DB_CACHE) {
      const oldestKey = dbCache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = dbCache.get(oldestKey);
        dbCache.delete(oldestKey);
        try { oldest?.db.close(); } catch {}
        try { oldest?.extDb?.close(); } catch {}
      }
    }
    entry = { db, dbPath, extDb, extDbPath, isMemory, lastSyncAt: 0, dirty: true };
    dbCache.set(key, entry);
  }
  if (opts.sync !== false) {
    let emptyDb = false;
    try { emptyDb = !hasIndexedFiles(entry.db); } catch { emptyDb = true; }
    if (entry.dirty || emptyDb || Date.now() - entry.lastSyncAt >= refreshTtlMs()) {
      let synced = false;
      try {
        indexDir(entry.db, key);
        synced = true;
      } catch {
        // Best-effort incremental refresh: keep serving last known snapshot on lock/race.
      }
      if (entry.extDb) {
        try {
          indexExtDir(entry.extDb, key);
          synced = true;
        } catch {
          // Best-effort incremental refresh on ext DB.
        }
      }
      if (synced) {
        entry.lastSyncAt = Date.now();
        entry.dirty = false;
      }
    }
  }
  return entry;
}

/**
 * Build a compact per-turn `<code_graph_scope>` hint block from `.jeo/db/jeo.db`
 * so prompts automatically reference indexed symbol/doc locations before broad grep.
 */
export function jeoxScopePromptSection(cwd: string, query?: string, opts?: { maxHits?: number; sandboxed?: boolean }): string {
  if (jeoEnv("NO_JEOX_CONTEXT") === "1" || jeoEnv("NO_MEMORY") === "1" || jeoEnv("STATIC_MEMORY") === "1") {
    return "";
  }
  const q = (query ?? "").trim();
  if (q.length < 4 || q.startsWith("/")) return "";

  const key = path.resolve(cwd);
  const dbPath = path.join(key, ".jeo", "db", "jeo.db");
  const dbExists = fs.existsSync(dbPath) || fs.existsSync(resolveExtDbPath(dbPath));
  if (opts?.sandboxed && !dbExists) return "";

  const isTestEnv = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test";
  if (isTestEnv && jeoEnv("ENABLE_JEOX_SCOPE_IN_TEST") !== "1" && !dbExists) return "";

  const hasProjectMarkers =
    dbExists || [".git", "package.json", "tsconfig.json", "src"].some(m => fs.existsSync(path.join(key, m)));
  if (!hasProjectMarkers) return "";

  try {
    const entry = getFreshDb(key, { sync: true });
    const dbs = [entry.db, ...(entry.extDb ? [entry.extDb] : [])];
    const hits = multiSearch(dbs, q, opts?.maxHits ?? 5);
    if (hits.length === 0) return "";
    const lines = hits.map(h => `- [${h.type}] ${h.path}:${h.start}-${h.end} — ${h.label}`);
    return (
      `<code_graph_scope>\n` +
      `Indexed code-graph & doc locations matching this request (from .jeo/db/jeo.db — prefer \`jeox\` or targeted \`read\` lineRanges before broad grep):\n` +
      `${lines.join("\n")}\n` +
      `</code_graph_scope>`
    );
  } catch {
    return "";
  }
}

export function createJeoxTool(): ToolHandler {
  return async (args: Record<string, any>, cwd: string): Promise<ToolResult> => {
    const action = String(args.action ?? "").trim().toLowerCase();
    if (!action) {
      return {
        success: false,
        output: "",
        error: `jeox requires an "action": "who-calls", "what-calls", "where-defined", "impact", "search", "scope", "build", or "status".`,
      };
    }

    const isBuild = action === "build" || action === "index" || action === "reindex";
    const entry = getFreshDb(cwd, { sync: !isBuild });
    const dbs = [entry.db, ...(entry.extDb ? [entry.extDb] : [])];

    const name = String(args.name ?? args.target ?? "").trim();
    const query = String(args.query ?? args.q ?? name).trim();
    const limit = Number(args.limit ?? 5);
    const strict = !!args.strict;
    const depth = Number(args.depth ?? 3);
    const rebuild = !!args.rebuild;

    try {
      switch (action) {
        case "who-calls":
        case "whocalls": {
          if (!name) return { success: false, output: "", error: `who-calls requires a symbol "name".` };
          const hits = multiWhoCalls(dbs, name, { limit, strict });
          if (!hits.length) return { success: true, output: `0 callers found for "${name}".` };
          return { success: true, output: JSON.stringify(hits, null, 2) };
        }
        case "what-calls":
        case "whatcalls": {
          if (!name) return { success: false, output: "", error: `what-calls requires a symbol "name".` };
          const hits = multiWhatCalls(dbs, name, { limit, strict });
          if (!hits.length) return { success: true, output: `0 callees found for "${name}".` };
          return { success: true, output: JSON.stringify(hits, null, 2) };
        }
        case "where-defined":
        case "wheredefined": {
          if (!name) return { success: false, output: "", error: `where-defined requires a symbol "name".` };
          const hits = multiWhereDefined(dbs, name, limit);
          if (!hits.length) return { success: true, output: `0 definitions found for "${name}".` };
          return { success: true, output: JSON.stringify(hits, null, 2) };
        }
        case "impact": {
          if (!name) return { success: false, output: "", error: `impact requires a symbol or path "target".` };
          const imp = multiImpact(dbs, name, depth, limit * 4, strict);
          return { success: true, output: JSON.stringify(imp, null, 2) };
        }
        case "search":
        case "query": {
          if (!query) return { success: false, output: "", error: `search requires a "query" string.` };
          const rawHits = multiSearch(dbs, query, limit);
          const hits = await rerankHitsWithQev(query, rawHits, typeof args.rerank === "boolean" ? args.rerank : undefined);
          if (!hits.length) return { success: true, output: `0 search hits for "${query}".` };
          return { success: true, output: JSON.stringify(hits, null, 2) };
        }
        case "scope": {
          if (!query) return { success: false, output: "", error: `scope requires a task "query" string.` };
          const rawHits = multiSearch(dbs, query, limit);
          const hits = await rerankHitsWithQev(query, rawHits, typeof args.rerank === "boolean" ? args.rerank : undefined);
          const manifest = { meta: { task: query, hits: hits.length, preview: "none" }, hits };
          return { success: true, output: JSON.stringify(manifest, null, 2) };
        }
        case "build":
        case "index":
        case "reindex": {
          const absRoot = path.resolve(cwd);
          const res = indexDir(entry.db, absRoot, { rebuild });
          const extRes = entry.extDb ? indexExtDir(entry.extDb, absRoot, { rebuild }) : undefined;
          entry.lastSyncAt = Date.now();
          entry.dirty = false;
          const payload = extRes ? { ...res, ext: extRes } : res;
          const totalMs = +(res.ms + (extRes?.ms ?? 0)).toFixed(1);
          return { success: true, output: `Indexed in ${totalMs}ms: ${JSON.stringify(payload)}` };
        }
        case "status":
        case "stats": {
          const st = multiStats(entry.db, entry.extDb);
          return { success: true, output: JSON.stringify(st, null, 2) };
        }
        default:
          return {
            success: false,
            output: "",
            error: `Unknown action: "${action}". Valid actions: who-calls, what-calls, where-defined, impact, search, scope, build, status.`,
          };
      }
    } catch (err: any) {
      return { success: false, output: "", error: err?.message || String(err) };
    }
  };
}
