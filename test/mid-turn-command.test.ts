import { test, expect } from "bun:test";
import { classifyMidTurnLine } from "../src/commands/launch/input";

// Mid-turn (while a turn is running), a typed Enter is routed by its sigil:
//  - "/…" slash commands and "$…" skills must run as COMMANDS at the turn boundary,
//    never be steered into the model as literal text;
//  - anything else is a STEER query fed to the running turn;
//  - blank/whitespace is EMPTY and ignored.

test("slash commands classify as command", () => {
  expect(classifyMidTurnLine("/model")).toBe("command");
  expect(classifyMidTurnLine("/agents executor")).toBe("command");
  expect(classifyMidTurnLine("  /help  ")).toBe("command"); // leading space tolerated
});

test("$skill invocations classify as command", () => {
  expect(classifyMidTurnLine("$team build the thing")).toBe("command");
  expect(classifyMidTurnLine("$ralplan")).toBe("command");
});

test("plain queries classify as steer", () => {
  expect(classifyMidTurnLine("also check the auth flow")).toBe("steer");
  expect(classifyMidTurnLine("use 127.0.0.1 not localhost")).toBe("steer");
  expect(classifyMidTurnLine("email me at a/b@x")).toBe("steer"); // slash not at start
});

test("blank input classifies as empty", () => {
  expect(classifyMidTurnLine("")).toBe("empty");
  expect(classifyMidTurnLine("   ")).toBe("empty");
  expect(classifyMidTurnLine("\n\t ")).toBe("empty");
});

test("a lone sigil (no command name) is empty — never aborts the turn", () => {
  expect(classifyMidTurnLine("/")).toBe("empty");
  expect(classifyMidTurnLine("$")).toBe("empty");
  expect(classifyMidTurnLine("  /  ")).toBe("empty");
});
