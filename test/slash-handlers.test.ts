import { test, expect } from "bun:test";
import { handleUsage, handleTools, handleHotkeys, handleContext, type SlashContext } from "../src/commands/launch/slash-handlers";
import type { Message } from "../src/agent/loop";
import type { GlobalConfig } from "../src/agent/state";

const mockContext = (): SlashContext => ({
  history: [{ role: "system", content: "test" }],
  sessionModel: "claude-sonnet-4-5",
  sessionId: "test-session",
  cwd: "/tmp",
  config: {} as GlobalConfig,
});

test("handleUsage: formats session usage stats", () => {
  const ctx = mockContext();
  const result = handleUsage(ctx, { turns: 3, inputTokens: 100, outputTokens: 50 });
  expect(result).toBeDefined();
  expect(result && "lines" in result).toBe(true);
  if (result && "lines" in result) {
    expect(result.lines[0]).toBe("Provider token usage (this REPL):");
    expect(result.lines.some(l => l.includes("turns   3"))).toBe(true);
    expect(result.lines.some(l => l.includes("total   150"))).toBe(true);
  }
});

test("handleUsage: zero usage shows hint", () => {
  const ctx = mockContext();
  const result = handleUsage(ctx, { turns: 0, inputTokens: 0, outputTokens: 0 });
  expect(result && "lines" in result).toBe(true);
  if (result && "lines" in result) {
    const totalLine = result.lines.find(l => l.includes("total"));
    expect(totalLine).toContain("providers report usage per turn");
  }
});

test("handleTools: lists all tool protocol lines", async () => {
  const ctx = mockContext();
  const result = await handleTools(ctx);
  expect(result && "lines" in result).toBe(true);
  if (result && "lines" in result) {
    expect(result.lines[0]).toBe("Tools visible to the agent:");
    expect(result.lines.length).toBeGreaterThan(5);
    // All lines after header should be indented
    for (const line of result.lines.slice(1)) expect(line.startsWith("  ")).toBe(true);
  }
});

test("handleHotkeys: returns static reference lines", () => {
  const ctx = mockContext();
  const result = handleHotkeys(ctx);
  expect(result && "lines" in result).toBe(true);
  if (result && "lines" in result) {
    expect(result.lines[0]).toBe("Keyboard shortcuts:");
    expect(result.lines.length).toBe(16);
  }
});

test("handleContext: estimates token usage per role", async () => {
  const ctx = mockContext();
  ctx.history = [
    { role: "system", content: "x".repeat(40) },
    { role: "user", content: "y".repeat(20) },
  ];
  const result = await handleContext(ctx);
  expect(result && "lines" in result).toBe(true);
  if (result && "lines" in result) {
    expect(result.lines[0]).toBe("Context usage (estimated, ~4 chars/token):");
    expect(result.lines.some(l => l.includes("system") && l.includes("~10 tokens"))).toBe(true);
    expect(result.lines.some(l => l.includes("user") && l.includes("~5 tokens"))).toBe(true);
  }
});
