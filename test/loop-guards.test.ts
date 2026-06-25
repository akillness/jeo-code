import { test, expect } from "bun:test";
import {
  GUARD_LIMITS,
  VERIFY_SIGNAL_RE,
  isVerificationSignal,
  repeatHint,
  classifyDoneGate,
} from "../src/agent/loop-guards";

test("GUARD_LIMITS exposes the named thresholds and is frozen", () => {
  expect(GUARD_LIMITS.MAX_REPEAT).toBe(4);
  expect(GUARD_LIMITS.MAX_FAILURES).toBe(5);
  expect(GUARD_LIMITS.MAX_REFUSAL_RETRIES).toBe(3);
  expect(GUARD_LIMITS.MAX_INVALID_CALLS).toBe(3);
  expect(GUARD_LIMITS.MAX_PARSE_BOUNCES).toBe(2);
  expect(GUARD_LIMITS.CYCLE_WINDOW).toBe(6);
  expect(Object.isFrozen(GUARD_LIMITS)).toBe(true);
});

test("isVerificationSignal matches test/build/typecheck commands and output banners", () => {
  expect(isVerificationSignal("bun test")).toBe(true);
  expect(isVerificationSignal("bun run typecheck")).toBe(true);
  expect(isVerificationSignal("npm run build")).toBe(true);
  expect(isVerificationSignal("eslint .")).toBe(false); // no word boundary inside "eslint" → "lint" does not match
  expect(isVerificationSignal("eslint .")).toBe(false); // "eslint" has no standalone "lint" word boundary? -> ensure regex semantics
  // A bare command with a verification signal only in its OUTPUT still counts.
  expect(isVerificationSignal("./run.sh", "Running vitest suite...")).toBe(true);
  expect(isVerificationSignal("ls -la", "drwxr-xr-x")).toBe(false);
});

test("isVerificationSignal only scans the first 2000 chars of output", () => {
  const farSignal = "x".repeat(2100) + " typecheck";
  expect(isVerificationSignal("echo hi", farSignal)).toBe(false);
  const nearSignal = "x".repeat(1900) + " typecheck " + "y".repeat(500);
  expect(isVerificationSignal("echo hi", nearSignal)).toBe(true);
});

test("VERIFY_SIGNAL_RE is the regex backing isVerificationSignal", () => {
  expect(VERIFY_SIGNAL_RE.test("run the spec")).toBe(true);
  expect(VERIFY_SIGNAL_RE.test("hello world")).toBe(false);
});

test("repeatHint tailors guidance to the repeated tool", () => {
  expect(repeatHint("search", { success: true, output: "no match" })).toContain("BROADEN");
  expect(repeatHint("search", { success: true, output: "src/a.ts:1: hit" })).toContain("already returned results");
  expect(repeatHint("read")).toContain("read a DIFFERENT file");
  expect(repeatHint("bash")).toContain("change the command");
  expect(repeatHint("edit")).toContain("take a different action");
});

test("repeatHint prepends a reflection directive when the previous attempt FAILED", () => {
  // A failed bash retry: keep the per-tool base, but lead with the reflect-and-change directive.
  const failed = repeatHint("bash", { success: false, output: "error: command not found" });
  expect(failed).toContain("The previous attempt FAILED");
  expect(failed).toContain("change the tool or its arguments");
  expect(failed).toContain("change the command"); // base hint still present
  // A successful repeat (results unchanged, not a failure) gets NO reflection prefix.
  const ok = repeatHint("bash", { success: true, output: "done" });
  expect(ok).not.toContain("The previous attempt FAILED");
  // Missing prev (no recorded result) is not treated as a failure.
  expect(repeatHint("edit")).not.toContain("The previous attempt FAILED");
});

test("classifyDoneGate: no mutation → accept", () => {
  const v = classifyDoneGate({ sawMutation: false, sawVerification: false, pendingHookFailure: null });
  expect(v.state).toBe("done_ok");
  expect(v.block).toBe(false);
  expect(v.message).toBe("");
});

test("classifyDoneGate: mutation + verification + clean hook → accept", () => {
  const v = classifyDoneGate({ sawMutation: true, sawVerification: true, pendingHookFailure: null });
  expect(v.state).toBe("done_ok");
  expect(v.block).toBe(false);
});

test("classifyDoneGate: mutation without verification → block (unverified)", () => {
  const v = classifyDoneGate({ sawMutation: true, sawVerification: false, pendingHookFailure: null });
  expect(v.state).toBe("done_unverified");
  expect(v.block).toBe(true);
  expect(v.message).toContain("ran NO verification");
});

test("classifyDoneGate: failing post-turn hook outranks verification → block (hook)", () => {
  const v = classifyDoneGate({ sawMutation: true, sawVerification: true, pendingHookFailure: "bun test" });
  expect(v.state).toBe("done_hook_failing");
  expect(v.block).toBe(true);
  expect(v.message).toContain('post-turn hook "bun test" FAILING');
});

test("classifyDoneGate: verified then mutated again → block (stale verification)", () => {
  const v = classifyDoneGate({
    sawMutation: true,
    sawVerification: true,
    verificationStale: true,
    pendingHookFailure: null,
  });
  expect(v.state).toBe("done_stale_verification");
  expect(v.block).toBe(true);
  expect(v.message).toContain("no longer reflects the current tree");
});

test("classifyDoneGate: fresh verification (not stale) → accept", () => {
  const v = classifyDoneGate({
    sawMutation: true,
    sawVerification: true,
    verificationStale: false,
    pendingHookFailure: null,
  });
  expect(v.state).toBe("done_ok");
  expect(v.block).toBe(false);
});

test("classifyDoneGate: stale flag without any verification stays unverified", () => {
  // verificationStale is meaningless when nothing was verified; the unverified
  // branch must still win so the message is accurate.
  const v = classifyDoneGate({
    sawMutation: true,
    sawVerification: false,
    verificationStale: true,
    pendingHookFailure: null,
  });
  expect(v.state).toBe("done_unverified");
  expect(v.block).toBe(true);
  expect(v.message).toContain("ran NO verification");
});

test("classifyDoneGate: failing hook outranks stale verification", () => {
  const v = classifyDoneGate({
    sawMutation: true,
    sawVerification: true,
    verificationStale: true,
    pendingHookFailure: "bun test",
  });
  expect(v.state).toBe("done_hook_failing");
  expect(v.block).toBe(true);
});
