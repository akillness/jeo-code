import type { Database } from "bun:sqlite";
import { impact, isTestPath, search, stats, whatCalls, whereDefined, whoCalls } from "./query.ts";
import type { Hit, Loc, QOpts } from "./query.ts";

export interface DbStats {
  files: number;
  nodes: number;
  edges: number;
  chunks: number;
}

export interface MultiStats extends DbStats {
  ext?: DbStats;
}

const CONF_RANK: Record<string, number> = {
  import: 0,
  local: 1,
  name: 2,
};

function confRank(conf?: string): number {
  return (conf ? CONF_RANK[conf] : undefined) ?? 2;
}

function locKey(l: Loc): string {
  return `${l.path}|${l.name}|${l.kind}|${l.start}|${l.end}`;
}

function isExtendedTestPath(p: string): boolean {
  return (
    isTestPath(p) ||
    /(^|\/)spec\//.test(p) ||
    /_test\.(go|rb|py|c|cpp|cc|cxx)$/.test(p) ||
    /_spec\.rb$/.test(p) ||
    /(Test|Tests|Spec)\.(java|kt|kts|cs|swift|php)$/.test(p)
  );
}

export function multiWhereDefined(dbs: Database[], name: string, limit = 5): Loc[] {
  const safeLimit = Math.max(0, limit);
  if (safeLimit === 0) return [];
  const seen = new Set<string>();
  const out: Loc[] = [];
  for (const db of dbs) {
    if (!db) continue;
    for (const loc of whereDefined(db, name, safeLimit)) {
      const k = locKey(loc);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(loc);
      if (out.length >= safeLimit) return out;
    }
  }
  return out;
}

function mergeCallResults(perDb: Loc[][], limit: number): Loc[] {
  const byKey = new Map<string, Loc>();
  for (const rows of perDb) {
    for (const loc of rows) {
      const k = locKey(loc);
      const prev = byKey.get(k);
      if (!prev || confRank(loc.conf) < confRank(prev.conf)) {
        byKey.set(k, loc);
      }
    }
  }
  const merged = [...byKey.values()];
  merged.sort(
    (a, b) =>
      confRank(a.conf) - confRank(b.conf) ||
      a.name.localeCompare(b.name) ||
      a.path.localeCompare(b.path) ||
      a.start - b.start,
  );
  return merged.slice(0, Math.max(0, limit));
}

export function multiWhoCalls(dbs: Database[], name: string, opts: QOpts = {}): Loc[] {
  const limit = opts.limit ?? 5;
  const perDb = dbs.filter(Boolean).map((db) => whoCalls(db, name, opts));
  return mergeCallResults(perDb, limit);
}

export function multiWhatCalls(dbs: Database[], name: string, opts: QOpts = {}): Loc[] {
  const limit = opts.limit ?? 5;
  const perDb = dbs.filter(Boolean).map((db) => whatCalls(db, name, opts));
  return mergeCallResults(perDb, limit);
}

export function multiImpact(
  dbs: Database[],
  target: string,
  depth = 3,
  limit = 20,
  strict = false,
): { files: string[]; tests: string[]; symbols: Loc[] } {
  const fileSet = new Set<string>();
  const testSet = new Set<string>();
  const symSeen = new Set<string>();
  const symbols: Loc[] = [];

  for (const db of dbs) {
    if (!db) continue;
    const res = impact(db, target, depth, limit, strict);
    for (const f of res.files) {
      if (isExtendedTestPath(f)) testSet.add(f);
      else fileSet.add(f);
    }
    for (const t of res.tests) testSet.add(t);
    for (const s of res.symbols) {
      if (isExtendedTestPath(s.path)) continue;
      const k = locKey(s);
      if (!symSeen.has(k)) {
        symSeen.add(k);
        symbols.push(s);
      }
    }
  }

  return {
    files: [...fileSet].slice(0, limit),
    tests: [...testSet].slice(0, limit),
    symbols: symbols.slice(0, limit),
  };
}

export function multiSearch(dbs: Database[], text: string, limit = 5, globs?: string[]): Hit[] {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(Number.isFinite(limit) ? limit : 5)));
  const maxHits = safeLimit * 2;
  const buckets = dbs.filter(Boolean).map((db) => search(db, text, safeLimit, globs));
  const seen = new Set<string>();
  const out: Hit[] = [];
  let idx = 0;

  while (out.length < maxHits) {
    let progressed = false;
    for (const bucket of buckets) {
      if (idx < bucket.length) {
        progressed = true;
        const hit = bucket[idx]!;
        const k = `${hit.type}|${hit.path}|${hit.start}|${hit.end}|${hit.label}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push(hit);
          if (out.length >= maxHits) break;
        }
      }
    }
    if (!progressed) break;
    idx++;
  }

  return out;
}

export function multiStats(db: Database, extDb?: Database | null): MultiStats {
  const base = stats(db);
  if (!extDb) return base;
  return {
    ...base,
    ext: stats(extDb),
  };
}
