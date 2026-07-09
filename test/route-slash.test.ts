import { test, expect } from "bun:test";
import { runRouteSlash, type RouteSlashCtx } from "../src/commands/launch/route-slash";
import type { RouteDecision } from "../src/agent/prompt-router";
import type { RouteHistoryEntry } from "../src/agent/route-history";

const baseCtx = (overrides: Partial<RouteSlashCtx> = {}): RouteSlashCtx => ({
  sessionRouteOverride: undefined,
  routingConfigEnabled: false,
  lastRouteDecision: null,
  routeHistory: [],
  ...overrides,
});

const decision: RouteDecision = {
  model: "claude-haiku-4-5",
  tier: "trivial",
  confidence: 0.85,
  source: "heuristic",
  signals: ["short-question", "no-code-no-path"],
};

test("/route (bare) reports effective state off when nothing is configured", () => {
  const result = runRouteSlash("/route", baseCtx());
  expect(result.sessionRouteOverride).toBeUndefined();
  expect(result.lines).toEqual(["routing: off (this session)"]);
});

test("/route status reports effective state on when config.routing.enabled is true", () => {
  const result = runRouteSlash("/route status", baseCtx({ routingConfigEnabled: true }));
  expect(result.lines).toEqual(["routing: on (this session)"]);
});

test("/route status: sessionRouteOverride wins over routingConfigEnabled", () => {
  const off = runRouteSlash("/route status", baseCtx({ routingConfigEnabled: true, sessionRouteOverride: false }));
  expect(off.lines).toEqual(["routing: off (this session)"]);

  const on = runRouteSlash("/route status", baseCtx({ routingConfigEnabled: false, sessionRouteOverride: true }));
  expect(on.lines).toEqual(["routing: on (this session)"]);
});

test("/route status includes a one-line summary of the last real decision", () => {
  const result = runRouteSlash("/route status", baseCtx({ lastRouteDecision: decision }));
  expect(result.lines).toHaveLength(2);
  expect(result.lines[1]).toContain("trivial");
  expect(result.lines[1]).toContain("claude-haiku-4-5");
  expect(result.lines[1]).toContain("heuristic");
});

test("/route status omits a decision summary when only a {note} placeholder exists", () => {
  const result = runRouteSlash("/route status", baseCtx({ lastRouteDecision: { note: "routing not active this turn" } }));
  expect(result.lines).toEqual(["routing: off (this session)"]);
});

test("/route on sets sessionRouteOverride true and reports it", () => {
  const result = runRouteSlash("/route on", baseCtx());
  expect(result.sessionRouteOverride).toBe(true);
  expect(result.lines).toEqual(["routing: on (this session)"]);
});

test("/route off sets sessionRouteOverride false and reports it", () => {
  const result = runRouteSlash("/route off", baseCtx({ sessionRouteOverride: true }));
  expect(result.sessionRouteOverride).toBe(false);
  expect(result.lines).toEqual(["routing: off (this session)"]);
});

test("/route why prints full detail from a real RouteDecision", () => {
  const result = runRouteSlash("/route why", baseCtx({ lastRouteDecision: decision }));
  const joined = result.lines.join("\n");
  expect(joined).toContain("tier: trivial");
  expect(joined).toContain("model: claude-haiku-4-5");
  expect(joined).toContain("source: heuristic");
  expect(joined).toContain("confidence: 0.85");
  expect(joined).toContain("short-question, no-code-no-path");
  expect(result.sessionRouteOverride).toBeUndefined();
});

test("/route why includes thinking and warning fields when present", () => {
  const withExtras: RouteDecision = { ...decision, thinking: "low", warning: "roles.smol not configured" };
  const result = runRouteSlash("/route why", baseCtx({ lastRouteDecision: withExtras }));
  const joined = result.lines.join("\n");
  expect(joined).toContain("thinking: low");
  expect(joined).toContain("warning: roles.smol not configured");
});

test("/route why on a {note} placeholder explains plainly instead of crashing", () => {
  const result = runRouteSlash("/route why", baseCtx({ lastRouteDecision: { note: "routing has never engaged this session" } }));
  expect(result.lines).toEqual(["routing has never engaged this session"]);
});

test("/route why with no decision at all explains plainly instead of crashing", () => {
  const result = runRouteSlash("/route why", baseCtx({ lastRouteDecision: null }));
  expect(result.lines).toEqual(["No routing decision has been made yet this session."]);
});

test("unknown /route subcommand prints a usage hint, never throws", () => {
  const result = runRouteSlash("/route bogus", baseCtx());
  expect(result.sessionRouteOverride).toBeUndefined();
  expect(result.lines[0]).toContain("bogus");
  expect(result.lines[1]).toContain("/route [status|on|off|why|history [n]]");
});
test("/route status: an active model pin appends a note that routing is blocked, with the escape hatch", () => {
  const result = runRouteSlash("/route status", baseCtx({ routingConfigEnabled: true, pinnedModel: "claude-opus-4-6" }));
  expect(result.lines).toEqual([
    "routing: on (this session)",
    "note: model pinned to 'claude-opus-4-6' this session — routing will not evaluate any prompt until the pin is cleared (/model auto) or you run '/route on' to override the pin",
  ]);
});

test("/route status: an explicit /route on override notes that it overrides the pin instead of being blocked", () => {
  const result = runRouteSlash("/route status", baseCtx({ sessionRouteOverride: true, pinnedModel: "claude-opus-4-6" }));
  expect(result.lines).toEqual([
    "routing: on (this session)",
    "note: model pinned to 'claude-opus-4-6', but '/route on' overrides the pin — routing will evaluate every prompt",
  ]);
});


test("/route status: no pin note when the session has no explicit model pin", () => {
  const result = runRouteSlash("/route status", baseCtx({ routingConfigEnabled: true }));
  expect(result.lines).toEqual(["routing: on (this session)"]);
});

const mkEntry = (turnNumber: number, model: string, tier: string = "standard"): RouteHistoryEntry => ({
  model,
  tier: tier as RouteDecision["tier"],
  confidence: 0.75,
  source: "heuristic",
  signals: [],
  timestamp: Date.now(),
  turnNumber,
});

test("/route history reports a plain message when nothing has been recorded", () => {
  const result = runRouteSlash("/route history", baseCtx());
  expect(result.lines).toEqual(["No routing decisions recorded yet this session."]);
});

test("/route history lists each recorded entry as one formatted line", () => {
  const history = [
    mkEntry(1, "claude-haiku-4-5", "trivial"),
    mkEntry(2, "claude-sonnet-4-5", "standard"),
  ];
  const result = runRouteSlash("/route history", baseCtx({ routeHistory: history }));
  expect(result.lines).toEqual([
    "turn 1: trivial -> claude-haiku-4-5 (heuristic, confidence 0.75)",
    "turn 2: standard -> claude-sonnet-4-5 (heuristic, confidence 0.75)",
  ]);
});

test("/route history defaults to the last 10 entries when no n is given", () => {
  const history = Array.from({ length: 12 }, (_, i) => mkEntry(i + 1, `model-${i + 1}`));
  const result = runRouteSlash("/route history", baseCtx({ routeHistory: history }));
  expect(result.lines).toHaveLength(10);
  expect(result.lines[0]).toContain("turn 3:");
  expect(result.lines[9]).toContain("turn 12:");
});

test("/route history <n> limits output to the last n entries", () => {
  const history = [mkEntry(1, "model-1"), mkEntry(2, "model-2"), mkEntry(3, "model-3")];
  const result = runRouteSlash("/route history 2", baseCtx({ routeHistory: history }));
  expect(result.lines).toEqual([
    "turn 2: standard -> model-2 (heuristic, confidence 0.75)",
    "turn 3: standard -> model-3 (heuristic, confidence 0.75)",
  ]);
});

test("/route history with a non-numeric n falls back to the default window", () => {
  const history = [mkEntry(1, "model-1")];
  const result = runRouteSlash("/route history bogus", baseCtx({ routeHistory: history }));
  expect(result.lines).toEqual(["turn 1: standard -> model-1 (heuristic, confidence 0.75)"]);
});

test("/route history 0 falls back to the default window (not the empty message)", () => {
  const history = [mkEntry(1, "model-1"), mkEntry(2, "model-2")];
  const result = runRouteSlash("/route history 0", baseCtx({ routeHistory: history }));
  // `0` must NOT print "No routing decisions recorded yet this session." — that
  // message means the history is empty, and here it is not.
  expect(result.lines).toEqual([
    "turn 1: standard -> model-1 (heuristic, confidence 0.75)",
    "turn 2: standard -> model-2 (heuristic, confidence 0.75)",
  ]);
});

test("/route history with a negative n falls back to the default window", () => {
  const history = [mkEntry(1, "model-1"), mkEntry(2, "model-2")];
  const result = runRouteSlash("/route history -3", baseCtx({ routeHistory: history }));
  expect(result.lines).toEqual([
    "turn 1: standard -> model-1 (heuristic, confidence 0.75)",
    "turn 2: standard -> model-2 (heuristic, confidence 0.75)",
  ]);
});
