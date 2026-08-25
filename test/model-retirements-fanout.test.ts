import { test, expect, afterEach } from "bun:test";
import {
  MODEL_RETIREMENTS,
  findRetirement,
  findRetiredPins,
  isRetiredModel,
  resetRetirementAnnouncements,
  resolveRetiredModel,
  shouldAnnounceRetirement,
} from "../src/ai/model-retirements";
import { findCatalogModel } from "../src/ai/model-catalog";
import {
  MAX_FANOUT,
  MAX_FANOUT_LIMIT,
  MIN_FANOUT_LIMIT,
  resolveFanoutLimit,
} from "../src/agent/task-tool";

afterEach(() => resetRetirementAnnouncements());

// ---------------------------------------------------------------------------
// model retirements
// ---------------------------------------------------------------------------

test("every retirement points at a model that still exists on the SAME provider", () => {
  expect(MODEL_RETIREMENTS.length).toBeGreaterThan(0);
  for (const r of MODEL_RETIREMENTS) {
    expect(r.retired).not.toBe(r.replacement);
    expect(r.note.trim().length).toBeGreaterThan(10);
    // The replacement must be a real catalog id — a table pointing at a second dead id
    // would just move the 404 rather than fix it.
    expect(findCatalogModel(r.replacement)).toBeDefined();
    // Never silently move a user to a different vendor: different pricing, different
    // account, different data handling. A cross-provider swap is the user's call.
    const providerOf = (id: string) => (id.includes("/") ? id.split("/")[0] : undefined);
    const retiredProvider = providerOf(r.retired);
    if (retiredProvider) expect(providerOf(r.replacement)).toBe(retiredProvider);
  }
});

test("lookup is case- and whitespace-insensitive; current ids are untouched", () => {
  const known = MODEL_RETIREMENTS[0]!;
  expect(findRetirement(known.retired)?.replacement).toBe(known.replacement);
  expect(findRetirement(`  ${known.retired.toUpperCase()}  `)?.replacement).toBe(known.replacement);
  expect(isRetiredModel(known.retired)).toBe(true);

  expect(findRetirement("claude-sonnet-4-6")).toBeUndefined();
  expect(isRetiredModel("claude-sonnet-4-6")).toBe(false);
  expect(isRetiredModel(undefined)).toBe(false);
  expect(isRetiredModel("")).toBe(false);
});

test("resolveRetiredModel maps a sunset id forward and passes current ids through", () => {
  const known = MODEL_RETIREMENTS[0]!;
  const mapped = resolveRetiredModel(known.retired);
  expect(mapped.model).toBe(known.replacement);
  expect(mapped.retirement?.retired).toBe(known.retired);

  const untouched = resolveRetiredModel("claude-sonnet-4-6");
  expect(untouched.model).toBe("claude-sonnet-4-6");
  expect(untouched.retirement).toBeUndefined();
});

test("findRetiredPins names the exact config key holding the stale id", () => {
  const known = MODEL_RETIREMENTS[0]!;
  const pins = findRetiredPins({
    defaultModel: known.retired,
    roles: { high: known.retired, smol: "claude-sonnet-4-6" },
    subagents: { executor: { model: known.retired }, planner: { model: "gpt-5.5" } },
  });

  expect(pins.map(p => p.location).sort()).toEqual(["defaultModel", "roles.high", "subagents.executor.model"]);
  for (const pin of pins) {
    expect(pin.retired).toBe(known.retired);
    expect(pin.replacement).toBe(known.replacement);
  }
  // A clean config produces no noise.
  expect(findRetiredPins({ defaultModel: "claude-sonnet-4-6" })).toEqual([]);
  expect(findRetiredPins({})).toEqual([]);
});

test("a retirement explains itself once per session, not once per turn", () => {
  const id = MODEL_RETIREMENTS[0]!.retired;
  expect(shouldAnnounceRetirement(id)).toBe(true);
  expect(shouldAnnounceRetirement(id)).toBe(false);
  expect(shouldAnnounceRetirement(id.toUpperCase())).toBe(false);
  resetRetirementAnnouncements();
  expect(shouldAnnounceRetirement(id)).toBe(true);
});

// ---------------------------------------------------------------------------
// configurable fan-out concurrency
// ---------------------------------------------------------------------------

test("fan-out concurrency defaults to MAX_FANOUT when unset or unusable", () => {
  expect(resolveFanoutLimit()).toBe(MAX_FANOUT);
  expect(resolveFanoutLimit({})).toBe(MAX_FANOUT);
  expect(resolveFanoutLimit({ subagentConcurrency: undefined })).toBe(MAX_FANOUT);
  // NaN/Infinity must fall back rather than produce a nonsensical pool size.
  expect(resolveFanoutLimit({ subagentConcurrency: Number.NaN })).toBe(MAX_FANOUT);
  expect(resolveFanoutLimit({ subagentConcurrency: Number.POSITIVE_INFINITY })).toBe(MAX_FANOUT);
});

test("a configured concurrency is honoured and clamped to a runnable range", () => {
  expect(resolveFanoutLimit({ subagentConcurrency: 1 })).toBe(1);
  expect(resolveFanoutLimit({ subagentConcurrency: 8 })).toBe(8);
  // A typo must never yield a batch that can't start (0/-1) or never yields (500).
  expect(resolveFanoutLimit({ subagentConcurrency: 0 })).toBe(MIN_FANOUT_LIMIT);
  expect(resolveFanoutLimit({ subagentConcurrency: -3 })).toBe(MIN_FANOUT_LIMIT);
  expect(resolveFanoutLimit({ subagentConcurrency: 500 })).toBe(MAX_FANOUT_LIMIT);
  // Fractions truncate toward a whole worker count.
  expect(resolveFanoutLimit({ subagentConcurrency: 3.9 })).toBe(3);
});

test("the clamp range is sane and contains the default", () => {
  expect(MIN_FANOUT_LIMIT).toBeLessThan(MAX_FANOUT_LIMIT);
  expect(MAX_FANOUT).toBeGreaterThanOrEqual(MIN_FANOUT_LIMIT);
  expect(MAX_FANOUT).toBeLessThanOrEqual(MAX_FANOUT_LIMIT);
});
