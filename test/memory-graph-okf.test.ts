import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildConceptGraph,
  expandByGraph,
  lintConceptGraph,
  resolveLinkTarget,
  graphifyAvailable,
  type GraphConcept,
} from "../src/agent/memory-graph";
import { memoryPromptSection, lintMemoryBundle, MEMORY_INJECT_MAX_CHARS } from "../src/agent/memory";

// Sprint 04 — Graph Layer (docs/okf_mem/sprint-04-graph-layer): a zero-dependency
// concept cross-link graph that tolerates broken links, strengthens search by
// 1-hop expansion, lints the bundle, and degrades gracefully without graphify.

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "jeo-memory-graph-"));
}

async function writeConcept(
  dir: string,
  sub: string,
  slug: string,
  fm: Record<string, string>,
  body: string,
): Promise<void> {
  const d = path.join(dir, ".jeo", "memory", sub);
  await fs.mkdir(d, { recursive: true });
  const front = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  await fs.writeFile(path.join(d, `${slug}.md`), `---\n${front}\n---\n${body}\n`, "utf-8");
}

function gc(relPath: string, body: string, title?: string): GraphConcept {
  return { relPath, body, title };
}

test("resolveLinkTarget: bundle-absolute, relative, and non-concept links", () => {
  // bundle-absolute
  expect(resolveLinkTarget("facts/a", "/commands/x.md")).toBe("commands/x");
  // relative within a dir
  expect(resolveLinkTarget("facts/a", "b.md")).toBe("facts/b");
  // relative across dirs
  expect(resolveLinkTarget("facts/a", "../commands/x.md")).toBe("commands/x");
  // anchor + query stripped
  expect(resolveLinkTarget("facts/a", "/facts/b.md#section")).toBe("facts/b");
  // external / protocol / pure anchor → null
  expect(resolveLinkTarget("facts/a", "https://example.com")).toBeNull();
  expect(resolveLinkTarget("facts/a", "mailto:x@y.z")).toBeNull();
  expect(resolveLinkTarget("facts/a", "#heading")).toBeNull();
  // escaping the bundle → null
  expect(resolveLinkTarget("facts/a", "../../etc/passwd")).toBeNull();
});

test("buildConceptGraph builds nodes+edges and tolerates broken links", () => {
  const concepts: GraphConcept[] = [
    gc("facts/parser.md", "See [lexer](/facts/lexer.md) and [missing](/facts/ghost.md)."),
    gc("facts/lexer.md", "Tokenizes input."),
  ];
  const graph = buildConceptGraph(concepts);
  expect(graph.nodes.has("facts/parser")).toBe(true);
  expect(graph.nodes.has("facts/lexer")).toBe(true);
  // real edge resolved
  expect([...(graph.edges.get("facts/parser") ?? [])]).toContain("facts/lexer");
  // broken link tolerated, captured separately (not a throw, not an edge)
  expect([...(graph.broken.get("facts/parser") ?? [])]).toContain("facts/ghost");
});

test("expandByGraph pulls in 1-hop neighbours and respects hop count", () => {
  const concepts: GraphConcept[] = [
    gc("facts/a.md", "[b](/facts/b.md)"),
    gc("facts/b.md", "[c](/facts/c.md)"),
    gc("facts/c.md", "leaf"),
    gc("facts/island.md", "no links"),
  ];
  const graph = buildConceptGraph(concepts);
  const oneHop = expandByGraph(["facts/a"], graph, 1);
  expect(oneHop.has("facts/a")).toBe(true);
  expect(oneHop.has("facts/b")).toBe(true);
  expect(oneHop.has("facts/c")).toBe(false); // 2 hops away
  expect(oneHop.has("facts/island")).toBe(false);
  const twoHop = expandByGraph(["facts/a"], graph, 2);
  expect(twoHop.has("facts/c")).toBe(true);
  // unknown seed is dropped
  expect(expandByGraph(["facts/nope"], graph, 1).size).toBe(0);
});

test("lintConceptGraph reports orphans, broken links, and duplicate titles", () => {
  const concepts: GraphConcept[] = [
    gc("facts/a.md", "[b](/facts/b.md) [ghost](/facts/ghost.md)", "Alpha"),
    gc("facts/b.md", "linked", "Beta"),
    gc("facts/lonely.md", "no links in or out", "Lonely"),
    gc("facts/dup1.md", "x", "Same Title"),
    gc("commands/dup2.md", "y", "same title"),
  ];
  const graph = buildConceptGraph(concepts);
  const report = lintConceptGraph(concepts, graph);
  expect(report.orphans).toContain("facts/lonely");
  expect(report.orphans).not.toContain("facts/a");
  expect(report.orphans).not.toContain("facts/b");
  expect(report.brokenLinks).toEqual([{ from: "facts/a", to: "facts/ghost" }]);
  const dup = report.duplicates.find(d => d.ids.length === 2);
  expect(dup).toBeTruthy();
  expect(dup!.ids.sort()).toEqual(["commands/dup2", "facts/dup1"]);
});

test("graphifyAvailable is injectable and swallows detector errors (graceful)", () => {
  expect(graphifyAvailable(() => true)).toBe(true);
  expect(graphifyAvailable(() => false)).toBe(false);
  expect(graphifyAvailable(() => { throw new Error("boom"); })).toBe(false);
});

test("lintMemoryBundle lints a real on-disk bundle and an absent bundle is empty", async () => {
  const dir = await tmp();
  await writeConcept(dir, "facts", "a", { type: "RepoFact", title: "Alpha" }, "[b](/facts/b.md) [ghost](/facts/ghost.md)");
  await writeConcept(dir, "facts", "b", { type: "RepoFact", title: "Beta" }, "linked back via nothing");
  await writeConcept(dir, "gotchas", "lonely", { type: "Gotcha", title: "Lonely" }, "isolated");
  const report = await lintMemoryBundle(dir);
  expect(report.orphans).toContain("gotchas/lonely");
  expect(report.brokenLinks).toContainEqual({ from: "facts/a", to: "facts/ghost" });
  await fs.rm(dir, { recursive: true, force: true });

  const empty = await tmp();
  const none = await lintMemoryBundle(empty);
  expect(none.orphans).toEqual([]);
  expect(none.brokenLinks).toEqual([]);
  expect(none.duplicates).toEqual([]);
  await fs.rm(empty, { recursive: true, force: true });
});

test("graph 1-hop expansion lifts a linked neighbour into the injected budget", async () => {
  const dir = await tmp();
  // A query-hit concept links to a neighbour that the query does NOT directly hit;
  // budget is filled with unrelated low-confidence noise. The neighbour must still
  // be injected ahead of the noise thanks to 1-hop graph expansion.
  await writeConcept(dir, "commands", "deploy", { type: "Command", title: "deploy pipeline", description: "how to deploy", confidence: "low" }, "Run the deploy. See [rollback](/commands/rollback.md).");
  await writeConcept(dir, "commands", "rollback", { type: "Command", title: "undo a release", description: "revert steps", confidence: "low" }, "Steps to revert a bad release.");
  const big = "w ".repeat(500);
  for (let i = 0; i < 12; i++) {
    await writeConcept(dir, "facts", `noise-${i}`, { type: "RepoFact", title: `Noise ${i}`, description: "filler", confidence: "low" }, big);
  }
  const section = await memoryPromptSection(dir, "deploy");
  expect(section).toContain("deploy pipeline");
  // The neighbour, reachable only via the graph link (no "deploy" keyword), rode in.
  expect(section).toContain("undo a release");
  expect(section.length).toBeLessThan(MEMORY_INJECT_MAX_CHARS + 400);
  await fs.rm(dir, { recursive: true, force: true });
});

test("search/injection still works with graphify absent (built-in graph only)", async () => {
  const dir = await tmp();
  // Simulate graphify-absent: the feature must not depend on it.
  expect(graphifyAvailable(() => false)).toBe(false);
  await writeConcept(dir, "facts", "core", { type: "RepoFact", title: "CRITICAL", description: "always", confidence: "high" }, "essential fact");
  const section = await memoryPromptSection(dir, "anything");
  expect(section).toContain("CRITICAL");
  await fs.rm(dir, { recursive: true, force: true });
});
