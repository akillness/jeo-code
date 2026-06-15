import { test, expect } from "bun:test";
import { nativeToolSchemasFor, serializeToolCalls, normalizeNativeToolName } from "../src/agent/tool-schemas";

test("nativeToolSchemasFor: always appends `done` and mirrors handler arg keys", () => {
  const schemas = nativeToolSchemasFor(["read", "bash"]);
  const names = schemas.map(s => s.name);
  expect(names).toContain("read");
  expect(names).toContain("bash");
  expect(names).toContain("done"); // always available so the model can finish natively
  const read = schemas.find(s => s.name === "read")!;
  // Arg keys MUST match the DEFAULT_TOOLS handler readers exactly (filePath, not file_path).
  expect(Object.keys(read.parameters.properties)).toContain("filePath");
  expect(read.parameters.required).toContain("filePath");
});

test("nativeToolSchemasFor: a read-only toolset exposes NO write/edit/bash natively", () => {
  // Read-only subagents (planner/architect/critic) must never get mutating tools on the
  // native channel — the schema list is built from the ACTIVE toolset, not a static mirror.
  const names = nativeToolSchemasFor(["read", "find", "search", "ls"]).map(s => s.name);
  expect(names).not.toContain("write");
  expect(names).not.toContain("edit");
  expect(names).not.toContain("bash");
  expect(names).not.toContain("delete");
  expect(names).toContain("done");
});

test("nativeToolSchemasFor: deduplicates and ignores unknown tool names", () => {
  const names = nativeToolSchemasFor(["read", "read", "bogus-tool"]).map(s => s.name);
  expect(names.filter(n => n === "read")).toHaveLength(1);
  expect(names).not.toContain("bogus-tool");
});

// Gemini (antigravity) intermittently namespaces native functions under `default_api`
// (observed live: functionCall.name = "default_api:done") → engine rejected it as an
// unknown tool. serializeToolCalls must strip the namespace back to the bare tool name.
test("normalizeNativeToolName: strips the Gemini default_api namespace (dot and colon)", () => {
  expect(normalizeNativeToolName("default_api:done")).toBe("done");
  expect(normalizeNativeToolName("default_api.read")).toBe("read");
  expect(normalizeNativeToolName("default_api: search")).toBe("search");
  expect(normalizeNativeToolName("done")).toBe("done"); // unaffected
  expect(normalizeNativeToolName("read")).toBe("read");
});

test("serializeToolCalls: a default_api-namespaced call dispatches as the bare tool", () => {
  // The exact screenshot case: model called done but the name came back namespaced.
  expect(serializeToolCalls([{ tool: "default_api:done", arguments: { reason: "안녕하세요" } }]))
    .toBe(JSON.stringify({ tool: "done", arguments: { reason: "안녕하세요" } }));
  // A namespaced read normalizes too, single-call envelope.
  expect(serializeToolCalls([{ tool: "default_api.read", arguments: { filePath: "x" } }]))
    .toBe(JSON.stringify({ tool: "read", arguments: { filePath: "x" } }));
});
