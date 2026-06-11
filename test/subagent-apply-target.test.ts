import { test, expect } from "bun:test";
import { applyTargetChoices, SUBAGENT_ROLES } from "../src/agent/subagents";
import { renderWelcome, playWelcomeSweep } from "../src/tui/components/welcome";

test("applyTargetChoices: default first, then every role with its CURRENT model as hint", () => {
  const cfg = {
    defaultModel: "claude-sonnet-4-5",
    subagents: { planner: { model: "gemini-2.5-flash" } },
  };
  const choices = applyTargetChoices(cfg);
  expect(choices[0]).toEqual({ value: "default", label: "default — every session", hint: "claude-sonnet-4-5" });
  expect(choices.length).toBe(1 + SUBAGENT_ROLES.length);
  const planner = choices.find(c => c.value === "planner")!;
  expect(planner.hint).toBe("gemini-2.5-flash"); // explicit override → no "(default)" tag
  const executor = choices.find(c => c.value === "executor")!;
  expect(executor.hint).toBe("claude-sonnet-4-5 (default)"); // falls back + tagged
});

test("applyTargetChoices doubles as a change-existing viewer (hints reflect new config)", () => {
  const before = applyTargetChoices({ defaultModel: "m1", subagents: {} });
  const after = applyTargetChoices({ defaultModel: "m1", subagents: { critic: { model: "m2" } } });
  expect(before.find(c => c.value === "critic")!.hint).toBe("m1 (default)");
  expect(after.find(c => c.value === "critic")!.hint).toBe("m2");
});

test("playWelcomeSweep: N+1 in-place frames, cursor-up rewrites, final frame === static banner", async () => {
  const writes: string[] = [];
  const d = {
    version: "1.0.0",
    model: "m1",
    provider: "anthropic",
    cols: 80,
    unicode: true,
    color: false, // color off → frames byte-equal; the CONTRACT under test is the
    // frame/cursor mechanics + final-frame parity, not the gradient itself.
  };
  await playWelcomeSweep(d, { write: s => writes.push(s), sleep: async () => {}, frames: 4, delayMs: 0 });
  const frameWrites = writes.filter(w => !w.startsWith("\x1b["));
  expect(frameWrites.length).toBe(5); // frames + 1 (wrap back to phase 0)
  const cursorUps = writes.filter(w => /^\x1b\[\d+A$/.test(w));
  expect(cursorUps.length).toBe(4); // every redraw rewinds exactly the box height
  const boxHeight = renderWelcome(d).length;
  for (const up of cursorUps) expect(up).toBe(`\x1b[${boxHeight}A`);
  // Resting banner === static render (with per-line clear-to-EOL hygiene).
  const staticLines = renderWelcome(d).map(l => `${l}\x1b[K`).join("\n") + "\n";
  expect(frameWrites[frameWrites.length - 1]).toBe(staticLines);
});
