import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../packages/jeo-mem/src/db.ts";
import { indexDir } from "../packages/jeo-mem/src/indexer.ts";
import { search, whoCalls } from "../packages/jeo-mem/src/query.ts";

describe("jeo-mem llm-wiki project bridge", () => {
  it("indexes @wiki/ markdown chunks and links backticked symbols into whoCalls", () => {
    const base = mkdtempSync(join(tmpdir(), "jeo-mem-wiki-"));
    const repo = join(base, "jeo-sample-repo");
    const wikiRoot = join(base, "vault");
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      mkdirSync(join(wikiRoot, "wiki", "projects", "jeo-sample-repo"), { recursive: true });
      writeFileSync(
        join(repo, "src", "engine.ts"),
        "export function dispatchTurn(): string { return 'ok'; }\n",
      );
      writeFileSync(
        join(wikiRoot, "wiki", "projects", "jeo-sample-repo", "design.md"),
        "# Design\n\nEvery prompt invokes `dispatchTurn` after routing.\n",
      );

      const db = openDb(":memory:");
      indexDir(db, repo, { wikiRoot });

      const found = search(db, "routing");
      expect(found.some((c) => c.path === "@wiki/projects/jeo-sample-repo/design.md")).toBe(true);

      const callers = whoCalls(db, "dispatchTurn");
      expect(callers.some((c) => c.path === "@wiki/projects/jeo-sample-repo/design.md" && c.kind === "wiki")).toBe(true);
      db.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
