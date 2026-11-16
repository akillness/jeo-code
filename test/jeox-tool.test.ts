import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createJeoxTool } from "../src/agent/jeox-tool";

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
