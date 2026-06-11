import { test, expect } from "bun:test";
import { pushRecentModel, rememberModelPatch, recentModelsForDisplay, RECENT_MODELS_CAP } from "../src/agent/model-recency";
import type { Config } from "../src/agent/state";

const cfg = (defaultModel: string, recentModels?: string[]): Config =>
  ({ providers: {}, defaultModel, recentModels }) as Config;

test("pushRecentModel: newest first, deduped, capped", () => {
  expect(pushRecentModel(undefined, "a")).toEqual(["a"]);
  expect(pushRecentModel(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  // Re-selecting an existing model moves it to the head without duplicating.
  expect(pushRecentModel(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  // Cap: oldest entries fall off.
  const many = Array.from({ length: RECENT_MODELS_CAP }, (_, i) => `m${i}`);
  const capped = pushRecentModel(many, "new");
  expect(capped).toHaveLength(RECENT_MODELS_CAP);
  expect(capped[0]).toBe("new");
  expect(capped).not.toContain(`m${RECENT_MODELS_CAP - 1}`);
  // Blank input is a no-op.
  expect(pushRecentModel(["a"], "  ")).toEqual(["a"]);
});

test("rememberModelPatch: sets defaultModel and the recents head together", () => {
  const patch = rememberModelPatch(cfg("old", ["old", "older"]), "fresh");
  expect(patch.defaultModel).toBe("fresh");
  expect(patch.recentModels).toEqual(["fresh", "old", "older"]);
});

test("recentModelsForDisplay: default always leads, even with a stale/empty list", () => {
  expect(recentModelsForDisplay(cfg("d"))).toEqual(["d"]);
  expect(recentModelsForDisplay(cfg("d", ["x", "d", "y"]))).toEqual(["d", "x", "y"]);
});
