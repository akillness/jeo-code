import { test, expect } from "bun:test";
import { buildLiveModelChoices, liveModelPicker, renderLiveModelPicker, buildThinkingLevelChoices, THINKING_LEVEL_ORDER } from "../src/tui/components/live-model-picker";
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
test("buildThinkingLevelChoices lists the four levels in order with the current one flagged", () => {
  const choices = buildThinkingLevelChoices("high");
  expect(choices.map(c => c.value)).toEqual([...THINKING_LEVEL_ORDER]);
  expect(choices.map(c => c.value)).toEqual(["low", "medium", "high", "xhigh"]);
  expect(choices.find(c => c.value === "high")?.hint).toBe("current");
  expect(choices.find(c => c.value === "low")?.hint).toBe("");
  // gajae-code parity: "<level> — <description>" labels.
  expect(choices.find(c => c.value === "low")?.label).toBe("low — light reasoning");
  expect(choices.find(c => c.value === "xhigh")?.label).toBe("xhigh — maximum reasoning");
});

test("buildThinkingLevelChoices embeds token hints in every level's label", () => {
  const choices = buildThinkingLevelChoices("medium", {
    tokenHint: lvl => `~${lvl}-tok`,
  });
  expect(choices.find(c => c.value === "low")?.label).toBe("low — light reasoning (~low-tok)");
  expect(choices.find(c => c.value === "high")?.label).toBe("high — deep reasoning (~high-tok)");
});

test("buildThinkingLevelChoices prepends an inherit row only when an inheritLabel is given (role targets)", () => {
  const withInherit = buildThinkingLevelChoices(undefined, { inheritLabel: "inherit (default medium)" });
  expect(withInherit[0]?.value).toBe("inherit");
  expect(withInherit[0]?.label).toBe("inherit (default medium)");
  // current === undefined → the inherit row is the active one.
  expect(withInherit[0]?.hint).toBe("current");
  expect(withInherit.map(c => c.value)).toEqual(["inherit", "low", "medium", "high", "xhigh"]);

  const noInherit = buildThinkingLevelChoices("medium");
  expect(noInherit.some(c => c.value === "inherit")).toBe(false);
});

test("buildThinkingLevelChoices: an explicit role level outranks inherit for the current flag", () => {
  const choices = buildThinkingLevelChoices("low", { inheritLabel: "inherit (default medium)" });
  expect(choices.find(c => c.value === "inherit")?.hint).toBe("");
  expect(choices.find(c => c.value === "low")?.hint).toBe("current");
});