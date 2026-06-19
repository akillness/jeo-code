/**
 * Intermediate-judgment guards for the agent loop — the mid-run "should this turn
 * continue, correct itself, or stop" decisions that run between model calls.
 *
 * gjc keeps this concern in its own layer: `gjc-runtime/ultragoal-guard.ts` computes a
 * named `UltragoalGuardState` discriminated union PURELY, and the runtime merely acts on
 * the verdict. jeo previously inlined the same logic inside `engine.ts`'s `while` loop as
 * scattered booleans and message strings. This module gives jeo the same classification:
 * a named `GuardState` taxonomy plus pure, independently-testable classifier functions.
 * `engine.ts` still owns the control flow (history mutation, `step++`, `continue`,
 * `return finish(...)`) — only the JUDGMENT moves here, so behavior is unchanged.
 */

/**
 * Named taxonomy of the loop's intermediate judgments — jeo's descendant of gjc's
 * `UltragoalGuardState`. Each member names one decision the loop can reach mid-turn.
 */
export type GuardState =
  | "ok" // proceed: emit / execute the tool call as-is
  | "repeat_correct" // exact-repeat detected → ONE corrective bounce (skip execution)
  | "repeat_stop" // exact-repeat survived the correction → consolidate-stop
  | "cycle_correct" // A↔B alternation detected → ONE corrective bounce
  | "cycle_stop" // cycle survived the correction → consolidate-stop
  | "consecutive_failure_stop" // MAX_FAILURES different-but-failing steps → stop
  | "invalid_tool_stop" // MAX_INVALID_CALLS replies with no usable tool field → stop
  | "parse_salvage" // repeated non-JSON prose → salvage the text as the final answer
  | "context_overflow_retry" // provider reported context overflow → ONE trim + retry
  | "refusal_retry" // transient safety refusal → bounded resend ladder
  | "done_unverified" // mutated files, no verification signal → pushback on done
  | "done_hook_failing" // post-turn hook still failing → pushback on done
  | "done_ok"; // done accepted — the turn is finished

/**
 * Bounded thresholds for every loop guard — the single, named source of truth.
 * Kept in one frozen object so the limits are discoverable and testable instead of
 * sprinkled as bare literals through the loop body.
 */
export const GUARD_LIMITS = Object.freeze({
  /** Identical step repeats tolerated before a consolidated stop (with corrections en route). */
  MAX_REPEAT: 4,
  /** Consecutive different-but-failing steps before the turn stops. */
  MAX_FAILURES: 5,
  /** Safety-refusal resends per turn before surfacing the friendly error. */
  MAX_REFUSAL_RETRIES: 3,
  /** Replies with no usable `tool`/`tools` field before the turn stops. */
  MAX_INVALID_CALLS: 3,
  /** Consecutive non-JSON parse failures before the prose is salvaged as the answer. */
  MAX_PARSE_BOUNCES: 2,
  /** Recent-signature window scanned for an A↔B (≤2 distinct calls) cycle. */
  CYCLE_WINDOW: 6,
});

/**
 * Commands (or their output) that count as a verification signal: a test, build,
 * typecheck, or lint invocation. The done-verification guard treats a turn that mutated
 * files without any such signal as "unverified".
 */
export const VERIFY_SIGNAL_RE = /\b(test|tests|tsc|typecheck|lint|build|check|spec|pytest|vitest|jest)\b/i;

/**
 * True when a bash command (or the head of its output) proves the work was verified.
 * Output is examined only up to the first 2000 chars — enough to catch a tool runner's
 * banner without rescanning a megabyte of logs.
 */
export function isVerificationSignal(cmd: string, output = ""): boolean {
  return VERIFY_SIGNAL_RE.test(cmd) || VERIFY_SIGNAL_RE.test(output.slice(0, 2000));
}

/**
 * Result-aware repeat nudge: tells the model WHY repeating the call won't help and what
 * to try instead, tailored to the repeated tool and its last actual result.
 */
export function repeatHint(tool: string, prev?: { success: boolean; output: string }): string {
  const out = prev?.output ?? "";
  const empty = !prev || !prev.success || out.trim() === "" || /no match|0 match|no result|not found|no file/i.test(out);
  if (tool === "search" || tool === "find" || tool === "ls") {
    return empty
      ? `That '${tool}' returned nothing useful and will again — BROADEN it (a looser pattern, a parent directory, or a different tool such as ${tool === "search" ? "find" : "search"}), or call done if this lookup isn't needed.`
      : `That '${tool}' already returned results — open one of the hits with read, or move on; re-running it changes nothing.`;
  }
  if (tool === "read") return `You already read that and its content is unchanged — use what you read, or read a DIFFERENT file.`;
  if (tool === "bash") return `That command already ran with the same output — change the command, or call done.`;
  return `That call's result is unchanged — take a different action, or call done.`;
}

/** Inputs for the done-verification gate (jeo's descendant of gjc's ultragoal-guard). */
export interface DoneGateInput {
  /** A write/edit succeeded this turn. */
  sawMutation: boolean;
  /** A test/build/typecheck/lint command succeeded this turn. */
  sawVerification: boolean;
  /** The run-command of the most recent still-failing post-turn hook, or null. */
  pendingHookFailure: string | null;
}

/** Verdict from {@link classifyDoneGate}: whether to bounce `done`, and the message. */
export interface DoneGateVerdict {
  state: Extract<GuardState, "done_ok" | "done_unverified" | "done_hook_failing">;
  /** When true, `done` should be bounced ONCE with `message` (the caller owns the once-gate). */
  block: boolean;
  /** Corrective message to push back on `done`; empty when `state === "done_ok"`. */
  message: string;
}

/**
 * Classify whether a `done` should be accepted or bounced — the direct descendant of
 * gjc's `ultragoal-guard` completion gate (plan/gjc-inheritance.md B4).
 *
 * A turn that MUTATED files but has either NO verification signal or a still-failing
 * post-turn hook is blocked ONCE. The caller owns the single-pushback latch; a second
 * `done` always passes (the escape hatch for genuinely-unverifiable docs/config changes).
 */
export function classifyDoneGate(input: DoneGateInput): DoneGateVerdict {
  const hookFailing = input.pendingHookFailure !== null;
  const block = input.sawMutation && (!input.sawVerification || hookFailing);
  if (!block) return { state: "done_ok", block: false, message: "" };
  if (hookFailing) {
    return {
      state: "done_hook_failing",
      block: true,
      message:
        `Your latest mutation left the post-turn hook "${input.pendingHookFailure}" FAILING (non-zero exit) — its diagnostics were shown in the tool result above. ` +
        "Fix the reported problems (the hook re-runs on your next mutation), then call done. " +
        "If the hook failure is a false positive, call done again and say why in the reason.",
    };
  }
  return {
    state: "done_unverified",
    block: true,
    message:
      "You modified files this turn but ran NO verification (no test/build/typecheck command succeeded). " +
      "Run the narrowest command that proves your change works, then call done. " +
      "If verification is genuinely not applicable (docs/config-only change), call done again and say why in the reason.",
  };
}
