import { test, expect } from "bun:test";
import { RouteHistory } from "../src/agent/route-history";
import type { RouteDecision } from "../src/agent/prompt-router";

const mockDecision = (model: string, tier: string = "standard"): RouteDecision => ({
  model,
  tier: tier as any,
  confidence: 0.9,
  source: "heuristic",
  signals: ["test-signal"],
});

test("RouteHistory records decisions in FIFO order", () => {
  const history = new RouteHistory(5);
  history.add(mockDecision("claude-sonnet", "standard"));
  history.add(mockDecision("gpt-4o", "high"));
  history.add(mockDecision("claude-haiku", "trivial"));

  const all = history.getAll();
  expect(all.length).toBe(3);
  expect(all[0].model).toBe("claude-sonnet");
  expect(all[1].model).toBe("gpt-4o");
  expect(all[2].model).toBe("claude-haiku");
});

test("RouteHistory respects maxSize and drops oldest entries", () => {
  const history = new RouteHistory(3);
  history.add(mockDecision("model-1"));
  history.add(mockDecision("model-2"));
  history.add(mockDecision("model-3"));
  history.add(mockDecision("model-4")); // Should drop model-1

  const all = history.getAll();
  expect(all.length).toBe(3);
  expect(all[0].model).toBe("model-2");
  expect(all[2].model).toBe("model-4");
});

test("RouteHistory.getLast returns the most recent entry", () => {
  const history = new RouteHistory(5);
  history.add(mockDecision("model-1"));
  history.add(mockDecision("model-2"));

  const last = history.getLast();
  expect(last?.model).toBe("model-2");
});

test("RouteHistory.getLast returns undefined when empty", () => {
  const history = new RouteHistory(5);
  expect(history.getLast()).toBeUndefined();
});

test("RouteHistory.getByModel filters by model name", () => {
  const history = new RouteHistory(10);
  history.add(mockDecision("claude-sonnet"));
  history.add(mockDecision("gpt-4o"));
  history.add(mockDecision("claude-sonnet"));

  const sonnetDecisions = history.getByModel("claude-sonnet");
  expect(sonnetDecisions.length).toBe(2);
  expect(sonnetDecisions.every((d) => d.model === "claude-sonnet")).toBe(true);
});

test("RouteHistory.getByTier filters by tier", () => {
  const history = new RouteHistory(10);
  history.add(mockDecision("model-1", "trivial"));
  history.add(mockDecision("model-2", "high"));
  history.add(mockDecision("model-3", "trivial"));

  const trivialDecisions = history.getByTier("trivial");
  expect(trivialDecisions.length).toBe(2);
  expect(trivialDecisions.every((d) => d.tier === "trivial")).toBe(true);
});

test("RouteHistory.getStats computes frequency and confidence", () => {
  const history = new RouteHistory(10);
  history.add({ ...mockDecision("claude-sonnet"), confidence: 0.8 });
  history.add({ ...mockDecision("gpt-4o"), confidence: 0.9 });
  history.add({ ...mockDecision("claude-sonnet"), confidence: 1.0 });

  const stats = history.getStats();
  expect(stats.totalDecisions).toBe(3);
  expect(stats.modelFrequency["claude-sonnet"]).toBe(2);
  expect(stats.modelFrequency["gpt-4o"]).toBe(1);
  expect(stats.averageConfidence).toBeCloseTo((0.8 + 0.9 + 1.0) / 3, 2);
});

test("RouteHistory.getStats includes tier frequency", () => {
  const history = new RouteHistory(10);
  history.add(mockDecision("model-1", "trivial"));
  history.add(mockDecision("model-2", "high"));
  history.add(mockDecision("model-3", "trivial"));

  const stats = history.getStats();
  expect(stats.tierFrequency["trivial"]).toBe(2);
  expect(stats.tierFrequency["high"]).toBe(1);
});

test("RouteHistory.clear removes all entries and resets turn counter", () => {
  const history = new RouteHistory(5);
  history.add(mockDecision("model-1"));
  history.add(mockDecision("model-2"));
  expect(history.getAll().length).toBe(2);

  history.clear();
  expect(history.getAll().length).toBe(0);
  expect(history.getLast()).toBeUndefined();
});

test("RouteHistory entries include timestamp and turnNumber", () => {
  const history = new RouteHistory(5);
  const before = Date.now();
  history.add(mockDecision("model-1"));
  const after = Date.now();

  const entry = history.getLast()!;
  expect(entry.timestamp).toBeGreaterThanOrEqual(before);
  expect(entry.timestamp).toBeLessThanOrEqual(after);
  expect(entry.turnNumber).toBe(1);
});

test("RouteHistory increments turnNumber on each add", () => {
  const history = new RouteHistory(5);
  history.add(mockDecision("model-1"));
  history.add(mockDecision("model-2"));
  history.add(mockDecision("model-3"));

  const all = history.getAll();
  expect(all[0].turnNumber).toBe(1);
  expect(all[1].turnNumber).toBe(2);
  expect(all[2].turnNumber).toBe(3);
});
