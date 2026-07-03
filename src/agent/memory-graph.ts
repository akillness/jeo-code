/**
 * Concept cross-link graph for the OKF memory bundle — OKF Sprint 04 (Graph Layer).
 *
 * A first-class, zero-dependency link graph over the concept bundle: nodes are
 * concept IDs (bundle-relative path minus `.md`), edges are the markdown links a
 * concept's body points at another concept. Broken links (targets with no node)
 * are TOLERATED — OKF's lenient model treats them as "knowledge not yet written"
 * and the lint pass reports them rather than failing.
 *
 * Used to (1) strengthen Sprint 03 search by 1-hop graph expansion (a concept
 * the query directly hits pulls in its neighbours as injection candidates) and
 * (2) lint the bundle (orphans / broken links / duplicate-title candidates).
 *
 * graphify (the external graph tool) is an OPTIONAL second layer: when present
 * it can enrich, but every feature here runs fully on the built-in graph so the
 * bundle works with graphify absent (graceful degradation). Note: `graphify
 * update` is for CODE repos only — never run it against this markdown bundle.
 *
 * Design contract: docs/okf_mem/sprint-04-graph-layer/index.md
 */
import * as posix from "node:path/posix";
import { conceptId } from "./memory-okf";

/** Minimal shape the graph needs from a concept (a `Concept` satisfies it). */
export interface GraphConcept {
  /** Bundle-relative path, e.g. `commands/bun-test.md`. */
  relPath: string;
  /** Markdown body; scanned for `](target)` links. */
  body: string;
  /** Optional concept title (for duplicate-title lint). */
  title?: string;
}

/** A directed cross-link graph over concept IDs. */
export interface ConceptGraph {
  /** All concept IDs present in the bundle. */
  nodes: Set<string>;
  /** from-ID → set of to-IDs that resolve to a real node. */
  edges: Map<string, Set<string>>;
  /** from-ID → set of link targets that have NO node (tolerated broken links). */
  broken: Map<string, Set<string>>;
  /** ponytail: cached undirected adjacency for O(1) retrieval during graph expansion */
  adj?: Map<string, Set<string>>;
}

/** A markdown inline link `](target)` — captures the target, not the label. */
const LINK_RE = /\]\(([^)\s]+)\)/g;

function addEdge(map: Map<string, Set<string>>, from: string, to: string): void {
  const set = map.get(from) ?? new Set<string>();
  set.add(to);
  map.set(from, set);
}

/**
 * Resolve a markdown link target (as written in `from`'s body) to a concept ID,
 * or `null` when it is not an in-bundle concept reference. Handles:
 *  - external/protocol links (`http://…`, `mailto:`) → null
 *  - pure anchors (`#section`) → null
 *  - bundle-absolute (`/commands/x.md`) → `commands/x`
 *  - relative (`../facts/x.md`) → resolved against `from`'s directory
 * Anchors and query strings are stripped before ID normalization.
 */
export function resolveLinkTarget(fromId: string, rawTarget: string): string | null {
  let t = rawTarget.trim();
  if (!t || t.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(t)) return null; // external/protocol/anchor
  t = t.split("#")[0]!.split("?")[0]!.trim();
  if (!t) return null;
  let full: string;
  if (t.startsWith("/")) {
    full = t.replace(/^\/+/, "");
  } else {
    const slash = fromId.lastIndexOf("/");
    const fromDir = slash === -1 ? "" : fromId.slice(0, slash);
    full = fromDir ? posix.normalize(`${fromDir}/${t}`) : posix.normalize(t);
  }
  if (!full || full.startsWith("..")) return null; // escaped the bundle — not a concept ref
  const id = conceptId(full);
  return id || null;
}

/** Build the cross-link graph from a set of concepts. Broken links are kept
 *  (in `broken`) rather than dropped, so lint can surface them. */
export function buildConceptGraph(concepts: GraphConcept[]): ConceptGraph {
  const nodes = new Set(concepts.map(c => conceptId(c.relPath)));
  const edges = new Map<string, Set<string>>();
  const broken = new Map<string, Set<string>>();
  for (const c of concepts) {
    const from = conceptId(c.relPath);
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(c.body)) !== null) {
      const to = resolveLinkTarget(from, m[1]!);
      if (!to || to === from) continue;
      if (nodes.has(to)) addEdge(edges, from, to);
      else addEdge(broken, from, to);
    }
  }
  return { nodes, edges, broken };
}

/** Undirected adjacency (links are navigable both ways for discovery). */
function undirectedAdjacency(graph: ConceptGraph): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const [from, tos] of graph.edges) {
    for (const to of tos) {
      addEdge(adj, from, to);
      addEdge(adj, to, from);
    }
  }
  return adj;
}

/**
 * Expand a set of seed concept IDs along the (undirected) link graph by up to
 * `hops` steps, returning seeds + reachable neighbours. Seeds not present as
 * nodes are dropped. With `hops` 0 this is just the valid seeds.
 */
export function expandByGraph(seedIds: Iterable<string>, graph: ConceptGraph, hops = 1): Set<string> {
  if (!graph.adj) {
    graph.adj = undirectedAdjacency(graph);
  }
  const adj = graph.adj;
  const result = new Set<string>();
  for (const id of seedIds) if (graph.nodes.has(id)) result.add(id);
  let frontier = [...result];
  for (let h = 0; h < hops && frontier.length > 0; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!result.has(nb)) {
          result.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return result;
}

/** A lenient lint report over the concept graph (warnings, never hard failures). */
export interface GraphLintReport {
  /** Concept IDs with no incoming or outgoing edges. */
  orphans: string[];
  /** Links whose target resolves to no concept node. */
  brokenLinks: { from: string; to: string }[];
  /** Concepts that share a (case-insensitive) title — merge/contradiction candidates. */
  duplicates: { title: string; ids: string[] }[];
}

/** Lint the bundle's graph: orphan concepts, broken links, duplicate titles.
 *  Purely advisory — mirrors llm-wiki's lint pass (broken/orphan/contradiction). */
export function lintConceptGraph(concepts: GraphConcept[], graph: ConceptGraph): GraphLintReport {
  const linked = new Set<string>();
  for (const [from, tos] of graph.edges) {
    if (tos.size > 0) linked.add(from);
    for (const to of tos) linked.add(to);
  }
  const orphans = [...graph.nodes].filter(id => !linked.has(id)).sort();

  const brokenLinks: { from: string; to: string }[] = [];
  for (const [from, tos] of graph.broken) {
    for (const to of tos) brokenLinks.push({ from, to });
  }
  brokenLinks.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const byTitle = new Map<string, string[]>();
  for (const c of concepts) {
    const title = (c.title ?? "").trim();
    if (!title) continue;
    const key = title.toLowerCase();
    const ids = byTitle.get(key) ?? [];
    ids.push(conceptId(c.relPath));
    byTitle.set(key, ids);
  }
  const duplicates: { title: string; ids: string[] }[] = [];
  for (const ids of byTitle.values()) {
    if (ids.length > 1) duplicates.push({ title: ids.length ? (concepts.find(c => conceptId(c.relPath) === ids[0])?.title ?? "").trim() : "", ids: ids.sort() });
  }
  duplicates.sort((a, b) => a.title.localeCompare(b.title));

  return { orphans, brokenLinks, duplicates };
}

/**
 * Whether the optional graphify tool is available on PATH. The built-in graph
 * is always the primary layer; graphify is a best-effort enrichment, so callers
 * degrade gracefully when this is false. `detect` is injectable for testing.
 */
export function graphifyAvailable(detect: () => boolean = defaultGraphifyDetect): boolean {
  try {
    return detect();
  } catch {
    return false;
  }
}

function defaultGraphifyDetect(): boolean {
  // Bun.which resolves a binary on PATH without spawning it.
  const which = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun?.which;
  return typeof which === "function" ? which("graphify") != null : false;
}
