import { test, expect } from "bun:test";
import {
  BUILTIN_ALIASES,
  aliasesFor,
  isAlias,
  describeAlias,
  validateAliases,
  expandAlias,
} from "../src/ai/model-registry";

test("aliasesFor is the reverse of expandAlias", () => {
  expect(aliasesFor("ollama/qwen2.5:0.5b")).toEqual(["fast", "local"]);
  expect(aliasesFor("gpt-5.5")).toEqual(["gpt"]);
  expect(aliasesFor("nonexistent")).toEqual([]);
  // round-trip
  for (const alias of aliasesFor("gpt-5.5")) expect(expandAlias(alias)).toBe("gpt-5.5");
});

test("isAlias distinguishes aliases from concrete ids", () => {
  expect(isAlias("gpt")).toBe(true);
  expect(isAlias("gpt-4o")).toBe(false);
});

test("describeAlias resolves target + catalog knownness", () => {
  const d = describeAlias("sonnet");
  expect(d.isAlias).toBe(true);
  expect(d.target).toBe("claude-sonnet-4-6");
  expect(d.knownTarget).toBe(true);
  // concrete id passes through
  const c = describeAlias("gpt-4o");
  expect(c.isAlias).toBe(false);
  expect(c.target).toBe("gpt-4o");
});

test("validateAliases flags only targets missing from the catalog", () => {
  // all built-in alias targets are catalogued
  expect(validateAliases(BUILTIN_ALIASES)).toEqual([]);
  // a bogus target surfaces
  const bad = validateAliases({ ...BUILTIN_ALIASES, typo: "claude-typo-xyz" });
  expect(bad).toEqual([{ alias: "typo", target: "claude-typo-xyz" }]);
});
