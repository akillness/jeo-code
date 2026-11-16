import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, openDb, readEvents, SCHEMA_VERSION } from "../src/index.ts";

test("schema opens in memory and records version", () => {
  const db = openDb(":memory:");
  const r = db.query("SELECT MAX(version) v FROM schema_versions").get() as { v: number };
  expect(r.v).toBe(SCHEMA_VERSION);
  db.query("INSERT INTO code_nodes_fts(rowid,name) VALUES (1,'hello')").run();
  const hit = db.query("SELECT rowid FROM code_nodes_fts WHERE code_nodes_fts MATCH 'hello'").all();
  expect(hit.length).toBe(1);
});

test("events: v1 append + legacy ledger lines are both readable", () => {
  const f = join(mkdtempSync(join(tmpdir(), "jm-")), "ledger.jsonl");
  writeFileSync(f, `${JSON.stringify({ ts: "t", type: "plan_registered", planId: "p1", x: 1 })}\n`);
  appendEvent(f, "index_done", "src", { files: 3 });
  const ev = readEvents(f);
  expect(ev.map((e) => e.kind)).toEqual(["plan_registered", "index_done"]);
  expect(ev[0]!.ref).toBe("p1");
  expect(ev[0]!.payload).toEqual({ x: 1 });
});
