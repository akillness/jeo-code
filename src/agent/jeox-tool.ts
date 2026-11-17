/**
 * `jeox` tool — code graph & FTS5 search (mex/zvec core extraction via jeo-mem).
 * Provides fast symbol definitions, callers, callees, reverse impact analysis,
 * and token-optimized search/scope.
 */
import * as path from "node:path";
import { openDb, whereDefined, whoCalls, whatCalls, impact, search, indexDir, stats } from "../../packages/jeo-mem/src/index";
import type { ToolHandler } from "./engine";
import type { ToolResult } from "./tools";

export const JEOX_TOOL_PROTOCOL_LINE =
  `jeox {action, name?, target?, query?, limit?, strict?, depth?, rebuild?, rerank?} — code graph & search DB. ` +
  `Actions: "who-calls" (callers/importers), "what-calls" (callees), "where-defined" (definitions), ` +
  `"impact" (reverse dependency closure: files, tests, symbols), "search" (BM25 search), "scope" (task manifest), ` +
  `"build" (refresh index), "status" (counts).`;

async function rerankHitsWithQev<T extends { type?: string; path?: string; label?: string }>(
  query: string,
  hits: T[],
  explicitRerank?: boolean,
): Promise<T[]> {
  const enabled = explicitRerank === true || (explicitRerank !== false && process.env.JEOX_JEV_RERANK === "1");
  if (!enabled || hits.length <= 1) return hits;
  const endpoint = process.env.JEOX_QEV_URL?.trim() || "http://127.0.0.1:8017/v1/systemone";
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
    if (!resp.ok) return hits;
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
    return hits;
  }
}

/** Per-cwd DB connection cache — avoids re-opening on every tool call. */
const dbCache = new Map<string, ReturnType<typeof openDb>>();
function getDb(cwd: string): ReturnType<typeof openDb> {
  const key = path.resolve(cwd);
  let db = dbCache.get(key);
  if (db) return db;
  const dbDir = path.join(key, ".jeo", "db");
  const dbPath = path.join(dbDir, "jeo.db");
  db = openDb(dbPath);
  if (stats(db).files === 0) indexDir(db, key);
  dbCache.set(key, db);
  return db;
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

    const db = getDb(cwd);

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
          const hits = whoCalls(db, name, { limit, strict });
          if (!hits.length) return { success: true, output: `0 callers found for "${name}".` };
          return { success: true, output: JSON.stringify(hits, null, 2) };
        }
        case "what-calls":
        case "whatcalls": {
          if (!name) return { success: false, output: "", error: `what-calls requires a symbol "name".` };
          const hits = whatCalls(db, name, { limit, strict });
          if (!hits.length) return { success: true, output: `0 callees found for "${name}".` };
          return { success: true, output: JSON.stringify(hits, null, 2) };
        }
        case "where-defined":
        case "wheredefined": {
          if (!name) return { success: false, output: "", error: `where-defined requires a symbol "name".` };
          const hits = whereDefined(db, name, limit);
          if (!hits.length) return { success: true, output: `0 definitions found for "${name}".` };
          return { success: true, output: JSON.stringify(hits, null, 2) };
        }
        case "impact": {
          if (!name) return { success: false, output: "", error: `impact requires a symbol or path "target".` };
          const imp = impact(db, name, depth, limit * 4, strict);
          return { success: true, output: JSON.stringify(imp, null, 2) };
        }
        case "search":
        case "query": {
          if (!query) return { success: false, output: "", error: `search requires a "query" string.` };
          const rawHits = search(db, query, limit);
          const hits = await rerankHitsWithQev(query, rawHits, typeof args.rerank === "boolean" ? args.rerank : undefined);
          if (!hits.length) return { success: true, output: `0 search hits for "${query}".` };
          return { success: true, output: JSON.stringify(hits, null, 2) };
        }
        case "scope": {
          if (!query) return { success: false, output: "", error: `scope requires a task "query" string.` };
          const rawHits = search(db, query, limit);
          const hits = await rerankHitsWithQev(query, rawHits, typeof args.rerank === "boolean" ? args.rerank : undefined);
          const manifest = { meta: { task: query, hits: hits.length, preview: "none" }, hits };
          return { success: true, output: JSON.stringify(manifest, null, 2) };
        }
        case "build":
        case "index":
        case "reindex": {
          const res = indexDir(db, path.resolve(cwd), { rebuild });
          return { success: true, output: `Indexed in ${res.ms}ms: ${JSON.stringify(res)}` };
        }
        case "status":
        case "stats": {
          const st = stats(db);
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
