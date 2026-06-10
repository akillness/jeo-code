import { test, expect } from "bun:test";
import {
  flattenModels,
  parsePickToken,
  pickByIndex,
  matchModels,
  resolveSelection,
} from "../src/ai/model-picker";
import type { ProviderModelsResult } from "../src/ai/model-discovery";

const RESULTS: ProviderModelsResult[] = [
  { provider: "openai", ok: true, source: "oauth", models: ["gpt-4o", "gpt-4o-mini", "o3"] },
  { provider: "anthropic", ok: false, source: "none", error: "not logged in", models: [] },
  { provider: "gemini", ok: true, source: "api_key", models: ["gemini-2.0-flash"] },
];

test("flattenModels yields a 1-based ordered list of ok models only", () => {
  const flat = flattenModels(RESULTS);
  expect(flat.map(e => e.model)).toEqual(["gpt-4o", "gpt-4o-mini", "o3", "gemini-2.0-flash"]);
  expect(flat[0]).toEqual({ index: 1, provider: "openai", model: "gpt-4o" });
  expect(flat[3]).toEqual({ index: 4, provider: "gemini", model: "gemini-2.0-flash" });
});

test("parsePickToken parses #N, rejects others", () => {
  expect(parsePickToken("#3")).toBe(3);
  expect(parsePickToken("  #1 ")).toBe(1);
  expect(parsePickToken("#0")).toBeNull();
  expect(parsePickToken("3")).toBeNull();
  expect(parsePickToken("gpt")).toBeNull();
});

test("pickByIndex is 1-based and bounds-checked", () => {
  const flat = flattenModels(RESULTS);
  expect(pickByIndex(flat, 1)?.model).toBe("gpt-4o");
  expect(pickByIndex(flat, 4)?.model).toBe("gemini-2.0-flash");
  expect(pickByIndex(flat, 5)).toBeUndefined();
  expect(pickByIndex(flat, 0)).toBeUndefined();
});

test("matchModels does case-insensitive substring matching", () => {
  const flat = flattenModels(RESULTS);
  expect(matchModels(flat, "GPT").map(e => e.model)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  expect(matchModels(flat, "gemini").map(e => e.model)).toEqual(["gemini-2.0-flash"]);
  expect(matchModels(flat, "zzz")).toEqual([]);
  expect(matchModels(flat, "")).toEqual([]);
});

test("resolveSelection: index", () => {
  const flat = flattenModels(RESULTS);
  const sel = resolveSelection(flat, "#3");
  expect(sel.kind).toBe("index");
  if (sel.kind === "index") expect(sel.entry.model).toBe("o3");
});

test("resolveSelection: out of range", () => {
  const flat = flattenModels(RESULTS);
  const sel = resolveSelection(flat, "#9");
  expect(sel.kind).toBe("out-of-range");
  if (sel.kind === "out-of-range") expect(sel.max).toBe(4);
});

test("resolveSelection: exact id beats substring; unique substring matches", () => {
  const flat = flattenModels(RESULTS);
  const exact = resolveSelection(flat, "gpt-4o");
  expect(exact.kind).toBe("match");
  if (exact.kind === "match") expect(exact.entry.model).toBe("gpt-4o");

  const unique = resolveSelection(flat, "gemini");
  expect(unique.kind).toBe("match");
  if (unique.kind === "match") expect(unique.entry.model).toBe("gemini-2.0-flash");
});

test("resolveSelection: ambiguous and none", () => {
  const flat = flattenModels(RESULTS);
  const amb = resolveSelection(flat, "gpt-4o-"); // matches gpt-4o-mini only → unique actually
  // 'gpt' is ambiguous (two), use that:
  const ambiguous = resolveSelection(flat, "gpt");
  expect(ambiguous.kind).toBe("ambiguous");
  if (ambiguous.kind === "ambiguous") expect(ambiguous.matches.length).toBe(2);

  expect(resolveSelection(flat, "nope").kind).toBe("none");
  // sanity: gpt-4o- is unique to the mini variant
  expect(amb.kind).toBe("match");
});
