import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildEdges } from "../src/edges.ts";
import { chunkMarkdown, impact, indexDir, openDb, search, whoCalls, whereDefined, whatCalls } from "../src/index.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jm-fx-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), `export function readLedger(p: string) { return parse(p); }\nexport function parse(x: string) { return x; }\n`);
  writeFileSync(join(root, "src/b.ts"), `import { readLedger } from "./a";\nexport const run = () => readLedger("x");\nclass Foo { go() { run(); } }\n`);
  writeFileSync(join(root, "docs.md"), `# Ledger design\nappend only\n## Reading\nreadLedger folds events\n`);
  return root;
}

test("index → who-calls / what-calls / where-defined / impact / search", () => {
  const root = fixture();
  const db = openDb(":memory:");
  const s = indexDir(db, root);
  expect(s.added).toBe(3);
  expect(whereDefined(db, "readLedger")[0]!.path).toBe("src/a.ts");
  expect(whoCalls(db, "readLedger", { limit: 10 }).map((l) => l.name).sort()).toEqual(["<module>", "run"]);
  expect(whatCalls(db, "readLedger").map((l) => l.name)).toEqual(["parse"]);
  const imp = impact(db, "parse");
  expect(imp.files).toContain("src/b.ts");
  expect(search(db, "ledger reading").some((h) => h.type === "doc")).toBe(true);
  expect(search(db, "read ledger").some((h) => h.type === "symbol" && h.label.includes("readLedger"))).toBe(true);
});

test("incremental: unchanged skipped, change/remove handled, edges + fts stay consistent", () => {
  const root = fixture();
  const db = openDb(":memory:");
  indexDir(db, root);
  expect(indexDir(db, root).unchanged).toBe(3);
  writeFileSync(join(root, "src/a.ts"), `export function readLedger() { return other(); }\nexport function other() {}\n`);
  utimesSync(join(root, "src/a.ts"), new Date(), new Date(Date.now() + 5000));
  const s2 = indexDir(db, root);
  expect(s2.changed).toBe(1);
  expect(whatCalls(db, "readLedger").map((l) => l.name)).toEqual(["other"]);
  expect(whoCalls(db, "readLedger").length).toBe(2); // b.ts edges survive a.ts re-index
  rmSync(join(root, "src/b.ts"));
  expect(indexDir(db, root).removed).toBe(1);
  expect(whoCalls(db, "readLedger").length).toBe(0);
  expect(search(db, "parse").filter((h) => h.type === "symbol").length).toBe(0);
});

test("markdown chunker splits by heading and caps size", () => {
  const c = chunkMarkdown(`# A\nx\n## B\ny\n\`\`\`\n# not heading\n\`\`\`\n`);
  expect(c.map((x) => x.heading)).toEqual(["A", "A > B"]);
  const big = chunkMarkdown(`# H\n${"line\n".repeat(2000)}`);
  expect(big.length).toBeGreaterThan(1);
  expect(big.every((x) => x.text.length <= 3700)).toBe(true);
});

test("local variables are not symbols; their calls attribute to the enclosing function", () => {
  const root = mkdtempSync(join(tmpdir(), "jm-loc-"));
  writeFileSync(join(root, "x.ts"), `export function outer() { const tmp = helper(); return tmp; }\nfunction helper() {}\n`);
  const db = openDb(":memory:");
  indexDir(db, root);
  expect(whereDefined(db, "tmp").length).toBe(0);
  expect(whoCalls(db, "helper").map((l) => l.name)).toEqual(["outer"]);
});

test("incremental edit replaces imports without leaving duplicates or phantom edges", () => {
  const root = fixture();
  const db = openDb(":memory:");
  indexDir(db, root);
  expect(whoCalls(db, "readLedger", { strict: true }).some((l) => l.path === "src/b.ts")).toBe(true);
  writeFileSync(join(root, "src/b.ts"), `export const run = () => 1;\n`);
  utimesSync(join(root, "src/b.ts"), new Date(), new Date(Date.now() + 5000));
  indexDir(db, root);
  const imps = db.query("SELECT COUNT(*) c FROM code_imports").get() as { c: number };
  expect(imps.c).toBe(0);
  expect(whoCalls(db, "readLedger").length).toBe(0);
});

test("FTS5 search supports camelCase queries and Korean/Unicode text", () => {
  const root = mkdtempSync(join(tmpdir(), "jm-ko-"));
  writeFileSync(join(root, "README.ko.md"), `# 아키텍처 개요\n로컬 코드 그래프 메모리 엔진입니다.\n`);
  writeFileSync(join(root, "mod.ts"), `export function parseLedgerEntry() { return 1; }\n`);
  const db = openDb(":memory:");
  indexDir(db, root);
  expect(search(db, "parseLedgerEntry").some((h) => h.type === "symbol" && h.label.includes("parseLedgerEntry"))).toBe(true);
  expect(search(db, "메모리 엔진").some((h) => h.type === "doc" && h.path === "README.ko.md")).toBe(true);
  expect(search(db, "parseLedgerEntry", 5, ["!README*"]).every((h) => !h.path.startsWith("README"))).toBe(true);
});

test("indexes Python (.py) + Rust (.rs) definitions, calls, and glob-filtered queries", () => {
  const root = mkdtempSync(join(tmpdir(), "jm-py-rs-"));
  try {
    mkdirSync(join(root, "pkg"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "pkg/a.py"), "import os\ndef foo():\n    return bar()\ndef bar():\n    return 1\n");
    writeFileSync(join(root, "pkg/b.py"), "from .a import foo\ndef baz():\n    return foo()\n");
    writeFileSync(join(root, "scripts/native.rs"), "pub fn rs_entry() {\n    rs_leaf();\n}\nfn rs_leaf() {}\n");
    writeFileSync(join(root, "docs/guide.md"), "# PyWorker\nfoo pipeline needleAlpha notes\n");
    const db = openDb(":memory:");
    const s = indexDir(db, root);
    expect(s.added).toBe(4);
    expect(whereDefined(db, "foo")[0]?.path).toBe("pkg/a.py");
    expect(whoCalls(db, "foo", { limit: 10 }).map((l) => l.name)).toContain("baz");
    expect(whereDefined(db, "rs_entry")[0]?.path).toBe("scripts/native.rs");
    expect(whoCalls(db, "rs_leaf").map((l) => l.name)).toContain("rs_entry");
    const docsOnly = search(db, "needleAlpha", 10, ["docs/**", "!pkg/**"]);
    expect(docsOnly.some((h) => h.path === "docs/guide.md")).toBe(true);
    expect(search(db, "needleAlpha", 5, ["!docs/**"])).toEqual([]);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function canonicalEdges(db: Database): string[] {
  const rows = db.query(`
    SELECT sf.path || ':' || sn.name || ':' || sn.kind || ' -[' || e.kind || ':' || e.conf || ']-> ' ||
           df.path || ':' || dn.name || ':' || dn.kind AS edge
    FROM code_edges e
    JOIN code_nodes sn ON sn.id = e.src_id
    JOIN code_files sf ON sf.id = sn.file_id
    JOIN code_nodes dn ON dn.id = e.dst_id
    JOIN code_files df ON df.id = dn.file_id
    ORDER BY edge
  `).all() as { edge: string }[];
  return rows.map((r) => r.edge);
}

function rawEdgeTuples(db: Database): string[] {
  const rows = db.query(
    "SELECT src_id || ':' || dst_id || ':' || kind || ':' || conf AS row FROM code_edges ORDER BY src_id, dst_id, kind, conf",
  ).all() as { row: string }[];
  return rows.map((r) => r.row);
}

function fullCanonicalEdgesFromDisk(root: string): string[] {
  const fresh = openDb(":memory:");
  try {
    indexDir(fresh, root);
    rebuildEdges(fresh, { full: true });
    return canonicalEdges(fresh);
  } finally {
    fresh.close();
  }
}

test("incremental rebuildEdges matches full rebuild across edit, addition, removal, re-export chains, and manual code_edges wipe", () => {
  const root = mkdtempSync(join(tmpdir(), "jm-edges-inc-"));
  const incDb = openDb(":memory:");
  let tick = Date.now() + 5_000;
  const touch = (relPath: string, content: string) => {
    const abs = join(root, relPath);
    writeFileSync(abs, content);
    tick += 5_000;
    utimesSync(abs, new Date(tick), new Date(tick));
  };

  try {
    mkdirSync(join(root, "src"), { recursive: true });
    touch("src/leaf.ts", [
      "export function leafCore() { return leafUtil(); }",
      "export function leafUtil() { return 1; }",
      "export function helper() { return 2; }",
    ].join("\n"));
    touch("src/mid.ts", [
      'export { leafCore as renamedLeaf } from "./leaf";',
      'export * from "./leaf";',
    ].join("\n"));
    touch("src/barrel.ts", 'export * from "./mid";\n');
    touch("src/consumer.ts", [
      'import { renamedLeaf, helper } from "./barrel";',
      "export function runAll() { renamedLeaf(); return helper(); }",
    ].join("\n"));
    touch("src/ambig.ts", "export function sharedName() { return 1; }\nexport function callShared() { return sharedName(); }\n");

    // 1. Initial index + verify multi-hop re-export edges exist
    indexDir(incDb, root);
    expect(canonicalEdges(incDb)).toEqual(fullCanonicalEdgesFromDisk(root));
    expect(whoCalls(incDb, "leafCore", { strict: true }).map((l) => l.name)).toContain("runAll");

    // 2. 1-file edit: drop helper and add newHelper in leaf.ts (must clear stale consumer -> helper edge)
    touch("src/leaf.ts", [
      "export function leafCore() { return leafUtil(); }",
      "export function leafUtil() { return 1; }",
      "export function newHelper() { return 3; }",
    ].join("\n"));
    indexDir(incDb, root);
    expect(canonicalEdges(incDb)).toEqual(fullCanonicalEdgesFromDisk(root));
    expect(whoCalls(incDb, "helper")).toEqual([]);

    // 3. File addition: new caller through re-export chain + competing name definition
    touch("src/extra.ts", [
      'import { renamedLeaf } from "./barrel";',
      "export function extraCaller() { return renamedLeaf(); }",
    ].join("\n"));
    touch("src/shared_dup.ts", "export function sharedName() { return 2; }\n");
    indexDir(incDb, root);
    expect(canonicalEdges(incDb)).toEqual(fullCanonicalEdgesFromDisk(root));
    expect(whoCalls(incDb, "leafCore", { strict: true }).map((l) => l.name)).toContain("extraCaller");

    // 4. Re-export chain edit: retarget mid.ts alias to newHelper and drop wildcard re-export
    touch("src/mid.ts", 'export { newHelper as renamedLeaf } from "./leaf";\n');
    indexDir(incDb, root);
    expect(canonicalEdges(incDb)).toEqual(fullCanonicalEdgesFromDisk(root));
    expect(whoCalls(incDb, "leafCore", { strict: true }).map((l) => l.name)).not.toContain("extraCaller");
    expect(whoCalls(incDb, "newHelper", { strict: true }).map((l) => l.name)).toContain("extraCaller");

    // 5. File removal + subsequent addition (exercises removed state & potential SQLite rowid reuse)
    rmSync(join(root, "src/mid.ts"));
    rmSync(join(root, "src/extra.ts"));
    indexDir(incDb, root);
    expect(canonicalEdges(incDb)).toEqual(fullCanonicalEdgesFromDisk(root));
    expect(whoCalls(incDb, "newHelper", { strict: true })).toEqual([]);

    touch("src/mid.ts", 'export { leafCore as renamedLeaf } from "./leaf";\n');
    indexDir(incDb, root);
    expect(canonicalEdges(incDb)).toEqual(fullCanonicalEdgesFromDisk(root));
    expect(whoCalls(incDb, "leafCore", { strict: true }).map((l) => l.name)).toContain("runAll");

    // Check exact parity with full rebuild on the same DB before wipe
    const incBeforeFull = rawEdgeTuples(incDb);
    expect(incBeforeFull.length).toBeGreaterThan(0);

    // 6. Manual code_edges wipe while code_edge_file_state remains populated
    incDb.exec("DELETE FROM code_edges");
    expect(rawEdgeTuples(incDb)).toEqual([]);
    rebuildEdges(incDb);
    const afterWipeRecover = rawEdgeTuples(incDb);
    expect(afterWipeRecover).toEqual(incBeforeFull);

    rebuildEdges(incDb, { full: true });
    expect(rawEdgeTuples(incDb)).toEqual(afterWipeRecover);
  } finally {
    incDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});
