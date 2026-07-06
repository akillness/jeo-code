import { test, expect } from "bun:test";
import { runRouteSlash, type RouteSlashCtx } from "../src/commands/launch/route-slash";
import type { RouteDecision } from "../src/agent/prompt-router";

const baseCtx = (overrides: Partial<RouteSlashCtx> = {}): RouteSlashCtx => ({
  sessionRouteOverride: undefined,
  routingConfigEnabled: false,
  lastRouteDecision: null,
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
  expect(result.lines[1]).toContain("/route [status|on|off|why]");
});
