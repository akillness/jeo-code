import { test, expect } from "bun:test";
import { buildLiveModelChoices, liveModelPicker, renderLiveModelPicker } from "../src/tui/components/live-model-picker";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("buildLiveModelChoices annotates known capabilities and current model", () => {
  const choices = buildLiveModelChoices([
    { index: 1, provider: "openai", model: "gpt-4o" },
    { index: 2, provider: "openai", model: "custom-live" },
  ], { current: "gpt-4o" });
  expect(choices[0]?.label).toBe("#1 openai/gpt-4o");
  expect(choices[0]?.group).toBe("openai");
  expect(choices[0]?.hint).toContain("128K ctx");
  expect(choices[0]?.hint).toContain("current");
  expect(choices[1]?.hint).toContain("unknown caps");
});

test("buildLiveModelChoices disables models whose provider is not ready", () => {
  const choices = buildLiveModelChoices([
    { index: 1, provider: "openai", model: "gpt-4o" },
    { index: 2, provider: "gemini", model: "gemini-2.5-flash" },
  ], { disabledProviders: ["openai"], disabledHint: "needs API key" });
  expect(choices[0]?.disabled).toBe(true);
  expect(choices[0]?.group).toBe("openai (not ready)");
  expect(choices[0]?.hint).toContain("needs API key");
  expect(choices[1]?.disabled).toBe(false);
});
test("buildLiveModelChoices adds role and thinking badges for matching model assignments", () => {
  const choices = buildLiveModelChoices([
    { index: 1, provider: "openai", model: "gpt-5.5" },
    { index: 2, provider: "anthropic", model: "claude-opus-4-8" },
  ], {
    color: false,
    assignments: [
      { role: "default", label: "DEFAULT", model: "openai/gpt-5.5", thinking: "xhigh", color: "default" },
      { role: "planner", label: "PLANNER", model: "gpt-5.5", thinking: "inherit", color: "planner" },
      { role: "architect", label: "ARCHITECT", model: "anthropic/claude-opus-4-8", thinking: "high", color: "architect" },
    ],
  });
  expect(choices[0]?.hint).toContain("DEFAULT (xhigh)");
  expect(choices[0]?.hint).toContain("PLANNER (inherit)");
  expect(choices[0]?.hint).toContain("ctx");
  expect(choices[1]?.hint).toContain("ARCHITECT (high)");
  expect(choices[0]?.hintRaw).toBe(false);
});

test("renderLiveModelPicker uses the generic select-list renderer with width fitting", () => {
  const list = liveModelPicker([
    { index: 1, provider: "gemini", model: "gemini-2.5-flash" },
    { index: 2, provider: "gemini", model: "a-very-very-long-model-id-that-needs-fitting" },
  ]);
  const out = renderLiveModelPicker(list, { cols: 40, rows: 4, color: false, unicode: false }).map(strip);
  const joined = out.join("\n");
  expect(joined).toContain("Select a live model");
  expect(joined).toContain("gemini");
  expect(joined).toContain("#1 gemini/gemini-2.5-flash");
});
