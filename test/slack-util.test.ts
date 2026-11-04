import { test, expect } from "bun:test";
import { isDirectRequest, isSlackDM } from "../src/util/slack";

// ── isSlackDM: command-prefix detection ─────────────────────────────

test("isSlackDM rejects slash and bang command prefixes", () => {
  expect(isSlackDM("/deploy")).toBe(false);
  expect(isSlackDM("!ops")).toBe(false);
});

test("isSlackDM accepts plain text", () => {
  expect(isSlackDM("fix the build")).toBe(true);
  expect(isSlackDM("status")).toBe(true);
});

// ── isDirectRequest: dispatcher routing heuristic ───────────────────

test("empty or flags-only argv is not a direct request", () => {
  expect(isDirectRequest([])).toBe(false);
  expect(isDirectRequest(["--tmux"])).toBe(false);
  expect(isDirectRequest(["--tmux", "--worktree", "--list"])).toBe(false);
});

test("single command-shaped tokens stay on the dispatcher (typo suggestions)", () => {
  // Real commands must never be hijacked — regression for the pre-dispatch bug.
  expect(isDirectRequest(["status"])).toBe(false);
  expect(isDirectRequest(["evolve-core"])).toBe(false);
  expect(isDirectRequest(["skills:list"])).toBe(false);
  // Typos keep the "did you mean" path.
  expect(isDirectRequest(["stauts"])).toBe(false);
});

test("slash/bang-prefixed input is command-style, not a direct request", () => {
  expect(isDirectRequest(["/deploy", "prod"])).toBe(false);
  expect(isDirectRequest(["!restart", "gateway"])).toBe(false);
});

test("multi-word natural language is a direct request", () => {
  expect(isDirectRequest(["fix", "the", "build", "error"])).toBe(true);
  expect(isDirectRequest(["summarize", "recent", "changes"])).toBe(true);
});

test("non-command-shaped single tokens are direct requests", () => {
  expect(isDirectRequest(["빌드고쳐줘"])).toBe(true);
  expect(isDirectRequest(["what?"])).toBe(true);
});

test("leading flags are ignored when classifying", () => {
  expect(isDirectRequest(["--tmux", "fix", "the", "build"])).toBe(true);
  expect(isDirectRequest(["--tmux", "status"])).toBe(false);
});
