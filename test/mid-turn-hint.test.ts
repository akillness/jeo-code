import { test, expect } from "bun:test";
import { formatMidTurnHint, staticCompletionContext, type CompletionContext } from "../src/tui/components/autocomplete";

// Mid-turn command preview: while a turn runs, typing a /command or $skill should
// surface matching commands/skills/arguments above the input box (idle-prompt parity).
const ctx: CompletionContext = {
  ...staticCompletionContext(),
  liveModels: [],
  aliases: [],
  modelsForProvider: () => [],
  skillNames: ["team", "ralplan", "ultragoal"],
};

test("partial slash command surfaces command matches", () => {
  const hint = formatMidTurnHint("/mod", ctx);
  expect(hint[0]).toBe("Commands:");
  expect(hint.some(l => l.trim() === "/model")).toBe(true);
});

test("partial $skill surfaces skill matches", () => {
  const hint = formatMidTurnHint("$te", ctx);
  expect(hint[0]).toBe("Skills:");
  expect(hint.some(l => l.trim() === "$team")).toBe(true);
});

test("command argument surfaces argument matches", () => {
  const hint = formatMidTurnHint("/thinking ", ctx);
  expect(hint[0]).toBe("Thinking levels:");
  expect(hint.some(l => l.trim() === "high")).toBe(true);
});

test("non-command input yields no hint", () => {
  expect(formatMidTurnHint("just a normal query", ctx)).toEqual([]);
  expect(formatMidTurnHint("", ctx)).toEqual([]);
});

test("max caps the shown matches and notes the remainder", () => {
  const hint = formatMidTurnHint("/", ctx, 3); // many slash commands
  // label + at most `max` rows; a remainder note appears when capped
  expect(hint[0]).toBe("Commands:");
  expect(hint.length).toBeLessThanOrEqual(5);
  expect(hint.some(l => l.includes("more)"))).toBe(true);
});
