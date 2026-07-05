import { test, expect } from "bun:test";

// Source-text-level check (mirrors test/engine-computer-wiring.test.ts's pattern):
// launch.ts's KNOWN_TOOLS/fullTools are module-local closures, not exported, so the
// wiring contract is asserted at the source-text level instead of re-implementing
// CLI arg parsing / a live turn here.
test("launch's KNOWN_TOOLS advertises 'approve' so --tools approve is accepted", async () => {
  const src = await Bun.file("src/commands/launch.ts").text();
  const m = /const KNOWN_TOOLS = new Set\(\[([^\]]+)\]\);/.exec(src);
  expect(m).toBeTruthy();
  expect(m![1]).toContain('"approve"');
});

test("launch wires 'approve' into the per-turn tool map via createApproveTool()", async () => {
  const src = await Bun.file("src/commands/launch.ts").text();
  expect(src).toContain("approve: createApproveTool()");
  expect(src).toContain('import { createApproveTool, APPROVE_TOOL_PROTOCOL_LINE } from "../agent/approve-tool"');
  expect(src).toContain('allowedTools.has("approve")');
});
