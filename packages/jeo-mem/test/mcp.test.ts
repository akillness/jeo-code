import { expect, test } from "bun:test";
import { openDb } from "../src/db.ts";
import { MCP_TOOLS } from "../src/mcp.ts";

test("MCP_TOOLS definition contains required tools", () => {
  const toolNames = MCP_TOOLS.map((t) => t.name);
  expect(toolNames).toContain("jeox_where_defined");
  expect(toolNames).toContain("jeox_who_calls");
  expect(toolNames).toContain("jeox_what_calls");
  expect(toolNames).toContain("jeox_impact");
  expect(toolNames).toContain("jeox_search");
  expect(toolNames).toContain("jeox_build");
});
