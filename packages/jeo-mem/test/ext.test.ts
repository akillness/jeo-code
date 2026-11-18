import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractExtScript,
  indexDir,
  indexExtDir,
  isExtScript,
  multiImpact,
  multiSearch,
  multiStats,
  multiWhatCalls,
  multiWhereDefined,
  multiWhoCalls,
  openDb,
  resolveExtDbPath,
  runCli,
  search,
  whatCalls,
  whereDefined,
  whoCalls,
} from "../src/index.ts";
import { createJeoxTool } from "../../../src/agent/jeox-tool.ts";

interface CountRow {
  c: number;
}

interface NameRow {
  name: string;
}

interface PragmaFkRow {
  foreign_keys: number;
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

test("isExtScript classifies supported native/JVM/scripting extensions and rejects non-ext paths", () => {
  const cases: { path: string; expected: boolean }[] = [
    { path: "src/main.c", expected: true },
    { path: "include/vec.h", expected: true },
    { path: "src/engine.cpp", expected: true },
    { path: "include/engine.hpp", expected: true },
    { path: "src/impl.cc", expected: true },
    { path: "src/impl.hh", expected: true },
    { path: "src/alt.cxx", expected: true },
    { path: "src/alt.hxx", expected: true },
    { path: "Services/Order.cs", expected: true },
    { path: "cmd/server.go", expected: true },
    { path: "src/App.java", expected: true },
    { path: "src/Main.kt", expected: true },
    { path: "build.gradle.kts", expected: true },
    { path: "Sources/App.swift", expected: true },
    { path: "lib/worker.rb", expected: true },
    { path: "app/Router.php", expected: true },
    { path: "scripts/deploy.sh", expected: true },
    { path: "scripts/init.bash", expected: true },
    { path: "scripts/env.zsh", expected: true },
    { path: "UPPER/CASE.CPP", expected: true },
    { path: "UPPER/CASE.GO", expected: true },
    { path: "src/index.ts", expected: false },
    { path: "src/view.tsx", expected: false },
    { path: "worker.py", expected: false },
    { path: "lib.rs", expected: false },
    { path: "README.md", expected: false },
    { path: "package.json", expected: false },
    { path: "main.cpp.bak", expected: false },
    { path: "Makefile", expected: false },
  ];
  for (const row of cases) {
    expect(isExtScript(row.path)).toBe(row.expected);
  }
});

test("resolveExtDbPath maps jeo.db, :memory:, and custom paths deterministically", () => {
  expect(resolveExtDbPath(":memory:")).toBe(":memory:");
  expect(resolveExtDbPath("/tmp/proj/.jeo/db/jeo.db")).toBe("/tmp/proj/.jeo/db/jeo-ext.db");
  expect(resolveExtDbPath("jeo.db")).toBe("jeo-ext.db");
  expect(resolveExtDbPath("./jeo.db")).toBe("jeo-ext.db");
  expect(resolveExtDbPath("/tmp/custom/store.sqlite")).toBe("/tmp/custom/store-ext.sqlite");
  expect(resolveExtDbPath("/tmp/custom/store")).toBe("/tmp/custom/store-ext.db");
});

test("extractExtScript extracts C++ (.cpp/.hpp) includes, types, methods, calls, extends, and strips comments/strings", () => {
  const hpp = `
#pragma once
#include <vector>
#include "engine/base.hpp"

namespace render {
struct Vec3 {
  float x;
  float y;
  float z;
};

class MeshRenderer : public BaseRenderer, private IRenderable {
public:
  void draw() {
    prepareBuffer();
  }
};
}
`;
  const hppEx = extractExtScript("include/mesh.hpp", hpp);
  expect(hppEx.imports).toEqual([
    { spec: "vector", imported: "*", local: "vector", reexport: false },
    { spec: "./engine/base.hpp", imported: "*", local: "base", reexport: false },
  ]);
  const meshCls = hppEx.nodes.find((n) => n.name === "MeshRenderer");
  expect(meshCls?.kind).toBe("class");
  expect(meshCls?.refs).toEqual([
    { name: "BaseRenderer", kind: "extends", recv: "" },
    { name: "IRenderable", kind: "extends", recv: "" },
  ]);
  expect(hppEx.nodes.find((n) => n.name === "Vec3")?.kind).toBe("struct");
  expect(hppEx.nodes.find((n) => n.name === "render")?.kind).toBe("namespace");
  const drawFn = hppEx.nodes.find((n) => n.name === "draw");
  expect(drawFn?.kind).toBe("method");
  expect(drawFn?.refs).toEqual([{ name: "prepareBuffer", kind: "calls", recv: "" }]);

  const cpp = `
#include "mesh.hpp"
using namespace render::math;

static int internalHelper(int v) {
  return clampValue(v);
}

void MeshRenderer::upload() {
  // fakeCommentCall()
  const char* msg = "fakeStringCall()";
  if (ready()) {
    submitBatch();
  }
  int x = static_cast<int>(1'000);
}

int buildScene() {
  return internalHelper(1);
}
`;
  const cppEx = extractExtScript("src/mesh.cpp", cpp);
  expect(cppEx.imports).toEqual([
    { spec: "./mesh.hpp", imported: "*", local: "mesh", reexport: false },
    { spec: "render::math", imported: "*", local: "math", reexport: false },
  ]);
  const internalNode = cppEx.nodes.find((n) => n.name === "internalHelper");
  expect(internalNode?.kind).toBe("function");
  expect(internalNode?.exported).toBe(false);
  expect(internalNode?.refs).toEqual([{ name: "clampValue", kind: "calls", recv: "" }]);

  const uploadNode = cppEx.nodes.find((n) => n.name === "upload");
  expect(uploadNode?.kind).toBe("method");
  expect(uploadNode?.refs.map((r) => r.name).sort()).toEqual(["ready", "submitBatch"]);
  expect(uploadNode?.refs.some((r) => r.name === "fakeCommentCall" || r.name === "fakeStringCall")).toBe(false);
  expect(uploadNode?.refs.some((r) => r.name === "if" || r.name === "static_cast")).toBe(false);

  const buildNode = cppEx.nodes.find((n) => n.name === "buildScene");
  expect(buildNode?.kind).toBe("function");
  expect(buildNode?.exported).toBe(true);
  expect(buildNode?.refs).toEqual([{ name: "internalHelper", kind: "calls", recv: "" }]);
});

test("extractExtScript extracts C# (.cs) usings, namespaces, types, extends, block & expression-bodied methods", () => {
  const cs = `
using System.Collections.Generic;
using CoreAlias = MyApp.Core.Engine;

namespace App.Orders {
  internal struct OrderLine {
    public int Qty;
  }

  public class OrderService : BaseService, IOrderService {
    public async Task ProcessOrderAsync() {
      ValidateOrder();
      repo.SaveChanges();
    }

    private int GetCount() => ComputeTotal();
  }
}
`;
  const ex = extractExtScript("src/OrderService.cs", cs);
  expect(ex.imports).toEqual([
    { spec: "System.Collections.Generic", imported: "*", local: "Generic", reexport: false },
    { spec: "MyApp.Core.Engine", imported: "*", local: "CoreAlias", reexport: false },
  ]);
  expect(ex.nodes.find((n) => n.name === "Orders")?.kind).toBe("namespace");
  expect(ex.nodes.find((n) => n.name === "OrderLine")).toMatchObject({ kind: "struct", exported: true });

  const svc = ex.nodes.find((n) => n.name === "OrderService");
  expect(svc).toMatchObject({ kind: "class", exported: true });
  expect(svc?.refs).toEqual([
    { name: "BaseService", kind: "extends", recv: "" },
    { name: "IOrderService", kind: "extends", recv: "" },
  ]);

  const proc = ex.nodes.find((n) => n.name === "ProcessOrderAsync");
  expect(proc).toMatchObject({ kind: "method", exported: true });
  expect(proc?.refs).toEqual([
    { name: "ValidateOrder", kind: "calls", recv: "" },
    { name: "SaveChanges", kind: "calls", recv: "repo" },
  ]);

  const count = ex.nodes.find((n) => n.name === "GetCount");
  expect(count).toMatchObject({ kind: "method", exported: false });
  expect(count?.refs).toEqual([{ name: "ComputeTotal", kind: "calls", recv: "" }]);
});

test("extractExtScript extracts Go (.go) single/block imports, types, functions, receiver methods, and calls", () => {
  const go = `
package server

import "fmt"
import (
  "context"
  str "strings"
)

type Server struct {
  Port int
}

type runner interface {
  Run()
}

type UserID string

func HandleRequest(ctx context.Context) {
  n := len("abc")
  _ = n
  validateInput()
  helper.RunTask(ctx)
}

func helperLoop() {
  fmt.Println("ok")
}

func (s *Server) Start() {
  s.listenPort()
}
`;
  const ex = extractExtScript("cmd/server.go", go);
  expect(ex.imports).toEqual([
    { spec: "fmt", imported: "*", local: "fmt", reexport: false },
    { spec: "context", imported: "*", local: "context", reexport: false },
    { spec: "strings", imported: "*", local: "str", reexport: false },
  ]);
  expect(ex.nodes.find((n) => n.name === "Server")).toMatchObject({ kind: "struct", exported: true });
  expect(ex.nodes.find((n) => n.name === "runner")).toMatchObject({ kind: "interface", exported: false });
  expect(ex.nodes.find((n) => n.name === "UserID")).toMatchObject({ kind: "type", exported: true });

  const handle = ex.nodes.find((n) => n.name === "HandleRequest");
  expect(handle).toMatchObject({ kind: "function", exported: true });
  expect(handle?.refs).toEqual([
    { name: "validateInput", kind: "calls", recv: "" },
    { name: "RunTask", kind: "calls", recv: "helper" },
  ]);
  expect(handle?.refs.some((r) => r.name === "len")).toBe(false);

  const helper = ex.nodes.find((n) => n.name === "helperLoop");
  expect(helper).toMatchObject({ kind: "function", exported: false });

  const start = ex.nodes.find((n) => n.name === "Start");
  expect(start).toMatchObject({ kind: "method", exported: true });
  expect(start?.refs).toContainEqual({ name: "listenPort", kind: "calls", recv: "s" });
});

test("extractExtScript extracts Java (.java) imports, extends/implements, annotated methods, and calls", () => {
  const java = `
import java.util.List;
import com.acme.core.*;

public class AccountController extends BaseController implements Serializable, Runnable {
  @Override
  public void run() {
    service.executeTask();
    auditEvent();
  }

  private void helperOnly() {
    normalize();
  }
}
`;
  const ex = extractExtScript("src/AccountController.java", java);
  expect(ex.imports).toEqual([
    { spec: "java.util.List", imported: "List", local: "List", reexport: false },
    { spec: "com.acme.core.*", imported: "*", local: "core", reexport: false },
  ]);
  const cls = ex.nodes.find((n) => n.name === "AccountController");
  expect(cls).toMatchObject({ kind: "class", exported: true });
  expect(cls?.refs).toEqual([
    { name: "BaseController", kind: "extends", recv: "" },
    { name: "Serializable", kind: "extends", recv: "" },
    { name: "Runnable", kind: "extends", recv: "" },
  ]);
  const runMethod = ex.nodes.find((n) => n.name === "run");
  expect(runMethod).toMatchObject({ kind: "method", exported: true });
  expect(runMethod?.refs).toEqual([
    { name: "executeTask", kind: "calls", recv: "service" },
    { name: "auditEvent", kind: "calls", recv: "" },
  ]);
  const privMethod = ex.nodes.find((n) => n.name === "helperOnly");
  expect(privMethod).toMatchObject({ kind: "method", exported: false });
});

test("extractExtScript extracts Shell (.sh) sources, keyword/POSIX functions, and custom calls while skipping shell builtins", () => {
  const sh = `
#!/usr/bin/env bash
source ./scripts/common.sh
. /etc/profile

# comment_only_fn() {
#   ghost_call
# }
function deploy_service() {
local tag="v1"
echo "deploying"
mkdir -p /tmp/out
build_artifact && push_image
}

verify_health() {
curl -s http://localhost/health; status=$(poll_endpoint)
}

deploy_service
`;
  const ex = extractExtScript("scripts/deploy.sh", sh);
  expect(ex.imports).toEqual([
    { spec: "./scripts/common.sh", imported: "*", local: "common", reexport: false },
    { spec: "/etc/profile", imported: "*", local: "profile", reexport: false },
  ]);
  expect(ex.nodes.some((n) => n.name === "comment_only_fn")).toBe(false);

  const deployFn = ex.nodes.find((n) => n.name === "deploy_service");
  expect(deployFn).toMatchObject({ kind: "function", exported: true });
  expect(deployFn?.refs.map((r) => r.name)).toEqual(["build_artifact", "push_image"]);

  const verifyFn = ex.nodes.find((n) => n.name === "verify_health");
  expect(verifyFn).toMatchObject({ kind: "function", exported: true });
  expect(verifyFn?.refs.map((r) => r.name)).toEqual(["poll_endpoint"]);

  const mod = ex.nodes.find((n) => n.kind === "module");
  expect(mod?.refs.map((r) => r.name)).toContain("deploy_service");
});

test("indexExtDir populates jeo-ext.db schema/FTS5, handles incremental .cpp edits, and ON DELETE CASCADE cleans deleted .go files", () => {
  const root = makeTempDir("jm-ext-idx-");
  try {
    mkdirSync(join(root, "cpp"), { recursive: true });
    mkdirSync(join(root, "go"), { recursive: true });
    mkdirSync(join(root, "ts"), { recursive: true });
    mkdirSync(join(root, "build"), { recursive: true });
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });

    writeFileSync(
      join(root, "cpp", "math.hpp"),
      `#pragma once\nclass KernelMath {\npublic:\n  int computeLeaf() { return 7; }\n};\n`,
    );
    writeFileSync(
      join(root, "cpp", "engine.cpp"),
      `#include "math.hpp"\nint stepEngine() { return computeLeaf(); }\nint runFrame() { return stepEngine(); }\n`,
    );
    writeFileSync(
      join(root, "go", "worker.go"),
      `package worker\nfunc GoPacketLeaf() int { return 1 }\nfunc DispatchGoPacket() int { return GoPacketLeaf() }\n`,
    );
    writeFileSync(join(root, "ts", "ignored.ts"), `export function tsOnlySymbol() { return 1; }\n`);
    writeFileSync(join(root, "README.md"), `# Docs\nignored markdown\n`);
    writeFileSync(join(root, "build", "gen.cpp"), `void generatedIgnored() {}\n`);
    writeFileSync(join(root, "node_modules", "dep", "vendor.go"), `package dep\nfunc VendorIgnored() {}\n`);
    writeFileSync(join(root, "cpp", "binary.cpp"), `void bin()\u0000{}\n`);

    const extDbPath = resolveExtDbPath(join(root, ".jeo", "db", "jeo.db"));
    const db = openDb(extDbPath);
    try {
      const fk = db.query<PragmaFkRow, []>("PRAGMA foreign_keys").get();
      expect(fk?.foreign_keys).toBe(1);

      const s1 = indexExtDir(db, root);
      expect(existsSync(extDbPath)).toBe(true);
      expect(s1.added).toBe(3);
      expect(s1.changed).toBe(0);
      expect(s1.removed).toBe(0);

      const tables = db
        .query<NameRow, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name);
      for (const tbl of ["code_files", "code_nodes", "code_edges", "code_chunks", "code_nodes_fts", "code_chunks_fts"]) {
        expect(tables).toContain(tbl);
      }

      const files = db.query<{ path: string }, []>("SELECT path FROM code_files ORDER BY path").all().map((r) => r.path);
      expect(files).toEqual(["cpp/engine.cpp", "cpp/math.hpp", "go/worker.go"]);

      expect(whereDefined(db, "tsOnlySymbol")).toEqual([]);
      expect(whereDefined(db, "stepEngine")[0]?.path).toBe("cpp/engine.cpp");
      expect(whoCalls(db, "stepEngine").map((l) => l.name)).toEqual(["runFrame"]);
      expect(whatCalls(db, "stepEngine").map((l) => l.name)).toEqual(["computeLeaf"]);
      expect(search(db, "DispatchGoPacket").some((h) => h.type === "symbol" && h.path === "go/worker.go")).toBe(true);

      // Re-run with no changes -> all unchanged
      const s2 = indexExtDir(db, root);
      expect(s2.unchanged).toBe(3);
      expect(s2.added).toBe(0);
      expect(s2.changed).toBe(0);
      expect(s2.removed).toBe(0);
      // Modify cpp/engine.cpp -> incremental update replaces nodes, edges, and FTS5 rows without dropping go/worker.go edges
      writeFileSync(
        join(root, "cpp", "engine.cpp"),
        `#include "math.hpp"\nint computeMatrix() { return alternateLeaf(); }\nint alternateLeaf() { return 2; }\nint runFrame() { return computeMatrix(); }\n`,
      );
      utimesSync(join(root, "cpp", "engine.cpp"), new Date(), new Date(Date.now() + 5000));
      const s3 = indexExtDir(db, root);
      expect(s3.changed).toBe(1);
      expect(s3.unchanged).toBe(2);
      expect(whereDefined(db, "stepEngine")).toEqual([]);
      expect(search(db, "stepEngine")).toEqual([]);
      expect(whereDefined(db, "computeMatrix")[0]?.path).toBe("cpp/engine.cpp");
      expect(search(db, "computeMatrix").some((h) => h.type === "symbol" && h.path === "cpp/engine.cpp")).toBe(true);
      expect(whoCalls(db, "computeMatrix").map((l) => l.name)).toEqual(["runFrame"]);
      expect(whatCalls(db, "computeMatrix").map((l) => l.name)).toEqual(["alternateLeaf"]);
      // Unrelated Go edges survive C++ incremental re-index
      expect(whoCalls(db, "GoPacketLeaf").map((l) => l.name)).toEqual(["DispatchGoPacket"]);
      const goFileRow = db.query<{ id: number }, [string]>("SELECT id FROM code_files WHERE path=?").get("go/worker.go");
      expect(goFileRow).not.toBeNull();
      const goFileId = goFileRow!.id;
      const goNodeIds = db
        .query<{ id: number }, [number]>("SELECT id FROM code_nodes WHERE file_id=?")
        .all(goFileId)
        .map((r) => r.id);
      expect(goNodeIds.length).toBeGreaterThan(0);

      rmSync(join(root, "go", "worker.go"));
      const s4 = indexExtDir(db, root);
      expect(s4.removed).toBe(1);
      expect(whereDefined(db, "DispatchGoPacket")).toEqual([]);
      expect(search(db, "DispatchGoPacket")).toEqual([]);
      expect(whoCalls(db, "GoPacketLeaf")).toEqual([]);
      expect(db.query<CountRow, [number]>("SELECT COUNT(*) c FROM code_files WHERE id=?").get(goFileId)?.c).toBe(0);
      expect(db.query<CountRow, [number]>("SELECT COUNT(*) c FROM code_nodes WHERE file_id=?").get(goFileId)?.c).toBe(0);
      expect(db.query<CountRow, [number]>("SELECT COUNT(*) c FROM code_imports WHERE file_id=?").get(goFileId)?.c).toBe(0);
      for (const nid of goNodeIds) {
        expect(db.query<CountRow, [number]>("SELECT COUNT(*) c FROM code_refs WHERE src_id=?").get(nid)?.c).toBe(0);
        expect(
          db.query<CountRow, [number, number]>("SELECT COUNT(*) c FROM code_edges WHERE src_id=? OR dst_id=?").get(nid, nid)?.c,
        ).toBe(0);
      }

      // Direct SQLite DELETE FROM code_files also triggers ON DELETE CASCADE on code_nodes/code_refs/code_edges
      const engineFileRow = db.query<{ id: number }, [string]>("SELECT id FROM code_files WHERE path=?").get("cpp/engine.cpp");
      expect(engineFileRow).not.toBeNull();
      const engineId = engineFileRow!.id;
      const engineNodeIds = db
        .query<{ id: number }, [number]>("SELECT id FROM code_nodes WHERE file_id=?")
        .all(engineId)
        .map((r) => r.id);
      expect(engineNodeIds.length).toBeGreaterThan(0);
      db.query("DELETE FROM code_files WHERE id=?").run(engineId);
      expect(db.query<CountRow, [number]>("SELECT COUNT(*) c FROM code_nodes WHERE file_id=?").get(engineId)?.c).toBe(0);
      for (const nid of engineNodeIds) {
        expect(db.query<CountRow, [number]>("SELECT COUNT(*) c FROM code_refs WHERE src_id=?").get(nid)?.c).toBe(0);
        expect(
          db.query<CountRow, [number, number]>("SELECT COUNT(*) c FROM code_edges WHERE src_id=? OR dst_id=?").get(nid, nid)?.c,
        ).toBe(0);
      }

      // rebuild: true wipes and cleanly re-indexes remaining files on disk (math.hpp + engine.cpp)
      const s5 = indexExtDir(db, root, { rebuild: true });
      expect(s5.added).toBe(2);
      expect(whereDefined(db, "KernelMath")[0]?.path).toBe("cpp/math.hpp");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multiWhereDefined, multiWhoCalls, multiWhatCalls, multiImpact, multiSearch, and multiStats aggregate across jeo.db + jeo-ext.db", () => {
  const root = makeTempDir("jm-multi-");
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "native"), { recursive: true });
    mkdirSync(join(root, "dotnet"), { recursive: true });
    mkdirSync(join(root, "cmd"), { recursive: true });

    // TS + Markdown (jeo.db)
    writeFileSync(
      join(root, "src", "core.ts"),
      `export function sharedDispatch(id: string) { return formatAudit(id); }\nexport function formatAudit(id: string) { return id; }\n`,
    );
    writeFileSync(
      join(root, "src", "api.ts"),
      `import { sharedDispatch } from "./core";\nexport function handleHttp() { return sharedDispatch("req"); }\n`,
    );
    writeFileSync(
      join(root, "src", "api.test.ts"),
      `import { sharedDispatch } from "./core";\nexport function testApi() { return sharedDispatch("t"); }\n`,
    );
    writeFileSync(
      join(root, "docs", "arch.md"),
      `# Polyglot Pipeline\nsharedDispatch routes telemetry across TypeScript and native workers.\n`,
    );

    // C++ / C# / Go (jeo-ext.db)
    writeFileSync(
      join(root, "native", "engine.cpp"),
      `void sharedDispatch() { flushGpu(); }\nvoid flushGpu() {}\nvoid renderLoop() { sharedDispatch(); }\n`,
    );
    writeFileSync(
      join(root, "native", "engine_test.cpp"),
      `void testNativeLoop() { sharedDispatch(); }\n`,
    );
    writeFileSync(
      join(root, "dotnet", "BillingService.cs"),
      `namespace App.Billing {\n  public class BillingService {\n    public void Charge() { sharedDispatch(); }\n  }\n}\n`,
    );
    writeFileSync(
      join(root, "dotnet", "BillingServiceTests.cs"),
      `namespace App.Billing {\n  public class BillingServiceTests {\n    public void VerifyCharge() { sharedDispatch(); }\n  }\n}\n`,
    );
    writeFileSync(
      join(root, "cmd", "server.go"),
      `package main\nfunc StartGateway() { sharedDispatch() }\n`,
    );
    writeFileSync(
      join(root, "cmd", "server_test.go"),
      `package main\nfunc TestGateway() { sharedDispatch() }\n`,
    );

    const db = openDb(join(root, ".jeo", "db", "jeo.db"));
    const extDb = openDb(resolveExtDbPath(join(root, ".jeo", "db", "jeo.db")));
    try {
      indexDir(db, root);
      indexExtDir(extDb, root);
      const dbs = [db, extDb];

      // multiWhereDefined finds symbols from both DBs, deduplicates, and honors limit
      const defs = multiWhereDefined(dbs, "sharedDispatch", 10);
      expect(defs.map((d) => d.path).sort()).toEqual(["native/engine.cpp", "src/core.ts"]);
      expect(multiWhereDefined([db, db, extDb], "sharedDispatch", 10).length).toBe(2);
      expect(multiWhereDefined(dbs, "sharedDispatch", 1).length).toBe(1);
      expect(multiWhereDefined(dbs, "sharedDispatch", 0)).toEqual([]);
      expect(multiWhereDefined(dbs, "BillingService")[0]?.path).toBe("dotnet/BillingService.cs");
      expect(multiWhereDefined(dbs, "StartGateway")[0]?.path).toBe("cmd/server.go");

      // multiWhoCalls merges callers from jeo.db and jeo-ext.db, ranking import/local before name
      const callers = multiWhoCalls(dbs, "sharedDispatch", { limit: 20 });
      expect(callers.map((c) => c.name)).toContain("handleHttp");
      expect(callers.map((c) => c.name)).toContain("renderLoop");
      expect(callers.map((c) => c.name)).toContain("Charge");
      expect(callers.map((c) => c.name)).toContain("StartGateway");
      const strictCallers = multiWhoCalls(dbs, "sharedDispatch", { limit: 20, strict: true });
      expect(strictCallers.some((c) => c.path === "src/api.ts")).toBe(true);
      expect(strictCallers.some((c) => c.path === "native/engine.cpp")).toBe(true); // local edge in engine.cpp
      expect(strictCallers.some((c) => c.path === "cmd/server.go")).toBe(false); // name-only guess across files

      // multiWhatCalls queries callees across both DBs
      expect(multiWhatCalls(dbs, "handleHttp").map((c) => c.name)).toEqual(["sharedDispatch"]);
      expect(multiWhatCalls(dbs, "renderLoop").map((c) => c.name)).toEqual(["sharedDispatch"]);
      expect(multiWhatCalls(dbs, "Charge").map((c) => c.name)).toEqual(["sharedDispatch"]);

      // multiImpact separates production files from extended test paths (.test.ts, _test.cpp, Tests.cs, _test.go)
      const imp = multiImpact(dbs, "sharedDispatch", 3, 50, false);
      expect(imp.files).toContain("src/api.ts");
      expect(imp.files).toContain("dotnet/BillingService.cs");
      expect(imp.files).toContain("cmd/server.go");
      expect(imp.tests).toContain("src/api.test.ts");
      expect(imp.tests).toContain("native/engine_test.cpp");
      expect(imp.tests).toContain("dotnet/BillingServiceTests.cs");
      expect(imp.tests).toContain("cmd/server_test.go");
      expect(imp.files).not.toContain("native/engine_test.cpp");
      expect(imp.files).not.toContain("dotnet/BillingServiceTests.cs");
      expect(imp.files).not.toContain("cmd/server_test.go");
      expect(imp.symbols.some((s) => s.path.endsWith("_test.go") || s.path.endsWith("Tests.cs"))).toBe(false);

      // multiSearch interleaves symbol + markdown doc hits across both DBs and respects globs
      const hits = multiSearch(dbs, "sharedDispatch", 10);
      expect(hits.some((h) => h.type === "symbol" && h.path === "src/core.ts")).toBe(true);
      expect(hits.some((h) => h.type === "doc" && h.path === "docs/arch.md")).toBe(true);
      expect(hits.some((h) => h.type === "symbol" && h.path === "native/engine.cpp")).toBe(true);
      const nativeOnly = multiSearch(dbs, "sharedDispatch", 10, ["native/**"]);
      expect(nativeOnly.length).toBeGreaterThan(0);
      expect(nativeOnly.every((h) => h.path.startsWith("native/"))).toBe(true);

      // multiStats returns base stats alone when extDb is omitted, and nests ext stats when provided
      const baseOnly = multiStats(db);
      expect(baseOnly.ext).toBeUndefined();
      expect(baseOnly.files).toBe(4); // 3 ts + 1 md
      const combined = multiStats(db, extDb);
      expect(combined.files).toBe(4);
      expect(combined.ext).toBeDefined();
      expect(combined.ext!.files).toBe(6); // 2 cpp + 2 cs + 2 go
      expect(combined.ext!.nodes).toBeGreaterThan(6);
      expect(combined.ext!.edges).toBeGreaterThan(0);
    } finally {
      db.close();
      extDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli.ts and jeox-tool.ts build and query both jeo.db and jeo-ext.db end-to-end", async () => {
  const repo = makeTempDir("jm-ext-integ-");
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "native"), { recursive: true });
    mkdirSync(join(repo, "go"), { recursive: true });

    writeFileSync(join(repo, "src", "entry.ts"), `export function tsBridge() { return tsLeaf(); }\nfunction tsLeaf() { return 1; }\n`);
    writeFileSync(join(repo, "native", "kernel.cpp"), `int nativeLeaf() { return 42; }\nint nativeKernel() { return nativeLeaf(); }\n`);
    writeFileSync(join(repo, "go", "agent.go"), `package agent\nfunc RunAgent() int { return nativeLeaf() }\n`);

    // 1. cli.ts build / stats / where-defined / who-calls / search
    const buildOut: string[] = [];
    expect(await runCli(["build", "--repo", repo], (s) => buildOut.push(s))).toBe(0);
    const dbFile = join(repo, ".jeo", "db", "jeo.db");
    const extDbFile = join(repo, ".jeo", "db", "jeo-ext.db");
    expect(existsSync(dbFile)).toBe(true);
    expect(existsSync(extDbFile)).toBe(true);

    const buildJson = JSON.parse(buildOut[0] ?? "{}") as unknown;
    expect(isRecord(buildJson)).toBe(true);
    if (isRecord(buildJson)) {
      expect(buildJson.extDb).toBe(extDbFile);
      expect(isRecord(buildJson.ext)).toBe(true);
      expect(isRecord(buildJson.extIndexed)).toBe(true);
    }

    const whereOut: string[] = [];
    expect(await runCli(["where-defined", "nativeKernel", "--repo", repo, "--json"], (s) => whereOut.push(s))).toBe(0);
    const whereParsed = JSON.parse(whereOut[0] ?? "[]") as { name: string; path: string }[];
    expect(whereParsed[0]).toMatchObject({ name: "nativeKernel", path: "native/kernel.cpp" });

    const whoOut: string[] = [];
    expect(await runCli(["who-calls", "nativeLeaf", "--repo", repo, "--json"], (s) => whoOut.push(s))).toBe(0);
    const whoParsed = JSON.parse(whoOut[0] ?? "[]") as { name: string; path: string }[];
    expect(whoParsed.map((r) => r.name).sort()).toEqual(["RunAgent", "nativeKernel"]);

    const statsOut: string[] = [];
    expect(await runCli(["stats", "--repo", repo], (s) => statsOut.push(s))).toBe(0);
    const statsParsed = JSON.parse(statsOut[0] ?? "{}") as { files: number; ext?: { files: number } };
    expect(statsParsed.files).toBe(1);
    expect(statsParsed.ext?.files).toBe(2);

    // 2. jeox-tool.ts against a separate temp repo (clean cache entry)
    const toolRepo = makeTempDir("jm-ext-tool-");
    try {
      mkdirSync(join(toolRepo, "src"), { recursive: true });
      mkdirSync(join(toolRepo, "native"), { recursive: true });
      writeFileSync(join(toolRepo, "src", "app.ts"), `export function appEntry() { return 1; }\n`);
      writeFileSync(join(toolRepo, "native", "solver.cpp"), `int solveStep() { return 9; }\nint solveMain() { return solveStep(); }\n`);

      const jeoxTool = createJeoxTool();

      const buildRes = await jeoxTool({ action: "build" }, toolRepo);
      expect(buildRes.success).toBe(true);
      expect(existsSync(join(toolRepo, ".jeo", "db", "jeo-ext.db"))).toBe(true);
      expect(buildRes.output).toContain('"ext"');

      const defRes = await jeoxTool({ action: "where-defined", name: "solveMain" }, toolRepo);
      expect(defRes.success).toBe(true);
      const defRows = JSON.parse(defRes.output) as { name: string; path: string }[];
      expect(defRows[0]).toMatchObject({ name: "solveMain", path: "native/solver.cpp" });

      const whoRes = await jeoxTool({ action: "who-calls", name: "solveStep" }, toolRepo);
      expect(whoRes.success).toBe(true);
      const whoRows = JSON.parse(whoRes.output) as { name: string }[];
      expect(whoRows.map((r) => r.name)).toEqual(["solveMain"]);

      const whatRes = await jeoxTool({ action: "what-calls", name: "solveMain" }, toolRepo);
      expect(whatRes.success).toBe(true);
      const whatRows = JSON.parse(whatRes.output) as { name: string }[];
      expect(whatRows.map((r) => r.name)).toEqual(["solveStep"]);

      const impRes = await jeoxTool({ action: "impact", name: "solveStep" }, toolRepo);
      expect(impRes.success).toBe(true);
      const impObj = JSON.parse(impRes.output) as { symbols: { name: string }[] };
      expect(impObj.symbols.map((s) => s.name)).toContain("solveMain");

      const searchRes = await jeoxTool({ action: "search", query: "solveMain" }, toolRepo);
      expect(searchRes.success).toBe(true);
      const searchRows = JSON.parse(searchRes.output) as { path: string; label: string }[];
      expect(searchRows.some((h) => h.path === "native/solver.cpp" && h.label.includes("solveMain"))).toBe(true);

      const statusRes = await jeoxTool({ action: "status" }, toolRepo);
      expect(statusRes.success).toBe(true);
      const statusObj = JSON.parse(statusRes.output) as { files: number; ext?: { files: number } };
      expect(statusObj.files).toBe(1);
      expect(statusObj.ext?.files).toBe(1);
    } finally {
      rmSync(toolRepo, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
