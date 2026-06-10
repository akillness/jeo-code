import { test, expect } from "bun:test";
import {
  subagentRoleIds,
  parseMaxSteps,
  withSubagentSetting,
  clearSubagentSetting,
  resolveSubagentModel,
  resolveSubagentMaxSteps,
  getSubagentRole,
} from "../src/agent/subagents";
import type { Config } from "../src/agent/state";

const cfg = (subagents: Config["subagents"] = {}): Pick<Config, "defaultModel" | "subagents"> => ({
  defaultModel: "claude-3-5-sonnet",
  subagents,
});

test("subagentRoleIds lists the four bundled roles", () => {
  expect(subagentRoleIds()).toEqual(["executor", "planner", "architect", "critic"]);
});

test("parseMaxSteps accepts positive ints only", () => {
  expect(parseMaxSteps("12")).toBe(12);
  expect(parseMaxSteps(" 8 ")).toBe(8);
  expect(parseMaxSteps("0")).toBeUndefined();
  expect(parseMaxSteps("-3")).toBeUndefined();
  expect(parseMaxSteps("abc")).toBeUndefined();
  expect(parseMaxSteps(undefined)).toBeUndefined();
});

test("withSubagentSetting patches model/maxSteps immutably (case-insensitive role)", () => {
  const base = cfg();
  const subs = withSubagentSetting(base, "EXECUTOR", { model: "gpt-4o" });
  expect(subs.executor!.model).toBe("gpt-4o");
  expect(base.subagents).toEqual({}); // original untouched
  const subs2 = withSubagentSetting({ subagents: subs }, "executor", { maxSteps: 30 });
  expect(subs2.executor).toEqual({ model: "gpt-4o", maxSteps: 30 }); // merged, not replaced
});

test("resolve* read back the patched settings", () => {
  const subs = withSubagentSetting(cfg(), "planner", { model: "o1", maxSteps: 20 });
  const c = cfg(subs);
  expect(resolveSubagentModel("planner", c)).toBe("o1");
  expect(resolveSubagentMaxSteps("planner", c)).toBe(20);
  // unset role falls back to defaults
  expect(resolveSubagentModel("architect", c)).toBe("claude-3-5-sonnet");
  expect(resolveSubagentMaxSteps("architect", c)).toBe(getSubagentRole("architect")!.defaultMaxSteps);
});

test("clearSubagentSetting removes a role override", () => {
  const subs = withSubagentSetting(cfg(), "critic", { model: "gpt-4o" });
  const cleared = clearSubagentSetting({ subagents: subs }, "critic");
  expect(cleared.critic).toBeUndefined();
  expect(resolveSubagentModel("critic", cfg(cleared))).toBe("claude-3-5-sonnet");
});
