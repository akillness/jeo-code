import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createJeoxTool, markJeoxDirty, jeoxScopePromptSection } from "../src/agent/jeox-tool";

test("jeox tool: auto-builds on first call, answers who-calls, where-defined, search", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jeox-tool-test-"));
  fs.mkdirSync(path.join(tmp, "src"));
  fs.writeFileSync(
    path.join(tmp, "src", "sample.ts"),
    `export function targetFunc() { return 42; }\nexport function callerFunc() { return targetFunc(); }\n`
  );

  const tool = createJeoxTool();

  // Test status
  const stRes = await tool({ action: "status" }, tmp);
  expect(stRes.success).toBe(true);
  const st = JSON.parse(stRes.output);
  expect(st.files).toBe(1);
  expect(st.nodes).toBeGreaterThan(0);

  // Test where-defined
  const defRes = await tool({ action: "where-defined", name: "targetFunc" }, tmp);
  expect(defRes.success).toBe(true);
  expect(defRes.output).toContain("sample.ts");

  // Test who-calls
  const callRes = await tool({ action: "who-calls", name: "targetFunc" }, tmp);
  expect(callRes.success).toBe(true);
  expect(callRes.output).toContain("callerFunc");

  // Test what-calls
  const whatRes = await tool({ action: "what-calls", name: "callerFunc" }, tmp);
  expect(whatRes.success).toBe(true);
  expect(whatRes.output).toContain("targetFunc");

  // Test impact
  const impRes = await tool({ action: "impact", target: "targetFunc" }, tmp);
  expect(impRes.success).toBe(true);

  // Clean up
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("jeox tool: auto-indexes pre-existing legacy DB with empty code_files table", async () => {
  const { Database } = await import("bun:sqlite");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jeox-legacy-test-"));
  fs.mkdirSync(path.join(tmp, ".jeo", "db"), { recursive: true });
  const legacyDbPath = path.join(tmp, ".jeo", "db", "jeo.db");
  const legacyDb = new Database(legacyDbPath);
  legacyDb.exec("CREATE TABLE symbols (id INTEGER PRIMARY KEY, name TEXT);");
  legacyDb.close();
  fs.mkdirSync(path.join(tmp, "src"));
  fs.writeFileSync(path.join(tmp, "src", "legacy.ts"), `export function legacyMigrateFn() { return 7; }\n`);

  const tool = createJeoxTool();
  const res = await tool({ action: "where-defined", name: "legacyMigrateFn" }, tmp);
  expect(res.success).toBe(true);
  expect(res.output).toContain("src/legacy.ts");

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("jeox tool: auto-refreshes incrementally after edits via markJeoxDirty and TTL, and builds code_graph_scope", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jeox-refresh-test-"));
  const prevEnable = process.env.JEO_ENABLE_JEOX_SCOPE_IN_TEST;
  const prevTtl = process.env.JEO_DB_REFRESH_MS;
  try {
    fs.mkdirSync(path.join(tmp, "src"));
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "fx" }));
    fs.writeFileSync(path.join(tmp, "src", "alpha.ts"), `export function initialAlphaFn() { return 1; }\n`);

    const tool = createJeoxTool();
    const s0 = await tool({ action: "where-defined", name: "initialAlphaFn" }, tmp);
    expect(s0.success).toBe(true);
    expect(s0.output).toContain("src/alpha.ts");

    // Add a new symbol + caller after initial ingest and signal dirty via mutation hook
    const newFile = path.join(tmp, "src", "beta.ts");
    fs.writeFileSync(
      newFile,
      `import { initialAlphaFn } from "./alpha";\nexport function newlyAddedBetaFn() { return initialAlphaFn(); }\n`,
    );
    markJeoxDirty(tmp);

    const defNew = await tool({ action: "where-defined", name: "newlyAddedBetaFn" }, tmp);
    expect(defNew.success).toBe(true);
    expect(defNew.output).toContain("src/beta.ts");

    const callers = await tool({ action: "who-calls", name: "initialAlphaFn" }, tmp);
    expect(callers.success).toBe(true);
    expect(callers.output).toContain("newlyAddedBetaFn");

    // Verify TTL-triggered auto-refresh when an edit happens outside markJeoxDirty
    process.env.JEO_DB_REFRESH_MS = "0";
    const thirdFile = path.join(tmp, "src", "gamma.ts");
    fs.writeFileSync(thirdFile, `export function ttlDiscoveredGammaFn() { return 3; }\n`);
    const defTtl = await tool({ action: "where-defined", name: "ttlDiscoveredGammaFn" }, tmp);
    expect(defTtl.success).toBe(true);
    expect(defTtl.output).toContain("src/gamma.ts");

    // Verify per-turn `<code_graph_scope>` references indexed symbols
    process.env.JEO_ENABLE_JEOX_SCOPE_IN_TEST = "1";
    const scope = jeoxScopePromptSection(tmp, "inspect newlyAddedBetaFn behavior");
    expect(scope).toContain("<code_graph_scope>");
    expect(scope).toContain("src/beta.ts");
    expect(scope).toContain("newlyAddedBetaFn");
  } finally {
    if (prevEnable === undefined) delete process.env.JEO_ENABLE_JEOX_SCOPE_IN_TEST;
    else process.env.JEO_ENABLE_JEOX_SCOPE_IN_TEST = prevEnable;
    if (prevTtl === undefined) delete process.env.JEO_DB_REFRESH_MS;
    else process.env.JEO_DB_REFRESH_MS = prevTtl;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
