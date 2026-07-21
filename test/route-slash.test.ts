import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runRouteSlash, type RouteSlashCtx } from "../src/commands/launch/route-slash";
import { readGlobalConfig, saveConfigPatch } from "../src/agent/state";
import type { RouteDecision } from "../src/agent/prompt-router";
import type { RouteHistoryEntry } from "../src/agent/route-history";

let dir: string;
const savedCfgDir = process.env.JEO_CONFIG_DIR;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jeo-route-slash-"));
  process.env.JEO_CONFIG_DIR = dir;
});

afterEach(async () => {
  if (savedCfgDir === undefined) delete process.env.JEO_CONFIG_DIR;
  else process.env.JEO_CONFIG_DIR = savedCfgDir;
  await fs.rm(dir, { recursive: true, force: true });
});

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

test("/route (bare) reports effective state off when nothing is configured", async () => {
  const result = await runRouteSlash("/route", baseCtx());
  expect(result.sessionRouteOverride).toBeUndefined();
  expect(result.lines).toEqual(["routing: off (this session)"]);
});

test("/route status reports effective state on when config.routing.enabled is true", async () => {
  const result = await runRouteSlash("/route status", baseCtx({ routingConfigEnabled: true }));
  expect(result.lines).toEqual(["routing: on (this session)"]);
});

test("/route status: sessionRouteOverride wins over routingConfigEnabled", async () => {
  const off = await runRouteSlash("/route status", baseCtx({ routingConfigEnabled: true, sessionRouteOverride: false }));
  expect(off.lines).toEqual(["routing: off (this session)"]);

  const on = await runRouteSlash("/route status", baseCtx({ routingConfigEnabled: false, sessionRouteOverride: true }));
  expect(on.lines).toEqual(["routing: on (this session)"]);
});

test("/route status includes a one-line summary of the last real decision", async () => {
  const result = await runRouteSlash("/route status", baseCtx({ lastRouteDecision: decision }));
  expect(result.lines).toHaveLength(2);
  expect(result.lines[1]).toContain("trivial");
  expect(result.lines[1]).toContain("claude-haiku-4-5");
  expect(result.lines[1]).toContain("heuristic");
});

test("/route status omits a decision summary when only a {note} placeholder exists", async () => {
  const result = await runRouteSlash("/route status", baseCtx({ lastRouteDecision: { note: "routing not active this turn" } }));
  expect(result.lines).toEqual(["routing: off (this session)"]);
});

test("/route on sets sessionRouteOverride true and reports it", async () => {
  const result = await runRouteSlash("/route on", baseCtx());
  expect(result.sessionRouteOverride).toBe(true);
  expect(result.lines).toEqual(["routing: on (this session)"]);
});

test("/route off sets sessionRouteOverride false and reports it", async () => {
  const result = await runRouteSlash("/route off", baseCtx({ sessionRouteOverride: true }));
  expect(result.sessionRouteOverride).toBe(false);
  expect(result.lines).toEqual(["routing: off (this session)"]);
});

test("/route why prints full detail from a real RouteDecision", async () => {
  const result = await runRouteSlash("/route why", baseCtx({ lastRouteDecision: decision }));
  const joined = result.lines.join("\n");
  expect(joined).toContain("tier: trivial");
  expect(joined).toContain("model: claude-haiku-4-5");
  expect(joined).toContain("source: heuristic");
  expect(joined).toContain("confidence: 0.85");
  expect(joined).toContain("short-question, no-code-no-path");
  expect(result.sessionRouteOverride).toBeUndefined();
});

test("/route why includes thinking and warning fields when present", async () => {
  const withExtras: RouteDecision = { ...decision, thinking: "low", warning: "roles.smol not configured" };
  const result = await runRouteSlash("/route why", baseCtx({ lastRouteDecision: withExtras }));
  const joined = result.lines.join("\n");
  expect(joined).toContain("thinking: low");
  expect(joined).toContain("warning: roles.smol not configured");
});

test("/route why on a {note} placeholder explains plainly instead of crashing", async () => {
  const result = await runRouteSlash("/route why", baseCtx({ lastRouteDecision: { note: "routing has never engaged this session" } }));
  expect(result.lines).toEqual(["routing has never engaged this session"]);
});

test("/route why with no decision at all explains plainly instead of crashing", async () => {
  const result = await runRouteSlash("/route why", baseCtx({ lastRouteDecision: null }));
  expect(result.lines).toEqual(["No routing decision has been made yet this session."]);
});

test("unknown /route subcommand prints a usage hint, never throws", async () => {
  const result = await runRouteSlash("/route bogus", baseCtx());
  expect(result.sessionRouteOverride).toBeUndefined();
  expect(result.lines[0]).toContain("bogus");
  expect(result.lines[1]).toContain("Usage: /route [status|on|off|why|history [n]|save|on save|off save]");
});
test("/route status: an active model pin appends a note that routing is blocked, with the escape hatch", async () => {
  const result = await runRouteSlash("/route status", baseCtx({ routingConfigEnabled: true, pinnedModel: "claude-opus-4-6" }));
  expect(result.lines).toEqual([
    "routing: on (this session)",
    "note: model pinned to 'claude-opus-4-6' this session — routing will not evaluate any prompt until the pin is cleared (/model auto) or you run '/route on' to override the pin",
  ]);
});

test("/route status: an explicit /route on override notes that it overrides the pin instead of being blocked", async () => {
  const result = await runRouteSlash("/route status", baseCtx({ sessionRouteOverride: true, pinnedModel: "claude-opus-4-6" }));
  expect(result.lines).toEqual([
    "routing: on (this session)",
    "note: model pinned to 'claude-opus-4-6', but '/route on' overrides the pin — routing will evaluate every prompt",
  ]);
});


test("/route status: no pin note when the session has no explicit model pin", async () => {
  const result = await runRouteSlash("/route status", baseCtx({ routingConfigEnabled: true }));
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

test("/route history reports a plain message when nothing has been recorded", async () => {
  const result = await runRouteSlash("/route history", baseCtx());
  expect(result.lines).toEqual(["No routing decisions recorded yet this session."]);
});

test("/route history lists each recorded entry as one formatted line", async () => {
  const history = [
    mkEntry(1, "claude-haiku-4-5", "trivial"),
    mkEntry(2, "claude-sonnet-4-5", "standard"),
  ];
  const result = await runRouteSlash("/route history", baseCtx({ routeHistory: history }));
  expect(result.lines).toEqual([
    "turn 1: trivial -> claude-haiku-4-5 (heuristic, confidence 0.75)",
    "turn 2: standard -> claude-sonnet-4-5 (heuristic, confidence 0.75)",
  ]);
});

test("/route history defaults to the last 10 entries when no n is given", async () => {
  const history = Array.from({ length: 12 }, (_, i) => mkEntry(i + 1, `model-${i + 1}`));
  const result = await runRouteSlash("/route history", baseCtx({ routeHistory: history }));
  expect(result.lines).toHaveLength(10);
  expect(result.lines[0]).toContain("turn 3:");
  expect(result.lines[9]).toContain("turn 12:");
});

test("/route history <n> limits output to the last n entries", async () => {
  const history = [mkEntry(1, "model-1"), mkEntry(2, "model-2"), mkEntry(3, "model-3")];
  const result = await runRouteSlash("/route history 2", baseCtx({ routeHistory: history }));
  expect(result.lines).toEqual([
    "turn 2: standard -> model-2 (heuristic, confidence 0.75)",
    "turn 3: standard -> model-3 (heuristic, confidence 0.75)",
  ]);
});

test("/route history with a non-numeric n falls back to the default window", async () => {
  const history = [mkEntry(1, "model-1")];
  const result = await runRouteSlash("/route history bogus", baseCtx({ routeHistory: history }));
  expect(result.lines).toEqual(["turn 1: standard -> model-1 (heuristic, confidence 0.75)"]);
});

test("/route history 0 falls back to the default window (not the empty message)", async () => {
  const history = [mkEntry(1, "model-1"), mkEntry(2, "model-2")];
  const result = await runRouteSlash("/route history 0", baseCtx({ routeHistory: history }));
  // `0` must NOT print "No routing decisions recorded yet this session." — that
  // message means the history is empty, and here it is not.
  expect(result.lines).toEqual([
    "turn 1: standard -> model-1 (heuristic, confidence 0.75)",
    "turn 2: standard -> model-2 (heuristic, confidence 0.75)",
  ]);
});

test("/route history with a negative n falls back to the default window", async () => {
  const history = [mkEntry(1, "model-1"), mkEntry(2, "model-2")];
  const result = await runRouteSlash("/route history -3", baseCtx({ routeHistory: history }));
  expect(result.lines).toEqual([
    "turn 1: standard -> model-1 (heuristic, confidence 0.75)",
    "turn 2: standard -> model-2 (heuristic, confidence 0.75)",
  ]);
});
test("/route on save persists routing.enabled=true to config and keeps it session-local too", async () => {
  const result = await runRouteSlash("/route on save", baseCtx());
  expect(result.sessionRouteOverride).toBe(true);
  expect(result.lines).toEqual(["routing: on (this session) — saved to ~/.jeo/config.json"]);
  const saved = await readGlobalConfig();
  expect(saved.routing?.enabled).toBe(true);
});

test("/route off save persists routing.enabled=false to config", async () => {
  await saveConfigPatch(() => ({ routing: { enabled: true } }));
  const result = await runRouteSlash("/route off save", baseCtx({ sessionRouteOverride: true }));
  expect(result.sessionRouteOverride).toBe(false);
  expect(result.lines).toEqual(["routing: off (this session) — saved to ~/.jeo/config.json"]);
  const saved = await readGlobalConfig();
  expect(saved.routing?.enabled).toBe(false);
});

test("/route on save preserves other routing config fields (tiers, confidenceThreshold) instead of clobbering them", async () => {
  await saveConfigPatch(() => ({ routing: { enabled: false, confidenceThreshold: 0.42, tiers: { trivial: { model: "custom-model" } } } }));
  await runRouteSlash("/route on save", baseCtx());
  const saved = await readGlobalConfig();
  expect(saved.routing?.enabled).toBe(true);
  expect(saved.routing?.confidenceThreshold).toBe(0.42);
  expect(saved.routing?.tiers?.trivial?.model).toBe("custom-model");
});

test("bare /route save persists whatever is currently effective (session override wins over config)", async () => {
  await saveConfigPatch(() => ({ routing: { enabled: false } }));
  const result = await runRouteSlash("/route save", baseCtx({ routingConfigEnabled: false, sessionRouteOverride: true }));
  expect(result.lines).toEqual(["routing: on — saved to ~/.jeo/config.json"]);
  const saved = await readGlobalConfig();
  expect(saved.routing?.enabled).toBe(true);
});

test("bare /route save with no session override persists the existing config value unchanged", async () => {
  await saveConfigPatch(() => ({ routing: { enabled: true } }));
  const result = await runRouteSlash("/route save", baseCtx({ routingConfigEnabled: true }));
  expect(result.lines).toEqual(["routing: on — saved to ~/.jeo/config.json"]);
});

test("/route on (no save) never touches ~/.jeo/config.json", async () => {
  await runRouteSlash("/route on", baseCtx());
  const saved = await readGlobalConfig();
  expect(saved.routing?.enabled).toBeUndefined();
});
