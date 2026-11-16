import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
