import { test, expect } from "bun:test";
import { parseRoleGateVerdict } from "../src/commands/team";

test("architect: plain CLEAR/APPROVE passes", () => {
  const reason = "Summary:\nFindings:\nRecommendations:\nArchitectural Status: CLEAR\nCode Review Recommendation: APPROVE";
  expect(parseRoleGateVerdict("architect", reason).ok).toBe(true);
});

test("architect: BLOCK gates execution", () => {
  const reason = "Summary:\nFindings:\nRecommendations:\nArchitectural Status: BLOCK\nCode Review Recommendation: REQUEST CHANGES";
  const v = parseRoleGateVerdict("architect", reason);
  expect(v.ok).toBe(false);
  expect(v.message).toContain("architect gated execution");
});

test("architect: WATCH/COMMENT passes (non-blocking review)", () => {
  const reason = "Summary:\nFindings:\nRecommendations:\nArchitectural Status: WATCH\nCode Review Recommendation: COMMENT";
  expect(parseRoleGateVerdict("architect", reason).ok).toBe(true);
});

test("architect: tolerates markdown emphasis around verdict labels", () => {
  const reason =
    "Summary:\nFindings:\nRecommendations:\n" +
    "**Architectural Status:** CLEAR\n" +
    "**Code Review Recommendation:** APPROVE";
  expect(parseRoleGateVerdict("architect", reason).ok).toBe(true);
});

test("architect: tolerates trailing parenthetical / em-dash caveats and matches the first token", () => {
  const reason =
    "Summary:\nFindings:\nRecommendations:\n" +
    "Architectural Status: CLEAR (with caveats)\n" +
    "Code Review Recommendation: APPROVE — minor nits only";
  expect(parseRoleGateVerdict("architect", reason).ok).toBe(true);
});

test("architect: rejects out-of-enum status values", () => {
  const reason =
    "Summary:\nFindings:\nRecommendations:\n" +
    "Architectural Status: maybe\n" +
    "Code Review Recommendation: APPROVE";
  const v = parseRoleGateVerdict("architect", reason);
  expect(v.ok).toBe(false);
  expect(v.message).toContain("Architectural Status invalid");
});

test("architect: rejects out-of-enum review recommendations", () => {
  const reason =
    "Summary:\nFindings:\nRecommendations:\n" +
    "Architectural Status: CLEAR\n" +
    "Code Review Recommendation: LGTM";
  const v = parseRoleGateVerdict("architect", reason);
  expect(v.ok).toBe(false);
  expect(v.message).toContain("Code Review Recommendation invalid");
});

test("architect: missing labels gate execution", () => {
  expect(parseRoleGateVerdict("architect", "Summary:\nFindings:\nRecommendations:").ok).toBe(false);
});

test("critic: only explicit [OKAY] first line approves", () => {
  expect(parseRoleGateVerdict("critic", "[OKAY]\nJustification: plan is actionable").ok).toBe(true);
});

test("critic: [REJECT] / [ITERATE] gate execution", () => {
  expect(parseRoleGateVerdict("critic", "[REJECT]\nJustification: missing acceptance criteria").ok).toBe(false);
  expect(parseRoleGateVerdict("critic", "[ITERATE]\nJustification: needs sequencing").ok).toBe(false);
});

test("critic: fails-closed on malformed / missing verdict (the fail-open regression)", () => {
  // Wrong case
  expect(parseRoleGateVerdict("critic", "[Okay]\nJustification: ok").ok).toBe(false);
  // Missing brackets
  expect(parseRoleGateVerdict("critic", "OKAY\nJustification: ok").ok).toBe(false);
  // Prose preamble before the verdict
  expect(parseRoleGateVerdict("critic", "Looks fine to me\n[OKAY]").ok).toBe(false);
  // Empty
  expect(parseRoleGateVerdict("critic", "").ok).toBe(false);
  // Unknown bracketed verdict
  expect(parseRoleGateVerdict("critic", "[WAT]\nJustification:").ok).toBe(false);
});

test("executor / planner / unknown roles pass through (no gate)", () => {
  expect(parseRoleGateVerdict("executor", "anything").ok).toBe(true);
  expect(parseRoleGateVerdict("planner", "anything").ok).toBe(true);
  expect(parseRoleGateVerdict("unknown-role", "anything").ok).toBe(true);
});
