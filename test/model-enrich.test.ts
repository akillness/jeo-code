import { test, expect } from "bun:test";
import {
  enrichResult,
  enrichAll,
  knownCount,
  sortByCapability,
  filterCapable,
} from "../src/ai/model-enrich";
import { formatEnrichedModels } from "../src/tui/components/config-panel";
import type { ProviderModelsResult } from "../src/ai/model-discovery";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const RESULTS: ProviderModelsResult[] = [
  { provider: "openai", ok: true, source: "oauth", models: ["gpt-4o", "some-unknown-model"] },
  { provider: "anthropic", ok: false, source: "none", error: "not logged in", models: [] },
  { provider: "gemini", ok: true, source: "api_key", models: ["gemini-2.5-pro"] },
];

test("enrichResult attaches catalog metadata to known ids only; failed → []", () => {
  const openai = enrichResult(RESULTS[0]);
  expect(openai.length).toBe(2);
  expect(openai.find(m => m.id === "gpt-4o")!.meta?.canonical).toBe("gpt-4o");
  expect(openai.find(m => m.id === "some-unknown-model")!.meta).toBeUndefined();
  expect(enrichResult(RESULTS[1])).toEqual([]);
});

test("enrichAll flattens across ok providers", () => {
  const all = enrichAll(RESULTS);
  expect(all.map(m => m.id)).toEqual(["gpt-4o", "some-unknown-model", "gemini-2.5-pro"]);
});

test("knownCount splits known vs unknown", () => {
  expect(knownCount(enrichAll(RESULTS))).toEqual({ known: 2, unknown: 1 });
});

test("sortByCapability: known (largest context) first, unknown last", () => {
  const sorted = sortByCapability(enrichAll(RESULTS));
  // gemini-2.5-pro (1M) and gpt-4o (128K) are known; unknown goes last.
  expect(sorted[0].id).toBe("gemini-2.5-pro");
  expect(sorted[1].id).toBe("gpt-4o");
  expect(sorted[2].id).toBe("some-unknown-model");
});

test("filterCapable: thinking filter excludes unknown + non-thinking models", () => {
  const all = enrichAll(RESULTS);
  const thinkers = filterCapable(all, { thinking: "high" });
  // gemini-2.5-pro supports high; gpt-4o has no thinking; unknown excluded.
  expect(thinkers.map(m => m.id)).toEqual(["gemini-2.5-pro"]);
});

test("filterCapable: images filter", () => {
  const imgs = filterCapable(enrichAll(RESULTS), { images: true });
  expect(imgs.map(m => m.id).sort()).toEqual(["gemini-2.5-pro", "gpt-4o"]);
});

test("filterCapable: minContext filter (long context)", () => {
  const long = filterCapable(enrichAll(RESULTS), { minContext: 200_000 });
  expect(long.map(m => m.id)).toEqual(["gemini-2.5-pro"]); // 1M ≥ 200K; gpt-4o 128K excluded
});

test("filterCapable: no filter returns all (including unknown)", () => {
  expect(filterCapable(enrichAll(RESULTS), {}).length).toBe(3);
});

test("formatEnrichedModels renders caps with - / ? for unknown ids", () => {
  const out = formatEnrichedModels(sortByCapability(enrichAll(RESULTS)), { current: "gpt-4o" }).map(strip);
  expect(out[0]).toContain("provider");
  expect(out[0]).toContain("thinking");
  const joined = out.join("\n");
  expect(joined).toContain("gpt-4o");
  expect(joined).toContain("some-unknown-model");
  // unknown row shows ? for thinking/img
  const unknownRow = out.find(l => l.includes("some-unknown-model"))!;
  expect(unknownRow).toContain("?");
});

test("formatEnrichedModels empty → login hint", () => {
  expect(formatEnrichedModels([]).join("\n")).toContain("no live models");
});
