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

test("playWelcomeSweep: synchronized in-place frames, seamless cycle loop, final frame === static banner", async () => {
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
  await playWelcomeSweep(d, { write: s => writes.push(s), sleep: async () => {}, frames: 4, cycles: 1, delayMs: 0 });
  // One write per frame: frames + 1 (the last wraps back to phase 0).
  expect(writes.length).toBe(5);
  const boxHeight = renderWelcome(d).length;
  for (const [i, w] of writes.entries()) {
    // Every repaint is atomic: BSU opens, ESU closes (no tearing mid-frame).
    expect(w.startsWith("\x1b[?2026h")).toBe(true);
    expect(w.endsWith("\x1b[?2026l")).toBe(true);
    // Every redraw after the first rewinds exactly the box height.
    if (i > 0) expect(w).toContain(`\x1b[${boxHeight}A`);
  }
  // Resting banner === static render (with per-line clear-to-EOL hygiene).
  const staticBody = renderWelcome(d).map(l => `${l}\x1b[K`).join("\n") + "\n";
  expect(writes[writes.length - 1]).toBe(`\x1b[?2026h\x1b[${boxHeight}A${staticBody.slice(0, -1)}\n\x1b[?2026l`);
});

test("playWelcomeSweep: cycles loop seamlessly — frames*cycles+1 repaints, phase wraps each cycle", async () => {
  const writes: string[] = [];
  const phases: number[] = [];
  const d = { version: "1.0.0", model: "m1", cols: 80, unicode: true, color: false };
  // Observe the phase sequence via a render spy: color:false output is byte-stable
  // across phases, so we assert the LOOP SHAPE through call counts instead.
  await playWelcomeSweep(d, { write: s => writes.push(s), sleep: async () => phases.push(1), frames: 3, cycles: 2, delayMs: 1 });
  expect(writes.length).toBe(7); // 3*2 + 1 (final wrap to phase 0)
  // Constant cadence: exactly one sleep between consecutive frames — no pause
  // at the cycle boundary (the "seamless" contract).
  expect(phases.length).toBe(6);
});
